import { CompElem, showWarn, signal, signalComputed } from "compelem";
import { has, isPlainObject } from "myfx";
import { clearStoreDevtools, registerStoreDevtools, unregisterStoreDevtools } from "./devtools";
import type { DefineStoreOptions, StoreFacade, StoreMutation, StoreSubscriber } from "./types";

/** 同 id 的 store 单例注册表（直接存 facade） */
const registry = new Map<string, any>();

function sanitizeSlotKey(id: string): string {
  const key = "__ce_store_" + String(id).replace(/[^a-zA-Z0-9_$]/g, "_");
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
    throw new Error(`[compelem-store] invalid store id: '${id}'`);
  }
  return key;
}

function createStoreInternal<S extends Record<string, any>, G extends Record<string, any>, A extends Record<string, any>>(
  options: DefineStoreOptions<S, G, A>
): StoreFacade<S, G, A> {
  const { id, getters = {} as G, actions = {} as A } = options;

  // ---- 1. 信号化响应式状态 ----------------------------------------------------
  const slotKey = sanitizeSlotKey(id);
  const raw = options.state();
  if (!isPlainObject(raw)) {
    throw new Error(`[compelem-store] store '${id}' state must be a plain object`);
  }
  // 订阅注册表 + 广播闭包
  const compRefs = new Set<WeakRef<CompElem>>();
  const compKnown = new WeakSet<object>();
  const listeners = new Set<StoreSubscriber>();
  let version = 0;
  const sigs: Record<string, any> = {};
  for (const k of Object.keys(raw)) sigs[k] = signal(raw[k]);

  // ---- 1.1 嵌套深响应式（兼容 0.1.x 的深代理语义） --------------------------
  // 0.3.0 只把顶层 state key 做成 signal；嵌套对象/数组是普通引用，赋值
  // （selection.nodes = ... / node.x = 5 / doc.nodes.push(...)）不触发任何
  // signal、不广播，订阅者（画布 onStoreChange、useStore 等）全部失活。
  // 这里在读取顶层值时把嵌套对象/数组递归包成响应式 proxy：嵌套 set/delete
  // 与数组变更方法都向上层 chain 广播，恢复「任意写入即通知」的语义。
  // 注意：broadcast 已被 compelem-store 自身与调用方自己的批量包装（项目侧
  // subscribeBatched / compelem Queue）合并，深响应式不会放大写入次数。
  const wrapped = new WeakMap<object, any>();
  const ARRAY_MUTATORS = ['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin'];
  function makeReactive(obj: any, chain: string[]): any {
    if (obj === null || typeof obj !== 'object') return obj;
    const cached = wrapped.get(obj);
    if (cached) return cached;
    const isArr = Array.isArray(obj);
    const p = new Proxy(obj, {
      get(target, k, recv) {
        if (isArr && ARRAY_MUTATORS.includes(k as string)) {
          return (...args: any[]) => {
            const res = (target as any)[k as string].apply(target, args);
            broadcast(undefined, undefined, [...chain, k as string], undefined, undefined);
            return res;
          };
        }
        if (typeof k !== 'string') return Reflect.get(target, k, target);
        return makeReactive(Reflect.get(target, k, target), [...chain, k]);
      },
      set(target, k, v, recv) {
        const old = Reflect.get(target, k, target);
        const nv = makeReactive(v, [...chain, k as string]);
        Reflect.set(target, k, nv, target);
        broadcast(undefined, old, [...chain, k as string], nv, old);
        return true;
      },
      deleteProperty(target, k) {
        const old = Reflect.get(target, k, target);
        Reflect.deleteProperty(target, k);
        broadcast(undefined, undefined, [...chain, k as string], undefined, old);
        return true;
      },
    });
    wrapped.set(obj, p);
    return p;
  }

  const stateProxy: Record<string, any> = new Proxy({} as Record<string, any>, {
    get(_t, k: string | symbol) { return typeof k === 'string' && sigs[k] ? makeReactive(sigs[k].value, [slotKey, k]) : undefined; },
    set(_t, k: string | symbol, v) {
      if (typeof k !== 'string') return false;
      const old = sigs[k] ? sigs[k].value : undefined;
      if (!sigs[k]) sigs[k] = signal(v); else sigs[k].value = v;
      broadcast(undefined, old, [slotKey, k], v, old);
      return true;
    },
    has(_t, k) { return typeof k === 'string' && k in sigs; },
    deleteProperty(_t, k) {
      if (typeof k === 'string' && k in sigs) {
        const old = sigs[k].value;
        delete sigs[k];
        broadcast(undefined, old, [slotKey, k], undefined, old);
        return true;
      }
      return false;
    },
    ownKeys() { return Object.keys(sigs); },
    getOwnPropertyDescriptor(_t, k) { return typeof k === 'string' && k in sigs ? { enumerable: true, configurable: true, value: sigs[k].value } : undefined; },
  });

  // ---- 2. getters（signal 依赖自动失效） --------------------------------------
  const getterCache = new Map<string, any>();
  function getGetter(name: string): any {
    let c = getterCache.get(name);
    if (!c) {
      c = signalComputed(() => (getters as any)[name](stateProxy));
      getterCache.set(name, c);
    }
    return c.value;
  }

  // ---- 3. 订阅注册表 + 广播 ------------------------------------------------
  function subscribe(comp: CompElem) {
    if (compKnown.has(comp)) return;
    if (!(comp instanceof CompElem)) {
      showWarn(`[compelem-store] 'connect' expects a CompElem instance, got:`, comp);
      return;
    }
    compKnown.add(comp);
    compRefs.add(new WeakRef(comp));
  }

  // 所有变更都经 signal 直写：组件模板的 point effect 读到 sig.value 即建立订阅，
  // 信号变更自动驱动对应 DOM 更新推进；此处只需通知显式 subscribe 的监听器。
  function broadcast(nv: any, ov: any, chain: string[], subNewValue?: any, subOldValue?: any) {
    version++;
    const path = chain.join(".");
    const newVal = subNewValue;
    const oldVal = subOldValue;
    if (listeners.size > 0) {
      const mutation: StoreMutation = { key: path, newValue: newVal, oldValue: oldVal, chain };
      const snapshot = { ...stateProxy };
      listeners.forEach(cb => {
        try {
          cb(mutation, snapshot);
        } catch (e) {
          showWarn(`[compelem-store] subscriber of '${id}' threw:`, e);
        }
      });
    }
  }

  // ---- 4. store 方法（无 $ 前缀） -------------------------------------------
  const methods: Record<string, any> = {
    id,
    state: stateProxy,
    patch(partial: Partial<S>) {
      if (!isPlainObject(partial)) {
        showWarn(`[compelem-store] 'patch' expects a plain object, got:`, partial);
        return;
      }
      Object.keys(partial).forEach(k => {
        (stateProxy as any)[k] = (partial as any)[k];
      });
    },
    reset() {
      const fresh = options.state();
      Object.keys(fresh).forEach(k => {
        (stateProxy as any)[k] = (fresh as any)[k];
      });
      // 移除 state() 中不存在的多余键
      Object.keys(stateProxy).forEach(k => {
        if (!has(fresh, k)) {
          delete (stateProxy as any)[k];
        }
      });
    },
    subscribe(cb: StoreSubscriber) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    connect(comp: CompElem) {
      subscribe(comp);
    },
    disconnect(comp: CompElem) {
      compRefs.forEach(ref => {
        if (ref.deref() === comp) compRefs.delete(ref);
      });
      compKnown.delete(comp);
    },
  };

  // ---- 5. facade proxy -------------------------------------------------------
  const facade: any = new Proxy(stateProxy, {
    get(target, prop) {
      if (typeof prop === "string") {
        if (has(methods, prop)) {
          const m = methods[prop];
          return typeof m === "function" ? m.bind(facade) : m;
        }
        if (has(getters, prop)) return getGetter(prop);
        if (has(actions, prop)) return (actions as any)[prop].bind(facade);
        return Reflect.get(target, prop, target);
      }
      return Reflect.get(target, prop, target);
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value, target);
    },
    has(target, prop) {
      if (typeof prop === "string" && (has(methods, prop) || has(getters, prop) || has(actions, prop))) return true;
      return Reflect.has(target, prop);
    },
    deleteProperty(target, prop) {
      // 删除广播由 stateProxy 的 deleteProperty trap 触发
      if (typeof prop === "string" && has(target, prop)) {
        return Reflect.deleteProperty(target, prop);
      }
      return Reflect.deleteProperty(target, prop);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, prop) {
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });

  // ---- 6. devtools 接入点（未安装 devtools 时只是往 globalThis 挂一个对象）----
  // getters/actions 必须显式登记：facade 的 ownKeys 只暴露 state，
  // devtools 无法通过反射枚举出这两类成员。
  registerStoreDevtools({
    id,
    facade,
    getters: Object.keys(getters),
    actions: Object.keys(actions),
    slotKey,
  });

  return facade as StoreFacade<S, G, A>;
}

/**
 * 按 id 查找已注册的 store facade（供 useStore 的字符串形式使用）
 */
export function getStoreById(id: string): object | undefined {
  return registry.get(id);
}

/**
 * 按 id 注册 store 并直接返回 facade：同 id 重复注册返回既有实例并告警。
 */
function register<T>(id: string, make: () => T): T {
  const existed = registry.get(id);
  if (existed) {
    showWarn(`[compelem-store] store '${id}' is already defined, the previous instance is returned`);
    return existed as T;
  }
  const facade = make();
  registry.set(id, facade);
  return facade;
}

/**
 * 定义一个全局 store 并返回 facade 本体。同 id 重复定义返回同一 store。
 *
 * @example
 * const counter = defineStore({
 *   id: 'counter',
 *   state: () => ({ count: 0 }),
 *   getters: { double: s => s.count * 2 },
 *   actions: { inc() { this.count++ } },
 * });
 * counter.count++;          // 读写即触发订阅组件更新
 * counter.inc();
 *
 * // 轻量形式：只给 state
 * const theme = defineStore({ id: 'theme', state: () => ({ mode: 'light' }) });
 */
export function defineStore<S extends Record<string, any>, G extends Record<string, any> = {}, A extends Record<string, any> = {}>(
  options: DefineStoreOptions<S, G, A>
): StoreFacade<S, G, A> {
  return register(options.id, () => createStoreInternal<S, G, A>(options));
}

/**
 * 从注册表摘除一个 store，之后可用同 id 重新定义、得到全新状态。
 * 主要面向测试隔离（用例之间拿到干净的 store）。
 *
 * 注意：已持有旧 facade 引用的组件不会自动解绑，其订阅仍然有效；
 * 若新旧 store 同时存活，两者共用同一依赖路径根，会出现交叉失效。
 * 因此本 API 应在确认无组件引用旧 facade 时使用。
 */
export function disposeStore(id: string): boolean {
  unregisterStoreDevtools(id);
  return registry.delete(id);
}

/**
 * 清空全部已注册 store（测试 / 整体重置场景）。注意事项同 {@link disposeStore}。
 */
export function resetStores(): void {
  clearStoreDevtools();
  registry.clear();
}

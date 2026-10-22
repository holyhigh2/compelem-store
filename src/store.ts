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
  //
  // ⚠️ 2026-10-15 修复「数组 mutator 不触发模板更新」缺陷：
  // broadcast 只通知显式 subscribe 的监听器，而模板 point effect 依赖的是
  // signal 写入 —— 顶层重赋值（sig.value = v）会触发，push/splice 等原地
  // mutator 不会 ⇒ 按官方文档示例写的 `store.items.push(x)` 之后 UI 不更新
  // （读过 items 的模板冻结在首渲染帧）。修法：给每个被代理的**数组**挂一个
  // 对象级版本 signal —— 数组被读时注册依赖（track），mutator 执行后自增。
  // 只有「读过该数组」的效果会重跑，粒度到对象为止。
  //
  // 刻意**不**对普通嵌套 set 做 ver 触发：宿主工程（compelem-report-builder）
  // 的画布把单元格原文写入 cell.text（嵌套 set）并依赖「写原文不回流视图」
  // 的性能设计（Workbench 一次性把行数据派生给 ce-editable，若每次嵌套写都
  // 触发读者重跑，每敲一格就会重建网格导致光标跳动）。嵌套属性写的模板更新
  // 仍走「顶层重赋值 / Seq 通道」，与该工程既有架构一致。
  const wrapped = new WeakMap<object, { p: any; ver: any }>();
  const ARRAY_MUTATORS = ['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin'];
  function makeReactive(obj: any, chain: string[]): any {
    if (obj === null || typeof obj !== 'object') return obj;
    const cached = wrapped.get(obj);
    if (cached) return cached.p;
    const isArr = Array.isArray(obj);
    // 对象级版本 signal：仅数组使用（读时 track、mutator 后自增）
    const ver = isArr ? signal(0) : null;
    const p = new Proxy(obj, {
      get(target, k, recv) {
        if (isArr && ARRAY_MUTATORS.includes(k as string)) {
          return (...args: any[]) => {
            const res = (target as any)[k as string].apply(target, args);
            ver!.value++; // 结构变更：读过该数组的模板 effect 重跑（见上方注释）
            broadcast([...chain, k as string]);
            return res;
          };
        }
        if (typeof k !== 'string') return Reflect.get(target, k, target);
        // 数组任意键读取（length / 索引 / 方法名）都注册对 ver 的依赖
        if (isArr) ver!.value;
        return makeReactive(Reflect.get(target, k, target), [...chain, k]);
      },
      set(target, k, v, recv) {
        const old = Reflect.get(target, k, target);
        const nv = makeReactive(v, [...chain, k as string]);
        Reflect.set(target, k, nv, target);
        broadcast([...chain, k as string], nv, old);
        return true;
      },
      deleteProperty(target, k) {
        const old = Reflect.get(target, k, target);
        Reflect.deleteProperty(target, k);
        broadcast([...chain, k as string], undefined, old);
        return true;
      },
    });
    wrapped.set(obj, { p, ver });
    return p;
  }

  const stateProxy: Record<string, any> = new Proxy({} as Record<string, any>, {
    get(_t, k: string | symbol) { return typeof k === 'string' && sigs[k] ? makeReactive(sigs[k].value, [slotKey, k]) : undefined; },
    set(_t, k: string | symbol, v) {
      if (typeof k !== 'string') return false;
      const old = sigs[k] ? sigs[k].value : undefined;
      if (!sigs[k]) sigs[k] = signal(v); else sigs[k].value = v;
      broadcast([slotKey, k], v, old);
      return true;
    },
    has(_t, k) { return typeof k === 'string' && k in sigs; },
    deleteProperty(_t, k) {
      if (typeof k === 'string' && k in sigs) {
        const old = sigs[k].value;
        delete sigs[k];
        broadcast([slotKey, k], undefined, old);
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
  // ⚠️ 旧签名是 `broadcast(nv, ov, chain, subNewValue, subOldValue)`，但前两个形参在
  // 函数体内从未被读取（真正生效的是后三个），且 `version++` 无人消费 ⇒ 已收敛为
  // `(chain, newValue, oldValue)`，避免调用方误以为前两个有语义。
  function broadcast(chain: string[], newValue?: any, oldValue?: any) {
    const path = chain.join(".");
    if (listeners.size > 0) {
      const mutation: StoreMutation = { key: path, newValue, oldValue, chain };
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
 * **非单例**工厂：直接构建一份全新 store，**不进注册表**（同 id 可建多份）。
 *
 * 用途：需要"同一份 store 逻辑、多个互相隔离的实例"的场景（例如一个宿主里
 * 同时打开多份文档，每份要独立的 state / 订阅 / 历史）。`defineStore` 是"同 id
 * 单例"，本函数是它的多实例版。
 *
 * ⚠️ 各实例的 `id` 建议唯一（如 `designer:tab-1`）：`id` 用于 devtools 登记与
 * 变更路径前缀（`slotKey`）。用同一 id 建多份不会串数据（信号对象各自独立），
 * 但 devtools 里会重名。
 */
export function createStore<S extends Record<string, any>, G extends Record<string, any> = {}, A extends Record<string, any> = {}>(
  options: DefineStoreOptions<S, G, A>
): StoreFacade<S, G, A> {
  return createStoreInternal<S, G, A>(options);
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

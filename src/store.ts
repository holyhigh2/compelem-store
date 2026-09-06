import { CompElem, createReactiveState, getCurrentRenderComponent, showWarn } from "compelem";
import { has, isPlainObject } from "myfx";
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

  // ---- 1. 直接造框架响应式代理（不再需要 headless CompElem 宿主）-----------
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
  // _getPrivateData 必须返回 { [slotKey]: raw } —— 与 set 陷阱里
  // context._getPrivateData()[subChain[0]]（subChain[0] === slotKey）的取根逻辑一致，
  // 从而 nv/ov 拿到整个 state 根对象（与改动前 host._notify 行为字节级一致）。
  const data = { [slotKey]: raw };
  const host = { _getPrivateData: () => data } as any;
  // reactive 内部把 OBJECT_VAR_PATH 设为 [slotKey]，与组件 render 期间 Collector
  // 收集的依赖路径（slotKey.xxx）完全一致，组件侧 _notify / ViewDepMap 匹配零改动。
  const stateProxy = createReactiveState(raw, host, slotKey) as Record<string, any>;

  // ---- 2. getters（惰性求值 + 版本失效） ----------------------------------
  const getterCache = new Map<string, { version: number; value: any }>();
  function getGetter(name: string): any {
    let c = getterCache.get(name);
    if (!c || c.version !== version) {
      c = { version, value: (getters as any)[name](stateProxy) };
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

  // 所有变更经框架 reactive 代理 → 框架 requestUpdate → context._notify（即本函数）
  // 统一在此广播。chain 以 slotKey 为根，与组件 render 期间 Collector 收集到的
  // 依赖路径完全一致，组件侧 _notify / ViewDepMap 匹配零改动。
  // （此前版本用 headless CompElem 宿主透传，现直接由普通对象承担，顺带消除了
  //  宿主永不挂载导致 #updateSources 无界增长的内存泄漏。）
  function broadcast(nv: any, ov: any, chain: string[], subNewValue?: any, subOldValue?: any) {
    version++;
    const path = chain.join(".");
    // 框架已在 _notify 的 subNewValue/subOldValue 中填入该路径的叶子级新/旧值
    // （compelem requestUpdate 现透传 set 陷阱算好的叶子值，见 compelem index.js:664 / :644），
    // 故 subscribe 的 newValue/oldValue 直接取这两个参数，无需 store 侧再维护快照。
    // 注：nv/ov（root 级）在 chain 长度 > 1 时仍被框架塌缩为同一 root 对象，仅用于组件更新管线。
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
    compRefs.forEach(ref => {
      const comp = ref.deref();
      if (!comp || comp.isDestroyed || !comp.isConnected) {
        compRefs.delete(ref);
        return;
      }
      // 组件更新管线沿用框架下发的 (nv, ov, chain, subNV, subOV)，与改动前一致；
      // store 侧对 oldValue 的处理只影响 subscribe 回调，不改组件渲染行为。
      comp._notify(nv, ov, chain, subNewValue, subOldValue);
    });
  }
  host._notify = broadcast;

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
      // 移除 state() 中不存在的多余键并广播
      Object.keys(stateProxy).forEach(k => {
        if (!has(fresh, k)) {
          const old = (stateProxy as any)[k];
          delete (stateProxy as any)[k];
          broadcast(undefined, old, [slotKey, k]);
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
        if (!has(methods, prop)) {
          const comp = getCurrentRenderComponent();
          if (comp) subscribe(comp as CompElem);
        }
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
      if (typeof prop === "string" && has(target, prop)) {
        const old = Reflect.get(target, prop, target);
        const rs = Reflect.deleteProperty(target, prop);
        // 框架代理无 deleteProperty trap，手动广播一次
        broadcast(undefined, old, [slotKey, prop]);
        return rs;
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
  return registry.delete(id);
}

/**
 * 清空全部已注册 store（测试 / 整体重置场景）。注意事项同 {@link disposeStore}。
 */
export function resetStores(): void {
  registry.clear();
}

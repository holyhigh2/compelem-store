import type { CompElem } from "compelem";
import { showWarn } from "compelem";
import { getStoreById } from "./store";
import type { StoreFacade } from "./types";

/**
 * 把一个 store 接入组件的响应式订阅。在 render() 中调用，显式传入组件实例（this）：
 *
 * @example
 * const counter = defineStore({ id: 'counter', state: () => ({ count: 0 }), ... });
 *
 * \@tag('counter-view')
 * class CounterView extends CompElem {
 *   render() {
 *     const store = useStore(counter, this);  // 或 useStore('counter', this)
 *     return h`<span>${store.count}</span>`;
 *   }
 * }
 *
 * 调用点即订阅点：无需"当前渲染组件"探测。同一组件重复调用幂等（内部 WeakRef 去重），
 * 组件销毁后由广播侧剪枝（WeakRef + isDestroyed/isConnected 检查），无需手动退订。
 *
 * @param store store id 字符串 / store facade（defineStore 直接返回的本体）
 * @param comp  组件实例（render 中的 this）
 * @returns 解析出的 store facade（可直接读写 state、调用 actions）
 */
export function useStore<F extends StoreFacade<any, any, any>>(store: F, comp: CompElem): F;
export function useStore(store: string, comp: CompElem): StoreFacade<Record<string, any>, Record<string, never>, Record<string, never>>;
export function useStore(storeRef: object | string, comp: CompElem): any {
  let facade: any;
  if (typeof storeRef === "string") {
    facade = getStoreById(storeRef);
    if (!facade) {
      showWarn(`[compelem-store] useStore: no store registered with id '${storeRef}' (define it first via defineStore)`);
      return undefined;
    }
  } else {
    facade = storeRef;
  }
  if (facade === null || typeof facade !== "object") {
    showWarn(`[compelem-store] useStore expects a store id or facade, got:`, storeRef);
    return facade;
  }
  if (comp == null) {
    showWarn(`[compelem-store] useStore: missing component instance — call it as useStore(store, this) inside render()`);
    return facade;
  }
  facade.connect(comp);
  return facade;
}

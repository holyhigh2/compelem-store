import type { Template } from "compelem";

/**
 * subscribe 回调收到的变更描述
 */
export interface StoreMutation {
  /** 变更路径（以 store 内部根为起点），如 "user.profile.name" */
  key: string;
  newValue: any;
  oldValue: any;
  /** 变更路径链 */
  chain: string[];
}

export type StoreSubscriber = (mutation: StoreMutation, snapshot: Record<string, any>) => void;

/**
 * defineStore options。
 * G/A 使用 intersection 写法以同时获得字面量推断与参数上下文类型（Pinia 同款技巧）。
 */
export interface DefineStoreOptions<S extends Record<string, any>, G, A> {
  /** 全局唯一 id，同 id 重复 define 会返回同一 store */
  id: string;
  /** 返回初始 state 的工厂函数，reset() 时会重新调用 */
  state: () => S;
  /** 计算属性，参数为响应式 state；任一 state 变更后惰性重算 */
  getters?: G & Record<string, (state: S) => any>;
  /** 修改 state 的方法，this 为 store facade（可直接读写 state 属性） */
  actions?: A & Record<string, (...args: any[]) => any> & ThisType<any>;
}

/** getters 求值后的属性视图 */
export type GetterValues<G> = { [K in keyof G]: G[K] extends (state: any) => infer R ? R : never };

/**
 * store facade：既可直接读写 state 属性，也暴露 getters / actions / store 方法
 */
export type StoreFacade<S extends Record<string, any>, G, A> = S & GetterValues<G> & A & {
  /** 响应式 state 代理（render 中读取同样会被依赖收集） */
  readonly state: S;
  /** store id */
  readonly id: string;
  /** 批量更新 state（逐键触发响应式更新，同 tick 内自动合并渲染） */
  patch(partial: Partial<S>): void;
  /** 用 state() 工厂重新生成的初始值覆盖当前 state（多余键会被移除） */
  reset(): void;
  /** 订阅任意变更（与组件渲染无关的手动监听），返回退订函数 */
  subscribe(cb: StoreSubscriber): () => void;
  /** 手动把一个组件实例接入订阅（等价于在 render 中调用 useStore(store, this)） */
  connect(comp: any): void;
  /** 解除组件订阅 */
  disconnect(comp: any): void;
};

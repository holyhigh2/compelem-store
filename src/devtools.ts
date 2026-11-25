/**
 * compelem-store × compelem-devtools 接入点。
 *
 * 设计约束：
 * - **零依赖、零副作用**：未安装 devtools 时这里只是往 globalThis 上挂一个对象，
 *   不注册任何监听、不持有额外引用；
 * - **懒求值**：provider 只保存 facade 的 WeakRef，读取时机完全由 devtools 决定；
 * - **不改变既有语义**：mutation 订阅复用公开的 `facade.subscribe()`，而 `broadcast`
 *   内部本来就用 `listeners.size > 0` 做闸门（store.ts），因此面板未打开时零开销。
 *
 * 契约：`globalThis.__COMPELEM_ECOSYSTEM__.store`
 * 三个生态库共用同一个 globalThis 槽位，各自占一个命名空间键，
 * devtools 侧按 `store` / `router` / `i18n` 分别探测。
 */

export const ECOSYSTEM_KEY = '__COMPELEM_ECOSYSTEM__'

/** 单个 store 暴露给 devtools 的元信息（facade 本身仍是唯一数据源） */
export interface StoreDevtoolsEntry {
  /** store id */
  id: string
  /** store facade 本体：state 读写 / patch / reset / subscribe / actions 全在这上面 */
  facade: any
  /** getter 名。facade 的 ownKeys 只暴露 state，getters 必须单独登记 */
  getters: string[]
  /** action 名，同上 */
  actions: string[]
  /** 响应式根路径（`__ce_store_<id>`），用于把组件依赖路径反推回 store */
  slotKey: string
}

export interface StoreDevtoolsProvider {
  /** 全部已注册 store 的 id */
  list(): string[]
  /** 按 id 取元信息 */
  entry(id: string): StoreDevtoolsEntry | undefined
  /** 订阅某个 store 的变更（直接复用 facade.subscribe，返回退订函数） */
  subscribe(id: string, cb: (mutation: any, snapshot: any) => void): () => void
}

interface StoreDevtoolsRecord {
  id: string
  facadeRef: WeakRef<any>
  getters: string[]
  actions: string[]
  slotKey: string
}

/**
 * 模块级注册表；provider 本身挂在 globalThis，供 devtools 统一探测。
 * 元信息保持强引用，只有 facade 使用 WeakRef；createStore 的临时实例可被 GC，
 * 但只要 facade 仍存活，devtools 登记就不会随机消失。
 * 注意 devtools 只通过 provider 的三个方法访问它，不直接暴露 Map。
 */
const entries = new Map<string, StoreDevtoolsRecord>()

function pruneEntries() {
  entries.forEach((record, id) => {
    if (!record.facadeRef.deref()) entries.delete(id)
  })
}

function toEntry(record: StoreDevtoolsRecord): StoreDevtoolsEntry | undefined {
  const facade = record.facadeRef.deref()
  return facade ? {
    id: record.id,
    facade,
    getters: record.getters,
    actions: record.actions,
    slotKey: record.slotKey,
  } : undefined
}

/**
 * 取得（必要时创建）provider 并挂到 globalThis。
 * 用 defineProperty 保持可配置，便于热更新 / 重复注入时覆盖。
 */
function provider(): StoreDevtoolsProvider {
  const g = globalThis as any
  const eco = (g[ECOSYSTEM_KEY] = g[ECOSYSTEM_KEY] || {})
  if (!eco.store) {
    const p: StoreDevtoolsProvider = {
      list: () => {
        pruneEntries()
        return Array.from(entries.keys())
      },
      entry: (id: string) => {
        const record = entries.get(id)
        return record ? toEntry(record) : undefined
      },
      subscribe: (id: string, cb: (mutation: any, snapshot: any) => void) => {
        const facade = entries.get(id)?.facadeRef.deref()
        return facade ? facade.subscribe(cb) : () => { /* noop */ }
      },
    }
    Object.defineProperty(eco, 'store', {
      value: p,
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  return eco.store
}

/** 由 defineStore 内部调用：登记一个新创建的 store */
export function registerStoreDevtools(entry: StoreDevtoolsEntry): void {
  entries.set(entry.id, {
    id: entry.id,
    facadeRef: new WeakRef(entry.facade),
    getters: entry.getters,
    actions: entry.actions,
    slotKey: entry.slotKey,
  })
  provider()
}

/** 由 disposeStore 调用：摘除登记 */
export function unregisterStoreDevtools(id: string): void {
  entries.delete(id)
}

/** 由 resetStores 调用：清空登记 */
export function clearStoreDevtools(): void {
  entries.clear()
}

/** 供控制台 / 测试直接读取全部登记项 */
export function getStoreDevtoolsEntries(): StoreDevtoolsEntry[] {
  pruneEntries()
  const live: StoreDevtoolsEntry[] = []
  entries.forEach(record => {
    const entry = toEntry(record)
    if (entry) live.push(entry)
  })
  return live
}

/**
 * 模块加载期即把 provider 挂到 globalThis。
 *
 * 目的是让 devtools 能区分两种「没有 store」：
 * - **本库未加载** → `__COMPELEM_ECOSYSTEM__.store` 不存在；
 * - **本库已加载但尚未创建实例** → 命名空间在、`list()` 为空。
 *
 * 若只在 `registerStoreDevtools` 里懒挂，两者对外完全同形，面板无法给出准确提示。
 * 这里只挂一个惰性 provider 对象（不注册监听、不持有额外引用、`list()` 才求值），
 * 因此「零副作用 / 零开销」的约束依然成立。
 */
provider()

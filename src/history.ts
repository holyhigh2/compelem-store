/**
 * 撤销 / 重做控制器（快照式 + 事务化记账）。框架无关，可配接到任意 store。
 *
 * 设计取向是**快照式**而非"逆操作"式：调用方给定"取快照"与"用快照还原"两个回调，
 * 控制器只在"最外层被追踪操作"前后各取一次快照并比对，变更才入栈。相比为每个写操作
 * 手写逆操作，模型一致性只有一份真相，不会随写入口增多而分叉。
 *
 * 三条约束（由调用方语义决定，控制器只提供机制）：
 *
 * 1. **快照内容由调用方决定**：通常是"可序列化的设计态"。运行时态（跑出来的数据、
 *    选区、UI 开关）是否纳入，由 `snapshot` / `restore` 的实现决定。
 *
 * 2. **只在最外层操作记账**：被追踪操作之间可能互相调用，嵌套时用深度计数器把内层
 *    并入外层，避免"一次点击"被记成多步。
 *
 * 3. **连续变更合并**：同指纹（操作名 + 前两个参数）在 `coalesceMs` 内的连续变更并成
 *    一步，否则同一处连续输入会各占一步。
 *
 * ⚠️ 异步操作不要放进 `wrap` 的追踪名单：包装器在同步返回处即结算，`await` 之后的
 *    写入不会被本次记账覆盖；异步整段合并请用 `batchAsync`。
 */

export interface HistoryOptions {
  /** 参与记账的操作名；未列出的操作原样透传（不取快照、不动深度） */
  tracked: readonly string[];
  /** 取当前快照（须是可直接比较的字符串，通常为 `JSON.stringify(...)`） */
  snapshot: () => string;
  /** 用快照还原（须走 store 的写通道，否则订阅方收不到通知）；抛错时历史栈不变，但已写入的部分状态不会自动回滚 */
  restore: (json: string) => void;
  /** 连续变更的合并窗口（ms），默认 500 */
  coalesceMs?: number;
  /** 历史栈上限，默认 50 */
  limit?: number;
  /** 每次栈内容变化后回调（记账 / 撤销 / 重做 / 清空都会触发），用于刷新按钮禁用态 */
  onChange?: () => void;
}

export interface HistoryController {
  /** 包装一组操作：只有 `tracked` 里的成员会被记账，其余原样透传 */
  wrap<T extends Record<string, any>>(actions: T): T;
  /**
   * 把 `fn` 里的**所有**写操作合并成**一步**历史（嵌套时最外层为准）。
   *
   * @param key 合并指纹（同 key 且落在 `coalesceMs` 内会并成一步）
   */
  batch<T>(fn: () => T, key?: string): T;
  /** `batch` 的异步版：`await fn()` 之后才结算，用于把整段异步过程并成一步 */
  batchAsync<T>(fn: () => Promise<T>, key?: string): Promise<T>;
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  /** 当前栈深（探针 / 调试用） */
  depth(): { undo: number; redo: number };
  clear(): void;
}

const DEFAULT_COALESCE_MS = 500;
const DEFAULT_LIMIT = 50;

/**
 * 创建一个快照式撤销 / 重做控制器。
 *
 * @example
 * const history = createHistory({
 *   tracked: ['setText', 'addRow'],
 *   snapshot: () => JSON.stringify(store.state),
 *   restore: (json) => store.patch(JSON.parse(json)),
 * })
 * const actions = history.wrap({ setText, addRow })  // 记账
 * history.batch(() => { setText('a'); addRow() })     // 这两笔并成一步
 * history.undo()                                      // 回退一步
 *
 * @param opts 配置（见 {@link HistoryOptions}）
 * @returns 控制器（见 {@link HistoryController}）
 */
export function createHistory(opts: HistoryOptions): HistoryController {
  const tracked = new Set(opts.tracked);
  const coalesceMs = opts.coalesceMs ?? DEFAULT_COALESCE_MS;
  const limit = opts.limit ?? DEFAULT_LIMIT;

  /** 每项都是"这一步之前"的完整快照 */
  const undoStack: string[] = [];
  const redoStack: string[] = [];

  /** 嵌套深度：0 = 当前不在任何被追踪操作内 */
  let depth = 0;
  /** 最外层操作的入口快照（深层调用复用，退出到 0 时才结算） */
  let entry: string | null = null;

  /** 上一次记账的指纹与时刻（指纹 = 操作名 + 前两个参数） */
  let lastKey = "";
  let lastAt = 0;

  /** 还原期间置位：撤销 / 重做自身绝不能反过来记账 */
  let restoring = false;

  const notify = () => opts.onChange?.();

  function fingerprint(name: string, args: any[]): string {
    return `${name}|${args[0] ?? ""}|${args[1] ?? ""}`;
  }

  function record(before: string, key: string) {
    const now = Date.now();
    // 合并窗口内、且指纹相同的变更不新起一步 —— 栈顶已是"这一串输入开始之前"的状态
    const merged = undoStack.length > 0 && key === lastKey && now - lastAt <= coalesceMs;
    if (!merged) {
      undoStack.push(before);
      if (undoStack.length > limit) undoStack.shift();
    }
    // 新分支产生 ⇒ 重做栈失效（所有编辑器的通行语义）
    redoStack.length = 0;
    lastKey = key;
    lastAt = now;
    notify();
  }

  /** 事务化记账入口（`wrap` 与 `batch` 共用）：退出到 depth 0 时才比对前后快照 */
  function scoped<T>(key: string, inner: () => T): T {
    const outermost = depth === 0;
    if (outermost) entry = opts.snapshot();
    depth++;
    try {
      return inner();
    } finally {
      depth--;
      if (depth === 0) {
        const before = entry;
        entry = null;
        if (before !== null && !restoring) {
          const after = opts.snapshot();
          if (after !== before) record(before, key);
        }
      }
    }
  }

  function wrap<T extends Record<string, any>>(actions: T): T {
    const out: Record<string, any> = {};
    for (const name of Object.keys(actions)) {
      const fn = (actions as Record<string, any>)[name];
      if (typeof fn !== "function" || !tracked.has(name)) {
        out[name] = fn;
        continue;
      }
      out[name] = function (this: any, ...args: any[]) {
        return scoped(fingerprint(name, args), () => fn.apply(this, args));
      };
    }
    return out as T;
  }

  function batch<T>(fn: () => T, key = "batch"): T {
    return scoped(key, fn);
  }

  async function batchAsync<T>(fn: () => Promise<T>, key = "batch"): Promise<T> {
    const outermost = depth === 0;
    if (outermost) entry = opts.snapshot();
    depth++;
    try {
      return await fn();
    } finally {
      depth--;
      if (depth === 0) {
        const before = entry;
        entry = null;
        if (before !== null && !restoring) {
          const after = opts.snapshot();
          if (after !== before) record(before, key);
        }
      }
    }
  }

  function undo(): boolean {
    if (undoStack.length < 1) return false;
    const current = opts.snapshot();
    const prev = undoStack[undoStack.length - 1];
    restoring = true;
    try {
      opts.restore(prev);
    } finally {
      restoring = false;
    }
    undoStack.pop();
    redoStack.push(current);
    if (redoStack.length > limit) redoStack.shift();
    // 还原后指纹作废：紧跟其后的编辑必须新起一步，不能被合并进被撤销的那一步
    lastKey = "";
    lastAt = 0;
    notify();
    return true;
  }

  function redo(): boolean {
    if (redoStack.length < 1) return false;
    const current = opts.snapshot();
    const next = redoStack[redoStack.length - 1];
    restoring = true;
    try {
      opts.restore(next);
    } finally {
      restoring = false;
    }
    redoStack.pop();
    undoStack.push(current);
    if (undoStack.length > limit) undoStack.shift();
    lastKey = "";
    lastAt = 0;
    notify();
    return true;
  }

  return {
    wrap,
    batch,
    batchAsync,
    undo,
    redo,
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    depth: () => ({ undo: undoStack.length, redo: redoStack.length }),
    clear() {
      undoStack.length = 0;
      redoStack.length = 0;
      lastKey = "";
      lastAt = 0;
      notify();
    },
  };
}

import { describe, it, expect, vi } from "vitest";
import { createHistory } from "../src/index";

/** 构造一个可被快照 / 还原的最小 state 容器 */
function makeCtx() {
  let value = 0;
  const snapshot = () => String(value);
  const restore = (json: string) => {
    value = Number(json);
  };
  return {
    snapshot,
    restore,
    get value() {
      return value;
    },
    set(n: number) {
      value = n;
    },
  };
}

describe("createHistory", () => {
  it("wrap 只对 tracked 记账，undo/redo 还原快照", () => {
    const ctx = makeCtx();
    const h = createHistory({ tracked: ["inc", "setN"], snapshot: ctx.snapshot, restore: ctx.restore });
    const raw = {
      inc(by: number) {
        ctx.set(ctx.value + by);
        return ctx.value;
      },
      setN(n: number) {
        ctx.set(n);
      },
      noop() {
        return 42;
      },
    };
    const a = h.wrap(raw);

    expect(a.noop()).toBe(42); // 未追踪：原样透传
    a.inc(1); // 0 -> 1（记账：栈存 "0"）
    a.inc(2); // 1 -> 3（指纹 inc|1 vs inc|2 不同 ⇒ 新起一步）
    expect(ctx.value).toBe(3);
    expect(h.depth()).toEqual({ undo: 2, redo: 0 });

    expect(h.undo()).toBe(true);
    expect(ctx.value).toBe(1);
    expect(h.undo()).toBe(true);
    expect(ctx.value).toBe(0);
    expect(h.undo()).toBe(false);

    expect(h.redo()).toBe(true);
    expect(ctx.value).toBe(1);
    expect(h.redo()).toBe(true);
    expect(ctx.value).toBe(3);
  });

  it("相同指纹在合并窗口内并成一步", () => {
    const ctx = makeCtx();
    const h = createHistory({
      tracked: ["inc"],
      snapshot: ctx.snapshot,
      restore: ctx.restore,
      coalesceMs: 5000,
    });
    const a = h.wrap({
      inc(by: number) {
        ctx.set(ctx.value + by);
      },
    });
    a.inc(1);
    a.inc(1);
    a.inc(1); // 同指纹 inc|1 ⇒ 合并
    expect(h.depth().undo).toBe(1);
    h.undo();
    expect(ctx.value).toBe(0);
  });

  it("batch 把多笔写操作并成一步；嵌套以最外层为准", () => {
    const ctx = makeCtx();
    const h = createHistory({ tracked: ["inc"], snapshot: ctx.snapshot, restore: ctx.restore });
    const a = h.wrap({
      inc(by: number) {
        ctx.set(ctx.value + by);
      },
    });
    h.batch(() => {
      a.inc(1);
      a.inc(2); // 内层被并入最外层
    });
    expect(h.depth().undo).toBe(1);
    expect(ctx.value).toBe(3);
    h.undo();
    expect(ctx.value).toBe(0);
  });

  it("batchAsync 在 await 之后才结算", async () => {
    const ctx = makeCtx();
    const h = createHistory({ tracked: ["inc"], snapshot: ctx.snapshot, restore: ctx.restore });
    const a = h.wrap({
      inc(by: number) {
        ctx.set(ctx.value + by);
      },
    });
    await h.batchAsync(async () => {
      a.inc(1);
      await new Promise((r) => setTimeout(r, 5));
      a.inc(2);
    });
    expect(h.depth().undo).toBe(1);
    expect(ctx.value).toBe(3);
    h.undo();
    expect(ctx.value).toBe(0);
  });

  it("无变化的操作不入栈；新分支使 redo 栈失效；onChange 触发", () => {
    const ctx = makeCtx();
    const onChange = vi.fn();
    const h = createHistory({ tracked: ["setN"], snapshot: ctx.snapshot, restore: ctx.restore, onChange });
    const a = h.wrap({
      setN(n: number) {
        ctx.set(n);
      },
    });
    a.setN(0); // 无变化（快照相同）⇒ 不入栈
    expect(h.depth().undo).toBe(0);
    a.setN(1);
    h.undo();
    expect(h.canRedo()).toBe(true);
    a.setN(2); // 新编辑使 redo 失效
    expect(h.canRedo()).toBe(false);
    expect(onChange).toHaveBeenCalled();
  });

  it("limit 限制栈深；clear 清空", () => {
    const ctx = makeCtx();
    const h = createHistory({ tracked: ["setN"], snapshot: ctx.snapshot, restore: ctx.restore, limit: 2, coalesceMs: 0 });
    const a = h.wrap({
      setN(n: number) {
        ctx.set(n);
      },
    });
    a.setN(1);
    a.setN(2);
    a.setN(3); // 超过 limit=2 ⇒ 最旧一步被丢弃
    expect(h.depth().undo).toBe(2);
    h.clear();
    expect(h.depth()).toEqual({ undo: 0, redo: 0 });
    expect(h.canUndo()).toBe(false);
  });

  it("restore 抛错时保留原历史栈", () => {
    const ctx = makeCtx();
    const h = createHistory({
      tracked: ["setN"],
      snapshot: ctx.snapshot,
      restore: () => { throw new Error("restore failed"); },
    });
    const a = h.wrap({ setN(n: number) { ctx.set(n); } });
    a.setN(1);
    expect(() => h.undo()).toThrow("restore failed");
    expect(ctx.value).toBe(1);
    expect(h.depth()).toEqual({ undo: 1, redo: 0 });
    expect(h.canUndo()).toBe(true);
    expect(h.canRedo()).toBe(false);
  });
});

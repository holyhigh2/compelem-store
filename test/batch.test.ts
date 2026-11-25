import { describe, it, expect, vi } from "vitest";
import { createStore } from "../src/index";
import type { StoreMutation } from "../src/types";

/** 每个用例独立一份 store：createStore 不进注册表，同 id 可重复建 */
function makeStore(id: string) {
  return createStore({
    id,
    state: () => ({ a: 0, b: 0, list: [] as number[] }),
  });
}

function track(store: any) {
  const got: StoreMutation[] = [];
  store.subscribe((m: StoreMutation) => got.push(m));
  return got;
}

describe("batch", () => {
  it("同一路径多次写只通知一次，oldValue 取首次、newValue 取末次", () => {
    const s = makeStore("batch-same");
    const got = track(s);
    s.batch(() => {
      s.a = 1;
      s.a = 2;
      s.a = 3;
    });
    expect(got.length).toBe(1);
    expect(got[0].key.endsWith(".a")).toBe(true);
    expect(got[0].oldValue).toBe(0);
    expect(got[0].newValue).toBe(3);
  });

  it("不同路径各通知一条，顺序取首次出现序", () => {
    const s = makeStore("batch-multi");
    const got = track(s);
    s.batch(() => {
      s.b = 1;
      s.a = 1;
      s.b = 2;
      s.a = 2;
    });
    expect(got.map(m => m.key.split(".").pop())).toEqual(["b", "a"]);
    expect(got.map(m => m.newValue)).toEqual([2, 2]);
  });

  it("嵌套 batch 只在外层结束时派发一次", () => {
    const s = makeStore("batch-nested");
    const got = track(s);
    s.batch(() => {
      s.a = 1;
      s.batch(() => {
        s.b = 2;
        s.a = 2;
      });
      s.a = 3;
    });
    expect(got.length).toBe(2);
    expect(got.find(m => m.key.endsWith(".a"))!.newValue).toBe(3);
    expect(got.find(m => m.key.endsWith(".b"))!.newValue).toBe(2);
  });

  it("fn 返回值透传", () => {
    const s = makeStore("batch-ret");
    expect(s.batch(() => 42)).toBe(42);
    expect(s.batch(() => "x")).toBe("x");
  });

  it("回调拿到的快照是本批最终态", () => {
    const s = makeStore("batch-snapshot");
    const seen: Record<string, any>[] = [];
    s.subscribe((_m: StoreMutation, snap: Record<string, any>) => seen.push({ ...snap }));
    s.batch(() => {
      s.a = 1;
      s.b = 2;
    });
    expect(seen.length).toBe(2);
    expect(seen[0].a).toBe(1);
    expect(seen[0].b).toBe(2); // 同一条快照，含本批全部结果
  });

  it("fn 抛出时仍派发已产生的变更，并保留异常", () => {
    const s = makeStore("batch-throw");
    const got = track(s);
    expect(() =>
      s.batch(() => {
        s.a = 1;
        throw new Error("boom");
      })
    ).toThrow("boom");
    expect(got.length).toBe(1);
    expect(got[0].newValue).toBe(1);
  });

  it("非 batch 行为不变：连续两次写产生两条通知", () => {
    const s = makeStore("batch-off");
    const got = track(s);
    s.a = 1;
    s.a = 2;
    expect(got.length).toBe(2);
    expect(got[0].newValue).toBe(1);
    expect(got[1].newValue).toBe(2);
  });

  it("batch 内数组 mutator 也按路径合并", () => {
    const s = makeStore("batch-array");
    const got = track(s);
    s.list = [1];
    got.length = 0;
    s.batch(() => {
      s.list.push(2);
      s.list.push(3);
    });
    expect(got.length).toBe(1);
    expect(s.list).toEqual([1, 2, 3]);
  });

  it("非函数入参安全返回 undefined，不进入 batch 状态", () => {
    const s = makeStore("batch-bad");
    const got = track(s);
    expect((s as any).batch(123)).toBeUndefined();
    // batchDepth 未被污染：后续写入仍是即时通知
    s.a = 1;
    expect(got.length).toBe(1);
  });

  it("字面点号键与嵌套路径不会合并", () => {
    const s = createStore({
      id: "batch-dotted-key",
      state: () => ({ nested: { value: 0 }, "nested.value": 0 }),
    });
    const got = track(s);
    s.batch(() => {
      s.nested.value = 1;
      s["nested.value"] = 2;
    });
    expect(got).toHaveLength(2);
    expect(got.map(m => m.chain)).toEqual([
      ["__ce_store_batch_dotted_key", "nested", "value"],
      ["__ce_store_batch_dotted_key", "nested.value"],
    ]);
    expect(got.map(m => [m.oldValue, m.newValue])).toEqual([[0, 1], [0, 2]]);
  });

  it("监听器重入写入按真实顺序排队，不发出倒退通知", () => {
    const s = createStore({ id: "batch-reentrant", state: () => ({ a: 0, b: 0 }) });
    const got: StoreMutation[] = [];
    s.subscribe(m => {
      got.push(m);
      if (m.key.endsWith(".a")) s.b = 2;
    });
    s.batch(() => {
      s.a = 1;
      s.b = 1;
    });
    expect(got.map(m => [m.key.split(".").pop(), m.oldValue, m.newValue])).toEqual([
      ["a", 0, 1],
      ["b", 0, 1],
      ["b", 1, 2],
    ]);
  });

  it("监听器无限重入会被预算终止并告警", () => {
    const s = makeStore("batch-reentrant-budget");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    let reenter = true;
    s.subscribe(m => {
      calls++;
      if (reenter && m.key.endsWith(".a")) s.a = s.a;
    });
    try {
      s.batch(() => { s.a = 1; });
      expect(calls).toBeGreaterThan(1);
      expect(calls).toBeLessThan(200);
      expect(warn).toHaveBeenCalledWith(
        "[CompElem]",
        expect.stringContaining("batch exceeded 100 reentrant rounds")
      );
      reenter = false;
      const before = calls;
      s.a = 2;
      expect(calls).toBe(before + 1);
    } finally {
      warn.mockRestore();
    }
  });

  it("回调退订再订阅不会在同一条通知内重复调用", () => {
    const s = makeStore("batch-listener-snapshot");
    let calls = 0;
    let off = () => {};
    const cb = () => {
      calls++;
      if (calls === 1) {
        off();
        off = s.subscribe(cb);
      }
    };
    off = s.subscribe(cb);
    s.a = 1;
    expect(calls).toBe(1);
    s.a = 2;
    expect(calls).toBe(2);
  });
});

import { describe, it, expect, beforeAll, vi } from "vitest";
import { defineComponents, effect, flushSync } from "compelem";
import { defineStore, createStore, getStoreById, useStore } from "../src/index";
import { counterStore, themeStore, todoStore } from "./stores";
import { CounterPanel, CounterBadge, GetterOnly, ThemePanel, TodoApp } from "./components";

const wait = (ms = 60) => new Promise(r => setTimeout(r, ms));

// ===================================================================
// 组件响应式：挂载真实组件，变更 store 后断言 shadowRoot 文本更新。
// compelem >=0.30 组件经信号依赖图自动订阅 store（模板 point effect 读
// facade 属性即建立订阅），不再经 _notify 管线。
// ===================================================================
describe("component reactivity", () => {
  const captured: any[] = [];

  beforeAll(async () => {
    // 触发 @tag 装饰器注册并定义自定义元素
    void [CounterPanel, CounterBadge, GetterOnly, ThemePanel, TodoApp];
    defineComponents();
    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <ce-counter-panel></ce-counter-panel>
      <ce-counter-badge></ce-counter-badge>
      <ce-getter-only></ce-getter-only>
      <ce-theme-panel></ce-theme-panel>
      <ce-todo-app></ce-todo-app>
    `;
    document.body.appendChild(wrap);
    counterStore.subscribe(m => captured.push(m));
    await wait(150);
  });

  it("components mount & register as custom elements", () => {
    for (const sel of ["ce-counter-panel", "ce-counter-badge", "ce-getter-only", "ce-theme-panel", "ce-todo-app"]) {
      const el = document.querySelector(sel) as any;
      expect(el).toBeTruthy();
      expect(el.shadowRoot).toBeTruthy();
    }
  });

  it("store change propagates to subscribed component (DOM update)", async () => {
    counterStore.inc(); // count 0 -> 1
    await wait();
    const panel = document.querySelector("ce-counter-panel") as any;
    expect(panel.shadowRoot.textContent).toContain("count = 1");
    expect(panel.shadowRoot.textContent).toContain("double: 2");
  });

  it("getter-only component also subscribes (double getter)", async () => {
    counterStore.inc(); // count 1 -> 2
    await wait();
    const el = document.querySelector("ce-getter-only") as any;
    expect(el.shadowRoot.textContent).toContain("double: 4");
  });

  it("theme store change propagates to theme component", async () => {
    themeStore.mode = "dark"; // light -> dark
    await wait();
    const el = document.querySelector("ce-theme-panel") as any;
    expect(el.shadowRoot.textContent).toContain("mode: dark");
  });

  it("todo add propagates to todo component", async () => {
    const len0 = todoStore.items.length;
    todoStore.add("selftest item");
    await wait();
    expect(todoStore.items.length).toBeGreaterThanOrEqual(4);
    const el = document.querySelector("ce-todo-app") as any;
    expect(el.shadowRoot.textContent).toContain("selftest item");
  });

  it("subscribe-fired (subscribe receives mutation)", () => {
    expect(captured.some(m => m.key.includes("count"))).toBe(true);
  });

  it("explicit connect refreshes once per batch and disconnect stops it", () => {
    const s = createStore({ id: "connect-explicit", state: () => ({ value: 0 }) });
    const panel = document.querySelector("ce-counter-panel") as any;
    const update = vi.spyOn(panel, "forceUpdate");
    s.connect(panel);
    s.batch(() => {
      s.value = 1;
      s.value = 2;
    });
    expect(update).toHaveBeenCalledTimes(1);
    s.disconnect(panel);
    update.mockClear();
    s.value = 3;
    expect(update).not.toHaveBeenCalled();
    update.mockRestore();
  });

  it("temporarily disconnected components keep their explicit subscription", () => {
    const s = createStore({ id: "connect-reconnect", state: () => ({ value: 0 }) });
    const panel = document.querySelector("ce-counter-panel") as any;
    const parent = panel.parentElement;
    const update = vi.spyOn(panel, "forceUpdate");
    try {
      s.connect(panel);
      panel.remove();
      update.mockClear();
      s.value = 1;
      expect(update).not.toHaveBeenCalled();
      parent.appendChild(panel);
      update.mockClear();
      s.value = 2;
      expect(update).toHaveBeenCalledTimes(1);
    } finally {
      if (!panel.isConnected) parent.appendChild(panel);
      s.disconnect(panel);
      update.mockRestore();
    }
  });
});

// ===================================================================
// 纯 store API（不依赖组件渲染）：订阅值 / 幂等注册 / getStoreById / useStore
// ===================================================================
describe("store API", () => {
  it("subscribe: key / snapshot / oldValue-distinct", () => {
    const s = defineStore({ id: "sub-test", state: () => ({ count: 0 }) });
    const rec: any[] = [];
    // subscribe 回调签名为 (mutation, snapshot) —— snapshot 是第二个参数
    s.subscribe((m, snap) => rec.push({ m, snap }));
    s.count = 100; // ov 0
    s.count = 11; // ov 100
    s.count = 22; // ov 11

    expect(rec[0].m.key).toBe("__ce_store_sub_test.count");
    expect(Object.keys(rec[0].snap).sort()).toEqual(Object.keys(s.state).sort());
    expect(rec[1].m).toMatchObject({ newValue: 11, oldValue: 100 });
    expect(rec[2].m).toMatchObject({ newValue: 22, oldValue: 11 });
    expect(rec[1].m.newValue !== rec[1].m.oldValue).toBe(true);
    expect(rec[2].m.newValue !== rec[2].m.oldValue).toBe(true);
  });

  it("unsubscribe stops delivery", () => {
    const s = defineStore({ id: "unsub", state: () => ({ n: 0 }) });
    let calls = 0;
    const unsub = s.subscribe(() => calls++);
    s.n = 1;
    expect(calls).toBe(1);
    unsub();
    s.n = 2;
    expect(calls).toBe(1); // 退订后不再触发
  });

  it("getStoreById returns same facade / miss", () => {
    expect(getStoreById("counter")).toBe(counterStore);
    expect(getStoreById("nope")).toBeUndefined();
  });

  it("dup defineStore warns and returns existing (counter)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = counterStore;
    a.count = 23;
    const b = defineStore({ id: "counter", state: () => ({ count: 0, step: 1 }) });
    expect(b).toBe(a);
    expect(b.count).toBe(23); // 既有实例，状态不被覆盖
    expect(warn).toHaveBeenCalledWith(
      "[CompElem]",
      expect.stringContaining("store 'counter' is already defined")
    );
    warn.mockRestore();
  });

  it("dup defineStore warns and returns existing (theme)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = themeStore;
    const b = defineStore({ id: "theme", state: () => ({ mode: "light", primaryColor: "#4a90d9" }) });
    expect(b).toBe(a);
    expect(warn).toHaveBeenCalledWith(
      "[CompElem]",
      expect.stringContaining("store 'theme' is already defined")
    );
    warn.mockRestore();
  });

  it("useStore missing id warns and returns undefined", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = useStore("nope", {} as any);
    expect(r).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "[CompElem]",
      expect.stringContaining("no store registered with id 'nope'")
    );
    warn.mockRestore();
  });
});

describe('deep reactive: array mutator notifies template effects (2026-10-15 fix)', () => {
  it('push/splice re-run effects that read the array', () => {
    const s = defineStore({ id: 'arr-push-test', state: () => ({ list: [1, 2] as number[] }) });
    let runs = 0;
    let lastLen = -1;
    const e = effect(() => {
      runs++;
      lastLen = s.list.length;
    });
    expect(lastLen).toBe(2);
    s.list.push(3);
    flushSync();
    expect(runs).toBeGreaterThanOrEqual(2);
    expect(lastLen).toBe(3);
    s.list.splice(0, 1);
    flushSync();
    expect(lastLen).toBe(2);
    e.dispose();
  });

  it('nested plain set does NOT force template re-run (by design)', () => {
    const s = defineStore({
      id: 'nested-set-test',
      state: () => ({ obj: { text: 'a' } }),
    });
    let runs = 0;
    const e = effect(() => {
      void s.obj;
      runs++;
    });
    s.obj.text = 'b';
    flushSync();
    // 嵌套属性写只广播 listeners，不触发读者重跑（宿主画布依赖此语义）
    expect(runs).toBe(1);
    e.dispose();
  });
});

describe('audit regressions', () => {
  it('dynamic __proto__ and constructor keys cannot pollute prototypes', () => {
    const s = createStore({ id: 'safe-dynamic-keys', state: () => ({ safe: 0 }) });
    try {
      (s as any).__proto__ = { auditPolluted: true };
      (s as any).constructor = 'state value';
      expect(({} as any).auditPolluted).toBeUndefined();
      expect(({} as any).constructor).toBe(Object);
      expect((s as any).__proto__).toEqual({ auditPolluted: true });
      expect((s as any).constructor).toBe('state value');
    } finally {
      delete (Object.prototype as any).auditPolluted;
    }
  });

  it('nested proxies do not expose or mutate prototypes', () => {
    const s = createStore({ id: 'safe-nested-keys', state: () => ({ obj: { x: 1 }, list: [1] }) });
    expect((s.obj as any).__proto__).toBeUndefined();
    expect((s.obj as any).constructor).toBeUndefined();
    expect((s.list as any).__proto__).toBeUndefined();
    expect(() => { (s.obj as any).__proto__.auditNestedPolluted = true; }).toThrow(TypeError);
    expect(({} as any).auditNestedPolluted).toBeUndefined();
    (s.obj as any).__proto__ = { auditNestedOwn: true };
    expect(Object.getPrototypeOf(s.obj)).toBe(Object.prototype);
    expect((s.obj as any).__proto__).toEqual({ auditNestedOwn: true });
  });

  it('frozen nested objects respect Proxy invariants and failed writes do not broadcast', () => {
    const child = Object.freeze({ x: 1 });
    const frozen = Object.freeze({ child, value: 1 });
    const s = createStore({ id: 'frozen-nested', state: () => ({ frozen }) });
    const seen: any[] = [];
    s.subscribe(m => seen.push(m));
    expect(s.frozen.child).toBe(child);
    expect(() => { (s.frozen as any).value = 2; }).toThrow(TypeError);
    expect(() => { delete (s.frozen as any).value; }).toThrow(TypeError);
    expect(() => { (s.frozen as any).extra = 1; }).toThrow(TypeError);
    expect(seen).toHaveLength(0);
  });

  it('top-level enumeration and in track shape changes', () => {
    const s = createStore({ id: 'shape-enumeration', state: () => ({ fixed: 1 }) });
    let keyRuns = 0;
    let hasRuns = 0;
    const keys = effect(() => {
      keyRuns++;
      void Object.keys(s.state);
    });
    const present = effect(() => {
      hasRuns++;
      void ('optional' in s.state);
    });
    (s as any).optional = 2;
    flushSync();
    expect([keyRuns, hasRuns]).toEqual([2, 2]);
    delete (s as any).optional;
    flushSync();
    expect([keyRuns, hasRuns]).toEqual([3, 3]);
    keys.dispose();
    present.dispose();
  });

  it('signal-backed getter changes do not invalidate twice', () => {
    const s = createStore({
      id: 'getter-single-invalidation',
      state: () => ({ count: 1, list: [1, 2] }),
      getters: {
        double: state => state.count * 2,
        sum: state => state.list.reduce((a, b) => a + b, 0),
      },
    });
    let doubleRuns = 0;
    let sumRuns = 0;
    const doubled = effect(() => { doubleRuns++; void s.double; });
    const summed = effect(() => { sumRuns++; void s.sum; });
    s.count = 2;
    flushSync();
    expect(doubleRuns).toBe(2);
    s.list[0] = 9;
    flushSync();
    expect(sumRuns).toBe(2);
    doubled.dispose();
    summed.dispose();
  });

  it('patch, reset and facade writes cannot inject reserved members', () => {
    let valid = true;
    const s = createStore({ id: 'reserved-dynamic', state: (): any => valid ? { value: 1 } : { value: 2, batch: 3 } });
    s.value = 7;
    expect(() => s.patch({ value: 8, batch: 3 } as any)).toThrow('conflicts with a store method');
    expect(s.value).toBe(7);
    valid = false;
    expect(() => s.reset()).toThrow('conflicts with a store method');
    expect(s.value).toBe(7);
    expect(() => { (s as any).batch = 1; }).toThrow(TypeError);
    expect(() => { (s as any).state = {}; }).toThrow(TypeError);
    expect(Object.keys(s)).toEqual(['value']);
  });

  it('action this supports calls to other actions and getters', () => {
    const s = defineStore({
      id: 'typed-actions',
      state: () => ({ count: 1 }),
      getters: { double: state => state.count * 2 },
      actions: {
        inc() { this.count++; },
        twice() { this.inc(); this.inc(); return this.double; },
      },
    });
    const result: number = s.twice();
    expect(result).toBe(6);
  });

  it('nested writes, array index/length writes and deletion invalidate getters', () => {
    const s = createStore({
      id: 'getter-invalidation',
      state: () => ({ obj: { x: 1 }, list: [1, 2], extra: 1 }),
      getters: {
        nested: state => state.obj.x,
        sum: state => state.list.reduce((a, b) => a + b, 0),
        length: state => state.list.length,
        extraValue: state => state.extra,
      },
    });
    expect([s.nested, s.sum, s.length, s.extraValue]).toEqual([1, 3, 2, 1]);
    s.obj.x = 2;
    expect(s.nested).toBe(2);
    s.list[0] = 9;
    expect(s.sum).toBe(11);
    s.list.length = 1;
    expect(s.length).toBe(1);
    delete (s as any).extra;
    expect(s.extraValue).toBeUndefined();
  });

  it('top-level key addition and deletion invalidate shape readers', () => {
    const s = createStore({ id: 'shape-invalidation', state: () => ({ fixed: 1 }) });
    let runs = 0;
    let value: unknown;
    const e = effect(() => {
      runs++;
      value = (s as any).optional;
    });
    expect(runs).toBe(1);
    (s as any).optional = 2;
    flushSync();
    expect(runs).toBe(2);
    expect(value).toBe(2);
    delete (s as any).optional;
    flushSync();
    expect(runs).toBe(3);
    expect(value).toBeUndefined();
    e.dispose();
  });

  it('array index assignment invalidates effects that read the array', () => {
    const s = createStore({ id: 'array-index-invalidation', state: () => ({ list: [1, 2] }) });
    let first = 0;
    const e = effect(() => { first = s.list[0]; });
    s.list[0] = 9;
    flushSync();
    expect(first).toBe(9);
    e.dispose();
  });

  it('Date, Map and Set keep their built-in receivers', () => {
    const s = createStore({
      id: 'builtin-values',
      state: () => ({
        date: new Date('2020-01-01T00:00:00Z'),
        map: new Map([['a', 1]]),
        set: new Set([1]),
      }),
    });
    expect(s.date.toISOString()).toBe('2020-01-01T00:00:00.000Z');
    expect(s.map.get('a')).toBe(1);
    expect(s.set.has(1)).toBe(true);
  });

  it('reset rejects an invalid factory result without changing state', () => {
    let valid = true;
    const s = createStore({ id: 'reset-validation', state: (): any => valid ? { value: 1 } : [] });
    s.value = 2;
    valid = false;
    expect(() => s.reset()).toThrow('state must be a plain object');
    expect(s.value).toBe(2);
  });

  it('state, getter and action names cannot shadow store members', () => {
    expect(() => createStore({ id: 'reserved-state', state: () => ({ patch: 1 }) })).toThrow('conflicts with a store method');
    expect(() => createStore({ id: 'reserved-getter', state: () => ({ value: 1 }), getters: { value: s => s.value } })).toThrow('conflicts with an existing member');
    expect(() => createStore({ id: 'reserved-action', state: () => ({ value: 1 }), actions: { batch() {} } })).toThrow('conflicts with an existing member');
  });

  it('useStore string form exposes typed state properties', () => {
    const readCount = (comp: any) => {
      const store = useStore('counter', comp);
      const count: number = store.count;
      return count.toFixed();
    };
    expect(readCount).toBeTypeOf('function');
  });

  it('getStoreById exposes typed state properties', () => {
    const found = getStoreById('counter');
    if (found) {
      const count: number = found.count;
      expect(count).toBeTypeOf('number');
      expect(found.count.toFixed()).toBeTypeOf('string');
    }
  });
});

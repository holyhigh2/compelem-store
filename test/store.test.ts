import { describe, it, expect, beforeAll, vi } from "vitest";
import { defineComponents } from "compelem";
import { defineStore, getStoreById, useStore } from "../src/index";
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

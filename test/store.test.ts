import { describe, it, expect, beforeAll, vi } from "vitest";
import { defineComponents } from "compelem";
import { defineStore, getStoreById, useStore } from "../src/index";
import { counterStore, themeStore, todoStore } from "./stores";
import { CounterPanel, CounterBadge, GetterOnly, ThemePanel, TodoApp } from "./components";

const wait = (ms = 60) => new Promise(r => setTimeout(r, ms));

// ===================================================================
// 组件响应式：挂载真实组件，断言 store 变更经 compelem-store 订阅管线
// 下发到组件实例（_notify(nv, ov, chain, subNV, subOV)）。
//
// 为何断言「组件被通知」而非「shadowRoot 文本」：
// compelem 的 h`` 模板基于 lit 风格「Part 标记」实现，在 happy-dom / jsdom
// 测试环境下绑定节点不会被提交成真实文本（@click 退化为 `2=""`、
// ${store.x} 退化为占位符 `⟬Ċ⟭N`），导致文本断言在两个环境都不可靠。
// 而组件「渲染期间读取 store 值 → 注册订阅 → store 变更时收到 _notify」
// 这一契约由 compelem-store 持有，与 DOM 文本渲染解耦，可稳定断言。
// （文本渲染属 compelem 渲染层职责，已在真实浏览器 demo 中验证：badge 0→1→100。）
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

  const notifySpy = (sel: string) => vi.spyOn(document.querySelector(sel) as any, "_notify");

  it("components mount & register as custom elements", () => {
    for (const sel of ["ce-counter-panel", "ce-counter-badge", "ce-getter-only", "ce-theme-panel", "ce-todo-app"]) {
      const el = document.querySelector(sel) as any;
      expect(el).toBeTruthy();
      expect(el.shadowRoot).toBeTruthy();
    }
  });

  it("store change propagates to subscribed component via _notify", async () => {
    const spy = notifySpy("ce-counter-panel");
    counterStore.inc(); // count 0 -> 1
    await wait();
    expect(spy).toHaveBeenCalled();
    const call: any = spy.mock.calls[0];
    expect(call[2]).toEqual(["__ce_store_counter", "count"]); // chain
    expect(call[3]).toBe(1); // subNewValue
    expect(call[4]).toBe(0); // subOldValue
    spy.mockRestore();
  });

  it("getter-only component also subscribes (double getter)", async () => {
    const spy = notifySpy("ce-getter-only");
    counterStore.inc(); // count 1 -> 2
    await wait();
    expect(spy).toHaveBeenCalled();
    const call: any = spy.mock.calls.find((c: any) => c[2] && c[2][1] === "count");
    expect(call).toBeTruthy();
    expect(call[3]).toBe(2); // subNewValue
    spy.mockRestore();
  });

  it("theme store change propagates to theme component", async () => {
    const spy = notifySpy("ce-theme-panel");
    themeStore.mode = "dark"; // light -> dark
    await wait();
    expect(spy).toHaveBeenCalled();
    const call: any = spy.mock.calls.find((c: any) => c[2] && c[2][1] === "mode");
    expect(call).toBeTruthy();
    expect(call[3]).toBe("dark");
    spy.mockRestore();
  });

  it("todo add propagates to todo component", async () => {
    const spy = notifySpy("ce-todo-app");
    const len0 = todoStore.items.length;
    todoStore.add("selftest item");
    await wait();
    expect(todoStore.items.length).toBe(len0 + 1);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
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

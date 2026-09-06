import { defineComponents } from "compelem";
import { counterStore, themeStore, todoStore } from "./stores";
import { CounterPanel, CounterBadge, GetterOnly, ThemePanel, TodoApp } from "./components";

// 注册组件（demo 入口；测试通过 test/components.ts 单独引入，不依赖本文件）
void [CounterPanel, CounterBadge, GetterOnly, ThemePanel, TodoApp];

// ---------------------------------------------------------------- subscribe log

const logEl = document.getElementById("sub-log")!;
let logLines: string[] = [];
counterStore.subscribe(mutation => {
  logLines.unshift(`[${new Date().toLocaleTimeString()}] ${mutation.key}: ${JSON.stringify(mutation.oldValue)} → ${JSON.stringify(mutation.newValue)}`);
  logLines = logLines.slice(0, 20);
  logEl.textContent = logLines.join("\n");
});

// ---------------------------------------------------------------- mount

defineComponents();

// ---------------------------------------------------------------- selftest (?selftest=1)
// 仅供自动化验证：对 store 做一系列变更，断言各订阅组件的 shadow DOM 同步更新，
// 结果写入 light DOM 的 <pre id="selftest-result"> 供 headless dump 读取。

async function runSelfTest() {
  const results: string[] = [];
  const assert = (name: string, cond: boolean, detail?: string) => {
    results.push(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  };
  const wait = (ms = 60) => new Promise(r => setTimeout(r, ms));
  const textOf = (sel: string) => document.querySelector(sel)?.shadowRoot?.textContent ?? "";
  const pre = document.createElement("pre");
  pre.id = "selftest-result";
  pre.style.display = "none";

  try {
    await wait(150);

    const counter = counterStore;
    const todos = todoStore;

    // 初始渲染
    assert("initial-render", textOf("ce-counter-panel").includes("count = 0"), textOf("ce-counter-panel"));
    assert("badge-initial", textOf("ce-counter-badge").includes(">0<") || /0/.test(textOf("ce-counter-badge")));

    // forEach 项内 checkbox 布尔特性初始状态（?checked 语法回归，原生元素不支持 .prop 绑定）
    const boxes = document.querySelector("ce-todo-app")!.shadowRoot!.querySelectorAll<HTMLInputElement>("li input[type=checkbox]");
    assert("todo-checkbox-initial", boxes.length >= 3 && boxes[0].checked && boxes[1].checked && !boxes[2].checked,
      JSON.stringify([...boxes].map(b => b.checked)));

    // 跨组件同步：action 修改 → 两个订阅组件同时更新
    counter.inc();
    await wait();
    assert("cross-sync-a", textOf("ce-counter-panel").includes("count = 1"), textOf("ce-counter-panel"));
    assert("cross-sync-b", textOf("ce-counter-badge").includes("1"), textOf("ce-counter-badge"));

    // getter
    assert("getter-double", textOf("ce-counter-panel").includes("2"), "double should be 2");

    // 只读 getter 的组件（render 期只读取 store.double，不读任何普通 state 键）
    // 在自动订阅修复后也应随 count 变化刷新
    assert("getter-only-updates", textOf("ce-getter-only").includes("2"), textOf("ce-getter-only"));

    // patch
    counter.patch({ count: 100 });
    await wait();
    assert("patch", textOf("ce-counter-badge").includes("100"), textOf("ce-counter-badge"));

    // defineStore 直接赋值 + reset
    themeStore.mode = "dark";
    await wait();
    assert("theme-set", textOf("ce-theme-panel").includes("dark"), textOf("ce-theme-panel"));
    themeStore.reset();
    await wait();
    assert("theme-reset", textOf("ce-theme-panel").includes("light"), textOf("ce-theme-panel"));

    // 数组 + forEach
    const len0 = todos.items.length;
    todos.add("selftest item");
    await wait();
    assert("todo-add", todos.items.length === len0 + 1 && textOf("ce-todo-app").includes("selftest item"));
    todos.toggle(todos.items[len0].id);
    await wait();
    assert("todo-toggle", todos.items[len0].done === true);
    // 程序性 toggle（元素未被点击过、无 dirty 标记）应同步到 checkbox UI
    const boxes2 = document.querySelector("ce-todo-app")!.shadowRoot!.querySelectorAll<HTMLInputElement>("li input[type=checkbox]");
    assert("todo-checkbox-toggle", boxes2[len0]?.checked === true, `checked=${boxes2[len0]?.checked}`);
    todos.remove(todos.items[len0].id);
    await wait();
    assert("todo-remove", todos.items.length === len0);

    // subscribe
    assert("subscribe-fired", document.getElementById("sub-log")!.textContent!.includes("count"));
  } catch (e: any) {
    results.push(`ERROR ${e?.message ?? e}\n${e?.stack ?? ""}`);
  }

  pre.textContent = "SELFTEST-BEGIN\n" + results.join("\n") + "\nSELFTEST-END";
  document.body.appendChild(pre);
}

if (new URLSearchParams(location.search).has("selftest")) {
  runSelfTest();
}

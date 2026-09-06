import { CompElem, css, forEach, h, tag } from "compelem";
import { counterStore, themeStore, todoStore, type TodoItem } from "./stores";

@tag("ce-counter-panel")
export class CounterPanel extends CompElem {
  render() {
    const store = counterStore;
    return h`
      <div>
        <p><strong>counter-panel</strong> — ${store.label}</p>
        <p>double: <code>${store.double}</code></p>
        <button @click=${() => store.inc()}>+${store.step}</button>
        <button @click=${() => store.dec()}>-${store.step}</button>
        <button @click=${() => store.setStep(store.step + 1)}>step +1</button>
        <button @click=${() => store.patch({ count: 100 })}>patch(100)</button>
      </div>
    `;
  }
}

@tag("ce-counter-badge")
export class CounterBadge extends CompElem {
  static css = css`
    .badge {
      display: inline-block;
      padding: 6px 14px;
      border-radius: 999px;
      background: #e6f1fb;
      border: 1px solid #85b7eb;
      font-weight: 500;
    }
  `;
  label = "badge";
  render() {
    const store = counterStore;
    return h`
      <div>
        <p><strong>${this.label}</strong></p>
        <span class="badge">${store.count}</span>
      </div>
    `;
  }
}

@tag("ce-getter-only")
export class GetterOnly extends CompElem {
  render() {
    // 仅读取 getter（store.double），不读任何普通 state 键。
    // 用于回归验证「只订阅 getter 的组件」在自动订阅修复后也能正确更新
    // （早期 bug：只读取 getter/action 的组件会在分派分支提前 return，永远拿不到订阅）。
    const store = counterStore;
    return h`
      <div>
        <p><strong>getter-only</strong>（只读 store.double，无普通 state 读取）</p>
        <p>double: <code>${store.double}</code></p>
        <button @click=${() => store.inc()}>+1</button>
      </div>
    `;
  }
}

@tag("ce-theme-panel")
export class ThemePanel extends CompElem {
  render() {
    const theme = themeStore;
    return h`
      <div>
        <p>mode: <code>${theme.mode}</code> · primaryColor: <code>${theme.primaryColor}</code></p>
        <button @click=${() => (theme.mode = theme.mode === "light" ? "dark" : "light")}>toggle mode</button>
        <button @click=${() => theme.patch({ primaryColor: "#d95a4a" })}>patch(color)</button>
        <button @click=${() => theme.reset()}>reset</button>
      </div>
    `;
  }
}

@tag("ce-todo-app")
export class TodoApp extends CompElem {
  static css = css`
    ul { list-style: none; padding: 0; margin: 8px 0; }
    li { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
    li.done span { text-decoration: line-through; color: #8c959f; }
    input { flex: 1; padding: 4px 8px; border: 1px solid #d0d7de; border-radius: 6px; }
  `;
  #inputText = "";
  render() {
    const store = todoStore;
    return h`
      <div>
        <input placeholder="new todo..." value=${this.#inputText}
          @input=${(e: Event) => { this.#inputText = (e.target as HTMLInputElement).value }} />
        <button @click=${() => { if (this.#inputText) { store.add(this.#inputText); this.#inputText = ""; this.forceUpdate() } }}>add</button>
        <ul>
          ${forEach(
            store.items,
            item => item.id,
            (item: TodoItem) => h`
              <li class=${item.done ? "done" : ""}>
                <input type="checkbox" ?checked=${item.done} @change=${() => store.toggle(item.id)} />
                <span>${item.text}</span>
                <button @click=${() => store.remove(item.id)}>x</button>
              </li>
            `
          )}
        </ul>
        <p>${store.items.filter(i => !i.done).length} 项未完成</p>
      </div>
    `;
  }
}

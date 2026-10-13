import { CompElem, css, forEach, h, tag } from "compelem";
import { counterStore, themeStore, todoStore, type TodoItem } from "./stores";

@tag("ce-counter-panel")
export class CounterPanel extends CompElem {
  render() {
    return h`
      <div>
        <p><strong>counter-panel</strong> — ${counterStore.label}</p>
        <p>double: <code>${counterStore.double}</code></p>
        <button @click=${() => counterStore.inc()}>+${counterStore.step}</button>
        <button @click=${() => counterStore.dec()}>-${counterStore.step}</button>
        <button @click=${() => counterStore.setStep(counterStore.step + 1)}>step +1</button>
        <button @click=${() => counterStore.patch({ count: 100 })}>patch(100)</button>
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
    return h`
      <div>
        <p><strong>${this.label}</strong></p>
        <span class="badge">${counterStore.count}</span>
      </div>
    `;
  }
}

@tag("ce-getter-only")
export class GetterOnly extends CompElem {
  render() {
    return h`
      <div>
        <p><strong>getter-only</strong>（只读 store.double，无普通 state 读取）</p>
        <p>double: <code>${counterStore.double}</code></p>
        <button @click=${() => counterStore.inc()}>+1</button>
      </div>
    `;
  }
}

@tag("ce-theme-panel")
export class ThemePanel extends CompElem {
  render() {
    return h`
      <div>
        <p>mode: <code>${themeStore.mode}</code> · primaryColor: <code>${themeStore.primaryColor}</code></p>
        <button @click=${() => (themeStore.mode = themeStore.mode === "light" ? "dark" : "light")}>toggle mode</button>
        <button @click=${() => themeStore.patch({ primaryColor: "#d95a4a" })}>patch(color)</button>
        <button @click=${() => themeStore.reset()}>reset</button>
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
  #onInput(e: Event) {
    this.#inputText = (e.target as HTMLInputElement).value;
  }
  render() {
    return h`
      <div>
        <input placeholder="new todo..." value=${this.#inputText}
          @input=${this.#onInput} />
        <button @click=${() => { if (this.#inputText) { todoStore.add(this.#inputText); this.#inputText = ""; this.forceUpdate() } }}>add</button>
        <ul>
          ${forEach(
            todoStore.items,
            item => item.id,
            (item: TodoItem) => h`
              <li class=${item.done ? "done" : ""}>
                <input type="checkbox" ?checked=${item.done} @change=${() => todoStore.toggle(item.id)} />
                <span>${item.text}</span>
                <button @click=${() => todoStore.remove(item.id)}>x</button>
              </li>
            `
          )}
        </ul>
        <p>${todoStore.items.filter(i => !i.done).length} 项未完成</p>
      </div>
    `;
  }
}

import { defineStore } from "../src/index";

export const counterStore = defineStore({
  id: "counter",
  state: () => ({ count: 0, step: 1 }),
  getters: {
    double: s => s.count * 2,
    label: s => `count = ${s.count} (step ${s.step})`,
  },
  actions: {
    inc() { this.count += this.step },
    dec() { this.count -= this.step },
    setStep(step: number) { this.step = step },
  },
});

export const themeStore = defineStore({
  id: "theme",
  state: () => ({
    mode: "light",
    primaryColor: "#4a90d9",
  }),
});

export interface TodoItem { id: number; text: string; done: boolean }
export const todoStore = defineStore({
  id: "todos",
  state: () => ({
    items: [
      { id: 1, text: "review compelem reactive.ts", done: true },
      { id: 2, text: "design store architecture", done: true },
      { id: 3, text: "write compelem-store demo", done: false },
    ] as TodoItem[],
  }),
  actions: {
    add(text: string) {
      this.items = [...this.items, { id: Date.now(), text, done: false }];
    },
    toggle(id: number) {
      this.items = this.items.map((i: TodoItem) => i.id === id ? { ...i, done: !i.done } : i);
    },
    remove(id: number) {
      this.items = this.items.filter((i: TodoItem) => i.id !== id);
    },
  },
});

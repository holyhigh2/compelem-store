# CompElem Store

A state management for CompElem.


## Installation

```bash
npm install compelem-store
```

## Usage

### defineStore

```typescript
import { defineStore } from 'compelem-store';

// 完整形态：state / getters / actions
const counterStore = defineStore({
  id: 'counter',
  state: () => ({ count: 0, step: 1 }),
  getters: {
    double: (state) => state.count * 2,
  },
  actions: {
    inc() { this.count += this.step },   // this 即 store facade，直接读写 state
    setStep(step: number) { this.step = step },
  },
});

// 轻量形态：只给 state —— defineStore 直接返回可读写的 facade（无工厂、无调用括号）
const themeStore = defineStore({
  id: 'theme',
  state: () => ({ mode: 'light' }),
});
```

### Use in Component

```typescript
import { CompElem, tag, h } from 'compelem';
import { useStore } from 'compelem-store';

@tag('counter-view')
export class CounterView extends CompElem {
  render() {
    const store = counterStore;   // render 内读取即自动订阅，无需任何注册
    return h`<span>${store.count} / ${store.double}</span>
             <button @click=${() => store.inc()}>+1</button>`;
  }
}
```

在 render 之外（如 connectedCallback、事件回调中初始化）需要显式接入时：

```typescript
const store = useStore('counter', this);   // 或 useStore(counterStore, this)
// 或 counterStore.connect(this);
```

### Subscribe / Batch

```typescript
const unsubscribe = store.subscribe((mutation, snapshot) => {
  console.log(mutation.key, mutation.oldValue, '→', mutation.newValue);
});
store.patch({ count: 100 });
```

## API

| API | 说明 |
|---|---|
| `defineStore(options)` | 完整 store（state/getters/actions），同 id 单例；直接返回 facade 本体（轻量场景只给 state 即可） |
| `getStoreById(id)` | 按 id 取已注册 facade（undefined 表示未定义） |
| `disposeStore(id)` / `resetStores()` | 从注册表摘除 / 清空全部 store（测试隔离用） |
| `useStore(store, comp)` | 显式接入订阅（render 内读取已自动订阅，此形式用于 render 之外）；store 参数支持 facade / id 字符串，返回 facade |
| `store.state` | 响应式 state 代理 |
| `store.patch(partial)` | 批量更新 |
| `store.reset()` | 用 state() 工厂重新初始化（多余键移除） |
| `store.subscribe(cb)` | 手动监听，返回退订函数 |
| `store.connect(comp)` / `disconnect(comp)` | 手动接入/解除组件订阅 |

## Development

```bash
npm install
npm run dev          # demo（内置 ?selftest=1 自动化自检）
npm run typecheck    # tsc --noEmit
npm run build        # 库构建（ESM + UMD + d.ts + sourcemap）
```

## License

MIT

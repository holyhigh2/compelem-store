# CONTEXT.md - 项目上下文

## 项目背景

compelem-store 是为 compelem Web Components 框架设计的轻量级响应式全局状态管理库，提供类似 Pinia/Vuex 的状态管理能力。

## 核心概念

### Store 模型
- **defineStore**: 工厂函数，创建 store 实例
- **State**: 响应式状态，通过 compelem 的响应式系统实现
- **Getters**: 懒计算属性，带缓存
- **Actions**: 直接读写 state 的方法

### 订阅机制
- **懒加载订阅**: render 内读取即自动订阅
- **批量更新**: 状态变更按 tick 批量通知组件
- **WeakRef 管理**: 组件销毁后自动清理

## 文件依赖关系

```
index.ts
├── store.ts             # defineStore 核心实现
├── useStore.ts          # useStore 工具函数
├── types.ts             # 类型定义
└── utils.ts             # 工具函数
```

## 状态管理

### Store 注册表
- 同一 `id` 的 store 自动共享实例（单例模式）
- 重复定义返回现有实例并警告

### 响应式实现
- 基于 compelem 的 `createReactiveState`
- 所有写操作通过响应式代理
- 广播机制通知订阅组件

## 更新流程

1. 修改 store 状态（`store.count++`）
2. 响应式代理捕获变更
3. 触发 `requestUpdate`
4. 批量合并更新
5. 广播通知所有订阅组件
6. 组件重新渲染

## 订阅流程

1. 组件 render 内读取 store 属性
2. 自动调用 `getCurrentRenderComponent()`
3. 将组件加入订阅列表（WeakRef）
4. store 状态变更时通知组件
5. 组件销毁时自动清理

## 设计决策

### 为什么使用单例模式
- 全局状态应共享同一实例
- 避免状态不一致
- 简化使用方式

### 为什么使用懒加载订阅
- 无需手动注册/取消订阅
- render 内读取即自动订阅
- 基于 WeakRef，组件销毁后自动清理

### 为什么使用批量更新
- 减少不必要的重渲染
- 合并同一 tick 内的多次变更
- 提升性能

## 扩展性

- 支持自定义 state 工厂函数
- 支持 getters 懒计算
- 支持 actions 绑定 this
- 支持手动订阅/取消订阅
- 支持 store 重置

## 测试覆盖

测试应覆盖：
- store 定义和注册
- state 响应式更新
- getters 计算
- actions 执行
- 订阅/通知机制
- 批量更新
- 边界情况（重复定义、store 重置等）

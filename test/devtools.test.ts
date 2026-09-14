/**
 * compelem-store × devtools 接入点回归测试（`src/devtools.ts`）
 *
 * 覆盖：provider 注册、list/entry 元信息、state 读取、patch、action 调用、
 *       reset、subscribe 转发的 mutation 载荷、退订、resetStores 清理。
 *
 * 运行方式（在 compelem-store 仓库内）：`npx vitest run`
 *
 * 断言里的 key 前缀是实测取证项：链以 slotKey 为根，故 key 形如
 * `__ce_store_<id>.<stateKey>`，不是裸的 stateKey。
 */
import { describe, it, expect } from 'vitest'
import { defineStore, resetStores, disposeStore } from '../src/index'
import { ECOSYSTEM_KEY } from '../src/devtools'

const wait = (ms = 60) => new Promise(r => setTimeout(r, ms))

function provider() {
  return (globalThis as any)[ECOSYSTEM_KEY]?.store
}

describe('devtools 接入点', () => {
  it('T1 注册：provider 挂到 __COMPELEM_ECOSYSTEM__.store', () => {
    resetStores()
    // 命名空间在**模块加载期**就已挂上（见 devtools.ts 末尾的 provider()），
    // 因此这里不是 undefined，而是「库已加载、尚无实例」—— list() 为空
    expect(provider()).toBeTruthy()
    expect(provider().list()).toEqual([])

    defineStore({
      id: 'counter',
      state: () => ({ count: 0, step: 1 }),
      getters: { double: (s: any) => s.count * 2 },
      actions: {
        inc(this: any) { this.count += this.step },
        add(this: any, n: number) { this.count += n },
      },
    })

    const p = provider()
    expect(p).toBeTruthy()
    expect(typeof p.list).toBe('function')
    expect(typeof p.entry).toBe('function')
    expect(typeof p.subscribe).toBe('function')
    expect(p.list()).toEqual(['counter'])
  })

  it('T2 entry 元信息：facade 同源、getters/actions 可枚举、slotKey 正确', () => {
    const facade = defineStore({
      id: 'meta',
      state: () => ({ a: 1 }),
      getters: { twice: (s: any) => s.a * 2 },
      actions: { bump(this: any) { this.a++ } },
    })
    const e = provider().entry('meta')
    expect(e.facade).toBe(facade)                 // 同一 facade，不是副本
    expect(e.getters).toEqual(['twice'])          // facade ownKeys 拿不到 getter，必须登记
    expect(e.actions).toEqual(['bump'])
    expect(e.slotKey).toBe('__ce_store_meta')
  })

  it('T3 state 读取：Object.keys(facade) 只含 state，getter 值可读', () => {
    const facade: any = defineStore({
      id: 'read',
      state: () => ({ n: 3, label: 'x' }),
      getters: { triple: (s: any) => s.n * 3 },
      actions: { noop() {} },
    })
    expect(Object.keys(facade).sort()).toEqual(['label', 'n'])   // 不含 triple/noop
    expect(facade.n).toBe(3)
    expect(facade.triple).toBe(9)
    expect(provider().entry('read').getters).toContain('triple')
  })

  it('T4 patch 写入 + subscribe 转发的 mutation 载荷', async () => {
    const facade: any = defineStore({ id: 'mut', state: () => ({ count: 0, tag: '' }) })
    const seen: any[] = []
    const off = provider().subscribe('mut', (m: any, snap: any) => {
      seen.push({ mutation: m, snapshot: snap })
    })

    facade.patch({ count: 5 })
    await wait()

    expect(seen.length).toBeGreaterThanOrEqual(1)
    const m = seen[0].mutation
    // 实测取证：链以 slotKey 为根
    expect(m.key.endsWith('count')).toBe(true)
    expect(m.key.startsWith('__ce_store_mut')).toBe(true)
    expect(m.newValue).toBe(5)
    expect(m.oldValue).toBe(0)
    expect(Array.isArray(m.chain)).toBe(true)
    // snapshot 是浅快照：含当前全部 state 键
    expect(seen[0].snapshot.count).toBe(5)
    expect('tag' in seen[0].snapshot).toBe(true)

    off()
    const before = seen.length
    facade.patch({ count: 99 })
    await wait()
    expect(seen.length).toBe(before)               // 退订生效
  })

  it('T5 action 调用：this 绑定 facade、可传参、可累加', async () => {
    const facade: any = defineStore({
      id: 'act',
      state: () => ({ count: 1, step: 2 }),
      actions: {
        inc(this: any) { this.count += this.step },
        add(this: any, n: number) { this.count += n; return this.count },
      },
    })
    const seen: any[] = []
    provider().subscribe('act', (m: any) => seen.push(m))

    facade.inc()
    expect(facade.count).toBe(3)
    const rs = facade.add(10)
    expect(rs).toBe(13)
    expect(facade.count).toBe(13)
    await wait()
    expect(seen.length).toBeGreaterThanOrEqual(2)
  })

  it('T6 reset：状态回初始值', async () => {
    const facade: any = defineStore({ id: 'rst', state: () => ({ count: 0, name: 'init' }) })
    facade.patch({ count: 42, name: 'changed' })
    expect(facade.count).toBe(42)
    facade.reset()
    expect(facade.count).toBe(0)
    expect(facade.name).toBe('init')
    await wait()
    expect(provider().entry('rst')).toBeTruthy()
  })

  it('T7 浅快照限制取证：嵌套对象是共享引用，旧快照的深层值会被后续改动覆盖', async () => {
    const facade: any = defineStore({ id: 'shallow', state: () => ({ obj: { deep: 1 }, n: 0 }) })
    const snaps: any[] = []
    provider().subscribe('shallow', (_m: any, snap: any) => snaps.push(snap))

    facade.patch({ n: 1 })                       // 快照 A：obj 引用被共享
    await wait()
    const snapA = snaps[0]
    expect(snapA.obj.deep).toBe(1)

    facade.obj.deep = 2                          // 原地改深层字段
    await wait()
    // 浅快照只能回滚顶层；深层已被原地改写，旧快照跟着变 → 必须在 UI 上标注
    expect(snapA.obj.deep).toBe(2)
    expect(snapA.n).toBe(1)                      // 顶层标量是可靠的
  })

  it('T8 disposeStore / resetStores 同步摘除登记', () => {
    defineStore({ id: 'bye', state: () => ({ v: 1 }) })
    expect(provider().list()).toContain('bye')
    expect(disposeStore('bye')).toBe(true)
    expect(provider().list()).not.toContain('bye')

    resetStores()
    expect(provider().list()).toEqual([])
  })

  it('T9 重复 define 同 id 不产生重复登记，entry 指向既有 facade', () => {
    resetStores()
    const a = defineStore({ id: 'dup', state: () => ({ v: 1 }) })
    const b = defineStore({ id: 'dup', state: () => ({ v: 999 }) })
    expect(b).toBe(a)
    expect(provider().list()).toEqual(['dup'])
    expect(provider().entry('dup').facade).toBe(a)
  })

  it('T10 无 devtools 也不抛错：provider 缺失时调用方需自行降级', () => {
    const saved = (globalThis as any)[ECOSYSTEM_KEY]
    delete (globalThis as any)[ECOSYSTEM_KEY]
    // 重新注册会重建 provider，不应抛错
    expect(() => defineStore({ id: 'noeco', state: () => ({ ok: true }) })).not.toThrow()
    expect(provider()).toBeTruthy()
    ;(globalThis as any)[ECOSYSTEM_KEY] = saved
  })

  it('T11 区分「库未加载」与「库已加载无实例」：注册表清空后命名空间仍在', () => {
    // 面板右侧「未启用 compelem-store 依赖」的判定完全依赖这条契约：
    //   命名空间不存在       → 库没加载
    //   命名空间在、list() 空 → 库加载了但还没创建实例
    // 所以 provider 必须在模块加载期就挂上，而不是等到第一次 defineStore。
    resetStores()
    expect(provider()).toBeTruthy()
    expect(provider().list()).toEqual([])

    defineStore({ id: 'scoped', state: () => ({ n: 1 }) })
    expect(provider().list()).toEqual(['scoped'])

    resetStores()
    expect(provider()).toBeTruthy()      // 命名空间不随实例销毁而消失
    expect(provider().list()).toEqual([])
  })
})

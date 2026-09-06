# compelem-store — Agent Guide

A lightweight, reactive **global store** for [compelem](https://github.com/holyhigh2/compelem) Web Components (Pinia/Vuex-like, but framework-free and singleton-per-id).

## Tech stack

- **Vite 6** + **TypeScript** (legacy decorators: `experimentalDecorators: true`)
- **vite-plugin-dts** for `.d.ts` output
- Peer deps (kept `external` in the lib build): `compelem` `>=0.27.0`, `myfx` `^1.15.11` (only `has` / `isPlainObject` are used)
- Tests: **vitest 3** (`globals: true`) + **jsdom**

## Commands

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server on port **5173**; root `index.html` is the demo page, loading `/test/main.ts` |
| `npm run build` | Library build → `dist/` (ESM + UMD + d.ts, sourcemaps on) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | `vitest run` (jsdom) |
| `npm run preview` | Preview the built demo |

## Verifying changes

1. `npm run test` + `npm run typecheck` — fast checks, but see the jsdom gotcha below: vitest can only assert the **notification contract**, not rendered DOM text.
2. **Real-browser selftest**: `npm run dev`, open `http://localhost:5173/?selftest=1`. The page mutates every store and writes results into a hidden `<pre id="selftest-result">` appended to `document.body` (inspect the DOM / dump the page). Success = a `SELFTEST-BEGIN … SELFTEST-END` block where every line is `PASS` (no `FAIL` / `ERROR`). This is the **only** place DOM text rendering is asserted.

## Layout

- `src/` — library source: `index.ts` (public API), `store.ts` (the `defineStore` engine), `useStore.ts`, `types.ts`
- `test/` — demo entry `main.ts` (also runs the `?selftest=1` DOM self-check) + fixtures `stores.ts` (ids: `counter`, `theme`, `todos`) / `components.ts` + `store.test.ts`
- Fixtures are **shared** between the demo page and the tests — changing them affects both.

## Conventions & gotchas

- **Test environment is `jsdom`, NOT `happy-dom`.** compelem's `h\`\`` template (lit-style "Part" markers) does not commit interpolated bindings to real DOM text under either jsdom or happy-dom. Component tests therefore assert the **store→component notification contract** — `vi.spyOn(comp, '_notify')` then verify `_notify(nv, ov, chain, subNV, subOV)` fires with `chain = ["__ce_store_<id>", "<key>"]` and correct leaf `subNV`/`subOV`. Do **not** assert `shadowRoot.textContent` in vitest (that path is verified by the browser selftest above).
- **Mutation key format** (needed when asserting on `subscribe`): `mutation.key` is the full dotted path `"__ce_store_<sanitized-id>.<path>"` (e.g. `__ce_store_sub_test.count`) and `mutation.chain` is `["__ce_store_<id>", "<key>", ...]`. The slot key prefix comes from `sanitizeSlotKey(id)`: non-`[a-zA-Z0-9_$]` chars in the id are replaced with `_`.
- **Updates are batched per tick.** After mutating a store in tests, `await wait()` (~60 ms, see the helper in `store.test.ts`) before asserting `_notify` fired.
- **Registering components in tests**: import the decorated classes (`void [CounterPanel, ...]` to trigger `@tag`), then call `defineComponents()` **before** inserting elements into the DOM.
- `vite.config.ts` sets `optimizeDeps.exclude: ['compelem']`. compelem is patched directly in its working tree (symlinked into `node_modules`), and excluding it stops Vite's dep pre-bundle cache from serving a stale copy — a stale copy previously dropped the `_notify` sub-value passthrough and broke `subscribe` values.
- compelem's `showWarn` logs as `console.warn("[CompElem]", message)` (two args). Warn assertions must use `toHaveBeenCalledWith("[CompElem]", expect.stringContaining(...))`.
- `subscribe(cb)` callback signature is `cb(mutation, snapshot)` — `snapshot` is the **second** parameter, `mutation` carries `{ key, newValue, oldValue, chain }`. `newValue`/`oldValue` are the **leaf** values at the changed path (passed through by compelem's reactive layer), not the root state.
- All warnings/messages in this library go through compelem's `showWarn` and are prefixed `[compelem-store]`.

## How the engine works (`src/store.ts`)

- State is created via compelem's `createReactiveState(raw, host, slotKey)`. The `host` is a **plain object** whose `_notify` is set to the store's `broadcast` — NOT a headless CompElem (that older design leaked `#updateSources` unboundedly). All writes flow through the framework's reactive proxy → `requestUpdate` → `broadcast`.
- The store facade is a `Proxy` over the reactive state proxy. Its `get` trap: reads of store **methods** (`id`/`state`/`patch`/`reset`/`subscribe`/`connect`/`disconnect`) do not subscribe; reading **any other property (state key, getter, even an action reference)** during a component render auto-subscribes that component (`getCurrentRenderComponent()` → registry). This is what makes the getter-only demo component update.
- Subscribed components are held as `WeakRef`s and pruned on each broadcast when deref fails or `isDestroyed`/`isConnected` is falsy — no manual unsubscribe needed; `disconnect(comp)` removes one explicitly.
- Getters are lazily evaluated with a per-name cache invalidated by a `version` counter that `broadcast` increments on every change.
- The framework's reactive proxy has **no `deleteProperty` trap**, so `delete facade.key` and `reset()`'s removal of extra keys broadcast manually via `broadcast(undefined, old, [slotKey, key])`.
- Duplicate `defineStore` with the same id: returns the **existing** facade + warns; existing state is not overwritten. `state()` must return a plain object (throws otherwise).

## Library API (high level)

- `defineStore({ id, state, getters?, actions? })` → facade (singleton per `id`)
- facade reads/writes state directly (`store.count++`), getters are lazy (`store.double`), actions are `this`-bound (`store.inc()`)
- facade methods: `id`, `state` (the raw reactive proxy), `patch(partial)`, `reset()` (re-runs the `state` factory, removes extra keys), `subscribe(cb)` (returns unsubscribe fn), `connect(comp)`, `disconnect(comp)` (both idempotent)
- `useStore(store | "id", this)` — call **inside `render()`** with the component instance; string form warns + returns `undefined` if the id isn't registered. Reading the facade in render already auto-subscribes, so `useStore` is mainly for explicitness.
- `getStoreById(id)`, `disposeStore(id)`, `resetStores()` — registry utilities, mainly for **test isolation**. Caveat: components holding the old facade keep their subscriptions; redefining the same id while the old store is alive shares the same dependency-path root and causes cross-invalidation. Only use when no component references the old facade.

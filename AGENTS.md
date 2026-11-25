# compelem-store — Agent Guide

A lightweight, reactive **global store** for [compelem](https://github.com/holyhigh2/compelem) Web Components (Pinia/Vuex-like, but framework-free and singleton-per-id).

## Tech stack

- **Vite 6** + **TypeScript** (legacy decorators: `experimentalDecorators: true`)
- **vite-plugin-dts** for `.d.ts` output
- Peer deps (kept `external` in the lib build): `compelem` `>=0.30.0-beta.13`, `myfx` `>=2.0.0` (only `has` / `isPlainObject` are used)
- Tests: **vitest 3** (`globals: true`) + **jsdom**

## Commands

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server on port **5173**; root `index.html` is the demo page, loading `/test/main.ts` |
| `npm run build` | Library build → `dist/` (ESM + CJS + d.ts, sourcemaps on) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | `vitest run` (jsdom) |
| `npm run preview` | Preview the built demo |

## Verifying changes

1. `npm run test` + `npm run typecheck` — fast checks, but see the jsdom gotcha below: vitest can only assert the **notification contract**, not rendered DOM text.
2. **Real-browser selftest**: `npm run dev`, open `http://localhost:5173/?selftest=1`. The page mutates every store and writes results into a hidden `<pre id="selftest-result">` appended to `document.body` (inspect the DOM / dump the page). Success = a `SELFTEST-BEGIN … SELFTEST-END` block where every line is `PASS` (no `FAIL` / `ERROR`). This is the **only** place DOM text rendering is asserted.

## Layout

- `src/` — library source: `index.ts` (public API), `store.ts` (the `defineStore`/`createStore` engine), `useStore.ts`, `history.ts`, `devtools.ts`, `types.ts`
- `test/` — demo entry `main.ts` (also runs the `?selftest=1` DOM self-check) + fixtures `stores.ts` (ids: `counter`, `theme`, `todos`) / `components.ts` + `store.test.ts`
- Fixtures are **shared** between the demo page and the tests — changing them affects both.

## Conventions & gotchas

- **Test environment is `jsdom`, NOT `happy-dom`.** Current compelem commits interpolated bindings in jsdom, so component tests may assert `shadowRoot.textContent`; the browser selftest remains the authoritative end-to-end check. Explicit `connect` can be tested by spying on `CompElem.forceUpdate`.
- **Mutation key format** (needed when asserting on `subscribe`): `mutation.key` is the full dotted path `"__ce_store_<sanitized-id>.<path>"` (e.g. `__ce_store_sub_test.count`) and `mutation.chain` is `["__ce_store_<id>", "<key>", ...]`. The slot key prefix comes from `sanitizeSlotKey(id)`: non-`[a-zA-Z0-9_$]` chars in the id are replaced with `_`.
- **Updates are batched per tick.** After mutating a store in component tests, `await wait()` (~60 ms, see the helper in `store.test.ts`) before asserting DOM text. Plain `subscribe` callbacks are synchronous unless the write happens inside `store.batch`.
- **Registering components in tests**: import the decorated classes (`void [CounterPanel, ...]` to trigger `@tag`), then call `defineComponents()` **before** inserting elements into the DOM.
- `vite.config.ts` sets `optimizeDeps.exclude: ['compelem']` so Vite does not serve a stale pre-bundled development copy.
- compelem's `showWarn` logs as `console.warn("[CompElem]", message)` (two args). Warn assertions must use `toHaveBeenCalledWith("[CompElem]", expect.stringContaining(...))`.
- `subscribe(cb)` callback signature is `cb(mutation, snapshot)` — `snapshot` is the **second** parameter, `mutation` carries `{ key, newValue, oldValue, chain }`. `newValue`/`oldValue` are the **leaf** values at the changed path, not the root state.
- All warnings/messages in this library go through compelem's `showWarn` and are prefixed `[compelem-store]`.

## How the engine works (`src/store.ts`)

- Top-level state keys are compelem `signal`s held in a null-prototype `sigs` object. Nested arrays and plain objects use recursive proxies; class instances and built-ins such as `Date`/`Map`/`Set` are left untouched.
- The facade is a `Proxy` over the state proxy. Reading a state key or getter during render lets compelem's signal graph subscribe the component automatically. Explicit `connect` stores a `WeakRef` and broadcast calls `forceUpdate` after pruning destroyed/disconnected components.
- Getters are lazy `signalComputed` values. A dedicated getter-version signal is incremented on nested plain-object writes/delete, so those writes invalidate getters without forcing ordinary nested template effects; top-level and array changes use their own signals directly.
- A shape-version signal is read by top-level state reads and incremented only when keys are added/deleted. Arrays also have an object-level version signal for mutators, index/length assignment, and index deletion.
- `batch` merges subscriber notifications by an unambiguous JSON encoding of `chain`; reentrant writes are queued with a 100-round safety budget and listeners are iterated from a per-notification snapshot. Explicit component refreshes are coalesced at batch flush. It does not merge signal writes and only supports synchronous callbacks.
- Duplicate `defineStore` with the same id returns the existing facade + warns; existing state is not overwritten. Both initial creation and `reset()` require `state()` to return a plain object. State/getter/action names may not collide with store methods or with each other.

## Library API (high level)

- `defineStore({ id, state, getters?, actions? })` → facade (singleton per `id`)
- `createStore(options)` → non-singleton facade for isolated instances
- facade reads/writes state directly (`store.count++`), getters are lazy (`store.double`), actions are `this`-bound (`store.inc()`)
- facade methods: `id`, `state`, `patch(partial)`, `reset()`, `batch(fn)`, `subscribe(cb)`, `connect(comp)`, `disconnect(comp)`
- `useStore(store | "id", this)` resolves the facade and explicitly connects the component; string form warns + returns `undefined` if the id isn't registered. Render-time state/getter reads auto-subscribe through signals.
- `createHistory(options)` provides snapshot-based undo/redo plus synchronous `batch` and asynchronous `batchAsync`.
- `getStoreById(id)`, `disposeStore(id)`, `resetStores()` — registry utilities, mainly for **test isolation**. `disposeStore` does not disconnect components or listeners already holding the old facade; callers must release those references explicitly.

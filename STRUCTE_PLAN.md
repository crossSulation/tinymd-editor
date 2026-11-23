# Monorepo Restructuring Plan — Yarn Workspaces

Status: **proposal only — no code has been changed.** This document is the plan to review before any execution begins.

## Goal

Restructure `tinymd-editor` from a single Vite package into a Yarn-workspaces monorepo with four packages:

1. **app** — the app shell (Home/Editor pages, routing, document-creation modal)
2. **adapter** — persistence (web SQLite-WASM/OPFS, Tauri native SQLite, the dispatcher between them)
3. **editor** — the reusable markdown editor component and its model layer
4. **milkdown-chunk-editor** — the virtualized/chunked rendering path, currently a mix of a vendored tarball + this app's own adaptation code

## Current state (surveyed directly, not assumed)

- Not a git repository yet. **Strong recommendation: `git init` and commit the current working tree before touching anything else** — a multi-package restructuring is exactly the kind of change that's painful to recover from without version control.
- Single package, Yarn Classic already declared (`packageManager: yarn@1.22.22` in `package.json`) — workspaces are natively supported, no package-manager migration needed.
- `tsconfig.app.json` uses `moduleResolution: "bundler"` and `noEmit: true` — there is currently **no separate TypeScript compile step**; Vite/esbuild transpiles source directly. This matters for the tooling decision below.
- Existing folders map almost directly onto the proposed packages, and each already has a clean barrel export:

| Current location | Files | Barrel export | Maps to |
|---|---|---|---|
| `src/app/` | 8 | (none yet — `App.tsx` imports directly) | **app** |
| `src/control/` | 6 | `src/control/index.ts` | **adapter** |
| `src/view/` + `src/model/` | 27 + 3 | `src/view/index.ts`, `src/model/index.ts` | **editor** |
| *(none yet — currently split across `vendor/` and `src/view/`)* | — | — | **milkdown-chunk-editor** |
| `src-tauri/` | — | — | stays with **app** (native shell wraps the app, not the editor) |

- `vendor/milkdown-chunk-editor-0.1.0.tgz` is installed today as a `file:` dependency of the root package; `vendor/milkdown-chunk-editor-src/` is a reference-only copy of its TypeScript source, excluded from compilation.
- The chunk-editor adaptation code (`virtualizedEditorController.ts`, `chunkMount.ts`) currently lives **inside** `src/view/` (the editor layer), not separately — see the open decision below for why.

## The one real architectural decision (not just file-moving)

`chunkMount.ts` mounts each chunk using `createMilkdownEditor.ts`'s full plugin stack (Mermaid/LaTeX preview, floating toolbar, placeholder, code-block exit-on-Enter, etc.) — this is a deliberate, already-documented choice so a chunked document has full feature parity with a normal one, instead of the vendored package's own bare `commonmark+gfm+history+listener`-only `mountChunk`.

This means **`milkdown-chunk-editor` cannot be a dependency-free "bottom" package** the way a simple top-down layer list (app → adapter → editor → milkdown-chunk-editor) implies. It needs `createMilkdownEditor.ts`'s plugin-stack builder, which lives in `editor`. There are two honest ways to resolve this, and the plan needs one picked before execution:

- **Option A — accept the back-reference (recommended default for this plan).** `milkdown-chunk-editor` depends on `editor` as a normal package dependency, purely for the plugin-stack builder. The "layers" are then not a strict linear chain; `editor` is consumed by two things (`app`, and `milkdown-chunk-editor`), and `milkdown-chunk-editor` itself is consumed by `editor`'s own `Editor.tsx` (which picks the virtualized path above `CHUNK_SIZE_THRESHOLD`) — i.e. there's a **real cycle at the package level** (`editor` ⇄ `milkdown-chunk-editor`) unless `Editor.tsx`'s own virtualized-path wiring is what moves into `milkdown-chunk-editor` instead of staying in `editor`. This needs a concrete sub-decision: does `editor` import `milkdown-chunk-editor` (today's direction, since `VirtualizedEditorBody` is called from `Editor.tsx`), or does `milkdown-chunk-editor` export the whole virtualized body and `editor` merely re-exports/re-wires it? Either way, a cycle has to be broken by choosing one side to own the integration point.
- **Option B — invert the coupling via injection.** `milkdown-chunk-editor` takes the plugin-stack builder as a parameter/callback instead of importing it directly (e.g. `mountEditorChunk(buildPluginStack, chunk, ...)`). This makes `milkdown-chunk-editor` genuinely dependency-free and matches the "layers" framing literally, but is real refactoring work, not a file move — every call site that currently imports `createMilkdownEditor` directly inside `chunkMount.ts` would need to change shape.

**This plan is written assuming Option A** (lower effort, matches what the code already does structurally) with the sub-decision that `milkdown-chunk-editor` owns `VirtualizedEditorBody`/`virtualizedEditorController.ts`/`chunkMount.ts` and exports them for `editor`'s `Editor.tsx` to consume — i.e. the dependency runs `milkdown-chunk-editor → editor` (for the plugin stack) and `editor → milkdown-chunk-editor` (for the component) is real but narrow: only `Editor.tsx` imports from it, nothing else in `editor` does. If Option B is actually wanted, say so before execution — it changes the effort estimate materially (see Phases below).

## Target package layout

```
tinymd-editor/                  (workspace root — no app code of its own)
├── package.json                (workspaces config, shared devDependencies, root scripts)
├── tsconfig.json                (solution-style references, if kept)
├── packages/
│   ├── app/
│   │   ├── package.json
│   │   ├── vite.config.ts       (moved from root)
│   │   ├── index.html           (moved from root)
│   │   ├── src/                 (current src/app/ + src/App.tsx + src/main.tsx)
│   │   └── src-tauri/           (moved from root — native shell wraps this package)
│   ├── adapter/
│   │   ├── package.json
│   │   └── src/                 (current src/control/)
│   ├── editor/
│   │   ├── package.json
│   │   └── src/                 (current src/view/ + src/model/)
│   └── milkdown-chunk-editor/
│       ├── package.json
│       └── src/                 (virtualizedEditorController.ts, chunkMount.ts,
│                                  dirtyPlugin.ts, split/join/VirtualLayout utilities
│                                  currently vendored — see below)
```

Package names (scoped, to avoid any collision with the existing `milkdown-chunk-editor` npm/vendor package name):

- `@tinymd/app`
- `@tinymd/adapter`
- `@tinymd/editor`
- `@tinymd/milkdown-chunk-editor`

## Final dependency graph

```
@tinymd/app
  ├─→ @tinymd/adapter
  └─→ @tinymd/editor
        └─→ @tinymd/milkdown-chunk-editor
               └─→ @tinymd/editor   (plugin-stack builder only — see Option A above)
```

`@tinymd/adapter` depends on nothing else in the workspace (confirmed — `src/control/` has no imports from `src/view/` or `src/app/` today). `@tinymd/app` is the only package that imports `@tauri-apps/*` directly.

## Vendor tarball — what happens to it

The vendored `milkdown-chunk-editor-0.1.0.tgz` and its reference-only source copy are the **origin** of the pure, DOM-free utilities (`splitIntoChunks`, `joinChunks`, `VirtualLayout`, `DocCache`) already used by `virtualizedEditorController.ts`. Two sub-options, needing a decision but not blocking the rest of the plan:

- **Keep vendoring it as-is**, and have `@tinymd/milkdown-chunk-editor` depend on it exactly like the root package does today (`file:` dependency, now relative to the new package's location instead of root). Lowest effort; preserves the existing "upgrade by dropping in a new tarball" workflow documented in CLAUDE.md.
- **Absorb the pure utilities into `@tinymd/milkdown-chunk-editor` directly**, dropping the external tarball dependency entirely now that this app has its own package boundary to hold them. Removes a layer of indirection but means manually re-porting future upstream fixes instead of dropping in a new tarball — a real loss of the "upgrade path" CLAUDE.md documents, and upstream fixes to `split.ts`/`virtual-layout.ts` have landed more than once.

**Recommended: keep vendoring it**, just relocated under the new package. No functional difference, no loss of the existing upgrade workflow.

## Tooling changes

**TypeScript resolution: keep source-level, no per-package build step.** Since `tsconfig.app.json` already runs in `noEmit`/bundler mode (Vite transpiles directly, no `tsc` compile step exists today), each workspace package should export its TypeScript source directly (`"main": "src/index.ts"` style, or Vite/Node's `exports` field pointing at `.ts`), not a pre-built `dist/`. This avoids introducing a build-before-build step and matches how the project already works. Each package still gets its own `tsconfig.json` for editor/IDE purposes, likely via `"references"` from a root solution file, but none of them need `"noEmit": false` or a `tsc -b` package build.

**Root `package.json`:**
```json
{
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "dev": "yarn workspace @tinymd/app dev",
    "build": "yarn workspace @tinymd/app build",
    "tauri": "yarn workspace @tinymd/app tauri"
  }
}
```

**Per-package `package.json`:** each of `adapter`, `editor`, `milkdown-chunk-editor` becomes a plain workspace package with its own `name`, `version`, `main`/`exports`, and only the dependencies it actually uses (e.g. `adapter` needs `@sqlite.org/sqlite-wasm` + `@tauri-apps/plugin-sql`; `editor` needs `@milkdown/*`, `@codemirror/*`, `katex`, `mermaid`, `vue`, `remark-*`, `unified`; `milkdown-chunk-editor` needs the vendored tarball + a `peerDependency` or direct `dependency` on `@tinymd/editor`). `app` keeps `react`, `react-dom`, `@tauri-apps/api`, and workspace references to the other three via `"@tinymd/adapter": "workspace:*"` syntax (Yarn Classic supports `workspace:*` resolution via its own `yarn.lock` linking, no extra plugin needed).

**Vite config** moves into `packages/app/vite.config.ts`. One addition needed: Vite needs to be told to resolve and watch the workspace packages' TS source (Yarn Classic workspaces are hoisted into the root `node_modules` with symlinks back to `packages/*`, which Vite's dependency pre-bundling can mishandle for packages that change frequently during development — likely needs `optimizeDeps.exclude` or `server.fs.allow` entries for the sibling packages, confirmed only by trying it, not assumed here).

**`src-tauri/` moves under `packages/app/`.** `tauri.conf.json`'s `beforeDevCommand`/`beforeBuildCommand` (currently implicitly `npm run dev`/`npm run build` at the root) need to point at the workspace-aware equivalents, and `frontendDist`/`devUrl` paths need re-checking relative to the new location.

## CLAUDE.md

This file currently documents a single-package layout with import direction enforced by convention ("App → Control → View → Model", "View and Model must not import from Control or App"). After the split, those same rules become **enforced by the package boundary itself** (a package simply has no dependency to import across), which is a genuine improvement worth calling out, not just a rename. The document needs:

- Every `src/control/` → `@tinymd/adapter`, `src/view/`+`src/model/` → `@tinymd/editor` reference updated.
- A new top-level section explaining the workspace layout and the `editor ⇄ milkdown-chunk-editor` relationship from the Decision section above, so a future session doesn't "fix" the back-reference thinking it's an accident.
- The vendor-tarball upgrade instructions (`vendor/milkdown-chunk-editor-src` sync steps) updated for the new path.

This is a substantial editing pass given how detailed the existing document is — budget real time for it, not a find-replace.

## Testing

The scratchpad CDP test suite (dozens of scripts) all assume a dev server at `http://localhost:5173/`. As long as `yarn dev` (via the root script delegating to `@tinymd/app`) still serves the same app on the same port with the same behavior, none of those scripts need to change. This should be **verified by running the existing suite once after the split**, not assumed safe.

## Suggested phases (lowest-risk first)

1. **Prerequisite:** `git init`, commit current state.
2. Introduce the workspace skeleton (`packages/*` folders, root `package.json` with `workspaces`) **without moving any files yet** — confirms Yarn's workspace resolution works in this environment before any code moves.
3. Move `adapter` (smallest, zero internal coupling, lowest risk) — update its `package.json`, confirm `app` can still import it via workspace resolution, confirm `yarn dev` still runs.
4. Move `editor` (the bulk of the code, but still a clean, already-barrel-exported move).
5. Carve out `milkdown-chunk-editor` from inside `editor` — the one step with real design work (Decision section above), do this last specifically because the first two moves de-risk the tooling (Vite workspace resolution, Yarn linking) before tackling the one step with actual code-shape changes.
6. Move `app` itself (shell, `src-tauri/`, root config files) into `packages/app/`, collapsing the old root down to just the workspace manifest.
7. Re-run the full existing CDP test suite; re-run `npx tauri android build` once to confirm the native shell still resolves correctly from its new location.
8. CLAUDE.md rewrite pass.

## Scope Boundaries

**Trade-offs / risks:**
- No git history exists yet to fall back on if a step goes wrong before step 1 is done — this is the single biggest risk, and it's fully avoidable.
- The `editor ⇄ milkdown-chunk-editor` package-level cycle (Option A) is unusual and will read as a mistake to anyone unfamiliar with the reasoning unless CLAUDE.md's rewrite explicitly calls it out.
- Vite's workspace dependency pre-bundling behavior with Yarn Classic's hoisted symlinks is not verified in this environment — flagged as a real unknown in the Tooling section, not assumed to "just work."
- Android build path references (`tauri.conf.json`, `beforeBuildCommand`) moving under `packages/app/src-tauri/` have not been tested; `gen/android/` regeneration behavior (already a documented sharp edge in CLAUDE.md) should be re-verified post-move.

**Constraints:**
- No change to runtime behavior, persistence format, or UI — this is a pure code-organization change.
- No separate build/compile step introduced per package (keeps today's zero-tsc-build, Vite-transpiles-everything model).
- No npm publishing of any package — these are workspace-internal only, never intended to be installed standalone.

**Not included in this phase:**
- Resolving the Option A vs. Option B decision — this plan assumes Option A; confirm before execution.
- Actually running any of the phases above — this document is the plan only.
- Changing the vendored `milkdown-chunk-editor` tarball's own upgrade workflow beyond relocating it.
- Any new CI/lint/test automation beyond what already exists.

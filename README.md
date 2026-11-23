# tinymd-editor

A mobile-first markdown editor built directly on [`@milkdown/kit`](https://milkdown.dev/) (ProseMirror-based), with a custom hand-built UI designed for touch — no `:hover`-only affordances anywhere. Runs as a web app and, via [Tauri 2.0](https://v2.tauri.app/), as a native Android app for on-device testing.

## Features

- Rich markdown editing (GFM: tables, task lists, strikethrough) with a fixed bottom toolbar sized and designed for touch, not a mouse
- Mermaid diagram and LaTeX preview inside code blocks
- Freehand ink annotation (PDF-markup style) that stays anchored to the text it was drawn on as the document reflows, and persists across reloads
- Automatic virtualized/chunked rendering for large documents, so editing a huge file doesn't cost full-document ProseMirror overhead
- Local-first persistence: SQLite WASM over OPFS on the web, native SQLite via Tauri on Android — no backend server
- Markdown export (web only; see `CLAUDE.md` for why Android export isn't supported yet)

## Getting started

```bash
npm install
npm run dev       # start the Vite dev server
npm run build     # type-check (tsc -b) and produce a production build
npm run preview   # serve the production build locally
npm run lint      # oxlint
```

The dev server requires `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` headers for OPFS (already configured in `vite.config.ts`); a production host needs the same.

## Android (Tauri)

```bash
npx tauri android dev --host <your-LAN-IP>    # hot-reload on a connected device
npx tauri android build --apk --target aarch64 --debug   # one-off debug APK
```

Android-only — no iOS target (would require a Mac/Xcode). See `CLAUDE.md`'s Tauri/Android section for device-testing notes, known WebView/orientation quirks, and the self-test release-signing setup under `src-tauri/`.

## Project layout

```
src/
  app/      App shell: document list, creation modal, routing between pages
  control/  Persistence — dispatches between the web (SQLite WASM/OPFS) and Tauri (native SQLite) backends
  view/     The reusable editor component itself (Editor.tsx) and its supporting UI/plugins
  model/    Document metadata and the markdown <-> SQLite-block mapping
src-tauri/  Native Android shell (Tauri 2.0)
vendor/     Vendored milkdown-chunk-editor package (virtualization utilities)
```

Dependency direction is one-way: `app -> control -> view -> model`. The editor itself (`src/view/Editor.tsx`) is a plain, self-contained React component — markdown in via props, changes out via `onChange` — with no knowledge of documents, routing, or persistence, so it could be dropped into a different app's UI as-is.

**`CLAUDE.md`** is the full architecture reference for this project — tech stack rationale, every module's design decisions, known bugs and how they were root-caused and fixed, and the Scope Boundaries (what's deliberately not built yet). Read it before making non-trivial changes.

**`STRUCTE_PLAN.md`** is a proposed (not yet executed) plan to restructure this repo into a Yarn-workspaces monorepo with separate `app`/`adapter`/`editor`/`milkdown-chunk-editor` packages.

## Status

Private, local-first, single-user project. No backend, no multi-device sync, no collaborative editing. See `CLAUDE.md`'s Scope Boundaries section for the full list of what's intentionally out of scope.

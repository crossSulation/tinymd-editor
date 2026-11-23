import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Set by `tauri android dev`/`tauri ios dev` to the host machine's LAN IP, since
// a physical device can't reach `localhost` (that resolves to the device itself).
// See https://v2.tauri.app/start/frontend/vite/#using-ssr-or-islands-frameworks
// and the mobile-dev guide's vite.config.ts snippet.
const tauriDevHost = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Don't let Tauri's own CLI output get cleared by Vite's dev-server banner.
  clearScreen: false,
  // Required for @sqlite.org/sqlite-wasm's OPFS (persistent) storage backend,
  // which needs a cross-origin-isolated context to use SharedArrayBuffer.
  server: {
    host: tauriDevHost || false,
    port: 5173,
    strictPort: true,
    hmr: tauriDevHost ? { protocol: "ws", host: tauriDevHost, port: 5174 } : undefined,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    // Don't let Vite's dev-server watcher react to Tauri's generated build
    // artifacts (src-tauri/target, src-tauri/gen, etc.).
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
})

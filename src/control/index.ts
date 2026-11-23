// Control layer: persistence (dual-backend — SQLite WASM/OPFS on the web,
// native SQLite via Tauri on Android, dispatched by db.ts) and any future
// document-level behavior not owned by the editor itself. See Claude.md.
export { createDoc, deleteDoc, getStorageInfo, listDocs, loadDoc, saveDoc } from "./db";
export { createDebouncedSave } from "./persistence";
export type { DocSummary, LoadedDoc, StorageInfo } from "./sqlite.worker";

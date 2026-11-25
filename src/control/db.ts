import { isTauri } from "@tauri-apps/api/core";
import type { DocumentMeta } from "../model";
import type { DocSummary, LoadedDoc, StorageInfo } from "./sqlite.worker";
import * as tauriDb from "./tauriDb";
import * as webDb from "./webDb";

// Dispatches to the native SQLite backend (tauriDb.ts) when running inside the
// Tauri/Android app, or the SQLite-WASM/OPFS backend (webDb.ts) on the web.
// See Claude.md for why these need to differ (Android WebView can't do the
// cross-origin isolation OPFS depends on).
const backend = isTauri() ? tauriDb : webDb;

export function getStorageInfo(): Promise<StorageInfo> {
  return backend.getStorageInfo();
}

export function listDocs(): Promise<DocSummary[]> {
  return backend.listDocs();
}

export function createDoc(parentId: string | null = null): Promise<string> {
  return backend.createDoc(parentId);
}

export function loadDoc(docId: string): Promise<LoadedDoc | null> {
  return backend.loadDoc(docId);
}

export function saveDoc(docId: string, meta: DocumentMeta, blocks: string[]): Promise<void> {
  return backend.saveDoc(docId, meta, blocks);
}

export function deleteDoc(docId: string): Promise<void> {
  return backend.deleteDoc(docId);
}

import type { DocumentMeta } from "../model";
import type { DocSummary, LoadedDoc, StorageInfo } from "./sqlite.worker";

// Thin request/response bridge to sqlite.worker.ts, where the actual SQLite
// WASM (OPFS-backed) database lives. View code should go through the typed
// functions below, never talk to the worker directly.

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, PendingRequest>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./sqlite.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent) => {
      const { id, ok, result, error } = event.data;
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      if (ok) request.resolve(result);
      else request.reject(new Error(error));
    };
    worker.onerror = (event: ErrorEvent) => {
      // A worker-level failure (e.g. it crashed before handling any message)
      // would otherwise leave every pending call hanging forever, silently.
      console.error("[db] sqlite worker crashed:", event.message, event);
      for (const request of pending.values()) {
        request.reject(new Error(`sqlite worker crashed: ${event.message}`));
      }
      pending.clear();
    };
  }
  return worker;
}

function call<T>(message: Record<string, unknown>): Promise<T> {
  const id = nextId++;
  const activeWorker = getWorker();
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    activeWorker.postMessage({ id, ...message });
  });
}

export function getStorageInfo(): Promise<StorageInfo> {
  return call({ type: "getStorageInfo" });
}

export function listDocs(): Promise<DocSummary[]> {
  return call({ type: "listDocs" });
}

export function createDoc(parentId: string | null): Promise<string> {
  return call({ type: "createDoc", parentId });
}

export function loadDoc(docId: string): Promise<LoadedDoc | null> {
  return call({ type: "loadDoc", docId });
}

export function saveDoc(docId: string, meta: DocumentMeta, blocks: string[]): Promise<void> {
  return call({ type: "saveDoc", docId, meta, blocks });
}

export function deleteDoc(docId: string): Promise<void> {
  return call({ type: "deleteDoc", docId });
}

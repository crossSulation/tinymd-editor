import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { Database } from "@sqlite.org/sqlite-wasm";
import type { DocumentMeta } from "../model";

export interface LoadedDoc {
  meta: DocumentMeta;
  blocks: string[];
}

export interface DocSummary {
  id: string;
  meta: DocumentMeta;
}

export interface StorageInfo {
  persistent: boolean;
  crossOriginIsolated: boolean;
}

type WorkerRequest =
  | { id: number; type: "getStorageInfo" }
  | { id: number; type: "listDocs" }
  | { id: number; type: "createDoc" }
  | { id: number; type: "loadDoc"; docId: string }
  | { id: number; type: "saveDoc"; docId: string; meta: DocumentMeta; blocks: string[] }
  | { id: number; type: "deleteDoc"; docId: string };

type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

let dbPromise: Promise<{ db: Database; persistent: boolean }> | null = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = sqlite3InitModule().then((sqlite3) => {
      const persistent = "opfs" in sqlite3;
      const db = persistent
        ? new sqlite3.oo1.OpfsDb("/tinymd-editor.sqlite3")
        : new sqlite3.oo1.DB("/tinymd-editor.sqlite3", "ct");

      db.exec("PRAGMA foreign_keys = ON;");
      db.exec(`
        CREATE TABLE IF NOT EXISTS docs (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '',
          author TEXT NOT NULL DEFAULT '',
          tags TEXT NOT NULL DEFAULT '[]',
          custom_properties TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS blocks (
          doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (doc_id, position)
        );
      `);

      if (!persistent) {
        console.warn(
          "[sqlite.worker] OPFS is not available; using a transient, in-memory-backed database " +
            "(data will NOT survive a page reload). crossOriginIsolated =",
          self.crossOriginIsolated,
        );
      }

      return { db, persistent };
    });
  }
  return dbPromise;
}

async function getStorageInfo(): Promise<StorageInfo> {
  const { persistent } = await openDb();
  return { persistent, crossOriginIsolated: self.crossOriginIsolated };
}

function rowToMeta(row: Record<string, unknown>): DocumentMeta {
  return {
    title: row.title as string,
    author: row.author as string,
    tags: JSON.parse(row.tags as string),
    customProperties: JSON.parse(row.custom_properties as string),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

async function listDocs(): Promise<DocSummary[]> {
  const { db } = await openDb();
  const rows = db.exec({
    sql: "SELECT * FROM docs ORDER BY updated_at DESC;",
    rowMode: "object",
    returnValue: "resultRows",
  }) as unknown as Record<string, unknown>[];

  return rows.map((row) => ({ id: row.id as string, meta: rowToMeta(row) }));
}

async function createDoc(): Promise<string> {
  const { db } = await openDb();
  const docId = crypto.randomUUID();
  const now = new Date().toISOString();

  db.exec({
    sql: "INSERT INTO docs (id, title, author, tags, custom_properties, created_at, updated_at) VALUES (?, '', '', '[]', '[]', ?, ?);",
    bind: [docId, now, now],
  });

  return docId;
}

async function loadDoc(docId: string): Promise<LoadedDoc | null> {
  const { db } = await openDb();
  const docRows = db.exec({
    sql: "SELECT * FROM docs WHERE id = ?;",
    bind: [docId],
    rowMode: "object",
    returnValue: "resultRows",
  }) as unknown as Record<string, unknown>[];

  if (docRows.length === 0) return null;

  const blockRows = db.exec({
    sql: "SELECT content FROM blocks WHERE doc_id = ? ORDER BY position;",
    bind: [docId],
    rowMode: "object",
    returnValue: "resultRows",
  }) as unknown as { content: string }[];

  return { meta: rowToMeta(docRows[0]!), blocks: blockRows.map((r) => r.content) };
}

async function saveDoc(docId: string, meta: DocumentMeta, blocks: string[]): Promise<void> {
  const { db } = await openDb();

  db.transaction((tx) => {
    tx.exec({
      sql: `
        INSERT INTO docs (id, title, author, tags, custom_properties, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          author = excluded.author,
          tags = excluded.tags,
          custom_properties = excluded.custom_properties,
          updated_at = excluded.updated_at;
      `,
      bind: [
        docId,
        meta.title,
        meta.author,
        JSON.stringify(meta.tags),
        JSON.stringify(meta.customProperties),
        meta.createdAt,
        meta.updatedAt,
      ],
    });

    tx.exec({ sql: "DELETE FROM blocks WHERE doc_id = ?;", bind: [docId] });

    blocks.forEach((content, position) => {
      tx.exec({
        sql: "INSERT INTO blocks (doc_id, position, content) VALUES (?, ?, ?);",
        bind: [docId, position, content],
      });
    });
  });
}

async function deleteDoc(docId: string): Promise<void> {
  const { db } = await openDb();
  // ON DELETE CASCADE (declared on blocks.doc_id) removes its blocks too.
  db.exec({ sql: "DELETE FROM docs WHERE id = ?;", bind: [docId] });
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  try {
    let result: unknown;
    switch (message.type) {
      case "getStorageInfo":
        result = await getStorageInfo();
        break;
      case "listDocs":
        result = await listDocs();
        break;
      case "createDoc":
        result = await createDoc();
        break;
      case "loadDoc":
        result = await loadDoc(message.docId);
        break;
      case "saveDoc":
        await saveDoc(message.docId, message.meta, message.blocks);
        result = undefined;
        break;
      case "deleteDoc":
        await deleteDoc(message.docId);
        result = undefined;
        break;
    }
    const response: WorkerResponse = { id: message.id, ok: true, result };
    self.postMessage(response);
  } catch (error) {
    const response: WorkerResponse = {
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};

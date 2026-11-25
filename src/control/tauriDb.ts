import Database from "@tauri-apps/plugin-sql";
import type { DocumentMeta } from "../model";
import type { DocSummary, LoadedDoc, StorageInfo } from "./sqlite.worker";

// Native SQLite backend for the Tauri/Android build, via @tauri-apps/plugin-sql
// (Rust/sqlx over Tauri's IPC bridge). Same schema and DocumentMeta mapping as
// webDb.ts's sqlite.worker.ts, so both backends produce identical shapes.
// No Worker needed: there's no OPFS-style sync-access-handle constraint here.

// IMPORTANT: db.execute()/db.select() each do a fresh acquire-execute-release
// against the plugin's underlying sqlx connection pool (confirmed directly
// against the installed tauri-plugin-sql 2.6.0 Rust source -- there is no
// per-call connection pinning, and no db.transaction() helper). A raw
// `BEGIN; ...; COMMIT;` sequence of separate calls is therefore NOT safe --
// each statement can land on a different pooled connection, so a `BEGIN` can
// be released back to the pool still open (its COMMIT running on a different
// connection, or not at all), leaving an orphaned transaction holding
// SQLite's single write lock indefinitely. That is exactly what produced a
// real on-device "database is locked" (SQLITE_BUSY) error from saveDoc's old
// manual transaction. So: no multi-statement transactions here, and every
// operation below is serialized through `enqueue` so this backend never has
// two pooled-connection calls in flight at once (mirroring how webDb.ts's
// single Worker already naturally serializes its own calls).
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(run: () => Promise<T>): Promise<T> {
  const result = queue.then(run, run);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// This app's first-ever schema change -- see sqlite.worker.ts's own
// migrateParentIdColumn for the full reasoning (verified directly against a
// real SQLite engine, not assumed). Mirrored here since tauriDb.ts keeps its
// own separate CREATE TABLE statements, same precedent as every other piece
// of schema/API shape in this file.
async function migrateParentIdColumn(db: Database): Promise<void> {
  const cols = await db.select<{ name: string }[]>("PRAGMA table_info(docs);");
  if (!cols.some((c) => c.name === "parent_id")) {
    await db.execute("ALTER TABLE docs ADD COLUMN parent_id TEXT REFERENCES docs(id) ON DELETE SET NULL;");
  }
}

let dbPromise: Promise<Database> | null = null;

function openDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load("sqlite:tinymd-editor.db").then(async (db) => {
      await db.execute("PRAGMA foreign_keys = ON;");
      await db.execute(`
        CREATE TABLE IF NOT EXISTS docs (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '',
          author TEXT NOT NULL DEFAULT '',
          tags TEXT NOT NULL DEFAULT '[]',
          custom_properties TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          parent_id TEXT REFERENCES docs(id) ON DELETE SET NULL
        );
      `);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS blocks (
          doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (doc_id, position)
        );
      `);
      await migrateParentIdColumn(db);
      return db;
    });
  }
  return dbPromise;
}

export async function getStorageInfo(): Promise<StorageInfo> {
  await openDb();
  // Native SQLite always persists to disk; there's no OPFS-style fallback case.
  return { persistent: true, crossOriginIsolated: true };
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

export function listDocs(): Promise<DocSummary[]> {
  return enqueue(async () => {
    const db = await openDb();
    const rows = await db.select<Record<string, unknown>[]>(
      "SELECT * FROM docs ORDER BY updated_at DESC;",
    );
    return rows.map((row) => ({ id: row.id as string, meta: rowToMeta(row), parentId: (row.parent_id as string | null) ?? null }));
  });
}

export function createDoc(parentId: string | null): Promise<string> {
  return enqueue(async () => {
    const db = await openDb();
    const docId = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.execute(
      "INSERT INTO docs (id, title, author, tags, custom_properties, created_at, updated_at, parent_id) VALUES ($1, '', '', '[]', '[]', $2, $3, $4);",
      [docId, now, now, parentId],
    );

    return docId;
  });
}

export function loadDoc(docId: string): Promise<LoadedDoc | null> {
  return enqueue(async () => {
    const db = await openDb();
    const docRows = await db.select<Record<string, unknown>[]>(
      "SELECT * FROM docs WHERE id = $1;",
      [docId],
    );

    if (docRows.length === 0) return null;

    const blockRows = await db.select<{ content: string }[]>(
      "SELECT content FROM blocks WHERE doc_id = $1 ORDER BY position;",
      [docId],
    );

    return {
      meta: rowToMeta(docRows[0]!),
      blocks: blockRows.map((r) => r.content),
      parentId: (docRows[0]!.parent_id as string | null) ?? null,
    };
  });
}

export function saveDoc(docId: string, meta: DocumentMeta, blocks: string[]): Promise<void> {
  return enqueue(async () => {
    const db = await openDb();

    // No BEGIN/COMMIT here -- see the big comment above `enqueue`. Each
    // statement is already atomic on its own; `enqueue` keeps this whole
    // sequence from interleaving with any other call against the pool, which
    // is the actual property that matters for a single-user local editor
    // (same trade-off the web/OPFS backend already made deliberately, per
    // Claude.md's Persistence section).
    await db.execute(
      `
        INSERT INTO docs (id, title, author, tags, custom_properties, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          author = excluded.author,
          tags = excluded.tags,
          custom_properties = excluded.custom_properties,
          updated_at = excluded.updated_at;
      `,
      [
        docId,
        meta.title,
        meta.author,
        JSON.stringify(meta.tags),
        JSON.stringify(meta.customProperties),
        meta.createdAt,
        meta.updatedAt,
      ],
    );

    await db.execute("DELETE FROM blocks WHERE doc_id = $1;", [docId]);

    for (const [position, content] of blocks.entries()) {
      await db.execute(
        "INSERT INTO blocks (doc_id, position, content) VALUES ($1, $2, $3);",
        [docId, position, content],
      );
    }
  });
}

export function deleteDoc(docId: string): Promise<void> {
  return enqueue(async () => {
    const db = await openDb();
    // ON DELETE CASCADE (declared on blocks.doc_id) removes its blocks too.
    await db.execute("DELETE FROM docs WHERE id = $1;", [docId]);
  });
}

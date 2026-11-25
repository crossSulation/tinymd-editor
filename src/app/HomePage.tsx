import { useEffect, useState } from "react";
import { isTauriAndroid } from "../view/platform";
import { createDoc, deleteDoc, listDocs, loadDoc, saveDoc } from "../control";
import type { DocSummary } from "../control";
import { touch } from "../model";
import { exportDocumentAsMarkdown } from "./exportDocument";
import { NewDocumentModal, type NewDocumentFields } from "./NewDocumentModal";
import "./home-page.css";

// Export is a browser-download primitive (Blob + `<a download>`), which
// Android's System WebView specifically doesn't support at all --
// confirmed against a still-open upstream Tauri issue, not something this
// app's own code can paper over without real native Rust/Kotlin work (the
// "proper" Tauri-documented alternative, plugin-dialog + plugin-fs, also has
// its own open upstream bug producing 0-byte files on Android). Hidden
// outright on the Android build rather than left visible-but-silently-broken
// -- same "no ambiguous state" reasoning as ModeHeader.tsx's `drawDisabled`
// gate. Checked against isTauriAndroid(), not plain isTauri(): a desktop
// Tauri build (Windows/macOS/Linux, used for local testing) has a real
// desktop webview, which doesn't share this limitation at all. Revisit
// only if a reliable native path becomes available upstream.
const exportAvailable = !isTauriAndroid();

export interface HomePageProps {
  onOpenDoc: (docId: string) => void;
}

interface DocTreeNode {
  doc: DocSummary;
  children: DocTreeNode[];
}

// Flat list -> tree, built client-side rather than a recursive SQL query --
// this app's own document count is small (a single user's personal notes),
// so there's no real cost to doing this in memory, and it avoids needing a
// recursive-CTE query path alongside the existing flat one. `docs` arrives
// already sorted by updated_at DESC (listDocs' own ORDER BY); iterating a
// Map in insertion order preserves that within each sibling group. A
// doc whose own parentId points at something no longer in the list (the
// parent was deleted -- though ON DELETE SET NULL should prevent this --
// or any other inconsistency) is treated as a root rather than dropped.
function buildDocTree(docs: DocSummary[]): DocTreeNode[] {
  const byId = new Map<string, DocTreeNode>(docs.map((doc) => [doc.id, { doc, children: [] }]));
  const roots: DocTreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.doc.parentId ? byId.get(node.doc.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

interface DocTreeProps {
  nodes: DocTreeNode[];
  onOpenDoc: (docId: string) => void;
  onAddChild: (parentId: string) => void;
  onDelete: (docId: string, title: string) => void;
}

// Indentation per level is plain CSS nesting (`.doc-list .doc-list` in
// home-page.css), not a depth prop threaded through -- each level of
// recursion just is one more level of actual DOM nesting, so the same
// margin rule compounds naturally without needing to know its own depth.
function DocTree({ nodes, onOpenDoc, onAddChild, onDelete }: DocTreeProps) {
  return (
    <ul className="doc-list">
      {nodes.map((node) => (
        <li key={node.doc.id} className="doc-tree-node">
          <div className="doc-list-item">
            <button type="button" className="doc-list-open" onClick={() => onOpenDoc(node.doc.id)}>
              <span className="doc-list-title">{node.doc.meta.title || "Untitled"}</span>
              <span className="doc-list-meta">
                {node.doc.meta.author && <span>{node.doc.meta.author} · </span>}
                Updated {new Date(node.doc.meta.updatedAt).toLocaleString()}
              </span>
            </button>
            <button
              type="button"
              className="doc-list-add-child"
              aria-label={`New page under ${node.doc.meta.title || "Untitled"}`}
              onClick={() => onAddChild(node.doc.id)}
            >
              +
            </button>
            {exportAvailable && (
              <button
                type="button"
                className="doc-list-export"
                aria-label={`Export ${node.doc.meta.title || "Untitled"}`}
                onClick={() => void exportDocumentAsMarkdown(node.doc.id)}
              >
                Export
              </button>
            )}
            <button
              type="button"
              className="doc-list-delete"
              aria-label={`Delete ${node.doc.meta.title || "Untitled"}`}
              onClick={() => onDelete(node.doc.id, node.doc.meta.title)}
            >
              Delete
            </button>
          </div>
          {node.children.length > 0 && (
            <DocTree nodes={node.children} onOpenDoc={onOpenDoc} onAddChild={onAddChild} onDelete={onDelete} />
          )}
        </li>
      ))}
    </ul>
  );
}

export function HomePage({ onOpenDoc }: HomePageProps) {
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  // null means "creating a top-level document" -- distinct from the modal
  // being closed (showCreateModal tracks that separately).
  const [createParentId, setCreateParentId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listDocs().then((result) => {
      if (!cancelled) setDocs(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function openCreateModal(parentId: string | null) {
    setCreateParentId(parentId);
    setShowCreateModal(true);
  }

  async function handleCreate(fields: NewDocumentFields) {
    const docId = await createDoc(createParentId);
    // createDoc() only sets up a blank row; load it back so we keep its real
    // createdAt rather than minting a second, slightly different timestamp
    // for the same creation moment.
    const doc = await loadDoc(docId);
    if (doc) {
      const meta = touch({ ...doc.meta, title: fields.title, author: fields.author, tags: fields.tags });
      await saveDoc(docId, meta, []);
    }
    setShowCreateModal(false);
    onOpenDoc(docId);
  }

  async function handleDelete(docId: string, title: string) {
    if (!window.confirm(`Delete "${title || "Untitled"}"? This can't be undone. Any sub-pages move up to the top level.`)) return;
    await deleteDoc(docId);
    // ON DELETE SET NULL re-parents any children to the top level rather
    // than cascading -- re-fetch rather than just filtering the deleted id
    // out locally, so those re-parented docs' own parentId is reflected
    // correctly in this list without a second, more complex local patch.
    setDocs(await listDocs());
  }

  const tree = docs ? buildDocTree(docs) : null;

  return (
    <div className="home-page">
      <header className="home-page-header">
        <h1>My Documents</h1>
        <button type="button" className="new-doc-button" onClick={() => openCreateModal(null)}>
          + New document
        </button>
      </header>

      {tree === null ? (
        <p className="home-page-status">Loading...</p>
      ) : tree.length === 0 ? (
        <p className="home-page-status">No documents yet. Create one to get started.</p>
      ) : (
        <DocTree nodes={tree} onOpenDoc={onOpenDoc} onAddChild={openCreateModal} onDelete={(id, title) => void handleDelete(id, title)} />
      )}

      {showCreateModal && (
        <NewDocumentModal onCreate={(fields) => void handleCreate(fields)} onCancel={() => setShowCreateModal(false)} />
      )}
    </div>
  );
}

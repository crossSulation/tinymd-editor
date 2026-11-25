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

export function HomePage({ onOpenDoc }: HomePageProps) {
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void listDocs().then((result) => {
      if (!cancelled) setDocs(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCreate(fields: NewDocumentFields) {
    const docId = await createDoc();
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
    if (!window.confirm(`Delete "${title || "Untitled"}"? This can't be undone.`)) return;
    await deleteDoc(docId);
    setDocs((prev) => prev?.filter((doc) => doc.id !== docId) ?? prev);
  }

  return (
    <div className="home-page">
      <header className="home-page-header">
        <h1>My Documents</h1>
        <button type="button" className="new-doc-button" onClick={() => setShowCreateModal(true)}>
          + New document
        </button>
      </header>

      {docs === null ? (
        <p className="home-page-status">Loading...</p>
      ) : docs.length === 0 ? (
        <p className="home-page-status">No documents yet. Create one to get started.</p>
      ) : (
        <ul className="doc-list">
          {docs.map((doc) => (
            <li key={doc.id} className="doc-list-item">
              <button type="button" className="doc-list-open" onClick={() => onOpenDoc(doc.id)}>
                <span className="doc-list-title">{doc.meta.title || "Untitled"}</span>
                <span className="doc-list-meta">
                  {doc.meta.author && <span>{doc.meta.author} · </span>}
                  Updated {new Date(doc.meta.updatedAt).toLocaleString()}
                </span>
              </button>
              {exportAvailable && (
                <button
                  type="button"
                  className="doc-list-export"
                  aria-label={`Export ${doc.meta.title || "Untitled"}`}
                  onClick={() => void exportDocumentAsMarkdown(doc.id)}
                >
                  Export
                </button>
              )}
              <button
                type="button"
                className="doc-list-delete"
                aria-label={`Delete ${doc.meta.title || "Untitled"}`}
                onClick={() => void handleDelete(doc.id, doc.meta.title)}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      {showCreateModal && (
        <NewDocumentModal onCreate={(fields) => void handleCreate(fields)} onCancel={() => setShowCreateModal(false)} />
      )}
    </div>
  );
}

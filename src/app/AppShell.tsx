import { useEffect, useState } from "react";
import { EditorPage } from "./EditorPage";
import { Sidebar } from "./Sidebar";
import { NewDocumentModal, type NewDocumentFields } from "./NewDocumentModal";
import { createDoc, deleteDoc, listDocs, loadDoc, saveDoc } from "../control";
import type { DocSummary } from "../control";
import { touch } from "../model";
import "./app-shell.css";

// The persistent-sidebar shell (UX_PLAN.md Phase 10): replaces the old
// two-screen Home <-> Editor navigation with one layout where the page tree
// (previously HomePage's own full-page view) sits beside whichever document
// is open, the same way Main.dc.html's design always shows both at once.
// This is pure App-layer orchestration -- src/view/Editor.tsx gains no new
// props and stays exactly as self-contained as it already was.
export function AppShell() {
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [didAutoSelect, setDidAutoSelect] = useState(false);
  // Landscape-only (persistent sidebar collapsed to nothing) and
  // portrait-only (off-canvas drawer slid into view) -- independent flags,
  // each defaulting to the correct appearance for its own breakpoint; see
  // Sidebar.tsx's own comment for why no JS-side orientation check decides
  // between them.
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
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

  // Auto-select the most-recently-updated doc (listDocs' own ORDER BY) the
  // first time the list loads, so a returning user doesn't land on an empty
  // pane -- but only once: deleting the currently-open doc later (below)
  // deliberately falls back to the empty state rather than re-picking
  // another document, per UX_PLAN.md Phase 10's own open call.
  useEffect(() => {
    if (didAutoSelect || !docs) return;
    setDidAutoSelect(true);
    if (docs.length > 0) setSelectedDocId(docs[0].id);
  }, [docs, didAutoSelect]);

  function openDoc(docId: string) {
    setSelectedDocId(docId);
    setDrawerOpen(false);
  }

  // Two separate triggers, not one shared "open sidebar" handler -- each
  // only ever touches the one flag its own breakpoint cares about.
  // `collapsed`/`drawerOpen` default correctly for their own breakpoint
  // (false = expanded in landscape, false = closed in portrait), so a
  // handler that set BOTH unconditionally (tried first, caught by this
  // phase's own CDP verification) would leave e.g. `drawerOpen` stuck
  // `true` after a landscape re-expand, silently popping the drawer open
  // on a later rotation to portrait with no doc-open/dismiss in between.
  // EditorPage.tsx renders both buttons but shows only one at a time via
  // the same `max-aspect-ratio` breakpoint this app already uses elsewhere
  // (sidebar.css), so there's still no JS-side orientation check anywhere.
  function expandSidebar() {
    setCollapsed(false);
  }

  function openDrawer() {
    setDrawerOpen(true);
  }

  function dismissSidebar() {
    setCollapsed(true);
    setDrawerOpen(false);
  }

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
    setDocs(await listDocs());
    setShowCreateModal(false);
    openDoc(docId);
  }

  async function handleDelete(docId: string, title: string) {
    if (!window.confirm(`Delete "${title || "Untitled"}"? This can't be undone. Any sub-pages move up to the top level.`)) return;
    await deleteDoc(docId);
    // ON DELETE SET NULL re-parents any children to the top level rather
    // than cascading -- re-fetch rather than just filtering the deleted id
    // out locally, so those re-parented docs' own parentId is reflected
    // correctly in the sidebar without a second, more complex local patch.
    setDocs(await listDocs());
    setSelectedDocId((current) => (current === docId ? null : current));
  }

  // TODO.md item 2 -- EditorPage.tsx already persisted the rename itself
  // (via `saveDoc`) by the time this fires; this just patches the already-
  // loaded `docs` list in place so Sidebar.tsx's tree reflects the new title
  // immediately, without a full `listDocs()` round trip for a change this
  // small and already known.
  function handleRenamed(docId: string, title: string) {
    setDocs((current) => current?.map((doc) => (doc.id === docId ? { ...doc, meta: { ...doc.meta, title } } : doc)) ?? current);
  }

  return (
    <div className="app-shell">
      <Sidebar
        docs={docs}
        selectedDocId={selectedDocId}
        collapsed={collapsed}
        drawerOpen={drawerOpen}
        onDismiss={dismissSidebar}
        onOpenDoc={openDoc}
        onNewPage={() => openCreateModal(null)}
        onAddChild={(parentId) => openCreateModal(parentId)}
        onDelete={(docId, title) => void handleDelete(docId, title)}
      />

      <div className="app-shell-main">
        {selectedDocId ? (
          <EditorPage
            docId={selectedDocId}
            onOpenDoc={openDoc}
            onExpandSidebar={expandSidebar}
            onOpenDrawer={openDrawer}
            onRenamed={handleRenamed}
          />
        ) : (
          <div className="app-shell-empty">
            <p>{docs === null ? "Loading..." : "Select a page from the sidebar, or create a new one."}</p>
            <button type="button" className="app-shell-empty-new" onClick={() => openCreateModal(null)}>
              + New page
            </button>
          </div>
        )}
      </div>

      {showCreateModal && (
        <NewDocumentModal onCreate={(fields) => void handleCreate(fields)} onCancel={() => setShowCreateModal(false)} />
      )}
    </div>
  );
}

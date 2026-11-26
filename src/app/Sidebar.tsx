import { useState, type ReactNode } from "react";
import { isTauriAndroid } from "../view/platform";
import type { DocSummary } from "../control";
import { exportDocumentAsMarkdown } from "./exportDocument";
import "./sidebar.css";

// See the note in HomePage's old DocTree (now here) -- Android's System
// WebView can't do a browser download at all, and the Tauri-documented
// native alternative has its own open upstream bug. Hidden outright there
// rather than left visible-but-silently-broken.
const exportAvailable = !isTauriAndroid();

export interface SidebarProps {
  docs: DocSummary[] | null;
  selectedDocId: string | null;
  /** Landscape-only: persistent sidebar collapsed to nothing. */
  collapsed: boolean;
  /** Portrait-only: off-canvas drawer currently slid into view. */
  drawerOpen: boolean;
  /** Closes whichever of the two above currently applies -- see AppShell. */
  onDismiss: () => void;
  onOpenDoc: (docId: string) => void;
  onNewPage: () => void;
  onAddChild: (parentId: string) => void;
  onDelete: (docId: string, title: string) => void;
}

// Stroke-based icon set, lifted directly from the design canvas' own `.ic`
// style (viewBox 0 0 24 24, stroke-width 1.75, round caps/joins, no fill) --
// `Icon` just wraps whichever path data a call site passes so every icon
// shares one markup shape rather than repeating the <svg> boilerplate.
// `small` renders at 16px (the row-action buttons, `.doc-list-add-child`
// etc., are 32px, too cramped for the design's own 20px) instead of 20px.
function Icon({ children, small }: { children: ReactNode; small?: boolean }) {
  return (
    <svg className={small ? "ic ic-sm" : "ic"} viewBox="0 0 24 24" aria-hidden="true">
      {children}
    </svg>
  );
}

function IconCollapse() {
  return (
    <Icon>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </Icon>
  );
}

function IconSearch() {
  return (
    <Icon>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Icon>
  );
}

// The design shows a right-chevron for a collapsed parent and a
// down-chevron for an expanded one -- this app's tree has no collapse
// state at all (every parent always shows its children), so every node
// with children always gets the "expanded" down-chevron; a leaf gets the
// page icon below instead. No new interaction/state added, just the
// icon that already matches what's on screen.
function IconChevronDown({ small }: { small?: boolean }) {
  return (
    <Icon small={small}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  );
}

function IconPage({ small }: { small?: boolean }) {
  return (
    <Icon small={small}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </Icon>
  );
}

function IconPlus({ small }: { small?: boolean }) {
  return (
    <Icon small={small}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

function IconTemplates() {
  return (
    <Icon>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 4v16" />
    </Icon>
  );
}

function IconTrash({ small }: { small?: boolean }) {
  return (
    <Icon small={small}>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
    </Icon>
  );
}

// Not one of the 13 design artboards (there's no per-row export affordance
// in the design at all) -- a plain download-tray glyph in the same
// stroke style, so it doesn't look out of place next to the ones that are.
function IconExport() {
  return (
    <Icon small>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </Icon>
  );
}

interface DocTreeNode {
  doc: DocSummary;
  children: DocTreeNode[];
}

// Flat list -> tree, built client-side rather than a recursive SQL query --
// this app's own document count is small (a single user's personal notes),
// so there's no real cost to doing this in memory. `docs` arrives already
// sorted by updated_at DESC (listDocs' own ORDER BY); iterating a Map in
// insertion order preserves that within each sibling group. A doc whose own
// parentId points at something not in the current list (filtered out by
// search, or an inconsistency) is treated as a root rather than dropped.
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
  selectedDocId: string | null;
  onOpenDoc: (docId: string) => void;
  onAddChild: (parentId: string) => void;
  onDelete: (docId: string, title: string) => void;
}

// Indentation per level is plain CSS nesting (`.doc-list .doc-list` in
// sidebar.css), not a depth prop threaded through -- each level of
// recursion is one more level of actual DOM nesting, so the same margin
// rule compounds naturally without needing to know its own depth.
function DocTree({ nodes, selectedDocId, onOpenDoc, onAddChild, onDelete }: DocTreeProps) {
  return (
    <ul className="doc-list">
      {nodes.map((node) => {
        const title = node.doc.meta.title || "Untitled";
        const active = node.doc.id === selectedDocId;
        const hasChildren = node.children.length > 0;
        return (
          <li key={node.doc.id} className="doc-tree-node">
            <div className={active ? "doc-list-item active" : "doc-list-item"}>
              <button
                type="button"
                className="doc-list-open"
                aria-current={active ? "page" : undefined}
                onClick={() => onOpenDoc(node.doc.id)}
              >
                {hasChildren ? <IconChevronDown /> : <IconPage />}
                <span className="doc-list-title">{title}</span>
              </button>
              <button
                type="button"
                className="doc-list-add-child"
                aria-label={`New page under ${title}`}
                onClick={() => onAddChild(node.doc.id)}
              >
                <IconPlus small />
              </button>
              {exportAvailable && (
                <button
                  type="button"
                  className="doc-list-export"
                  aria-label={`Export ${title}`}
                  onClick={() => void exportDocumentAsMarkdown(node.doc.id)}
                >
                  <IconExport />
                </button>
              )}
              <button
                type="button"
                className="doc-list-delete"
                aria-label={`Delete ${title}`}
                onClick={() => onDelete(node.doc.id, node.doc.meta.title)}
              >
                <IconTrash small />
              </button>
            </div>
            {hasChildren && (
              <DocTree
                nodes={node.children}
                selectedDocId={selectedDocId}
                onOpenDoc={onOpenDoc}
                onAddChild={onAddChild}
                onDelete={onDelete}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

// The persistent left sidebar (Main.dc.html) in landscape, and the same
// component repositioned into an off-canvas drawer (PortraitDrawer.dc.html)
// in portrait -- `data-collapsed`/`data-drawer-open` are two independent,
// always-set attributes; which one a given breakpoint's CSS actually reacts
// to is decided entirely in sidebar.css's `@media (max-aspect-ratio: 1/1)`
// block, so this component needs no JS-side orientation detection at all
// (none exists anywhere else in this app either -- see UX_PLAN.md Phase 10).
export function Sidebar({
  docs,
  selectedDocId,
  collapsed,
  drawerOpen,
  onDismiss,
  onOpenDoc,
  onNewPage,
  onAddChild,
  onDelete,
}: SidebarProps) {
  const [query, setQuery] = useState("");

  const visibleDocs = docs && query.trim()
    ? docs.filter((doc) => (doc.meta.title || "Untitled").toLowerCase().includes(query.trim().toLowerCase()))
    : docs;
  const tree = visibleDocs ? buildDocTree(visibleDocs) : null;

  return (
    <>
      {drawerOpen && (
        <button type="button" className="sidebar-scrim" aria-label="Close page tree" onClick={onDismiss} />
      )}
      <aside className="sidebar" data-collapsed={collapsed} data-drawer-open={drawerOpen} aria-label="Page tree">
        <div className="sidebar-workspace">
          <div className="sidebar-mark" aria-hidden="true">T</div>
          <div className="sidebar-workspace-labels">
            <span className="sidebar-workspace-name">tinymd</span>
            <span className="sidebar-workspace-sub">Local workspace</span>
          </div>
          <button type="button" className="sidebar-icon-button" aria-label="Close page tree" onClick={onDismiss}>
            <IconCollapse />
          </button>
        </div>

        <label className="sidebar-search">
          <IconSearch />
          <input
            type="search"
            placeholder="Search pages"
            aria-label="Search pages"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>

        <div className="sidebar-section-label">Pages</div>
        <nav aria-label="Page tree" className="sidebar-tree">
          {tree === null ? (
            <p className="sidebar-status">Loading...</p>
          ) : tree.length === 0 ? (
            <p className="sidebar-status">{query.trim() ? "No matching pages." : "No pages yet."}</p>
          ) : (
            <DocTree nodes={tree} selectedDocId={selectedDocId} onOpenDoc={onOpenDoc} onAddChild={onAddChild} onDelete={onDelete} />
          )}
        </nav>

        <div className="sidebar-spacer" />

        <div className="sidebar-footer">
          {/* Cosmetic-only, per UX_PLAN.md Phase 10 -- no templates feature,
              and critically no real soft-delete/undo behind "Trash": the
              existing hard-delete-with-confirm above is unchanged. `disabled`
              communicates that natively rather than silently no-op'ing. */}
          <button type="button" className="sidebar-nav-item" disabled>
            <IconTemplates />
            Templates
          </button>
          <button type="button" className="sidebar-nav-item" disabled>
            <IconTrash />
            Trash
          </button>
          <button type="button" className="sidebar-new-page" onClick={onNewPage}>
            <IconPlus />
            New page
          </button>
        </div>
      </aside>
    </>
  );
}

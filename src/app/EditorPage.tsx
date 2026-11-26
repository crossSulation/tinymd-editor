import { useEffect, useRef, useState } from "react";
import { Editor } from "../view";
import { joinBlocksIntoMarkdown, splitMarkdownIntoBlocks, touch } from "../model";
import type { DocumentMeta } from "../model";
import { createDebouncedSave, loadDoc } from "../control";
import "./editor-page.css";

// Same stroke-icon style as Sidebar.tsx's own icon set (the design's `.ic`
// class, re-declared locally as `.header-icon` -- see that file's own
// comment on why it isn't shared across the two CSS files).
function HamburgerIcon() {
  return (
    <svg className="header-icon" viewBox="0 0 24 24" aria-hidden="true">
      {/* PortraitDrawer.dc.html's own "Open page tree" glyph. */}
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg className="header-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 20l4-1 11-11a2.1 2.1 0 0 0-3-3L5 16z" />
    </svg>
  );
}

function SyncedIcon() {
  return (
    <svg className="header-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 18a4.5 4.5 0 0 1-.5-9A6 6 0 0 1 18 9a4 4 0 0 1-.5 9z" />
      <path d="m9.5 13.5 2 2 3.5-3.5" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg className="header-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function MoreOptionsIcon() {
  return (
    <svg className="header-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="5" cy="12" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="19" cy="12" r="1.2" />
    </svg>
  );
}

export interface EditorPageProps {
  docId: string;
  /** Navigates directly to another document -- used by the breadcrumb to jump to an ancestor page. */
  onOpenDoc: (docId: string) => void;
  /** Re-expands the persistent sidebar if collapsed (landscape only -- the
   *  button that calls this is hidden by CSS in portrait). */
  onExpandSidebar: () => void;
  /** Opens the off-canvas drawer (portrait only -- the button that calls
   *  this is hidden by CSS in landscape). Deliberately a separate prop from
   *  onExpandSidebar, not one combined handler -- see AppShell.tsx. */
  onOpenDrawer: () => void;
}

interface BreadcrumbEntry {
  id: string;
  title: string;
}

// Walks the parent chain via sequential loadDoc calls (root-first order)
// rather than a dedicated bulk query -- this app's own document trees are
// shallow (a personal notes hierarchy, not a large shared wiki), so this is
// simpler than adding a second "ancestor chain" SQL path alongside listDocs'
// existing flat one. The iteration cap is a cheap safety net against a
// hypothetical cycle (not something SET NULL/the lack of reparenting UI
// should ever actually produce), not a real expected case.
async function loadBreadcrumb(parentId: string | null): Promise<BreadcrumbEntry[]> {
  const chain: BreadcrumbEntry[] = [];
  let currentId = parentId;
  for (let i = 0; currentId && i < 50; i++) {
    const doc = await loadDoc(currentId);
    if (!doc) break;
    chain.unshift({ id: currentId, title: doc.meta.title || "Untitled" });
    currentId = doc.parentId;
  }
  return chain;
}

// This page is the app-specific glue (loading/saving a specific document ID)
// around the reusable <Editor> component from src/view/ -- that component
// knows nothing about docIds, SQLite, or navigation, so it can be dropped
// into another project as-is. This page is what's specific to *this* app.
//
// title/author/tags are set once at creation time (AppShell's
// NewDocumentModal) and are not editable here -- there is deliberately no
// metadata-editing UI on this page (see Claude.md's Persistence section).
export function EditorPage({ docId, onOpenDoc, onExpandSidebar, onOpenDrawer }: EditorPageProps) {
  const [meta, setMeta] = useState<DocumentMeta | null>(null);
  const [initialMarkdown, setInitialMarkdown] = useState<string | null>(null);
  const [breadcrumb, setBreadcrumb] = useState<BreadcrumbEntry[]>([]);
  const markdownRef = useRef("");
  const saveRef = useRef<ReturnType<typeof createDebouncedSave> | null>(null);
  // Mirrors `meta` for synchronous reads in handleContentChange -- see that
  // function's own comment for why scheduling a save can't wait on React
  // actually processing a `setMeta` update first.
  const metaRef = useRef<DocumentMeta | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMeta(null);
    setInitialMarkdown(null);
    setBreadcrumb([]);

    void (async () => {
      const doc = await loadDoc(docId);
      if (cancelled || !doc) return;

      const markdown = joinBlocksIntoMarkdown(doc.blocks);
      markdownRef.current = markdown;
      saveRef.current = createDebouncedSave(docId);
      metaRef.current = doc.meta;
      setMeta(doc.meta);
      setInitialMarkdown(markdown);

      const chain = await loadBreadcrumb(doc.parentId);
      if (!cancelled) setBreadcrumb(chain);
    })();

    return () => {
      cancelled = true;
      // Leaving this document (navigating back, or switching to a different
      // docId) must not race the 800ms debounce: a plain `setTimeout` keeps
      // running regardless of this component unmounting, so if the user
      // reopens the SAME document before it fires, the fresh instance's own
      // `loadDoc` can read SQLite before the previous instance's pending
      // write lands -- silently loading stale content. Confirmed directly
      // as a real bug (draw a stroke, immediately go back to the list,
      // immediately reopen the same doc -- the drawing was gone), not
      // theoretical. Flushing here closes that window for ordinary in-app
      // navigation; the visibility/pagehide effect below covers the app
      // being backgrounded/closed instead.
      saveRef.current?.flush();
    };
  }, [docId]);

  // Backgrounding or closing the app (Android home button, switching apps,
  // closing the tab) doesn't unmount this component the way navigating back
  // does, so the cleanup above wouldn't run -- same race, different trigger.
  // `visibilitychange` fires reliably when a mobile WebView is backgrounded;
  // `pagehide` covers an actual page/tab close. Both call the SAME flush,
  // keyed off whichever `saveRef` is current at the time (not stale: this
  // effect reads `saveRef.current` fresh on each call, not a snapshot).
  useEffect(() => {
    const flush = () => saveRef.current?.flush();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", flush);
    };
  }, []);

  function handleContentChange(markdown: string) {
    markdownRef.current = markdown;
    if (!metaRef.current) return;
    // Scheduling the save must happen SYNCHRONOUSLY, right here -- not
    // inside a `setMeta` functional updater. The previous version put
    // `saveRef.current?.(...)` inside that updater, which React only
    // invokes when it actually processes the queued state update; if this
    // component unmounts before that happens (confirmed directly as a real
    // race: draw a stroke, then immediately navigate back and reopen the
    // same doc, before this fix), React abandons the pending update for the
    // unmounting component, the updater's body -- including the call that
    // schedules the save -- never runs at all, and there is nothing left
    // for the unmount-flush fix above to flush. `metaRef` mirrors `meta` so
    // this reads the current value synchronously and schedules the save
    // unconditionally, independent of whether/when React gets around to
    // re-rendering.
    const next = touch(metaRef.current);
    metaRef.current = next;
    setMeta(next);
    saveRef.current?.(next, splitMarkdownIntoBlocks(markdown));
  }

  if (!meta || initialMarkdown === null) {
    return <div className="app-editor">Loading...</div>;
  }

  return (
    <div className="app-editor">
      <div className="editor-page-header">
        {/* Two buttons, same visual slot -- CSS shows only one at a time
            (editor-page.css's own `max-aspect-ratio` breakpoint) so each
            only ever calls the one handler its own breakpoint needs; see
            AppShell.tsx for why a single combined handler was wrong. */}
        <button type="button" className="sidebar-toggle sidebar-toggle-landscape" aria-label="Show page tree" onClick={onExpandSidebar}>
          <HamburgerIcon />
        </button>
        <button type="button" className="sidebar-toggle sidebar-toggle-portrait" aria-label="Open page tree" onClick={onOpenDrawer}>
          <HamburgerIcon />
        </button>
        <nav className="editor-breadcrumb" aria-label="Breadcrumb">
          {/* Separator trails each ancestor rather than leading it, so a
              root-level doc (an empty breadcrumb array) shows no stray "/"
              before its own title -- matches Main.dc.html's own markup
              (a separator BETWEEN segments, none before the first or after
              the last). */}
          {breadcrumb.map((entry) => (
            <span key={entry.id} className="editor-breadcrumb-segment">
              <button type="button" className="editor-breadcrumb-link" onClick={() => onOpenDoc(entry.id)}>
                {entry.title}
              </button>
              <span aria-hidden="true" className="editor-breadcrumb-sep">/</span>
            </span>
          ))}
        </nav>
        <span className="editor-page-title">{meta.title || "Untitled"}</span>

        {/* Main.dc.html's own header chrome (decision 8 / UX_PLAN.md Phase
            9): visual parity only -- no backend, no accounts, no real
            sync/sharing/search behind any of these, per that decision's own
            "purely inert" call. Share/Search/More options take no onClick
            at all (a plain button with none is a genuine no-op, not a
            disabled-looking placeholder the design doesn't show either).
            The pencil-status pill is copied verbatim, same inert treatment
            -- its literal text ties to decision 1's pointerType-based
            mode-switch idea, which was explicitly NOT adopted (this app
            keeps the explicit Draw/Text toggle instead), so it's cosmetic
            parity with the design rather than a true status readout. */}
        <span className="editor-status-pill">
          <PencilIcon />
          Pencil draws · finger edits
        </span>
        <span className="editor-synced-pill">
          <SyncedIcon />
          Synced
        </span>
        <button type="button" className="header-icon-button header-search-button" aria-label="Search in page">
          <SearchIcon />
        </button>
        <button type="button" className="editor-share-button">
          Share
        </button>
        <button type="button" className="header-icon-button" aria-label="More options">
          <MoreOptionsIcon />
        </button>
      </div>
      <Editor className="editor-surface" initialMarkdown={initialMarkdown} onChange={handleContentChange} />
    </div>
  );
}

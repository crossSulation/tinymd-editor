import { useEffect, useRef, useState } from "react";
import { Editor } from "../view";
import { joinBlocksIntoMarkdown, splitMarkdownIntoBlocks, touch } from "../model";
import type { DocumentMeta } from "../model";
import { createDebouncedSave, loadDoc } from "../control";
import "./editor-page.css";

export interface EditorPageProps {
  docId: string;
  onBack: () => void;
  /** Navigates directly to another document -- used by the breadcrumb to jump to an ancestor page. */
  onOpenDoc: (docId: string) => void;
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
// title/author/tags are set once at creation time (HomePage's
// NewDocumentModal) and are not editable here -- there is deliberately no
// metadata-editing UI on this page (see Claude.md's Persistence section).
export function EditorPage({ docId, onBack, onOpenDoc }: EditorPageProps) {
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
        <nav className="editor-breadcrumb" aria-label="Breadcrumb">
          <button type="button" className="back-button" onClick={onBack}>
            ← Home
          </button>
          {breadcrumb.map((entry) => (
            <span key={entry.id} className="editor-breadcrumb-segment">
              <span aria-hidden="true" className="editor-breadcrumb-sep">/</span>
              <button type="button" className="editor-breadcrumb-link" onClick={() => onOpenDoc(entry.id)}>
                {entry.title}
              </button>
            </span>
          ))}
          <span aria-hidden="true" className="editor-breadcrumb-sep">/</span>
        </nav>
        <span className="editor-page-title">{meta.title || "Untitled"}</span>
      </div>
      <Editor className="editor-surface" initialMarkdown={initialMarkdown} onChange={handleContentChange} />
    </div>
  );
}

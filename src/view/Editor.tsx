import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Editor as MilkdownEditor, schemaCtx, editorViewCtx, serializerCtx } from "@milkdown/kit/core";
import type { Transaction } from "@milkdown/kit/prose/state";
import "@milkdown/kit/prose/view/style/prosemirror.css";
import "@milkdown/kit/prose/tables/style/tables.css";
import { buildMilkdownEditor } from "./createMilkdownEditor";
import { createCommands, type EditorCommands } from "./commands";
import { Toolbar } from "./Toolbar";
import { DrawLayer } from "./DrawLayer";
import { ModeHeader, PEN_STYLES, type EditorMode, type PenStyle } from "./ModeHeader";
import { VirtualizedEditorBody } from "./VirtualizedEditorBody";
import { VirtualizedEditorController } from "./virtualizedEditorController";
import { useKeyboardInset } from "./useKeyboardInset";
import "./toolbar.css";
import "./code-block-layout.css";
import "./editor-base.css";
import "./draw-layer.css";
import "./mode-header.css";

// Above this, a single ProseMirror view holding the entire document starts
// costing real keystroke latency (every node gets its own DOM element kept
// in sync on every edit -- see milkdown-chunk-editor's README, which cites
// ProseMirror's own maintainer on this being out of core-library scope).
// Below it, VirtualizedEditorBody's per-chunk-instance approach is pure
// overhead (independent undo history per chunk, no cross-chunk selection --
// real limitations, not worth paying for most documents). A plain character
// count on initialMarkdown is a rough proxy for node count, but it's O(1)
// and available before any parsing, unlike an actual node-count check.
const CHUNK_SIZE_THRESHOLD = 50_000;

export interface EditorProps {
  /** Markdown content the editor is initialized with. Not reactive after mount. */
  initialMarkdown?: string;
  /** Shown while the document is empty. */
  placeholder?: string;
  /** Called with the serialized markdown whenever the document changes. */
  onChange?: (markdown: string) => void;
  className?: string;
}

// Custom mobile-first editor built directly on @milkdown/kit (no Crepe --
// Crepe's prebuilt UI relies on several :hover-revealed affordances, which
// have no equivalent on touch). See Claude.md for why and what's reused.
export function Editor({ initialMarkdown = "", placeholder = "Start typing...", onChange, className }: EditorProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Decided once, from the markdown this component was first mounted with --
  // not reactive the same way initialMarkdown itself isn't (see the effect
  // below). A document doesn't flip editor architecture mid-session just
  // because edits pushed it across the threshold.
  const isVirtualized = useMemo(() => initialMarkdown.length > CHUNK_SIZE_THRESHOLD, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [editor, setEditor] = useState<MilkdownEditor | null>(null);
  const [commands, setCommands] = useState<EditorCommands | null>(null);
  const [, bumpTick] = useState(0);
  const [mode, setMode] = useState<EditorMode>("text");
  const [penStyle, setPenStyle] = useState<PenStyle>(PEN_STYLES[0]!);
  const keyboardInset = useKeyboardInset();
  // The virtualized path's own analogue of "editor still null" below -- a
  // chunk needs to actually mount before DrawLayer can resolve/persist a
  // stroke drawn at a given point (getChunkEditor returns null for
  // anything not yet mounted), which has the identical window-of-ambiguity
  // problem a bare `!editor` check already has for the single-instance
  // path: a stroke drawn before anything mounts falls back to scroll-only
  // anchoring with no visible difference on screen. Set once, on whichever
  // chunk happens to mount first (via onChunkReady below) -- never reset
  // afterward, since later chunks mounting/unmounting doesn't reintroduce
  // the gap (getChunkEditor's own per-point resolution already handles an
  // individual chunk not being mounted gracefully once ink persistence
  // itself is live).
  const [anyChunkMounted, setAnyChunkMounted] = useState(false);
  // Reported up by VirtualizedEditorBody (via its own onPageChange prop) so
  // the page nav bar can be rendered HERE, outside `.editor-content` --
  // see VirtualizedEditorBody.tsx's own doc comment for why it used to
  // render there and had to move (DrawLayer's canvas covers that whole box
  // regardless of normal document flow).
  const [virtualizedPage, setVirtualizedPage] = useState<{ index: number; total: number } | null>(null);
  // DrawLayer's own subscription to the single instance's transaction
  // stream (position remapping for its reflow-anchored strokes) -- a ref,
  // not state, since transactions can fire many times between renders and
  // must be forwarded synchronously and losslessly (see createMilkdownEditor.ts's
  // onTransaction doc comment). Only ever populated for the single-instance
  // path; the virtualized path never calls buildMilkdownEditor with
  // onTransaction (see chunkMount.ts), so this stays unused there.
  const transactionHandlerRef = useRef<((tr: Transaction) => void) | null>(null);

  // Ink-only changes (drawing without touching any text) are persisted via
  // a transaction dispatched with `addToHistory: false` (see
  // inkPersistence.ts's writeInkData) -- @milkdown/plugin-listener's own
  // `apply()` explicitly excludes those from `markdownUpdated` (confirmed
  // directly against its source, not assumed), so the normal
  // onMarkdownUpdated -> onChange autosave chain below never fires for
  // them on its own. This re-serializes and calls onChange directly,
  // bypassing the listener plugin for this one case -- DrawLayer calls it
  // right after a successful ink write (see its onInkPersisted prop).
  function handleInkPersisted() {
    if (!editor) return;
    try {
      const markdown = editor.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc));
      onChangeRef.current?.(markdown);
    } catch {
      // Best-effort -- the next real text edit's own save will catch up anyway.
    }
  }

  // The virtualized path's own chunk-aware equivalents of the refs/handler
  // above -- see DrawLayer.tsx's own doc comment on `getChunkEditor` for why
  // a single "editor" isn't enough there (many independent, transient
  // per-chunk views, not one position space). Only ever populated/used when
  // `isVirtualized`; chunkMount.ts never wires these for the single-instance
  // path (it doesn't go through VirtualizedEditorBody at all).
  const virtualizedControllerRef = useRef<VirtualizedEditorController | null>(null);
  const chunkTransactionHandlerRef = useRef<((chunkId: string, tr: Transaction) => void) | null>(null);
  const chunkReadyHandlerRef = useRef<((chunkId: string, editor: MilkdownEditor) => void) | null>(null);

  // Stable identity (useCallback, not recreated every render) specifically
  // so DrawLayer's own effect that depends on this prop's identity doesn't
  // re-run every time Editor.tsx re-renders -- reads virtualizedControllerRef
  // fresh on every call regardless, so staleness isn't a concern from
  // keeping the function reference itself stable.
  const getChunkEditor = useCallback((chunkId: string) => virtualizedControllerRef.current?.getChunkEditor(chunkId) ?? null, []);

  // Same bypass as handleInkPersisted above, parameterized by chunk id:
  // DrawLayer writes ink directly into a chunk's own live view (obtained via
  // getChunkEditor), which -- same as the single-instance case -- never
  // reaches chunkMount.ts's own dirty-tracking/flush path on its own, since
  // that write is dispatched with addToHistory:false. Re-serializes that
  // SPECIFIC chunk's content and reports it through
  // VirtualizedEditorController's own handleChunkChange (now a public
  // entry point for exactly this reason -- see its own doc comment),
  // reusing the identical "chunk content changed" handling a normal text
  // edit in that chunk already goes through.
  function handleChunkInkPersisted(chunkId: string) {
    const controller = virtualizedControllerRef.current;
    const chunkEditor = controller?.getChunkEditor(chunkId);
    if (!controller || !chunkEditor) return;
    try {
      const markdown = chunkEditor.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc));
      controller.handleChunkChange(chunkId, markdown);
    } catch {
      // Best-effort -- the next real text edit in that chunk's own save will catch up anyway.
    }
  }

  function handleModeChange(next: EditorMode) {
    // Dismiss the keyboard when leaving text mode -- same technique used
    // elsewhere (group panels, code-block exit): nothing about switching to
    // draw mode needs the editor focused, and DrawLayer's canvas already
    // blocks interaction with the text underneath while active regardless,
    // but blurring also lets the toolbar hide itself the normal way (it's
    // driven by keyboardInset, not by mode -- see Toolbar.tsx).
    if (next === "draw" && editor) {
      editor.ctx.get(editorViewCtx).dom.blur();
    }
    setMode(next);
  }

  // Single-document path: one Milkdown instance for the whole document.
  // Skipped entirely in virtualized mode -- VirtualizedEditorBody mounts its
  // own per-chunk instances instead and reports the focused one below.
  useEffect(() => {
    if (isVirtualized) return;
    if (!mountRef.current) return;
    let destroyed = false;

    const milkdownEditor = buildMilkdownEditor({
      mount: mountRef.current,
      initialMarkdown,
      placeholder,
      onMarkdownUpdated: (markdown) => {
        onChangeRef.current?.(markdown);
        bumpTick((n) => n + 1);
      },
      onSelectionUpdated: () => bumpTick((n) => n + 1),
      onTransaction: (tr) => transactionHandlerRef.current?.(tr),
    });

    void milkdownEditor.create().then(() => {
      if (destroyed) {
        void milkdownEditor.destroy();
        return;
      }
      setCommands(createCommands(milkdownEditor.ctx.get(schemaCtx)));
      setEditor(milkdownEditor);
    });

    return () => {
      destroyed = true;
      setEditor(null);
      setCommands(null);
      void milkdownEditor.destroy();
    };
    // initialMarkdown/placeholder only seed the editor on mount; syncing
    // later external changes is a Control-layer concern, not handled here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVirtualized]);

  return (
    <div className={className}>
      <ModeHeader
        mode={mode}
        onModeChange={handleModeChange}
        penStyle={penStyle}
        onPenStyleChange={setPenStyle}
        // Single-instance: its own brief startup window (editor still
        // null). Virtualized: the analogous window before any chunk has
        // mounted yet (see anyChunkMounted's own doc comment) -- not a
        // permanent gate either way; drawing works normally on virtualized
        // documents once at least one chunk is live, same as it always has.
        drawDisabled={isVirtualized ? !anyChunkMounted : !editor}
      />
      {isVirtualized && virtualizedPage && virtualizedPage.total > 1 && (
        <div className="virtualized-page-nav" role="navigation" aria-label="Page navigation">
          <button
            type="button"
            className="virtualized-page-nav-button"
            aria-label="Previous page"
            disabled={virtualizedPage.index <= 0}
            onClick={() => virtualizedControllerRef.current?.scrollToPage(virtualizedPage.index - 1)}
          >
            ‹
          </button>
          <span className="virtualized-page-nav-label">
            Page {virtualizedPage.index + 1} / {virtualizedPage.total}
          </span>
          <button
            type="button"
            className="virtualized-page-nav-button"
            aria-label="Next page"
            disabled={virtualizedPage.index >= virtualizedPage.total - 1}
            onClick={() => virtualizedControllerRef.current?.scrollToPage(virtualizedPage.index + 1)}
          >
            ›
          </button>
        </div>
      )}
      <div className="editor-content">
        {isVirtualized ? (
          <VirtualizedEditorBody
            initialMarkdown={initialMarkdown}
            placeholder={placeholder}
            onChange={onChange}
            keyboardInset={keyboardInset}
            onActiveChange={(active) => {
              setEditor(active?.editor ?? null);
              setCommands(active?.commands ?? null);
            }}
            controllerRef={virtualizedControllerRef}
            onPageChange={setVirtualizedPage}
            onChunkTransaction={(chunkId, tr) => chunkTransactionHandlerRef.current?.(chunkId, tr)}
            onChunkReady={(chunkId, chunkEditor) => {
              setAnyChunkMounted(true);
              chunkReadyHandlerRef.current?.(chunkId, chunkEditor);
            }}
          />
        ) : (
          <div
            ref={mountRef}
            className="editor-mount"
            style={{ "--keyboard-inset": `${keyboardInset}px` } as CSSProperties}
          />
        )}
        <DrawLayer
          active={mode === "draw"}
          penStyle={penStyle}
          // The single, stable instance gets real reflow-anchoring directly
          // against it. The virtualized path's `editor` is whichever chunk
          // currently has focus (a transient, per-chunk view that gets
          // destroyed/recycled independently), not a single position space
          // a stroke could anchor into on its own -- so DrawLayer never
          // anchors against THIS prop for virtualized documents; it uses
          // `getChunkEditor` below instead, which resolves per-point
          // against whichever chunk is actually under that point.
          editor={isVirtualized ? null : editor}
          registerTransactionHandler={(handler) => {
            transactionHandlerRef.current = handler;
          }}
          onInkPersisted={handleInkPersisted}
          // Only set for virtualized documents -- see DrawLayer.tsx's own
          // doc comment on this prop for the chunk-aware anchoring it
          // enables (capture, redraw, and persistence all resolved
          // per-point against whichever chunk is under that point, via
          // this lookup).
          getChunkEditor={isVirtualized ? getChunkEditor : undefined}
          registerChunkTransactionHandler={(handler) => {
            chunkTransactionHandlerRef.current = handler;
          }}
          registerChunkReadyHandler={(handler) => {
            chunkReadyHandlerRef.current = handler;
          }}
          onChunkInkPersisted={handleChunkInkPersisted}
        />
      </div>
      {mode === "text" && editor && commands && <Toolbar editor={editor} commands={commands} />}
    </div>
  );
}

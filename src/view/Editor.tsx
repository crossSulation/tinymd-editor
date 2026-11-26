import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Editor as MilkdownEditor, schemaCtx, editorViewCtx, serializerCtx } from "@milkdown/kit/core";
import type { Transaction } from "@milkdown/kit/prose/state";
import { isTauriAndroid } from "./platform";
import "@milkdown/kit/prose/view/style/prosemirror.css";
import "@milkdown/kit/prose/tables/style/tables.css";
import { buildMilkdownEditor } from "./createMilkdownEditor";
import { createCommands, type EditorCommands } from "./commands";
import { Toolbar } from "./Toolbar";
import { SlashMenu } from "./SlashMenu";
import { FloatingToolbar } from "./floatingToolbar";
import { DrawLayer } from "./DrawLayer";
import { PagingLayer } from "./PagingLayer";
import { PEN_STYLES, type EditorMode, type PenStyle, type DrawAnchorMode } from "./drawTypes";
import { VirtualizedEditorBody } from "./VirtualizedEditorBody";
import { VirtualizedEditorController } from "./virtualizedEditorController";
import { useKeyboardInset } from "./useKeyboardInset";
import { MermaidEditorModal } from "./MermaidEditorModal";
import { insertMermaidDiagram, replaceMermaidDiagram, type MermaidEditRequest } from "./mermaidPreview";
import { CodeBlockEditorModal } from "./CodeBlockEditorModal";
import { insertCodeBlock, replaceCodeBlock, type CodeBlockEditRequest } from "./codeBlockEdit";
import "./toolbar.css";
import "./code-block-layout.css";
import "./editor-base.css";
import "./draw-layer.css";
import "./paging-layer.css";
import "./slash-menu.css";
import "./floating-toolbar.css";
import "./mermaid-editor.css";

// The "/" insert menu is a keyboard-centric affordance with no clear
// mobile-touch equivalent -- web/desktop only (decision 3, UX_PLAN.md).
// Tauri/Android keeps Toolbar's existing tap-to-open Insert group as the
// only insert path, unaffected either way. Checked against isTauriAndroid(),
// not plain isTauri() -- Tauri can also run as a desktop app (Windows/macOS/
// Linux) for local testing, which is keyboard/mouse-centric same as web and
// should keep the slash menu, not get lumped in with Android's constraints.
// Computed once at module load, not per-render -- doesn't change over an
// app session.
const SLASH_MENU_AVAILABLE = !isTauriAndroid();

// The floating selection toolbar (Bold/Italic/Code/Link) -- re-added per
// UX_PLAN.md's decision 2, same isTauriAndroid() gate and reasoning as
// SLASH_MENU_AVAILABLE above (see floatingToolbar.tsx's own doc comment
// for why that's the right gate despite UX_PLAN.md's own decision-2 prose
// literally saying "isTauri()" -- the Android-native-selection-toolbar
// collision this is gated to avoid has no equivalent on Tauri desktop).
const FLOATING_TOOLBAR_AVAILABLE = !isTauriAndroid();

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
  const [anchorMode, setAnchorMode] = useState<DrawAnchorMode>("pin");
  const [pagingMode, setPagingMode] = useState(false);
  // Full-screen Mermaid authoring surface (UX_PLAN.md Phase 6) -- null
  // means closed. Opened by Toolbar.tsx's "Mermaid diagram" insert action
  // or its "Edit diagram" button (shown for a selected Mermaid code
  // block), both via `onOpenMermaidEditor` below; `request.replace` tells
  // `handleMermaidEditorDone` whether to insert a new diagram or replace
  // an existing one at a known position.
  const [mermaidEditRequest, setMermaidEditRequest] = useState<MermaidEditRequest | null>(null);
  // Same pattern as mermaidEditRequest above, for every OTHER code_block
  // (plain code in any language, and LaTeX) -- CodeBlockEditorModal.tsx is
  // the generic counterpart to MermaidEditorModal.tsx, opened by
  // Toolbar.tsx's "Code block"/"LaTeX block" insert items and its generic
  // "Edit" button (any selected code_block whose language ISN'T Mermaid).
  const [codeEditRequest, setCodeEditRequest] = useState<CodeBlockEditRequest | null>(null);
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
  // DrawLayer's own "clear" action, handed up so Toolbar.tsx's draw-tools
  // row can trigger it directly (moved there from DrawLayer's own JSX,
  // requested directly) -- same register-a-callback-into-a-ref pattern as
  // transactionHandlerRef above, since the clearing logic itself still
  // needs to live inside DrawLayer (it touches strokesRef/canvas state that
  // isn't exposed anywhere else).
  const drawClearHandlerRef = useRef<(() => void) | null>(null);

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

  // "Done" in MermaidEditorModal.tsx -- `editor` here is already whichever
  // instance is currently relevant (the single instance, or the
  // virtualized path's currently-focused chunk), same as every other
  // editor.ctx use in this component, so no special virtualized-path
  // handling is needed beyond what already exists.
  //
  // **Both this and `closeMermaidEditor` below explicitly refocus the
  // editor view afterward -- a real bug found and fixed while testing,
  // not a defensive habit.** The modal's own CodeMirror instance takes DOM
  // focus while open (needed to actually type into it), and nothing else
  // ever returns focus to the main ProseMirror view once it closes.
  // Toolbar.tsx's mode derivation treats that exactly like any other
  // "stopped editing text" falling edge -- it silently switched to Draw
  // mode, whose canvas then intercepted every click on content afterward,
  // leaving the whole document looking permanently unresponsive (confirmed
  // directly via CDP: `document.activeElement` stayed unset and typed text
  // never landed, with `.draw-layer[data-active="true"]` present). A plain
  // `view.focus()` after closing restores the normal pre-modal state,
  // exactly like any other modal is expected to return focus on close.
  function handleMermaidEditorDone(source: string) {
    if (editor) {
      if (mermaidEditRequest?.replace) {
        replaceMermaidDiagram(editor.ctx, mermaidEditRequest.replace.pos, mermaidEditRequest.replace.nodeSize, source);
      } else {
        insertMermaidDiagram(editor.ctx, source);
      }
      editor.ctx.get(editorViewCtx).focus();
    }
    setMermaidEditRequest(null);
  }

  function closeMermaidEditor() {
    editor?.ctx.get(editorViewCtx).focus();
    setMermaidEditRequest(null);
  }

  // "Done" in CodeBlockEditorModal.tsx -- same shape and same reasons as
  // handleMermaidEditorDone/closeMermaidEditor above (the explicit
  // view.focus() calls are not optional, see that function's own comment).
  function handleCodeEditorDone(language: string, source: string) {
    if (editor) {
      if (codeEditRequest?.replace) {
        replaceCodeBlock(editor.ctx, codeEditRequest.replace.pos, codeEditRequest.replace.nodeSize, language, source);
      } else {
        insertCodeBlock(editor.ctx, language, source);
      }
      editor.ctx.get(editorViewCtx).focus();
    }
    setCodeEditRequest(null);
  }

  function closeCodeEditor() {
    editor?.ctx.get(editorViewCtx).focus();
    setCodeEditRequest(null);
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
            data-keyboard-open={keyboardInset > 0 || undefined}
            style={{ "--keyboard-inset": `${keyboardInset}px` } as CSSProperties}
          />
        )}
        <DrawLayer
          active={mode === "draw"}
          penStyle={penStyle}
          anchorMode={anchorMode}
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
          registerClearHandler={(handler) => {
            drawClearHandlerRef.current = handler;
          }}
        />
        <PagingLayer active={pagingMode} />
      </div>
      {mode === "text" && editor && commands && SLASH_MENU_AVAILABLE && (
        <SlashMenu editor={editor} commands={commands} onOpenMermaidEditor={setMermaidEditRequest} onOpenCodeEditor={setCodeEditRequest} />
      )}
      {mode === "text" && editor && commands && FLOATING_TOOLBAR_AVAILABLE && <FloatingToolbar editor={editor} commands={commands} />}
      <Toolbar
        editor={editor}
        commands={commands}
        onModeChange={setMode}
        penStyle={penStyle}
        onPenStyleChange={setPenStyle}
        onClearDrawing={() => drawClearHandlerRef.current?.()}
        anchorMode={anchorMode}
        onAnchorModeChange={setAnchorMode}
        pagingMode={pagingMode}
        onPagingModeChange={setPagingMode}
        onOpenMermaidEditor={setMermaidEditRequest}
        onOpenCodeEditor={setCodeEditRequest}
        // Single-instance: its own brief startup window (editor still
        // null). Virtualized: the analogous window before any chunk has
        // mounted yet (see anyChunkMounted's own doc comment) -- not a
        // permanent gate either way; drawing works normally on virtualized
        // documents once at least one chunk is live, same as it always has.
        drawDisabled={isVirtualized ? !anyChunkMounted : !editor}
      />
      {mermaidEditRequest && (
        <MermaidEditorModal
          initialSource={mermaidEditRequest.initialSource}
          onDone={handleMermaidEditorDone}
          onClose={closeMermaidEditor}
        />
      )}
      {codeEditRequest && (
        <CodeBlockEditorModal
          language={codeEditRequest.language}
          initialSource={codeEditRequest.initialSource}
          onDone={handleCodeEditorDone}
          onClose={closeCodeEditor}
        />
      )}
    </div>
  );
}

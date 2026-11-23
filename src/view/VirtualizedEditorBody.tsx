import { useEffect, useRef, type CSSProperties, type MutableRefObject } from "react";
import type { Editor as MilkdownEditor } from "@milkdown/kit/core";
import type { Transaction } from "@milkdown/kit/prose/state";
import { VirtualizedEditorController, type ActiveChunkEditor } from "./virtualizedEditorController";

export interface VirtualizedEditorBodyProps {
  /** Not reactive after mount -- same contract as Editor.tsx's own initialMarkdown. */
  initialMarkdown: string;
  placeholder: string;
  onChange?: (markdown: string) => void;
  /** Mirrors whichever chunk currently has focus, or null -- Editor.tsx feeds this straight into the same editor/commands state Toolbar.tsx already binds to. */
  onActiveChange: (active: ActiveChunkEditor | null) => void;
  /** Same on-screen-keyboard height Editor.tsx applies to the simple path's .editor-mount -- this element IS the scroll container here (see editor-base.css), so it needs the same margin-bottom to keep the caret clear of the keyboard. */
  keyboardInset: number;
  /** Forwarded straight into VirtualizedEditorController's own same-named option -- see its doc comment. DrawLayer.tsx uses this (via Editor.tsx) to remap chunk-anchored ink strokes through each chunk's own edits. */
  onChunkTransaction?: (chunkId: string, tr: Transaction) => void;
  /** Forwarded straight into VirtualizedEditorController's own same-named option -- see its doc comment. DrawLayer.tsx uses this (via Editor.tsx) to (re)rehydrate ink for whichever chunk just became ready. */
  onChunkReady?: (chunkId: string, editor: MilkdownEditor) => void;
  /**
   * Reports the current page/total (or null once there's nothing to show,
   * including on unmount) so Editor.tsx can render the page nav bar itself,
   * OUTSIDE `.editor-content` -- see this component's own doc comment below
   * for why the nav bar used to live here and had to move.
   */
  onPageChange?: (page: { index: number; total: number } | null) => void;
  /**
   * Populated with the live controller instance once mounted (and reset to
   * null on unmount) -- lets Editor.tsx call `getChunkEditor(chunkId)` on
   * demand (e.g. from DrawLayer's own point-capture/resolve/ink-write
   * logic) without this component needing to expose a purpose-built prop
   * for every individual controller method a caller might eventually need.
   */
  controllerRef?: MutableRefObject<VirtualizedEditorController | null>;
}

// Rendered by Editor.tsx in place of its normal single Milkdown instance
// once a document is large enough to trigger virtualization (see
// CHUNK_SIZE_THRESHOLD in Editor.tsx). Splits the document into per-heading
// chunks and mounts only the ones near the viewport, each its own full
// Milkdown instance, instead of one ProseMirror view holding the whole
// document -- see VirtualizedEditorController for the scroll/lifecycle
// orchestration and chunkMount.ts for what each chunk's instance is built
// from.
//
// The page nav bar ("<- Page N/Total ->") is purely a navigation
// affordance on top of that same continuous-scroll virtualization -- "page
// N" is just "chunk index N", and Prev/Next call the controller's
// scrollToPage(), which is a thin wrapper over the already-existing
// scrollToChunk() (VirtualLayout's own scrollTargetFor() + a smooth
// scrollTo()). No separate paginated rendering mode; the scroller, chunk
// split, and recycling machinery are all unchanged.
//
// The nav bar's own UI is NOT rendered here -- it's reported up via
// onPageChange and rendered by Editor.tsx instead, outside `.editor-content`
// entirely (alongside ModeHeader). It used to render here, as a flex-row
// sibling of the scroller inside `.virtualized-editor-body` -- correct in
// normal document flow, but DrawLayer's canvas (`.draw-layer`, `position:
// absolute; inset: 0` against `.editor-content`) covers that ENTIRE box
// regardless of flow, so it visually covered the nav bar too while draw mode
// was active. Moving the nav bar's rendering to a sibling of `.editor-content`
// (same reason ModeHeader/Toolbar already aren't covered) fixes this
// structurally rather than needing a DrawLayer-specific carve-out.
export function VirtualizedEditorBody({
  initialMarkdown,
  placeholder,
  onChange,
  onActiveChange,
  keyboardInset,
  onChunkTransaction,
  onChunkReady,
  onPageChange,
  controllerRef: externalControllerRef,
}: VirtualizedEditorBodyProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<VirtualizedEditorController | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onActiveChangeRef = useRef(onActiveChange);
  onActiveChangeRef.current = onActiveChange;
  const onChunkTransactionRef = useRef(onChunkTransaction);
  onChunkTransactionRef.current = onChunkTransaction;
  const onChunkReadyRef = useRef(onChunkReady);
  onChunkReadyRef.current = onChunkReady;
  const onPageChangeRef = useRef(onPageChange);
  onPageChangeRef.current = onPageChange;

  useEffect(() => {
    if (!scrollerRef.current) return;

    const controller = new VirtualizedEditorController({
      scroller: scrollerRef.current,
      content: initialMarkdown,
      placeholder,
      // Default is 1 (one chunk's worth of mount-ahead in each direction).
      // Raised to 2 so the chunk a user is about to scroll into is already
      // a live Milkdown instance (not just laid out) before it enters the
      // viewport -- the actual per-chunk cost is Editor.make()...create()
      // (ProseMirror/CodeMirror/Mermaid/KaTeX construction), not layout
      // math, so mounting it one screen earlier is what hides that cost,
      // not pre-computing VirtualLayout positions (already sub-millisecond
      // regardless of overscan -- see virtual-layout.ts).
      overscan: 2,
      onChange: (markdown) => onChangeRef.current?.(markdown),
      onActiveChange: (active: ActiveChunkEditor | null) => onActiveChangeRef.current(active),
      onPageChange: (index, total) => onPageChangeRef.current?.({ index, total }),
      onChunkTransaction: (chunkId, tr) => onChunkTransactionRef.current?.(chunkId, tr),
      onChunkReady: (chunkId, editor) => onChunkReadyRef.current?.(chunkId, editor),
    });
    controllerRef.current = controller;
    if (externalControllerRef) externalControllerRef.current = controller;

    void controller.mount();

    return () => {
      controllerRef.current = null;
      if (externalControllerRef) externalControllerRef.current = null;
      controller.destroy();
      onActiveChangeRef.current(null);
      onPageChangeRef.current?.(null);
    };
    // initialMarkdown/placeholder only seed the controller on mount; see
    // Editor.tsx's own identical comment for why this effect intentionally
    // doesn't re-run on later prop changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="virtualized-editor-body">
      <div
        ref={scrollerRef}
        className="editor-mount editor-mount-virtualized"
        style={{ "--keyboard-inset": `${keyboardInset}px` } as CSSProperties}
      />
    </div>
  );
}

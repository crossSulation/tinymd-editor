import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { type Editor as MilkdownEditor, editorViewCtx, schemaCtx } from "@milkdown/kit/core";
import type { Transaction } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { readInkData, writeInkData, INK_SYNC_META, type InkData, type InkStroke } from "./inkPersistence";
import { CONTENT_REPLACE_META } from "./dirtyPlugin";
import type { PenStyle } from "./ModeHeader";

export interface DrawLayerProps {
  /** Whether draw mode is active -- owned by Editor.tsx's ModeHeader, not this component itself. */
  active: boolean;
  /** Current color/width/opacity to paint with -- also selected via ModeHeader. */
  penStyle: PenStyle;
  /**
   * The single-instance path's one stable Milkdown editor, or null --
   * always null for virtualized documents (see `getChunkEditor` below for
   * that path's own equivalent) and for the single-instance path before
   * its one editor instance has finished mounting. New strokes drawn while
   * BOTH this and `getChunkEditor` are unavailable fall back to the
   * simpler scroll-only anchoring (tracks scroll position, not reflow;
   * never persisted).
   */
  editor: MilkdownEditor | null;
  /**
   * Lets DrawLayer subscribe to `editor`'s transaction stream, needed to
   * remap existing PM-anchored strokes through each edit's `tr.mapping` as
   * it happens (see createMilkdownEditor.ts's `onTransaction` option, which
   * Editor.tsx wires this same handler into). Pass `null` to unregister.
   */
  registerTransactionHandler: (handler: ((tr: Transaction) => void) | null) => void;
  /**
   * Called every time `syncInkSingle()` actually writes a change into the
   * single instance's own `ink` node (stroke completed, Clear, or a
   * transaction that moved/pruned a point) -- NOT a generic "something
   * changed" hook, specifically needed because that write is dispatched
   * with `addToHistory: false`, which `@milkdown/plugin-listener`
   * explicitly excludes from its own `markdownUpdated` callback (confirmed
   * directly against its source). Without this, Editor.tsx's normal
   * autosave chain (`onMarkdownUpdated` -> `onChange` -> debounced save)
   * would never fire for an ink-only change -- drawing without also
   * editing text would never actually get saved. Editor.tsx's handler
   * re-serializes the current document and calls the app's own `onChange`
   * directly, bypassing the listener plugin for this one case.
   */
  onInkPersisted: () => void;
  /**
   * Virtualized-path lookup: given a chunk id, the live editor currently
   * representing it, or null if that chunk isn't mounted right now. Set
   * only for virtualized documents (undefined for the single-instance
   * path, where `editor` above is used directly instead). A virtualized
   * document's "currently active" editor (whichever chunk has focus) is a
   * transient, per-chunk view with no single position space spanning the
   * whole document -- so unlike the single-instance path, DrawLayer
   * resolves EACH POINT independently against whichever chunk is actually
   * under it (found via the DOM -- see `findChunkEditorAtPoint`), not one
   * shared editor. A point whose chunk isn't currently mounted simply
   * doesn't resolve/redraw until that chunk is mounted again -- the same
   * graceful-skip behavior `editor` going null already has for the
   * single-instance path, just scoped per point instead of per component.
   */
  getChunkEditor?: (chunkId: string) => MilkdownEditor | null;
  /** Chunked analogue of `registerTransactionHandler` -- fires per chunk, tagged with whichever chunk id that transaction came from. */
  registerChunkTransactionHandler: (handler: ((chunkId: string, tr: Transaction) => void) | null) => void;
  /** Called whenever a chunk instance's content becomes ready to read (initial mount, or after a later recycle/rebind) -- lets DrawLayer (re)rehydrate whatever ink is already stored for whichever chunk that instance now represents. */
  registerChunkReadyHandler: (handler: ((chunkId: string, editor: MilkdownEditor) => void) | null) => void;
  /** Chunked analogue of `onInkPersisted`, parameterized by chunk id -- see that prop's own doc comment for why this bypass is needed at all. */
  onChunkInkPersisted: (chunkId: string) => void;
}

interface PmPoint {
  kind: "pm";
  /** Document position this point is anchored to, in the single-instance editor's own position space. */
  pos: number;
  /**
   * Pixel offset from `pos`'s own on-screen coordinates (`view.coordsAtPos(pos)`)
   * at the moment this point was drawn -- a position's coords are a thin
   * caret-like rect, not literally where the pen touched, so this is what
   * reproduces the actual drawn position rather than snapping every point
   * onto that rect.
   */
  dx: number;
  dy: number;
}

interface PmChunkPoint {
  kind: "pm-chunk";
  /** Which chunk's own position space `pos` belongs to -- a chunk's positions are only meaningful within that chunk's own document, not document-wide. */
  chunkId: string;
  pos: number;
  dx: number;
  dy: number;
}

interface ScrollPoint {
  kind: "scroll";
  /** Viewport (client) x -- this editor never scrolls horizontally, so no scroll compensation is needed on this axis. */
  clientX: number;
  /** Position relative to the scrollable CONTENT, not the viewport: `clientY + scrollTopAtCaptureTime`. */
  yDoc: number;
}

type StrokePoint = PmPoint | PmChunkPoint | ScrollPoint;

interface Stroke {
  points: StrokePoint[];
  penStyle: PenStyle;
}

// A free-floating ink layer over the editor's visible content area. Three
// anchoring strategies, chosen PER POINT at the moment it's drawn (not
// necessarily uniform across a whole stroke, though in practice it always
// is -- which anchoring is available doesn't change mid-gesture):
//
//   - PM-anchored (`editor` present -- the single-instance path only): each
//     point is captured as a real ProseMirror document position (via
//     `view.posAtCoords`) plus a small pixel offset from that position's
//     own on-screen coordinates. `registerTransactionHandler` subscribes to
//     every doc-changing transaction so each point's `pos` can be remapped
//     through `tr.mapping` as edits happen (a point whose anchor content
//     was deleted is dropped, not left pointing at the wrong place) --
//     redrawing afterward via `view.coordsAtPos(pos)` naturally reflects
//     BOTH scroll and reflow, since that call already accounts for
//     whatever the current, post-edit layout actually is.
//   - PM-chunk-anchored (`getChunkEditor` present -- the virtualized path):
//     the same mechanism, but resolved against WHICHEVER chunk is actually
//     under a given point (found via the DOM, see
//     `findChunkEditorAtPoint`) rather than one shared editor, and each
//     point's `pos` is only ever remapped through transactions from its
//     OWN chunk (`registerChunkTransactionHandler`, tagged per chunk).
//   - Scroll-anchored (neither available): the simplest mechanism -- a
//     point is `clientY + scrollTop` at capture time, re-projected as
//     `yDoc - currentScrollTop` on redraw. Tracks scrolling but NOT reflow.
//     This is what either path falls back to during its own brief startup
//     window (before the single instance, or any chunk, has mounted yet --
//     see ModeHeader.tsx's `drawDisabled`, which prevents drawing during
//     that exact window specifically so a stroke never silently lands here
//     when the user would reasonably expect it to persist).
//
// Either way, a scroll event still has to trigger a redraw: `coordsAtPos`
// returns viewport-relative coordinates (like `getBoundingClientRect`), so
// it genuinely reports a different position after a pure scroll with no
// doc change, same as the scroll-anchored math does.
//
// PM-anchored and PM-chunk-anchored strokes both persist across reloads
// (see inkPersistence.ts) -- a chunk's own `ink` node lives in that
// chunk's own markdown, exactly like the single instance's lives in the
// whole document's. Scroll-anchored strokes don't persist -- a raw
// scrollTop has no stable meaning across sessions/devices.
export function DrawLayer({
  active,
  penStyle,
  editor,
  registerTransactionHandler,
  onInkPersisted,
  getChunkEditor,
  registerChunkTransactionHandler,
  registerChunkReadyHandler,
  onChunkInkPersisted,
}: DrawLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const drawingRef = useRef(false);
  // Every completed stroke, as vector data -- the source of truth this
  // canvas is repainted FROM (on scroll, on resize, on every doc-changing
  // transaction) rather than relying on whatever pixels already happen to
  // be baked into the canvas. Needed once strokes have to be redrawn at a
  // different scroll/layout than when they were drawn; a plain raster
  // can't be "re-flowed" on its own.
  const strokesRef = useRef<Stroke[]>([]);
  // The in-progress stroke's points. Re-stroked as one single path on every
  // move (not segment-by-segment) for the same reason the committed-canvas
  // split below exists: semi-transparent pens (the highlighter) need every
  // self-overlapping segment of a path rasterized and alpha-composited
  // ONCE, not once per tiny segment, or the overlapping round joints
  // double-blend into a visibly "bumpy" line instead of a smooth
  // translucent one (confirmed directly -- it looked like a string of
  // pearls).
  const pointsRef = useRef<StrokePoint[]>([]);
  // The "baseline" layer: every COMPLETED stroke, pre-rendered, kept in
  // sync with strokesRef by redrawAll (see its own comment). An offscreen
  // canvas (never attached to the DOM) rather than the ImageData this used
  // to be: restoring an in-progress stroke's baseline on every pointermove
  // used to be a `getImageData` + `putImageData` pair -- a CPU-side,
  // full-canvas pixel-buffer copy, twice, at touch-move event rates.
  // `drawImage` between two canvases is a GPU-backed blit instead, same
  // visual result, far cheaper per move -- the standard "layered canvas"
  // pattern for exactly this kind of interactive-drawing workload. (Also
  // ruled out moving this logic to WASM for the same reason: Canvas 2D
  // already dispatches to native, hardware-accelerated code regardless of
  // the caller's language -- WASM has no direct Canvas/DOM binding of its
  // own, so it would still have to call back into JS to touch this same
  // context, adding a boundary crossing without bypassing anything.)
  const committedCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // Mirrors `editor`/`getChunkEditor` so the scroll/resize effects' own
  // long-lived (`[]`-deps) closures always see the CURRENT value -- those
  // effects intentionally don't re-attach on every prop change. Without
  // this, they'd freeze at whatever these props were when first attached
  // -- null, since the single-instance editor (or the first chunk) hasn't
  // mounted yet at that point -- silently treating every anchored point as
  // unresolvable forever after. Confirmed directly as a real bug for
  // `editor` (the scroll-anchor regression test failed until this was
  // added); `getChunkEditor` gets the identical treatment on the same
  // reasoning, not because it's been independently confirmed to fail the
  // same way.
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const getChunkEditorRef = useRef(getChunkEditor);
  getChunkEditorRef.current = getChunkEditor;

  // The real scroll container differs by path and isn't always present yet
  // when this component mounts: the single-instance path's is Milkdown's
  // own inner `.milkdown` div (inserted only once `editor.create()`
  // resolves -- see editor-page.css), the virtualized path's is
  // `.editor-mount-virtualized` (present immediately). Resolved fresh each
  // call rather than cached, since which one exists can change across the
  // very first render. Only used for scroll-anchored (non-PM) points.
  function getScrollTop(): number {
    const content = containerRef.current?.closest(".editor-content");
    const scroller = content?.querySelector<HTMLElement>(".milkdown, .editor-mount-virtualized");
    return scroller?.scrollTop ?? 0;
  }

  // Shared by capturePoint for both the single-instance and per-chunk
  // cases -- the actual posAtCoords/coordsAtPos dance is identical either
  // way, only WHICH view it runs against differs.
  function captureFromView(view: EditorView, clientX: number, clientY: number): { pos: number; dx: number; dy: number } | null {
    try {
      const found = view.posAtCoords({ left: clientX, top: clientY });
      // Drawing below the last line (this view's own click-past-end space)
      // resolves to nothing -- anchor to the very end of the doc instead,
      // which correctly tracks growth/shrinkage above it the same as any
      // other PM-anchored point.
      const pos = found ? found.pos : view.state.doc.content.size;
      // side: -1 -- see resolveClientPoint's own comment on why the
      // default side (1) can resolve to a degenerate zero rect at a
      // position with nothing meaningfully rendered after it (confirmed
      // directly: exactly this position, end-of-document/click-past-end,
      // is also exactly where this function's own fallback above lands).
      const coords = view.coordsAtPos(pos, -1);
      return { pos, dx: clientX - coords.left, dy: clientY - coords.top };
    } catch {
      return null;
    }
  }

  // Finds which chunk (if any) is actually under a given screen point, and
  // that chunk's own live editor. Deliberately uses `elementsFromPoint`
  // (plural -- the full stack of elements at that point, topmost first),
  // not `elementFromPoint`: this canvas itself sits ABOVE the chunk
  // content (z-index, `pointer-events: auto` while active), so a plain
  // `elementFromPoint` during an actual draw gesture would just return the
  // canvas itself, never reaching the `.milkdown-chunk-root` underneath.
  // `chunkMount.ts` already sets `data-chunk-id` on every chunk root, so no
  // new DOM wiring is needed on that side.
  function findChunkEditorAtPoint(clientX: number, clientY: number): { chunkId: string; editor: MilkdownEditor } | null {
    const getChunk = getChunkEditorRef.current;
    if (!getChunk) return null;
    const stack = document.elementsFromPoint(clientX, clientY);
    for (const el of stack) {
      const chunkId = (el instanceof HTMLElement ? el.closest<HTMLElement>("[data-chunk-id]") : null)?.dataset.chunkId;
      if (!chunkId) continue;
      const chunkEditor = getChunk(chunkId);
      if (chunkEditor) return { chunkId, editor: chunkEditor };
    }
    return null;
  }

  function capturePoint(event: ReactPointerEvent<HTMLCanvasElement>): StrokePoint {
    const liveEditor = editorRef.current;
    if (liveEditor) {
      const result = captureFromView(liveEditor.ctx.get(editorViewCtx), event.clientX, event.clientY);
      if (result) return { kind: "pm", ...result };
    } else {
      const chunkMatch = findChunkEditorAtPoint(event.clientX, event.clientY);
      if (chunkMatch) {
        const result = captureFromView(chunkMatch.editor.ctx.get(editorViewCtx), event.clientX, event.clientY);
        if (result) return { kind: "pm-chunk", chunkId: chunkMatch.chunkId, ...result };
      }
    }
    return { kind: "scroll", clientX: event.clientX, yDoc: event.clientY + getScrollTop() };
  }

  // Resolves a point's CURRENT viewport (client) coordinates. Returns null
  // if an anchored point can no longer be resolved (its editor/chunk isn't
  // currently live, or `coordsAtPos` rejects a position that's technically
  // in-range but otherwise unusable) -- callers skip such points rather
  // than guessing. Reads `editorRef`/`getChunkEditorRef`, not the props
  // directly -- this is called from the scroll/resize effects' long-lived
  // closures (see those refs' own comment for why that matters).
  //
  // `side: -1` is required, not optional polish: with the default side
  // (1, "look at this position from what comes after it"), `coordsAtPos`
  // returns a degenerate ALL-ZERO rect -- not an exception, a normal-looking
  // but wrong result -- for a position sitting at the very end of a text
  // run with nothing meaningfully rendered after it (confirmed directly by
  // logging its raw return value during debugging, not assumed) -- exactly
  // where `captureFromView`'s own end-of-document fallback lands, and
  // reproducible even well after the view has settled (not a layout-timing
  // race: waiting extra animation frames made no difference). `side: -1`
  // ("look at this position from what comes BEFORE it") measures from the
  // actual rendered text instead and resolves correctly every time, focused
  // or not. Without this, a stroke anchored in that click-past-end space
  // silently failed to redraw after every reload (readInkData/rehydration
  // succeeded; only the coordinate lookup for painting it was broken) --
  // confirmed directly as the actual root cause of "drawing doesn't survive
  // reload," not the save path, which turned out to already be correct by
  // this point.
  function resolveClientPoint(point: StrokePoint, scrollTop: number): { clientX: number; clientY: number } | null {
    if (point.kind === "scroll") return { clientX: point.clientX, clientY: point.yDoc - scrollTop };
    const liveEditor = point.kind === "pm" ? editorRef.current : (getChunkEditorRef.current?.(point.chunkId) ?? null);
    if (!liveEditor) return null;
    try {
      const coords = liveEditor.ctx.get(editorViewCtx).coordsAtPos(point.pos, -1);
      return { clientX: coords.left + point.dx, clientY: coords.top + point.dy };
    } catch {
      return null;
    }
  }

  function toCanvasPoints(points: StrokePoint[], scrollTop: number, canvasRect: DOMRect): { x: number; y: number }[] {
    const result: { x: number; y: number }[] = [];
    for (const point of points) {
      const resolved = resolveClientPoint(point, scrollTop);
      if (resolved) result.push({ x: resolved.clientX - canvasRect.left, y: resolved.clientY - canvasRect.top });
    }
    return result;
  }

  // Lazily created rather than up front: the resize effect below is what
  // actually sizes it (same dimensions/dpr-scale as the visible canvas,
  // kept in lockstep every time either resizes), so there's nothing useful
  // to create before that effect's first run anyway.
  function getCommittedCanvas(): HTMLCanvasElement {
    if (!committedCanvasRef.current) committedCanvasRef.current = document.createElement("canvas");
    return committedCanvasRef.current;
  }

  // Copies the committed (all-completed-strokes) canvas onto the visible
  // one -- the GPU-backed `drawImage` blit that replaces the old
  // `putImageData` restore. Both canvases share the same backing
  // resolution AND the same `ctx.scale(dpr, dpr)` transform (see the resize
  // effect below), so a naive `drawImage(committed, 0, 0)` through that
  // transform would draw the source's ALREADY-device-pixel-sized bitmap
  // scaled up by dpr a second time. Resetting to the identity transform for
  // the blit draws it 1:1 in raw device-pixel space instead (exactly what's
  // wanted, since the source bitmap IS already at device-pixel density),
  // then `restore()` puts the dpr-scale transform back for whatever
  // CSS-pixel-space stroking the caller does next.
  function blitCommittedToVisible() {
    const canvas = canvasRef.current;
    const committed = committedCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !committed) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(committed, 0, 0);
    ctx.restore();
  }

  // Repaints every completed stroke from scratch onto the COMMITTED canvas
  // (the whole point of keeping strokes as vector data rather than baked
  // pixels), then blits the result onto the visible one. Also what makes
  // resize (which clears a canvas's pixel buffer as a side effect of
  // reassigning width/height) non-destructive, and what applies a reflow
  // (for PM/PM-chunk-anchored strokes) or a scroll (any kind) after the
  // fact. Also the one place a just-finished stroke gets folded into the
  // committed baseline (see stopDrawing) -- without that, the NEXT stroke's
  // first `blitCommittedToVisible` call would restore a baseline missing
  // the previous one, visibly erasing it the instant a new stroke starts.
  function redrawAll(scrollTop: number) {
    const canvas = canvasRef.current;
    const committed = getCommittedCanvas();
    const committedCtx = committed.getContext("2d");
    if (!canvas || !committedCtx) return;
    const canvasRect = canvas.getBoundingClientRect();
    committedCtx.clearRect(0, 0, committed.width, committed.height);
    for (const stroke of strokesRef.current) {
      const points = toCanvasPoints(stroke.points, scrollTop, canvasRect);
      if (points.length === 0) continue;
      committedCtx.strokeStyle = stroke.penStyle.color;
      committedCtx.lineWidth = stroke.penStyle.width;
      committedCtx.globalAlpha = stroke.penStyle.opacity ?? 1;
      committedCtx.lineCap = "round";
      committedCtx.lineJoin = "round";
      committedCtx.beginPath();
      committedCtx.moveTo(points[0]!.x, points[0]!.y);
      for (let i = 1; i < points.length; i++) committedCtx.lineTo(points[i]!.x, points[i]!.y);
      committedCtx.stroke();
    }
    committedCtx.globalAlpha = 1;
    blitCommittedToVisible();
  }

  function toInkPenStyle(penStyle: PenStyle): InkStroke["penStyle"] {
    return { color: penStyle.color, width: penStyle.width, opacity: penStyle.opacity };
  }

  // Writes the CURRENT set of PM-anchored (single-instance) strokes back
  // into the live document as ink data (see inkPersistence.ts) -- a no-op
  // if `editor` is null or the schema doesn't have the `ink` node for some
  // reason. Points of any other kind are silently excluded: only
  // PM-anchored strokes persist here. Safe to call liberally -- writeInkData
  // itself no-ops when nothing actually changed.
  function syncInkSingle() {
    const liveEditor = editorRef.current;
    if (!liveEditor) return;
    try {
      const view = liveEditor.ctx.get(editorViewCtx);
      const inkType = liveEditor.ctx.get(schemaCtx).nodes.ink;
      if (!inkType) return;
      const strokes: InkStroke[] = [];
      for (const stroke of strokesRef.current) {
        const points = stroke.points.filter((p): p is PmPoint => p.kind === "pm");
        if (points.length === 0) continue;
        strokes.push({ penStyle: toInkPenStyle(stroke.penStyle), points: points.map((p) => ({ pos: p.pos, dx: p.dx, dy: p.dy })) });
      }
      const data: InkData | null = strokes.length > 0 ? { v: 1, strokes } : null;
      if (writeInkData(view, inkType, data)) onInkPersisted();
    } catch {
      // Persistence is best-effort -- drawing itself still works even if
      // this fails (e.g. the view is mid-teardown).
    }
  }

  // Chunked analogue of syncInkSingle: writes only the PM-chunk-anchored
  // points belonging to ONE specific chunk into THAT chunk's own `ink`
  // node (a no-op, including writing null to clear a stale node, if that
  // chunk isn't currently mounted -- callers only ever invoke this while
  // the relevant chunk IS mounted, since both stroke completion and
  // transaction-triggered pruning only ever happen in response to
  // something that chunk's own live view just did).
  function syncInkForChunk(chunkId: string) {
    const chunkEditor = getChunkEditorRef.current?.(chunkId);
    if (!chunkEditor) return;
    try {
      const view = chunkEditor.ctx.get(editorViewCtx);
      const inkType = chunkEditor.ctx.get(schemaCtx).nodes.ink;
      if (!inkType) return;
      const strokes: InkStroke[] = [];
      for (const stroke of strokesRef.current) {
        const points = stroke.points.filter((p): p is PmChunkPoint => p.kind === "pm-chunk" && p.chunkId === chunkId);
        if (points.length === 0) continue;
        strokes.push({ penStyle: toInkPenStyle(stroke.penStyle), points: points.map((p) => ({ pos: p.pos, dx: p.dx, dy: p.dy })) });
      }
      const data: InkData | null = strokes.length > 0 ? { v: 1, strokes } : null;
      if (writeInkData(view, inkType, data)) onChunkInkPersisted(chunkId);
    } catch {
      // Persistence is best-effort -- drawing itself still works even if
      // this fails (e.g. the chunk is mid-recycle/teardown).
    }
  }

  // Keep the canvas's backing resolution matched to its on-screen size
  // (device-pixel-ratio aware) whenever that size changes -- e.g. the
  // keyboard opening/closing resizes .editor-content via --keyboard-inset.
  // Reassigning width/height resets a canvas's own pixel buffer, so this
  // repaints from strokesRef immediately after. The committed (offscreen)
  // canvas is resized in lockstep, same dimensions/scale -- blitCommittedToVisible's
  // identity-transform blit assumes both canvases' backing pixels line up
  // 1:1, which only holds if they're always resized together.
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const committed = getCommittedCanvas();

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      // TEMP DIAGNOSTIC [dz-orient] -- forwarded to adb logcat via Tauri's
      // WebView console bridge. Confirms whether/when the ResizeObserver
      // actually fires after a real device rotation, and with what values.
      // Remove once the orientation-stretch bug is root-caused/fixed.
      // eslint-disable-next-line no-console
      console.log(
        "[dz-orient] resize() fired",
        JSON.stringify({ rectW: rect.width, rectH: rect.height, dpr, winInnerW: window.innerWidth, winInnerH: window.innerHeight }),
      );
      for (const target of [canvas, committed]) {
        target.width = Math.max(1, Math.round(rect.width * dpr));
        target.height = Math.max(1, Math.round(rect.height * dpr));
        target.getContext("2d")?.scale(dpr, dpr);
      }
      redrawAll(getScrollTop());
      // TEMP FIX ATTEMPT [dz-orient] -- confirmed (on a real device) that
      // the visible canvas's OWN attributes/backing buffer already match its
      // live CSS box after a rotation (no mismatch), AND that the stretch
      // persists even with the redrawAll() call above fully disabled, AND
      // that it's isolated to the canvas (surrounding text/UI reflow
      // correctly) -- ruling out both this component's redraw logic and a
      // general WebView-surface/layout problem. That combination points at
      // a stale GPU-COMPOSITED LAYER for this specific canvas: once a
      // canvas is actively drawn to, browsers typically promote it to its
      // own hardware compositing layer for performance, and there's a
      // documented class of Chromium/WebView bug where that layer's cached
      // texture isn't torn down/re-rasterized after a NATIVE (Activity
      // -level, not CSS-driven) reflow, even though the DOM-visible
      // width/height are already correct underneath. This nudges Chromium
      // into actually recompositing the layer: toggling `opacity` by a
      // visually-imperceptible amount and forcing a synchronous style/layout
      // flush (reading `offsetHeight`) in between is a known, narrowly-
      // targeted technique for exactly this "backing store correct but
      // compositor still showing stale content" symptom -- distinct from
      // (and layered on top of) the already-correct canvas-resize logic
      // above, not a replacement for it.
      const prevOpacity = canvas.style.opacity;
      canvas.style.opacity = "0.999999";
      void canvas.offsetHeight;
      canvas.style.opacity = prevOpacity;
      // TEMP DIAGNOSTIC [dz-orient] -- logged AFTER the resize/redraw above,
      // on the next frame, so it reflects the canvas's final state for this
      // pass rather than a value captured mid-update. Compares the canvas's
      // own backing-buffer resolution (what it actually renders at) against
      // its live CSS-rendered box (what the browser displays it at) -- if
      // these two don't agree (after accounting for dpr), the browser is
      // stretching the bitmap to fit the box, which is the specific bug
      // being chased here.
      requestAnimationFrame(() => {
        const liveRect = canvas.getBoundingClientRect();
        const liveDpr = window.devicePixelRatio || 1;
        // eslint-disable-next-line no-console
        console.log(
          "[dz-orient] post-resize canvas state",
          JSON.stringify({
            canvasAttrW: canvas.width,
            canvasAttrH: canvas.height,
            liveCssW: liveRect.width,
            liveCssH: liveRect.height,
            liveDpr,
            expectedAttrW: Math.round(liveRect.width * liveDpr),
            expectedAttrH: Math.round(liveRect.height * liveDpr),
            mismatch: Math.abs(canvas.width - liveRect.width * liveDpr) > 2 || Math.abs(canvas.height - liveRect.height * liveDpr) > 2,
          }),
        );
      });
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    // TEMP DIAGNOSTIC [dz-orient] -- independent of the ResizeObserver
    // above: if the native layer never tells the WebView's own `window`
    // about the size change at all (a deeper issue than this component's
    // own resize logic), plain `window.resize` wouldn't fire either. This
    // listener does nothing but log -- it does NOT drive any actual resize
    // logic -- so comparing whether this fires vs. whether the
    // ResizeObserver-driven `resize()` above fires (and with what values)
    // pinpoints which layer is failing to propagate the rotation.
    const handleWindowResize = () => {
      // eslint-disable-next-line no-console
      console.log(
        "[dz-orient] window resize event",
        JSON.stringify({ innerW: window.innerWidth, innerH: window.innerHeight, dpr: window.devicePixelRatio || 1 }),
      );
    };
    window.addEventListener("resize", handleWindowResize);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", handleWindowResize);
    };
  }, []);

  // Keeps already-drawn strokes aligned with whatever content they were
  // drawn over as the user scrolls -- needed even for PM/PM-chunk-anchored
  // strokes, since `coordsAtPos` returns viewport-relative coordinates
  // that genuinely change after a pure scroll with no doc change at all.
  // Listens in the CAPTURE phase on the always-present `.editor-content`
  // wrapper rather than needing to locate the actual scrolling element up
  // front (see getScrollTop's own comment on why that's not reliably
  // available this early): "scroll" events don't bubble, but capture-phase
  // listeners on an ancestor still fire on the way down to the actual
  // target regardless, so this catches a scroll on either path's real
  // container without needing to know which one is live.
  useEffect(() => {
    const content = containerRef.current?.closest(".editor-content");
    if (!content) return;
    const handleScroll = (event: Event) => {
      redrawAll((event.target as HTMLElement).scrollTop);
    };
    content.addEventListener("scroll", handleScroll, { capture: true, passive: true });
    return () => content.removeEventListener("scroll", handleScroll, { capture: true });
  }, []);

  // Subscribes to the single instance's transaction stream (see
  // createMilkdownEditor.ts's `onTransaction`, fired AFTER the view's own
  // DOM update) so PM-anchored points stay valid and correctly positioned
  // across edits: every surviving point's `pos` is remapped through
  // `tr.mapping`, a point whose anchor content was deleted is dropped (not
  // left pointing at the wrong place), and a redraw always follows --
  // unconditionally, not just when a `pos` numerically changed, since an
  // edit can change downstream layout (e.g. a replacement word that wraps
  // differently) without changing any later position's raw number at all.
  useEffect(() => {
    if (!editor) {
      registerTransactionHandler(null);
      return;
    }

    // Load-time rehydration: read back whatever ink data is already in the
    // document (from a previous session) and repaint it immediately.
    try {
      const data = readInkData(editor.ctx.get(editorViewCtx).state.doc, editor.ctx.get(schemaCtx).nodes.ink!);
      if (data) {
        strokesRef.current = data.strokes.map((stroke) => ({
          penStyle: { id: "restored", label: "Restored", color: stroke.penStyle.color, width: stroke.penStyle.width, opacity: stroke.penStyle.opacity },
          points: stroke.points.map((p): PmPoint => ({ kind: "pm", pos: p.pos, dx: p.dx, dy: p.dy })),
        }));
        redrawAll(getScrollTop());
      }
    } catch {
      // Malformed/missing ink data shouldn't block the editor from loading.
    }

    const handleTransaction = (tr: Transaction) => {
      // Our own ink-write transactions (writeInkData, tagged INK_SYNC_META)
      // must be excluded here, not just processed like any other edit --
      // see inkPersistence.ts's own comment on INK_SYNC_META for the
      // feedback loop this prevents (a point anchored at the document's end
      // colliding with the ink node's own always-at-the-end insertion
      // point).
      if (tr.getMeta(INK_SYNC_META)) return;
      let changed = false;
      for (const stroke of strokesRef.current) {
        for (let i = stroke.points.length - 1; i >= 0; i--) {
          const point = stroke.points[i]!;
          if (point.kind !== "pm") continue;
          const result = tr.mapping.mapResult(point.pos);
          if (result.deleted) {
            stroke.points.splice(i, 1);
            changed = true;
            continue;
          }
          if (result.pos !== point.pos) changed = true;
          point.pos = result.pos;
        }
      }
      const before = strokesRef.current.length;
      strokesRef.current = strokesRef.current.filter((stroke) => stroke.points.length > 0);
      if (strokesRef.current.length !== before) changed = true;
      redrawAll(getScrollTop());
      // Deferred, not dispatched synchronously from here: this callback
      // itself runs INSIDE the dispatchTransaction override that's
      // currently applying `tr` (see createMilkdownEditor.ts's
      // onTransaction). view.updateState() for `tr` has already completed
      // by this point, so dispatching another transaction is well-defined,
      // but pushing it to a microtask keeps this handler itself simple and
      // side-effect-light regardless, and avoids any question about
      // dispatching a second transaction from inside the first one's own
      // completion callback.
      if (changed) queueMicrotask(syncInkSingle);
    };
    registerTransactionHandler(handleTransaction);
    return () => registerTransactionHandler(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // The chunked analogue of the effect above -- active only for virtualized
  // documents (`getChunkEditor` provided). Keyed on `[getChunkEditor]`
  // rather than per-chunk: that prop's identity is stable for the whole
  // document's lifetime (Editor.tsx wraps it in useCallback), so this
  // effect runs (registers its handlers) exactly once, and the SAME two
  // handlers below naturally handle every chunk that ever mounts over the
  // controller's lifetime, not just whichever chunk happened to be live
  // when this effect last ran.
  useEffect(() => {
    if (!getChunkEditor) {
      registerChunkReadyHandler(null);
      registerChunkTransactionHandler(null);
      return;
    }

    // Fires once per chunk instance becoming ready to read -- initial
    // mount AND every later recycle/rebind (a recycled instance holds
    // entirely different content, and therefore different ink, each time).
    // Always treats the document as the source of truth: any existing
    // in-memory points for this chunk id are dropped and replaced with
    // whatever's freshly read, rather than trying to reconcile/merge --
    // simpler, and correct regardless of whether this is this chunk's
    // first-ever mount this session or a recycle bringing it back.
    const handleChunkReady = (chunkId: string, chunkEditor: MilkdownEditor) => {
      try {
        const data = readInkData(chunkEditor.ctx.get(editorViewCtx).state.doc, chunkEditor.ctx.get(schemaCtx).nodes.ink!);
        for (const stroke of strokesRef.current) {
          stroke.points = stroke.points.filter((p) => !(p.kind === "pm-chunk" && p.chunkId === chunkId));
        }
        strokesRef.current = strokesRef.current.filter((stroke) => stroke.points.length > 0);
        if (data) {
          for (const stroke of data.strokes) {
            strokesRef.current.push({
              penStyle: { id: "restored", label: "Restored", color: stroke.penStyle.color, width: stroke.penStyle.width, opacity: stroke.penStyle.opacity },
              points: stroke.points.map((p): PmChunkPoint => ({ kind: "pm-chunk", chunkId, pos: p.pos, dx: p.dx, dy: p.dy })),
            });
          }
        }
        redrawAll(getScrollTop());
      } catch {
        // Malformed/missing ink data shouldn't block this chunk from mounting.
      }
    };

    // Per-chunk analogue of handleTransaction above -- only ever touches
    // points anchored to THIS specific chunk id, remapped through THIS
    // chunk's own transaction. Excludes both INK_SYNC_META (this chunk's
    // own ink-write transactions -- same feedback-loop reasoning as the
    // single-instance case) AND CONTENT_REPLACE_META (a recycle/rebind
    // swapping this instance to represent an entirely different chunk --
    // remapping THIS chunk's old points through a full content replacement
    // is meaningless, and unnecessary regardless: those points simply stop
    // resolving once the chunk-id-to-instance mapping changes, handled
    // separately by handleChunkReady re-reading fresh data for whichever
    // chunk this instance represents now).
    const handleChunkTransaction = (chunkId: string, tr: Transaction) => {
      if (tr.getMeta(INK_SYNC_META) || tr.getMeta(CONTENT_REPLACE_META)) return;
      let changed = false;
      for (const stroke of strokesRef.current) {
        for (let i = stroke.points.length - 1; i >= 0; i--) {
          const point = stroke.points[i]!;
          if (point.kind !== "pm-chunk" || point.chunkId !== chunkId) continue;
          const result = tr.mapping.mapResult(point.pos);
          if (result.deleted) {
            stroke.points.splice(i, 1);
            changed = true;
            continue;
          }
          if (result.pos !== point.pos) changed = true;
          point.pos = result.pos;
        }
      }
      const before = strokesRef.current.length;
      strokesRef.current = strokesRef.current.filter((stroke) => stroke.points.length > 0);
      if (strokesRef.current.length !== before) changed = true;
      redrawAll(getScrollTop());
      // Deferred for the identical reason the single-instance case defers
      // it -- see that handler's own comment.
      if (changed) queueMicrotask(() => syncInkForChunk(chunkId));
    };

    registerChunkReadyHandler(handleChunkReady);
    registerChunkTransactionHandler(handleChunkTransaction);
    return () => {
      registerChunkReadyHandler(null);
      registerChunkTransactionHandler(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getChunkEditor]);

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    drawingRef.current = true;
    // No snapshot to capture here anymore -- the committed canvas is
    // already kept continuously in sync by redrawAll, so it's always a
    // valid baseline to blit from on the very first move of a new stroke.
    pointsRef.current = [capturePoint(event)];
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    pointsRef.current.push(capturePoint(event));
    // GPU-backed blit of the committed baseline, replacing the old
    // getImageData/putImageData pair -- see committedCanvasRef's own
    // comment for why.
    blitCommittedToVisible();

    const points = toCanvasPoints(pointsRef.current, getScrollTop(), canvas.getBoundingClientRect());
    if (points.length === 0) return;

    ctx.strokeStyle = penStyle.color;
    ctx.lineWidth = penStyle.width;
    ctx.globalAlpha = penStyle.opacity ?? 1;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(points[0]!.x, points[0]!.y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i]!.x, points[i]!.y);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function stopDrawing() {
    if (drawingRef.current && pointsRef.current.length > 0) {
      strokesRef.current.push({ points: pointsRef.current, penStyle });
      if (editorRef.current) {
        syncInkSingle();
      } else {
        // A stroke's points are all the same kind in practice (which
        // anchoring is available doesn't change mid-gesture), but this
        // iterates distinct chunk ids defensively rather than assuming
        // exactly one, in case a stroke ever does span a chunk boundary.
        const chunkIds = new Set(pointsRef.current.filter((p): p is PmChunkPoint => p.kind === "pm-chunk").map((p) => p.chunkId));
        for (const chunkId of chunkIds) syncInkForChunk(chunkId);
      }
      // Folds the just-finished stroke into the committed baseline -- see
      // redrawAll's own comment on why this can't be skipped.
      redrawAll(getScrollTop());
    }
    drawingRef.current = false;
    pointsRef.current = [];
  }

  function clear() {
    // Captured before clearing strokesRef -- these are exactly the chunks
    // (if any) that need an explicit null-write to remove their now-stale
    // ink node; a chunk with no tracked strokes here has nothing to clear
    // (either it never had ink, or it's not currently mounted and this
    // session never rehydrated/wrote anything for it).
    const chunkIds = new Set(strokesRef.current.flatMap((s) => s.points.filter((p): p is PmChunkPoint => p.kind === "pm-chunk").map((p) => p.chunkId)));
    const hadSingle = !!editorRef.current;
    strokesRef.current = [];
    // Clears both the committed and visible canvases (0 strokes to redraw),
    // rather than a direct clearRect on just the visible one -- the
    // committed canvas needs to reflect "nothing drawn" too, or the next
    // stroke's first blitCommittedToVisible would resurrect the "cleared" ink.
    redrawAll(getScrollTop());
    if (hadSingle) syncInkSingle();
    for (const chunkId of chunkIds) syncInkForChunk(chunkId);
  }

  return (
    <div ref={containerRef} className="draw-layer" data-active={active || undefined}>
      <canvas
        ref={canvasRef}
        className="draw-layer-canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={stopDrawing}
        onPointerCancel={stopDrawing}
        onPointerLeave={stopDrawing}
      />
      {active && (
        <div className="draw-layer-controls">
          <button type="button" className="draw-layer-clear" onClick={clear} aria-label="Clear drawing">
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

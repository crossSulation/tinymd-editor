import {
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
  type TouchList as ReactTouchList,
} from "react";
import { type Editor as MilkdownEditor, editorViewCtx, schemaCtx } from "@milkdown/kit/core";
import type { Transaction } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { readInkData, writeInkData, INK_SYNC_META, type InkData, type InkStroke } from "./inkPersistence";
import { CONTENT_REPLACE_META } from "./dirtyPlugin";
import type { PenStyle, DrawAnchorMode } from "./ModeHeader";
import { strokeOutlineToPath2D } from "./freehandStroke";

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
  /**
   * Which of ModeHeader's two draw modes is currently selected -- see
   * `DrawAnchorMode`'s own doc comment. "sketch" makes `capturePoint` skip
   * the rigid-anchoring attempt entirely (even though an editor/chunk IS
   * live) and every point captures as scroll-anchored instead -- the same
   * mechanism already used as an automatic startup-window fallback, now
   * also reachable as a deliberate, user-chosen mode for strokes that are
   * "just drawing," not markup meant to track specific text. "pin"
   * resolves ONE shared anchor position for the whole gesture -- the
   * nearest enclosing textblock (paragraph/heading/table-cell-paragraph/
   * etc.) under wherever the stroke STARTS -- and every point of that
   * stroke stores only its pixel offset from that one shared position; see
   * `resolveRigidAnchor`'s own comment for why this makes a "pin" stroke
   * translate as one rigid, undistorted unit. A third, no-longer-
   * selectable kind of point ("markup", per-point reflow) can still be
   * read from an existing document -- see this file's own top-of-file
   * comment. Each kind of stroke is correspondingly included/excluded from
   * `handleTransaction`/`handleChunkTransaction`'s remapping and from
   * `syncInkSingle`/`syncInkForChunk`'s persistence purely via the
   * captured point's own `kind` -- no separate gating needed at those call
   * sites.
   */
  anchorMode: DrawAnchorMode;
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

// "Pin" mode's whole-stroke-rigid analogue of PmPoint/PmChunkPoint: same
// shape (a position plus a pixel offset from it), but every point of ONE
// stroke shares the IDENTICAL `pos` -- the stroke's single resolved block
// anchor (see `resolveRigidAnchor`) -- rather than each point having its
// own independently-captured position. This is what makes the existing
// per-point remapping loops in handleTransaction/handleChunkTransaction
// produce RIGID (not reflowing) behavior for free, with no new remapping
// logic needed: `tr.mapping` is a deterministic function of position, so
// every point maps to the identical new position together, and if the
// shared anchor's content is deleted, every point is pruned together in
// the same transaction -- the whole stroke naturally falls to zero points
// and gets filtered out by the already-existing empty-stroke filter.
interface PmRigidPoint {
  kind: "pm-rigid";
  pos: number;
  dx: number;
  dy: number;
}

interface PmChunkRigidPoint {
  kind: "pm-chunk-rigid";
  chunkId: string;
  pos: number;
  dx: number;
  dy: number;
}

type StrokePoint = PmPoint | PmChunkPoint | PmRigidPoint | PmChunkRigidPoint | ScrollPoint;

interface Stroke {
  points: StrokePoint[];
  penStyle: PenStyle;
  /**
   * Real per-point `PointerEvent.pressure`, index-aligned with `points` --
   * only ever present for a stroke drawn with `pointerType === "pen"` (see
   * `pressuresRef`). Safe to prune/filter `points` without keeping this in
   * sync: a pressure-carrying stroke can only be "pin"/"pin-chunk" kind
   * (the only modes a NEW stroke can be drawn as -- see `capturePoint`),
   * and every point of a rigid stroke shares the SAME anchor `pos`, so
   * remapping/pruning in handleTransaction/handleChunkTransaction is
   * always all-or-nothing for the whole stroke, never a partial subset of
   * points -- there is no scenario where `points` shrinks to a PARTIAL
   * selection that would leave this array's indices misaligned.
   */
  pressures?: number[];
}

/** The one shared anchor resolved for a "pin"-mode gesture -- see `resolveRigidAnchor`. */
type RigidAnchor = { kind: "pm-rigid"; pos: number } | { kind: "pm-chunk-rigid"; chunkId: string; pos: number };

// Caps point collection during a gesture to roughly one sample per display
// frame at 60fps -- touch/mouse input can fire `pointermove` well above
// that rate (some digitizers/trackpads report at 90-240Hz), and both the
// per-point capture cost (`pin` mode's own `coordsAtPos` lookup) and the
// per-move redraw cost (`toCanvasPoints` resolving EVERY point of the
// stroke so far, then perfect-freehand's own `getStroke` recomputing the
// whole outline from scratch) scale with how many points the stroke has
// accumulated -- sampling faster than the screen can even repaint adds CPU
// work with no visible benefit, and makes that per-move cost grow needlessly
// faster as a long stroke accumulates points it never needed to capture.
const SAMPLE_INTERVAL_MS = 16;

// A second finger joining this soon after the first touched down is
// treated as "the user was still getting both fingers down for a
// two-finger scroll," not a deliberate single-finger stroke -- whatever
// was drawn in that brief window is DISCARDED (not committed) once
// panning starts. Confirmed directly as a real, user-visible gap, not
// theoretical: without this, EVERY two-finger scroll attempt left a tiny
// stray mark from the first finger's own brief touch-and-slight-move
// before the second finger landed (natural hand tremor/positioning, not
// an intentional stroke). Outside this window, a second finger joining
// means the user had already been drawing for a while -- that stroke is
// genuine and still gets committed normally (same as lifting the first
// finger on its own would).
const TWO_FINGER_GRACE_MS = 250;

// A free-floating ink layer over the editor's visible content area. A NEW
// stroke is captured one of two ways, per ModeHeader's Pin/Sketch toggle:
//
//   - PM-rigid / PM-chunk-rigid ("pin" mode, the default): ONE anchor
//     position is resolved for the whole gesture (the nearest enclosing
//     textblock under wherever the stroke starts -- see
//     `resolveRigidAnchor`'s own comment for the full design), and every
//     point stores only its pixel offset from that single shared position.
//     `registerTransactionHandler`/`registerChunkTransactionHandler`
//     remap every point's `pos` through `tr.mapping` as edits happen --
//     since every point of a rigid stroke shares the same starting `pos`,
//     `tr.mapping`'s determinism makes them all move together as one
//     rigid, undistorted unit, and if the shared anchor is deleted, every
//     point is pruned in the same transaction, so the whole stroke
//     disappears as a unit rather than partially distorting.
//   - Scroll-anchored ("sketch" mode, or a startup-window/resolution
//     fallback): the simplest mechanism -- a point is `clientY + scrollTop`
//     at capture time, re-projected as `yDoc - currentScrollTop` on redraw.
//     Tracks scrolling but NOT reflow, and never persists. Reached two
//     different ways: automatically, during either path's own brief
//     startup window (before the single instance, or any chunk, has
//     mounted yet -- see ModeHeader.tsx's `drawDisabled`, which prevents
//     drawing during that exact window specifically so a stroke never
//     silently lands here when the user would reasonably expect it to
//     persist); or deliberately, via ModeHeader.tsx's Pin/Sketch toggle
//     (`anchorMode` prop, see `DrawAnchorMode`'s own doc comment) -- a
//     user-chosen "just drawing, not markup on this specific text" mode,
//     for strokes that shouldn't reshape/disappear/translate at all as the
//     surrounding content is edited.
//
// A THIRD kind of point, PM/PM-chunk ("markup": each point captured and
// remapped independently, so a stroke could reflow/distort as its own
// specific span was edited), can still be READ from an existing document
// (`InkStroke.rigid` unset) and fully participates in the same
// remapping/redraw/persistence machinery as PM-rigid/PM-chunk-rigid below
// -- but `capturePoint` can no longer PRODUCE one: it existed briefly as a
// third user-selectable mode and was removed (confirmed too unpredictable
// in practice -- a stroke spanning edited content could visibly
// stretch/shrink, exactly the failure "pin" fixes). Keeping full read/
// render support for it is what lets a document drawn before this change
// keep working with no migration.
//
// Either way, a scroll event still has to trigger a redraw: `coordsAtPos`
// returns viewport-relative coordinates (like `getBoundingClientRect`), so
// it genuinely reports a different position after a pure scroll with no
// doc change, same as the scroll-anchored math does.
//
// PM-rigid, PM-chunk-rigid, and (read-only) PM/PM-chunk strokes all persist
// across reloads (see inkPersistence.ts, `InkStroke.rigid`) -- a chunk's
// own `ink` node lives in that chunk's own markdown, exactly like the
// single instance's lives in the whole document's. Scroll-anchored strokes
// don't persist -- a raw scrollTop has no stable meaning across
// sessions/devices.
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
  anchorMode,
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
  // The in-progress stroke's points. Re-rendered as one single filled
  // perfect-freehand outline on every move (not segment-by-segment), for
  // the same underlying reason the committed-canvas split below exists:
  // semi-transparent pens (the highlighter) need every self-overlapping
  // region of a shape rasterized and alpha-composited ONCE, not once per
  // tiny segment, or overlapping regions double-blend into a visibly
  // "bumpy" look instead of a smooth translucent one (confirmed directly,
  // back when this was a stroked polyline rather than a filled outline --
  // it looked like a string of pearls). A single `ctx.fill()` of one
  // outline polygon (see freehandStroke.ts) gets this for free: Canvas2D's
  // nonzero fill rule resolves a self-intersecting path's overlap as part
  // of rasterizing ONE shape, with `globalAlpha` applied once across all
  // of it -- not as separately-composited regions the way stroking the
  // same self-overlapping path segment-by-segment would.
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
  const anchorModeRef = useRef(anchorMode);
  anchorModeRef.current = anchorMode;
  // Holds the ONE anchor resolved for "pin" mode's current gesture --
  // populated on the first `capturePoint` call after `handlePointerDown`
  // resets it to null, then reused (not re-resolved) by every later point
  // of the SAME gesture. This is what actually guarantees rigidity: every
  // point of one stroke sharing this identical ref value is what makes them
  // all carry the identical `pos`, not just a coincidence of where the
  // pointer happened to move.
  const rigidAnchorRef = useRef<RigidAnchor | null>(null);
  // The `timeStamp` (DOMHighResTimeStamp, same clock as `performance.now()`)
  // of the last point actually captured during the current gesture -- see
  // `SAMPLE_INTERVAL_MS`'s own comment. Reset on every `handlePointerDown`
  // to that event's own timestamp, not left at whatever a PREVIOUS gesture
  // last set it to -- otherwise a new stroke started very soon after the
  // last one ended could have its own first pointermove incorrectly
  // throttled against a stale timestamp from the unrelated earlier gesture.
  const lastSampleTimeRef = useRef(0);
  // Fixed at the CURRENT gesture's own `pointerdown` timestamp, unlike
  // `lastSampleTimeRef` (which is overwritten by every later move, for
  // throttling) -- lets `handleTouchMove` tell "a second finger joined
  // almost immediately" from "this was already a real, ongoing
  // single-finger stroke" (see `TWO_FINGER_GRACE_MS`'s own comment).
  const gestureStartTimeRef = useRef(0);
  // Real per-point pressure for the CURRENT gesture, index-aligned with
  // `pointsRef` -- only collected when that gesture's own `pointerdown`
  // reported `pointerType === "pen"` (a real stylus/electronic pen, which
  // reports pressure reliably), null otherwise (touch/mouse, where
  // `PointerEvent.pressure` is a meaningless constant on most devices/
  // browsers -- perfect-freehand's own velocity-based `simulatePressure`
  // is used for those instead, see freehandStroke.ts). Decided once per
  // gesture at `pointerdown`, same granularity as `rigidAnchorRef` --
  // nothing in practice switches input device mid-stroke.
  const pressuresRef = useRef<number[] | null>(null);
  // True from the moment a second finger joins until every finger lifts --
  // while true, `handlePointerMove` skips drawing entirely (the actual pan
  // scroll is driven by native touch events instead, see below), and
  // drawing does NOT resume just because the touch count drops back to 1
  // (waits for a fresh single-finger gesture instead), avoiding a surprise
  // stroke starting from wherever a remaining finger happens to be.
  const isPanningRef = useRef(false);
  // The average client Y of all active TOUCHES as of the last pan-relevant
  // move -- deltas between consecutive averages drive the scroll, not an
  // absolute position (so panning starts smoothly from wherever the second
  // finger actually touched down, not from 0).
  const panLastYRef = useRef(0);

  // Driven by native `TouchEvent`s (`event.touches`, see the `onTouchMove`
  // handler below), NOT `PointerEvent` dispatch counting -- a second
  // finger's own `pointerdown` is NOT a reliable signal for this on a real
  // Android WebView (confirmed directly: a synthetic-PointerEvent-based
  // CDP test of exactly this logic passed, but real on-device two-finger
  // touch still drew instead of scrolling -- pointing at a real device/
  // WebView-specific gap in per-touch pointer-event dispatch, not a logic
  // bug). `TouchEvent.touches` is the browser's own single, authoritative
  // list of every finger currently down, with no per-element dispatch
  // ambiguity for additional simultaneous touches the way waiting on each
  // one's own separate `pointerdown` has. The standard "one finger draws,
  // two (or more) fingers scroll" convention (Notability/GoodNotes/
  // Procreate etc. all do this).
  function averageTouchY(touches: ReactTouchList): number {
    let sum = 0;
    for (let i = 0; i < touches.length; i++) sum += touches[i]!.clientY;
    return touches.length > 0 ? sum / touches.length : 0;
  }

  function handleTouchMove(event: ReactTouchEvent<HTMLCanvasElement>) {
    if (event.touches.length < 2) return;
    const currentY = averageTouchY(event.touches);
    if (!isPanningRef.current) {
      // First multi-touch move detected. A second finger joining THIS
      // SOON after the first touched down means the user was still
      // getting both fingers down for a scroll -- whatever that brief
      // touch-and-slight-move drew is incidental, not an intentional
      // stroke, so it's discarded rather than committed (see
      // TWO_FINGER_GRACE_MS's own comment). Outside that window, this is
      // a real, ongoing single-finger stroke -- commit it normally, same
      // as lifting that finger on its own would.
      if (drawingRef.current && event.timeStamp - gestureStartTimeRef.current < TWO_FINGER_GRACE_MS) {
        discardDrawing();
      } else {
        stopDrawing();
      }
      isPanningRef.current = true;
      panLastYRef.current = currentY;
      return;
    }
    const deltaY = panLastYRef.current - currentY;
    panLastYRef.current = currentY;
    const scroller = getScroller();
    if (scroller) scroller.scrollTop += deltaY;
  }

  function handleTouchEnd(event: ReactTouchEvent<HTMLCanvasElement>) {
    if (isPanningRef.current && event.touches.length < 2) {
      isPanningRef.current = false;
    }
  }

  // The real scroll container differs by path and isn't always present yet
  // when this component mounts: the single-instance path's is Milkdown's
  // own inner `.milkdown` div (inserted only once `editor.create()`
  // resolves -- see editor-page.css), the virtualized path's is
  // `.editor-mount-virtualized` (present immediately). Resolved fresh each
  // call rather than cached, since which one exists can change across the
  // very first render. Only used for scroll-anchored (non-PM) points.
  function getScroller(): HTMLElement | null {
    const content = containerRef.current?.closest(".editor-content");
    return content?.querySelector<HTMLElement>(".milkdown, .editor-mount-virtualized") ?? null;
  }

  function getScrollTop(): number {
    return getScroller()?.scrollTop ?? 0;
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

  // Resolves the nearest enclosing TEXTBLOCK (paragraph/heading/a table
  // cell's own paragraph/etc. -- anything `NodeType.isTextblock`) under a
  // screen point, returning the position right at the start of that
  // block's own content (`$pos.start(d)`, NOT `$pos.before(d)`): a position
  // strictly INSIDE the block's own content range is required for the
  // "delete the whole stroke if its anchor block is fully deleted" behavior
  // to fall out of the existing remapping loops for free -- a position
  // sitting exactly AT a deleted range's boundary (which `before(d)` would,
  // since deleting a whole node conventionally deletes the half-open range
  // `[before(d), after(d))`) is NOT marked `deleted` by ProseMirror's own
  // mapping (boundary positions survive a deletion, by design), so it would
  // silently survive instead of correctly vanishing. `start(d)` sits
  // strictly inside that range, so it IS marked deleted when the whole
  // block goes away, while still surviving (correctly) if only the block's
  // TEXT is deleted, leaving an empty-but-still-present block behind.
  // Deliberately paragraph-granularity, not per-character, same as Word's
  // own whole-object-anchored-to-one-paragraph behavior this mode is
  // modeled on -- walking to the NEAREST (innermost) textblock ancestor
  // means a point inside a table cell anchors to that cell's own
  // paragraph, which is exactly the granularity that fixes the original
  // bug report (a stroke spanning several table rows no longer
  // stretches/shrinks as unrelated rows are inserted/deleted elsewhere,
  // since it's rigidly anchored to whichever single row/cell it started
  // in).
  function resolveBlockAnchorPos(view: EditorView, clientX: number, clientY: number): number | null {
    try {
      const found = view.posAtCoords({ left: clientX, top: clientY });
      const pos = found ? found.pos : view.state.doc.content.size;
      const $pos = view.state.doc.resolve(pos);
      for (let d = $pos.depth; d > 0; d--) {
        if ($pos.node(d).isTextblock) return $pos.start(d);
      }
      return pos;
    } catch {
      return null;
    }
  }

  // "Pin" mode's entry point: resolves the ONE anchor a whole gesture will
  // share, against whichever of the single-instance editor or a virtualized
  // chunk is actually live under the given point -- same editor/chunk
  // resolution as capturePoint's "markup" branch, just producing a single
  // block-granularity position instead of an exact per-pixel one.
  function resolveRigidAnchor(clientX: number, clientY: number): RigidAnchor | null {
    const liveEditor = editorRef.current;
    if (liveEditor) {
      const pos = resolveBlockAnchorPos(liveEditor.ctx.get(editorViewCtx), clientX, clientY);
      return pos === null ? null : { kind: "pm-rigid", pos };
    }
    const chunkMatch = findChunkEditorAtPoint(clientX, clientY);
    if (chunkMatch) {
      const pos = resolveBlockAnchorPos(chunkMatch.editor.ctx.get(editorViewCtx), clientX, clientY);
      if (pos !== null) return { kind: "pm-chunk-rigid", chunkId: chunkMatch.chunkId, pos };
    }
    return null;
  }

  function capturePoint(event: ReactPointerEvent<HTMLCanvasElement>): StrokePoint {
    // "markup" (per-point PM/PM-chunk anchoring) is no longer a mode a NEW
    // stroke can be captured as -- removed as a user-selectable option
    // (see DrawAnchorMode's own doc comment: confirmed too unpredictable
    // in practice, the exact failure "pin" was built to fix). The "pm"/
    // "pm-chunk" point kinds and all their remapping/redraw/persistence
    // logic elsewhere in this file stay fully intact regardless -- purely
    // to keep rendering/reflowing any such points an EXISTING document
    // already has persisted, not to support drawing new ones here.
    if (anchorModeRef.current === "pin") {
      // Resolved once per gesture (handlePointerDown clears this ref before
      // the gesture's first capturePoint call) and reused for every later
      // point of the SAME gesture -- see rigidAnchorRef's own comment.
      if (!rigidAnchorRef.current) {
        rigidAnchorRef.current = resolveRigidAnchor(event.clientX, event.clientY);
      }
      const anchor = rigidAnchorRef.current;
      if (anchor) {
        const liveEditor = anchor.kind === "pm-rigid" ? editorRef.current : (getChunkEditorRef.current?.(anchor.chunkId) ?? null);
        if (liveEditor) {
          try {
            const coords = liveEditor.ctx.get(editorViewCtx).coordsAtPos(anchor.pos, -1);
            const dx = event.clientX - coords.left;
            const dy = event.clientY - coords.top;
            return anchor.kind === "pm-rigid"
              ? { kind: "pm-rigid", pos: anchor.pos, dx, dy }
              : { kind: "pm-chunk-rigid", chunkId: anchor.chunkId, pos: anchor.pos, dx, dy };
          } catch {
            // Fall through to scroll-anchored below.
          }
        }
      }
    }
    // "sketch" mode, or a "pin" resolution that failed (no live editor/chunk
    // yet -- the startup window ModeHeader's `drawDisabled` already
    // prevents in practice, but handled gracefully regardless).
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
  // where `resolveBlockAnchorPos`'s own end-of-document fallback lands, and
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
    const liveEditor =
      point.kind === "pm" || point.kind === "pm-rigid" ? editorRef.current : (getChunkEditorRef.current?.(point.chunkId) ?? null);
    if (!liveEditor) return null;
    try {
      const coords = liveEditor.ctx.get(editorViewCtx).coordsAtPos(point.pos, -1);
      return { clientX: coords.left + point.dx, clientY: coords.top + point.dy };
    } catch {
      return null;
    }
  }

  // `pressures`, when given, must be index-aligned with `points` (see
  // `Stroke.pressures`'s own doc comment). Looked up by each point's
  // ORIGINAL index, not by its position in the OUTPUT array -- a point
  // that fails to resolve (`resolveClientPoint` returning null, e.g. its
  // chunk isn't currently mounted) is skipped here, which would otherwise
  // silently misalign a separately-tracked pressures array against the
  // wrong points from then on. Carrying `pressure` alongside each
  // resolved point instead avoids that entirely: whichever points DO
  // resolve keep their own correct pressure value regardless of how many
  // others were skipped.
  function toCanvasPoints(
    points: StrokePoint[],
    scrollTop: number,
    canvasRect: DOMRect,
    pressures?: number[],
  ): { x: number; y: number; pressure?: number }[] {
    const result: { x: number; y: number; pressure?: number }[] = [];
    for (let i = 0; i < points.length; i++) {
      const resolved = resolveClientPoint(points[i]!, scrollTop);
      if (resolved) {
        result.push({ x: resolved.clientX - canvasRect.left, y: resolved.clientY - canvasRect.top, pressure: pressures?.[i] });
      }
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
  //
  // Each stroke is filled as a perfect-freehand variable-width outline
  // (strokeOutlineToPath2D), not stroked as a uniform-width polyline --
  // `last: true` here since every stroke reaching this function is already
  // complete (see handlePointerMove for the in-progress case).
  function redrawAll(scrollTop: number) {
    const canvas = canvasRef.current;
    const committed = getCommittedCanvas();
    const committedCtx = committed.getContext("2d");
    if (!canvas || !committedCtx) return;
    const canvasRect = canvas.getBoundingClientRect();
    committedCtx.clearRect(0, 0, committed.width, committed.height);
    for (const stroke of strokesRef.current) {
      const points = toCanvasPoints(stroke.points, scrollTop, canvasRect, stroke.pressures);
      const path = strokeOutlineToPath2D(points, stroke.penStyle, true);
      if (!path) continue;
      committedCtx.fillStyle = stroke.penStyle.color;
      committedCtx.globalAlpha = stroke.penStyle.opacity ?? 1;
      committedCtx.fill(path);
    }
    committedCtx.globalAlpha = 1;
    blitCommittedToVisible();
  }

  function toInkPenStyle(penStyle: PenStyle): InkStroke["penStyle"] {
    return { color: penStyle.color, width: penStyle.width, opacity: penStyle.opacity };
  }

  // Writes the CURRENT set of PM-anchored and PM-rigid (single-instance)
  // strokes back into the live document as ink data (see inkPersistence.ts)
  // -- a no-op if `editor` is null or the schema doesn't have the `ink` node
  // for some reason. Points of any other kind are silently excluded: only
  // these two persist here. `InkStroke.rigid` preserves which of the two a
  // stroke was, so rehydration (below) can reconstruct the right kind --
  // every point of a given stroke shares one kind in practice (capturePoint
  // never mixes them within a gesture), so checking just the first point is
  // sufficient. Safe to call liberally -- writeInkData itself no-ops when
  // nothing actually changed.
  function syncInkSingle() {
    const liveEditor = editorRef.current;
    if (!liveEditor) return;
    try {
      const view = liveEditor.ctx.get(editorViewCtx);
      const inkType = liveEditor.ctx.get(schemaCtx).nodes.ink;
      if (!inkType) return;
      const strokes: InkStroke[] = [];
      for (const stroke of strokesRef.current) {
        const points = stroke.points.filter((p): p is PmPoint | PmRigidPoint => p.kind === "pm" || p.kind === "pm-rigid");
        if (points.length === 0) continue;
        const rigid = points[0]!.kind === "pm-rigid";
        strokes.push({
          penStyle: toInkPenStyle(stroke.penStyle),
          points: points.map((p) => ({ pos: p.pos, dx: p.dx, dy: p.dy })),
          ...(rigid ? { rigid: true } : {}),
        });
      }
      const data: InkData | null = strokes.length > 0 ? { v: 1, strokes } : null;
      if (writeInkData(view, inkType, data)) onInkPersisted();
    } catch {
      // Persistence is best-effort -- drawing itself still works even if
      // this fails (e.g. the view is mid-teardown).
    }
  }

  // Chunked analogue of syncInkSingle: writes only the PM-chunk-anchored and
  // PM-chunk-rigid points belonging to ONE specific chunk into THAT chunk's
  // own `ink` node (a no-op, including writing null to clear a stale node,
  // if that chunk isn't currently mounted -- callers only ever invoke this
  // while the relevant chunk IS mounted, since both stroke completion and
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
        const points = stroke.points.filter(
          (p): p is PmChunkPoint | PmChunkRigidPoint => (p.kind === "pm-chunk" || p.kind === "pm-chunk-rigid") && p.chunkId === chunkId,
        );
        if (points.length === 0) continue;
        const rigid = points[0]!.kind === "pm-chunk-rigid";
        strokes.push({
          penStyle: toInkPenStyle(stroke.penStyle),
          points: points.map((p) => ({ pos: p.pos, dx: p.dx, dy: p.dy })),
          ...(rigid ? { rigid: true } : {}),
        });
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
          points: stroke.points.map((p): PmPoint | PmRigidPoint =>
            stroke.rigid ? { kind: "pm-rigid", pos: p.pos, dx: p.dx, dy: p.dy } : { kind: "pm", pos: p.pos, dx: p.dx, dy: p.dy },
          ),
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
          if (point.kind !== "pm" && point.kind !== "pm-rigid") continue;
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
          stroke.points = stroke.points.filter((p) => !((p.kind === "pm-chunk" || p.kind === "pm-chunk-rigid") && p.chunkId === chunkId));
        }
        strokesRef.current = strokesRef.current.filter((stroke) => stroke.points.length > 0);
        if (data) {
          for (const stroke of data.strokes) {
            strokesRef.current.push({
              penStyle: { id: "restored", label: "Restored", color: stroke.penStyle.color, width: stroke.penStyle.width, opacity: stroke.penStyle.opacity },
              points: stroke.points.map((p): PmChunkPoint | PmChunkRigidPoint =>
                stroke.rigid
                  ? { kind: "pm-chunk-rigid", chunkId, pos: p.pos, dx: p.dx, dy: p.dy }
                  : { kind: "pm-chunk", chunkId, pos: p.pos, dx: p.dx, dy: p.dy },
              ),
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
          if ((point.kind !== "pm-chunk" && point.kind !== "pm-chunk-rigid") || point.chunkId !== chunkId) continue;
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
    // Two reasons this can fire when a stroke is ALREADY in progress, both
    // of which must be ignored rather than re-initializing the gesture:
    // (1) already panning (a touchmove already detected 2+ fingers) -- a
    // third finger touching down shouldn't start a new draw gesture; (2)
    // confirmed directly, not assumed: a SECOND finger's own `touchStart`
    // can make the browser re-fire `pointerdown` for the FIRST finger's
    // pointerId too, even though it was already down and drawing -- a
    // real Chromium touch-to-pointer-event translation quirk, not a
    // theoretical one (reproduced via CDP's Input.dispatchTouchEvent).
    // Since `isPanningRef` isn't set yet at that exact moment (that only
    // happens once handleTouchMove's own multi-touch check runs, slightly
    // LATER), that guard alone doesn't catch this -- without the
    // `drawingRef.current` check too, this re-fire would stomp
    // `pointsRef`/`gestureStartTimeRef` with a fresh single-point gesture,
    // destroying whatever had actually been drawn AND corrupting the
    // grace-period elapsed-time calculation (resetting it to "just now"),
    // which then incorrectly DISCARDED the real stroke entirely instead of
    // committing it.
    if (isPanningRef.current || drawingRef.current) return;

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Best-effort: setPointerCapture throws (NotFoundError) if the UA
      // doesn't currently consider this pointerId "active" -- a real,
      // if rare, edge case (e.g. racing an OS-level gesture interruption),
      // not just a theoretical one. Capture is a nice-to-have (keeps the
      // gesture routed to this canvas even if the pointer strays outside
      // it mid-stroke); the drawing gesture itself works fine without it,
      // so this shouldn't abort the rest of handlePointerDown.
    }
    drawingRef.current = true;
    // Fresh anchor for this new gesture -- "pin" mode's capturePoint only
    // resolves a new one when this is null, so every later point of THIS
    // gesture reuses whatever the first point resolves below.
    rigidAnchorRef.current = null;
    // Baseline for this gesture's own sample-rate throttle (see
    // SAMPLE_INTERVAL_MS) -- NOT left at whatever the previous gesture set
    // it to.
    lastSampleTimeRef.current = event.timeStamp;
    // Separate from lastSampleTimeRef (which gets overwritten by every
    // later move, for throttling) -- this stays fixed at the gesture's own
    // start, so handleTouchMove can tell "did a second finger join almost
    // immediately" from "this was already a real, ongoing single-finger
    // stroke" (see TWO_FINGER_GRACE_MS's own comment).
    gestureStartTimeRef.current = event.timeStamp;
    // Real pressure tracking only for an actual electronic pen/stylus --
    // decided once per gesture (see pressuresRef's own comment).
    pressuresRef.current = event.pointerType === "pen" ? [event.pressure] : null;
    // No snapshot to capture here anymore -- the committed canvas is
    // already kept continuously in sync by redrawAll, so it's always a
    // valid baseline to blit from on the very first move of a new stroke.
    pointsRef.current = [capturePoint(event)];
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    // Panning (2+ fingers, driven by handleTouchMove's own TouchEvent-based
    // tracking) takes over entirely -- skip drawing until every finger lifts.
    if (isPanningRef.current) return;

    if (!drawingRef.current) return;
    // Sample-rate throttle -- see SAMPLE_INTERVAL_MS's own comment. Skips
    // BOTH capturing this point and redrawing for it entirely, rather than
    // e.g. capturing every point but only redrawing once per interval --
    // the extra points between samples wouldn't change the resulting
    // perfect-freehand outline enough to matter at a 16ms cadence, and
    // keeping them out of `pointsRef` is what actually keeps later
    // `toCanvasPoints`/`getStroke` calls (both O(n) in this stroke's own
    // point count) from paying for samples finer than the display can show.
    if (event.timeStamp - lastSampleTimeRef.current < SAMPLE_INTERVAL_MS) return;
    lastSampleTimeRef.current = event.timeStamp;

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    pointsRef.current.push(capturePoint(event));
    pressuresRef.current?.push(event.pressure);
    // GPU-backed blit of the committed baseline, replacing the old
    // getImageData/putImageData pair -- see committedCanvasRef's own
    // comment for why.
    blitCommittedToVisible();

    const points = toCanvasPoints(pointsRef.current, getScrollTop(), canvas.getBoundingClientRect(), pressuresRef.current ?? undefined);
    // `last: false` -- this stroke isn't finished yet (more points may
    // still arrive), so perfect-freehand shouldn't taper/cap its end the
    // way it will once stopDrawing's own redrawAll call passes `last: true`.
    const path = strokeOutlineToPath2D(points, penStyle, false);
    if (!path) return;

    ctx.fillStyle = penStyle.color;
    ctx.globalAlpha = penStyle.opacity ?? 1;
    ctx.fill(path);
    ctx.globalAlpha = 1;
  }

  function stopDrawing() {
    if (drawingRef.current && pointsRef.current.length > 0) {
      strokesRef.current.push({ points: pointsRef.current, penStyle, pressures: pressuresRef.current ?? undefined });
      if (editorRef.current) {
        syncInkSingle();
      } else {
        // A stroke's points are all the same kind in practice (which
        // anchoring is available doesn't change mid-gesture), but this
        // iterates distinct chunk ids defensively rather than assuming
        // exactly one, in case a stroke ever does span a chunk boundary.
        const chunkIds = new Set(
          pointsRef.current
            .filter((p): p is PmChunkPoint | PmChunkRigidPoint => p.kind === "pm-chunk" || p.kind === "pm-chunk-rigid")
            .map((p) => p.chunkId),
        );
        for (const chunkId of chunkIds) syncInkForChunk(chunkId);
      }
      // Folds the just-finished stroke into the committed baseline -- see
      // redrawAll's own comment on why this can't be skipped.
      redrawAll(getScrollTop());
    }
    drawingRef.current = false;
    pointsRef.current = [];
    rigidAnchorRef.current = null;
    pressuresRef.current = null;
  }

  // handleTouchMove's "a second finger joined almost immediately" case --
  // see TWO_FINGER_GRACE_MS's own comment. Same reset as stopDrawing's own
  // tail, but WITHOUT committing `pointsRef` into `strokesRef` first: the
  // brief touch-and-slight-move is incidental, not an intentional stroke.
  // `redrawAll` still has to run -- handlePointerMove's in-progress
  // rendering paints directly onto the VISIBLE canvas (not yet part of
  // `strokesRef`), so without this, that stray mark would stay on screen
  // even though it was never committed; redrawing from `strokesRef` (which
  // never included it) correctly erases it.
  function discardDrawing() {
    drawingRef.current = false;
    pointsRef.current = [];
    rigidAnchorRef.current = null;
    pressuresRef.current = null;
    redrawAll(getScrollTop());
  }

  // Wraps stopDrawing for pointerup/cancel/leave -- skips it entirely
  // while panning (nothing to stop; exiting panning itself is
  // handleTouchEnd's own job, driven by TouchEvent.touches, not this
  // pointer-based handler), otherwise falls through to the normal
  // end-of-stroke handling.
  function handlePointerEnd() {
    // While panning, there's no draw gesture to stop (drawingRef was
    // already cleared when panning started) -- actually exiting panning
    // is handleTouchEnd's own job, driven by TouchEvent.touches, not this
    // pointer-based handler.
    if (isPanningRef.current) return;
    stopDrawing();
  }

  function clear() {
    // Captured before clearing strokesRef -- these are exactly the chunks
    // (if any) that need an explicit null-write to remove their now-stale
    // ink node; a chunk with no tracked strokes here has nothing to clear
    // (either it never had ink, or it's not currently mounted and this
    // session never rehydrated/wrote anything for it).
    const chunkIds = new Set(
      strokesRef.current.flatMap((s) =>
        s.points.filter((p): p is PmChunkPoint | PmChunkRigidPoint => p.kind === "pm-chunk" || p.kind === "pm-chunk-rigid").map((p) => p.chunkId),
      ),
    );
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
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onPointerLeave={handlePointerEnd}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
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

export type EditorMode = "text" | "draw";

// Which of two ways a stroke, at the moment it's drawn, should be
// anchored:
//   - "pin": anchored ONCE, to the whole enclosing block (paragraph/
//     heading/table-cell/etc.) under wherever the stroke starts -- the
//     whole stroke translates together as a single rigid, undistorted
//     unit as that block moves (e.g. content inserted/removed above it),
//     and disappears as a unit if that block is itself fully deleted.
//     Modeled on how Word/PowerPoint/Google Docs anchor a drawn object to
//     one paragraph rather than reflowing it per character. Persists
//     across reloads (DrawLayer.tsx's PM-rigid/PM-chunk-rigid anchoring).
//     The default and only text-anchored mode a NEW stroke can be drawn
//     with.
//   - "sketch": drawn at a fixed screen/scroll position, independent of
//     document content entirely (DrawLayer.tsx's existing scroll-
//     anchoring, previously only ever used as an automatic startup-window
//     fallback -- now also a deliberate, user-chosen mode). Does NOT
//     persist across reload, same existing limitation scroll-anchored
//     points already had -- there's no stable, cross-session meaning for a
//     raw scrollTop, so there's nothing worth saving for one.
//
// A third mode, "markup" (per-POINT anchoring -- each point tracks its own
// nearby text independently, so a stroke could reflow/distort as that
// specific span was edited), existed briefly as a user-selectable option
// but was removed: confirmed in practice to be too unpredictable to
// control (a stroke spanning edited content could visibly stretch/shrink),
// which is exactly the failure mode "pin" was built to fix properly. It is
// NOT in this type anymore -- no new stroke can be drawn this way -- but
// DrawLayer.tsx still reads/renders/reflows any "markup" (non-rigid)
// points already persisted in an existing document (`InkStroke.rigid`
// unset), so no migration/data loss happens for documents drawn before
// this change.
export type DrawAnchorMode = "pin" | "sketch";

export interface PenStyle {
  id: string;
  label: string;
  color: string;
  width: number;
  /** Defaults to fully opaque when omitted. */
  opacity?: number;
  /**
   * perfect-freehand's `thinning` option (see freehandStroke.ts): how much
   * the stroke's width varies with simulated pressure/velocity -- higher
   * values give a more natural handwriting-style taper (thin when moving
   * fast, thick when slow/pressing), 0 keeps the stroke a uniform width
   * regardless of speed. Defaults to 0.6 (a natural pen-like taper) when
   * omitted -- the Highlighter preset overrides this near 0, since a real
   * highlighter's felt tip doesn't taper the way a ballpoint pen does.
   */
  thinning?: number;
}

export const PEN_STYLES: PenStyle[] = [
  { id: "pen", label: "Pen", color: "#e53935", width: 2.5, thinning: 0.7 },
  { id: "marker", label: "Marker", color: "#1976d2", width: 6, thinning: 0.4 },
  { id: "highlighter", label: "Highlighter", color: "#ffd54f", width: 16, opacity: 0.4, thinning: 0.05 },
];

export interface ModeHeaderProps {
  mode: EditorMode;
  onModeChange: (mode: EditorMode) => void;
  penStyle: PenStyle;
  onPenStyleChange: (style: PenStyle) => void;
  /** See `DrawAnchorMode`'s own doc comment. Only rendered/relevant while `mode === "draw"`. */
  anchorMode: DrawAnchorMode;
  onAnchorModeChange: (mode: DrawAnchorMode) => void;
  /**
   * True only during either path's own brief startup window -- the
   * single-instance editor before Milkdown's `.create()` resolves, or the
   * virtualized path before any chunk has mounted yet (see Editor.tsx's
   * `anyChunkMounted`). Disables the Draw button for that window --
   * DrawLayer.tsx's own position-anchoring needs a live editor/chunk to
   * capture a stroke as reflow-anchored (and therefore persistable);
   * drawing before that falls back to scroll-only anchoring with NO
   * visible difference on screen, so a stroke drawn in that window looked
   * identical to a normal one but silently never got saved -- confirmed
   * directly as a real user-visible gap on a real (slower) device, not
   * just a theoretical race. Disabling the button here prevents the
   * ambiguous state outright rather than needing to explain it after the
   * fact. (Irrelevant to -- not to be confused with -- "sketch" mode above,
   * which is a deliberate, permanent choice, not a startup-window gap.)
   */
  drawDisabled?: boolean;
  /**
   * Whole-viewport pagination mode (see PagingLayer.tsx) -- deliberately
   * independent of the virtualized editor's own chunk/heading-based
   * "Page N / Total" nav bar (`Editor.tsx`'s `virtualizedPage`): this is a
   * fresh, separate concept that defines a "page" as whatever currently
   * fits the viewport, works on ANY document regardless of size/
   * virtualization, and layers scroll-snap-to-next-page behavior on top of
   * the existing scroller rather than restructuring how content is
   * rendered. Always visible (not gated on `mode === "draw"`) since it
   * governs how the CONTENT scrolls, which is relevant in both text and
   * draw mode.
   */
  pagingMode: boolean;
  onPagingModeChange: (enabled: boolean) => void;
}

// Fixed top-of-editor bar: icon-only mode switcher (rich text vs. draw --
// DrawLayer.tsx) plus, while in draw mode, pen-style swatches (color/width
// presets DrawLayer paints with) and the Pin/Sketch anchor-mode toggle
// (see DrawAnchorMode's own doc comment). Deliberately not tab-styled (no underline,
// no visible text labels) -- a plain icon toolbar, consistent with the
// bottom Toolbar's own icon-only buttons (aria-label carries the name).
// Not actually `position: fixed` -- it's simply the first child in Editor's
// own flex column, outside the scrollable content area (same reason the
// bottom Toolbar doesn't scroll away either), which is enough to keep it in
// place without coupling to assumptions about an outer scroll container.
export function ModeHeader({
  mode,
  onModeChange,
  penStyle,
  onPenStyleChange,
  anchorMode,
  onAnchorModeChange,
  drawDisabled,
  pagingMode,
  onPagingModeChange,
}: ModeHeaderProps) {
  return (
    <div className="mode-header" role="toolbar" aria-label="Input mode">
      <button
        type="button"
        className="mode-header-button"
        title="Text"
        aria-label="Text mode"
        aria-pressed={mode === "text"}
        data-active={mode === "text" || undefined}
        onClick={() => onModeChange("text")}
      >
        ⌨
      </button>
      <button
        type="button"
        className="mode-header-button"
        title={drawDisabled ? "Draw (still loading)" : "Draw"}
        aria-label="Draw mode"
        aria-pressed={mode === "draw"}
        data-active={mode === "draw" || undefined}
        disabled={drawDisabled}
        onClick={() => onModeChange("draw")}
      >
        ✎
      </button>
      <span className="mode-header-separator" aria-hidden="true" />
      <button
        type="button"
        className="mode-header-button"
        title={pagingMode ? "Paged view (scroll to flip pages)" : "Continuous scroll"}
        aria-label="Paging mode"
        aria-pressed={pagingMode}
        data-active={pagingMode || undefined}
        onClick={() => onPagingModeChange(!pagingMode)}
      >
        📑
      </button>

      {mode === "draw" && (
        <>
          <span className="mode-header-separator" aria-hidden="true" />
          {PEN_STYLES.map((style) => (
            <button
              key={style.id}
              type="button"
              className="mode-header-pen-button"
              title={style.label}
              aria-label={style.label}
              aria-pressed={penStyle.id === style.id}
              data-active={penStyle.id === style.id || undefined}
              onClick={() => onPenStyleChange(style)}
            >
              <span className="mode-header-pen-swatch" style={{ background: style.color, opacity: style.opacity ?? 1 }} />
            </button>
          ))}
          <span className="mode-header-separator" aria-hidden="true" />
          <button
            type="button"
            className="mode-header-button"
            title="Pin (moves with its paragraph, keeps its shape, saved)"
            aria-label="Pin"
            aria-pressed={anchorMode === "pin"}
            data-active={anchorMode === "pin" || undefined}
            onClick={() => onAnchorModeChange("pin")}
          >
            📌
          </button>
          <button
            type="button"
            className="mode-header-button"
            title="Sketch (fixed position, not saved)"
            aria-label="Sketch"
            aria-pressed={anchorMode === "sketch"}
            data-active={anchorMode === "sketch" || undefined}
            onClick={() => onAnchorModeChange("sketch")}
          >
            ☁
          </button>
        </>
      )}
    </div>
  );
}

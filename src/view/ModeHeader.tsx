export type EditorMode = "text" | "draw";

export interface PenStyle {
  id: string;
  label: string;
  color: string;
  width: number;
  /** Defaults to fully opaque when omitted. */
  opacity?: number;
}

export const PEN_STYLES: PenStyle[] = [
  { id: "pen", label: "Pen", color: "#e53935", width: 2.5 },
  { id: "marker", label: "Marker", color: "#1976d2", width: 6 },
  { id: "highlighter", label: "Highlighter", color: "#ffd54f", width: 16, opacity: 0.4 },
];

export interface ModeHeaderProps {
  mode: EditorMode;
  onModeChange: (mode: EditorMode) => void;
  penStyle: PenStyle;
  onPenStyleChange: (style: PenStyle) => void;
  /**
   * True only during the single-instance editor's own brief startup window
   * (Milkdown's `.create()` hasn't resolved yet), never for virtualized
   * documents (which are always scroll-anchored/unpersisted by design, with
   * nothing to wait for). Disables the Draw button for that window --
   * DrawLayer.tsx's own position-anchoring needs the live editor to capture
   * a stroke as reflow-anchored (and therefore persistable); drawing before
   * that falls back to its scroll-only anchoring with NO visible difference
   * on screen, so a stroke drawn in that window looked identical to a
   * normal one but silently never got saved -- confirmed directly as a real
   * user-visible gap on a real (slower) device, not just a theoretical
   * race. Disabling the button here prevents the ambiguous state outright
   * rather than needing to explain it after the fact.
   */
  drawDisabled?: boolean;
}

// Fixed top-of-editor bar: icon-only mode switcher (rich text vs. draw --
// DrawLayer.tsx) plus, while in draw mode, pen-style swatches (color/width
// presets DrawLayer paints with). Deliberately not tab-styled (no underline,
// no visible text labels) -- a plain icon toolbar, consistent with the
// bottom Toolbar's own icon-only buttons (aria-label carries the name).
// Not actually `position: fixed` -- it's simply the first child in Editor's
// own flex column, outside the scrollable content area (same reason the
// bottom Toolbar doesn't scroll away either), which is enough to keep it in
// place without coupling to assumptions about an outer scroll container.
export function ModeHeader({ mode, onModeChange, penStyle, onPenStyleChange, drawDisabled }: ModeHeaderProps) {
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
        </>
      )}
    </div>
  );
}

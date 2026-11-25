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

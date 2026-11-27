import { getStroke } from "perfect-freehand";
import type { PenStyle } from "./drawTypes";

// perfect-freehand's own documented usage pattern (it doesn't ship this as
// part of its exported API, since consumers are expected to render the
// outline points however suits their own stack -- SVG, Canvas2D, WebGL,
// etc.): builds a smooth, CLOSED path through the outline points via
// quadratic-Bezier segments between consecutive midpoints, rather than
// straight lineTo segments between the raw outline points -- which would
// look faceted for the identical reason the ORIGINAL straight-lineTo
// stroke rendering (the thing this module replaces) did.
function getSvgPathFromStroke(points: number[][]): string {
  if (points.length === 0) return "";
  const d = points.reduce(
    (acc, [x0, y0], i, arr) => {
      const next = arr[(i + 1) % arr.length]!;
      acc.push(x0!, y0!, (x0! + next[0]!) / 2, (y0! + next[1]!) / 2);
      return acc;
    },
    ["M", ...points[0]!, "Q"] as (string | number)[],
  );
  d.push("Z");
  return d.join(" ");
}

// Default handwriting-style taper (width narrows at speed, widens when
// slow/pressing) for pen styles that don't specify their own `thinning` --
// see PenStyle.thinning's own doc comment for why the Highlighter preset
// overrides this toward 0 (a real highlighter doesn't taper).
const DEFAULT_THINNING = 0.6;

/**
 * Converts a stroke's current CANVAS-SPACE points into a fillable `Path2D`
 * -- a variable-width OUTLINE polygon (perfect-freehand's own stroke
 * model: `getStroke` returns the polygon that surrounds the input points,
 * meant to be filled, not stroked), not the simple uniform-width polyline
 * this replaces. Returns null for zero points (nothing to draw yet).
 *
 * Each point's own optional `pressure` (real `PointerEvent.pressure`,
 * carried alongside its x/y rather than tracked in a separate array --
 * see DrawLayer.tsx's `toCanvasPoints`, which is what keeps this correctly
 * aligned even when some points fail to resolve and get dropped) is only
 * ever present for a stroke drawn with `pointerType === "pen"` -- real
 * stylus pressure is reliable, unlike `PointerEvent.pressure` for
 * touch/mouse (inconsistent across devices and browsers, often a
 * meaningless constant like 0.5 or 1). Used only if EVERY point in this
 * call has one; a partial/missing set (shouldn't happen -- a gesture's
 * pressure-tracking decision is made once, at its own `pointerdown` --
 * but checked rather than trusted) falls back to `simulatePressure: true`,
 * which derives a synthetic pressure from stroke velocity instead -- the
 * same thing that gives mouse/finger-only input its natural-looking taper
 * when a real pressure-sensitive stylus isn't supplying one directly.
 *
 * A single filled polygon per stroke, built from ALL of that stroke's
 * points in one `getStroke` call, also naturally preserves this app's
 * existing "whole stroke as one draw call" alpha-blending correctness for
 * the semi-transparent Highlighter preset (see DrawLayer.tsx's own
 * `redrawAll`/`handlePointerMove` comments): a self-overlapping outline
 * filled via ONE `ctx.fill()` call applies `globalAlpha` once across the
 * whole shape, with no double-blending at points where the outline crosses
 * itself -- Canvas2D's nonzero fill rule resolves the overlap as part of
 * rasterizing a single path, not as separately-composited regions.
 *
 * `last: true` should be passed only for a COMPLETED stroke (after
 * pointerup) -- perfect-freehand uses it to decide whether to taper/cap
 * the stroke's END the same way it already does for the start, rather
 * than leaving an in-progress stroke looking prematurely "finished" while
 * more points are still arriving.
 */
export function strokeOutlineToPath2D(
  points: { x: number; y: number; pressure?: number }[],
  penStyle: PenStyle,
  last: boolean,
): Path2D | null {
  if (points.length === 0) return null;
  const usePressure = points.every((p) => p.pressure !== undefined);
  const outline = getStroke(
    usePressure ? points.map((p) => [p.x, p.y, p.pressure!]) : points.map((p) => [p.x, p.y]),
    {
      size: penStyle.width,
      thinning: penStyle.thinning ?? DEFAULT_THINNING,
      smoothing: 0.5,
      streamline: 0.5,
      simulatePressure: !usePressure,
      last,
    },
  );
  if (outline.length === 0) return null;
  return new Path2D(getSvgPathFromStroke(outline));
}

/**
 * Cheap, uniform-width polyline through 2+ points -- NOT perfect-freehand's
 * own tapered outline above, used only for the in-progress stroke's own
 * LIVE preview (DrawLayer.tsx's `handlePointerMove`) to avoid recomputing
 * `getStroke`'s full smoothing/outline geometry on every single move, a
 * cost that scales with how many points the stroke has accumulated so far
 * -- confirmed as one of the two real O(n)-per-move costs `SAMPLE_INTERVAL_MS`
 * only amortizes, not eliminates (see DrawLayer.tsx's own comment). Meant
 * to be STROKED (`ctx.lineWidth = penStyle.width`, round caps/joins), not
 * filled -- a materially cheaper primitive than building and filling an
 * outline polygon through the same points. The stroke's TRUE tapered shape
 * is still rendered exactly once, the moment the gesture ends
 * (`stopDrawing`'s own `redrawAll` call, which calls `strokeOutlineToPath2D`
 * above with `last: true`) -- so a Pen/Marker stroke visibly "settles" into
 * its final tapered look right as the pen lifts, a deliberate, user-
 * confirmed tradeoff, not an oversight (Highlighter's own near-zero
 * `thinning` makes this barely perceptible there, since it's already close
 * to uniform-width).
 *
 * Returns null for fewer than 2 points -- a lone point (no movement yet)
 * has no line to stroke; `DrawLayer.tsx` handles that case separately (a
 * small filled dot at the pen's own width), the live-preview analogue of
 * the identical "a single tap should still be visible" fix this file's own
 * `strokeOutlineToPath2D` already documents for the committed case.
 */
export function buildLivePreviewLine(points: { x: number; y: number }[]): Path2D | null {
  if (points.length < 2) return null;
  const path = new Path2D();
  path.moveTo(points[0]!.x, points[0]!.y);
  for (let i = 1; i < points.length; i++) path.lineTo(points[i]!.x, points[i]!.y);
  return path;
}

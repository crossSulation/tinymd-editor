import type { Command } from "prosemirror-state";
import type { ResolvedPos } from "prosemirror-model";
import {
  addRowBefore,
  addRowAfter,
  deleteRow as deleteRowGeneric,
  addColumnBefore,
  addColumnAfter,
  deleteColumn,
  splitCell,
  isInTable,
  selectionCell,
  TableMap,
  CellSelection,
  mergeCells,
} from "@milkdown/kit/prose/tables";

// toggleHeaderRow/toggleHeaderColumn (prosemirror-tables' generic commands)
// are deliberately NOT wired up here -- verified directly against
// @milkdown/preset-gfm's actual table schema source that they're
// incompatible with it, not just unimplemented. That schema uses SEPARATE
// node types for header vs. body (table_header_row/table_header vs.
// table_row/table_cell), with table_row's own content model only ever
// allowing table_cell children -- toggleHeaderRow's generic per-cell
// attribute-style toggle produced a real `TransformError: Invalid content
// for node table_header_row` when tried against this schema (confirmed
// directly, not assumed). toggleHeaderColumn is worse than merely
// incompatible: GFM/CommonMark markdown has no syntax for a header column
// at all (only the single header row the `---|---|` separator line
// produces), so a header column couldn't round-trip through this app's
// markdown-based persistence even if the schema allowed representing one.

// GFM's table schema (verified directly in @milkdown/preset-gfm's source)
// requires content "table_header_row table_row+" on the table node -- the
// header row is mandatory, always first, and exactly one; at least one
// table_row (body row) is mandatory too. prosemirror-tables' generic
// addRowBefore/deleteRow have no awareness of either constraint:
// addRowBefore always inserts a generic `table_row`-typed node (see
// prosemirror-tables' own addRow(), which creates via
// `tableNodeTypes(schema).row` unconditionally, never the header row type),
// so inserting "before" row 0 would put a table_row ahead of the mandatory
// header row, and deleteRow has no concept of "this specific row can never
// be removed" or "don't remove the last body row". Confirmed directly (not
// assumed): deleting the header row left an empty but still-present
// `<tr data-is-header>` and a corrupted extra row after ProseMirror's own
// schema-validity repair ran -- real corruption, not a cosmetic issue.
// addColumnBefore/After/deleteColumn don't have this problem: addColumn
// picks each row's new cell type from that SAME row's own existing
// neighbor cell (verified directly in its source), so it already
// correctly produces table_header cells in the header row and table_cell
// elsewhere -- no row-type guard needed for column operations.
function tableRowInfo(state: Parameters<Command>[0]): { map: InstanceType<typeof TableMap>; row: number } | null {
  if (!isInTable(state)) return null;
  const $cell: ResolvedPos = selectionCell(state);
  const table = $cell.node(-1);
  const tableStart = $cell.start(-1);
  const map = TableMap.get(table);
  const relPos = $cell.pos - tableStart;
  const rect = map.findCell(relPos);
  return { map, row: rect.top };
}

function insertRowAbove(): Command {
  return (state, dispatch) => {
    const info = tableRowInfo(state);
    if (!info) return false;
    // Row 0 is the mandatory header row -- there is no valid position
    // "above" it in this schema.
    if (info.row === 0) return false;
    return addRowBefore(state, dispatch);
  };
}

function deleteRow(): Command {
  return (state, dispatch) => {
    const info = tableRowInfo(state);
    if (!info) return false;
    if (info.row === 0) return false; // the mandatory header row can never be removed
    if (info.map.height <= 2) return false; // would remove the last remaining body row
    return deleteRowGeneric(state, dispatch);
  };
}

export interface TableCommands {
  insertRowAbove: Command;
  insertRowBelow: Command;
  deleteRow: Command;
  insertColumnLeft: Command;
  insertColumnRight: Command;
  deleteColumn: Command;
  combineRight: Command;
  combineDown: Command;
  splitCell: Command;
}

// "Combine Row"/"Combine Column": merges the focused cell with its immediate
// right/below neighbor. prosemirror-tables' own mergeCells only acts on an
// existing multi-cell CellSelection, which normally comes from a mouse/touch
// drag across cell boundaries -- the same drag gesture @milkdown/kit's
// table-block component and @milkdown/plugin-block both rely on, and both
// were rejected outright for this app as touch-unviable (see Claude.md's
// Mobile-first UI section). Rather than requiring a drag, this constructs a
// 2-cell CellSelection programmatically (the focused cell + its neighbor)
// and merges that directly -- a single tap, no selection gesture needed.
// Returns false (button disabled) at a table edge where no such neighbor
// exists (e.g. "combine right" on the last column).
function combineWithNeighbor(axis: "horiz" | "vert"): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;

    // selectionCell() returns a ResolvedPos positioned right before the
    // focused cell (nodeAfter is the cell), with node(-1)/start(-1) giving
    // the enclosing table/its start -- verified directly against
    // prosemirror-tables' own selectedRect(), which uses this exact pattern
    // internally.
    const $cell = selectionCell(state);
    const table = $cell.node(-1);
    const tableStart = $cell.start(-1);
    const map = TableMap.get(table);
    const cellRelPos = $cell.pos - tableStart;
    const nextRelPos = map.nextCell(cellRelPos, axis, 1);
    if (nextRelPos == null) return false;

    // Applicability check only (e.g. Toolbar.tsx's disabled={!command(state)}
    // on every render) -- stop here, before constructing any intermediate
    // state. Confirmed directly (reproduced via a real stack trace, not
    // assumed): state.apply(tr) is NOT the side-effect-free operation it is
    // in vanilla ProseMirror once Milkdown's listener plugin is registered
    // -- that plugin's selectionUpdated/markdownUpdated callbacks are wired
    // as a PLUGIN STATE FIELD's apply() method, which runs synchronously on
    // EVERY state.apply(tr) call, not just ones actually dispatched to a
    // live view. In this app those callbacks call Editor.tsx's bumpTick
    // (setState) directly, so calling state.apply() here during a render's
    // disabled-check synchronously triggered React's "Cannot update a
    // component while rendering a different component" error and a
    // subsequent infinite re-render/freeze -- confirmed via the exact CDP
    // stack trace (ToolbarItemButton render -> this function -> state.apply
    // -> listener plugin's apply -> onSelectionUpdated -> bumpTick).
    if (!dispatch) return true;

    const $nextCell = state.doc.resolve(tableStart + nextRelPos);
    const cellSelection = new CellSelection($cell, $nextCell);

    // Only the selection differs from `state` here, not the doc -- a
    // transaction built from this intermediate state has the same
    // `tr.before` as the real state's doc, so mergeCells' own dispatch call
    // can be passed straight through to the real `dispatch` exactly as if
    // it had been called on `state` directly (verified directly against
    // mergeCells/selectedRect's source: both only read state.doc/
    // state.selection, nothing tied to a "live" EditorView). The listener
    // side effect noted above still fires here too, but harmlessly -- this
    // only runs from a real click (inside an event handler), not during
    // render, so an extra bumpTick-triggered re-render is unobservable
    // (same as any other edit causing two renders instead of one).
    const intermediateState = state.apply(state.tr.setSelection(cellSelection));
    return mergeCells(intermediateState, dispatch);
  };
}

export function createTableCommands(): TableCommands {
  return {
    insertRowAbove: insertRowAbove(),
    insertRowBelow: addRowAfter,
    deleteRow: deleteRow(),
    insertColumnLeft: addColumnBefore,
    insertColumnRight: addColumnAfter,
    deleteColumn,
    combineRight: combineWithNeighbor("horiz"),
    combineDown: combineWithNeighbor("vert"),
    splitCell,
  };
}

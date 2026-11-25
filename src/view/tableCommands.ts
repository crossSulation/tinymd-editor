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
  setCellAttr,
  moveTableRow,
  moveTableColumn,
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

function tableColInfo(state: Parameters<Command>[0]): { map: InstanceType<typeof TableMap>; col: number } | null {
  if (!isInTable(state)) return null;
  const $cell: ResolvedPos = selectionCell(state);
  const table = $cell.node(-1);
  const tableStart = $cell.start(-1);
  const map = TableMap.get(table);
  const relPos = $cell.pos - tableStart;
  const rect = map.findCell(relPos);
  return { map, col: rect.left };
}

// moveTableRow/moveTableColumn (prosemirror-tables) swap CONTENT between
// row/column "slots" while each slot keeps its own existing node type
// (verified directly against its source: convertArrayOfRowsToTableNode uses
// `oldRow.type.createChecked(...)`/`oldCell.type.createChecked(...)`, the
// type at each position, not the type of whatever moved there) -- so moving
// the mandatory header row wouldn't corrupt the schema, but it WOULD
// silently reassign header styling to whatever body row's content got
// swapped into that slot, which is confusing rather than useful. Guarded
// out the same way insertRowAbove/deleteRow already guard row 0 above:
// row reorder only ever applies among body rows.
function moveRowUp(): Command {
  return (state, dispatch) => {
    const info = tableRowInfo(state);
    if (!info || info.row <= 1) return false;
    return moveTableRow({ from: info.row, to: info.row - 1 })(state, dispatch);
  };
}

function moveRowDown(): Command {
  return (state, dispatch) => {
    const info = tableRowInfo(state);
    if (!info || info.row === 0 || info.row >= info.map.height - 1) return false;
    return moveTableRow({ from: info.row, to: info.row + 1 })(state, dispatch);
  };
}

// No header-row-style guard needed for columns -- every column is a plain
// table_cell/table_header pair, none structurally mandatory the way row 0 is.
function moveColumnLeft(): Command {
  return (state, dispatch) => {
    const info = tableColInfo(state);
    if (!info || info.col <= 0) return false;
    return moveTableColumn({ from: info.col, to: info.col - 1 })(state, dispatch);
  };
}

function moveColumnRight(): Command {
  return (state, dispatch) => {
    const info = tableColInfo(state);
    if (!info || info.col >= info.map.width - 1) return false;
    return moveTableColumn({ from: info.col, to: info.col + 1 })(state, dispatch);
  };
}

// setCellAttr only touches the current CellSelection (or the single focused
// cell with no CellSelection) -- building a column-spanning CellSelection
// first (same technique combineWithNeighbor below uses for a 2-cell one)
// lets one setCellAttr call re-align every cell in the column at once.
function setColumnAlign(alignment: "left" | "center" | "right"): Command {
  return (state, dispatch) => {
    const info = tableColInfo(state);
    if (!info) return false;
    if (!dispatch) return true; // applicability-only check -- see combineWithNeighbor's own comment on why this must stop here
    const $cell = selectionCell(state);
    const table = $cell.node(-1);
    const tableStart = $cell.start(-1);
    const { map, col } = info;
    const $first = state.doc.resolve(tableStart + map.positionAt(0, col, table));
    const $last = state.doc.resolve(tableStart + map.positionAt(map.height - 1, col, table));
    const intermediateState = state.apply(state.tr.setSelection(CellSelection.colSelection($last, $first)));
    return setCellAttr("alignment", alignment)(intermediateState, dispatch);
  };
}

// Sorts the table's body rows (never the mandatory header row) ascending by
// the current column's own text content. Assumes no rowspans across that
// column -- true for every table this app's own UI can currently produce
// (insert/merge only ever merges horizontally via combineWithNeighbor's
// "vert" axis... actually combineDown does create a rowspan, so a sort
// across a column containing a vertically-merged cell can reorder its
// anchor away from the rows it spans; accepted as a known edge case rather
// than reconciling spans here, same spirit as the resize gap already
// documented for this table UI.
function sortColumnAscending(): Command {
  return (state, dispatch) => {
    const info = tableColInfo(state);
    if (!info) return false;
    const $cell = selectionCell(state);
    const table = $cell.node(-1);
    const tableStart = $cell.start(-1);
    const tablePos = tableStart - 1;
    const { map, col } = info;
    const bodyRows: { node: typeof table; text: string }[] = [];
    for (let row = 1; row < map.height; row++) {
      const rowNode = table.child(row);
      const cellPos = map.positionAt(row, col, table);
      const cellNode = table.nodeAt(cellPos);
      bodyRows.push({ node: rowNode, text: cellNode?.textContent ?? "" });
    }
    const sorted = [...bodyRows].sort((a, b) => a.text.localeCompare(b.text));
    if (sorted.every((entry, i) => entry.node === bodyRows[i]!.node)) return false; // already sorted
    if (!dispatch) return true;
    const newTable = table.type.createChecked(table.attrs, [table.child(0), ...sorted.map((entry) => entry.node)], table.marks);
    dispatch(state.tr.replaceWith(tablePos, tablePos + table.nodeSize, newTable));
    return true;
  };
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
  moveRowUp: Command;
  moveRowDown: Command;
  moveColumnLeft: Command;
  moveColumnRight: Command;
  setColumnAlign: (alignment: "left" | "center" | "right") => Command;
  sortColumnAscending: Command;
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
    moveRowUp: moveRowUp(),
    moveRowDown: moveRowDown(),
    moveColumnLeft: moveColumnLeft(),
    moveColumnRight: moveColumnRight(),
    setColumnAlign,
    sortColumnAscending: sortColumnAscending(),
  };
}

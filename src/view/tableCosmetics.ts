import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { Command, Transaction } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";
import { TableMap, isInTable, selectionCell } from "@milkdown/kit/prose/tables";

// Header-column and cell/fill color both have no GFM/markdown syntax to
// round-trip through at all (the same hard limitation CLAUDE.md already
// documents for header-column specifically) -- client-side-only cosmetic
// state, lost on reload, same tradeoff. Kept as plain position-keyed
// ProseMirror plugin state (remapped through tr.mapping on every
// transaction, the same technique DrawLayer's own PM-anchored ink points
// use) rather than real schema attributes, since patching a new attribute
// onto @milkdown/preset-gfm's already-defined table_cell/table_header node
// schemas from outside isn't something Milkdown's plugin system supports --
// two separate $nodeSchema registrations for the same node name fight over
// which wins, they don't merge.

export const CELL_COLORS = [
  { label: "Blue", color: "#dce8fd" },
  { label: "Green", color: "#dcf5e3" },
  { label: "Yellow", color: "#fdf0c4" },
];

interface CosmeticsState {
  headerColumnTables: ReadonlySet<number>;
  cellColors: ReadonlyMap<number, string>;
}

const tableCosmeticsKey = new PluginKey<CosmeticsState>("tinymdTableCosmetics");
const TOGGLE_HEADER_COLUMN_META = "tinymd-toggle-header-column";
const SET_CELL_COLOR_META = "tinymd-set-cell-color";

function remapState(tr: Transaction, value: CosmeticsState): CosmeticsState {
  if (!tr.docChanged) return value;
  const headerColumnTables = new Set<number>();
  for (const pos of value.headerColumnTables) {
    const mapped = tr.mapping.mapResult(pos);
    if (!mapped.deleted) headerColumnTables.add(mapped.pos);
  }
  const cellColors = new Map<number, string>();
  for (const [pos, color] of value.cellColors) {
    const mapped = tr.mapping.mapResult(pos);
    if (!mapped.deleted) cellColors.set(mapped.pos, color);
  }
  return { headerColumnTables, cellColors };
}

export function createTableCosmeticsPlugin() {
  return $prose(
    () =>
      new Plugin<CosmeticsState>({
        key: tableCosmeticsKey,
        state: {
          init: () => ({ headerColumnTables: new Set(), cellColors: new Map() }),
          apply: (tr, value) => {
            let next = remapState(tr, value);
            const togglePos = tr.getMeta(TOGGLE_HEADER_COLUMN_META) as number | undefined;
            if (togglePos !== undefined) {
              const headerColumnTables = new Set(next.headerColumnTables);
              if (headerColumnTables.has(togglePos)) headerColumnTables.delete(togglePos);
              else headerColumnTables.add(togglePos);
              next = { ...next, headerColumnTables };
            }
            const colorChange = tr.getMeta(SET_CELL_COLOR_META) as { positions: number[]; color: string | null } | undefined;
            if (colorChange) {
              const cellColors = new Map(next.cellColors);
              for (const pos of colorChange.positions) {
                if (colorChange.color) cellColors.set(pos, colorChange.color);
                else cellColors.delete(pos);
              }
              next = { ...next, cellColors };
            }
            return next;
          },
        },
        props: {
          decorations(state) {
            const value = tableCosmeticsKey.getState(state);
            if (!value || (value.headerColumnTables.size === 0 && value.cellColors.size === 0)) return DecorationSet.empty;
            const decorations: Decoration[] = [];
            for (const tablePos of value.headerColumnTables) {
              const table = state.doc.nodeAt(tablePos);
              if (!table) continue;
              const map = TableMap.get(table);
              for (let row = 0; row < map.height; row++) {
                const relPos = map.positionAt(row, 0, table);
                const cell = table.nodeAt(relPos);
                if (!cell) continue;
                const abs = tablePos + 1 + relPos;
                decorations.push(Decoration.node(abs, abs + cell.nodeSize, { class: "table-cosmetic-header-column" }));
              }
            }
            for (const [pos, color] of value.cellColors) {
              const cell = state.doc.nodeAt(pos);
              if (!cell) continue;
              decorations.push(Decoration.node(pos, pos + cell.nodeSize, { style: `background-color: ${color}` }));
            }
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
  );
}

// Toggles whether the CURRENT table's first column is styled like a header
// (bold/shaded) -- cosmetic only, see this file's own doc comment above.
export function toggleHeaderColumn(): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    if (!dispatch) return true;
    const $cell = selectionCell(state);
    const tablePos = $cell.start(-1) - 1;
    dispatch(state.tr.setMeta(TOGGLE_HEADER_COLUMN_META, tablePos));
    return true;
  };
}

// `color: null` clears. Applies to just the focused cell.
export function setCellColor(color: string | null): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    if (!dispatch) return true;
    const $cell = selectionCell(state);
    dispatch(state.tr.setMeta(SET_CELL_COLOR_META, { positions: [$cell.pos], color }));
    return true;
  };
}

// Applies the same color to every cell in the current column.
export function fillColumnColor(color: string | null): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    if (!dispatch) return true;
    const $cell = selectionCell(state);
    const table = $cell.node(-1);
    const tableStart = $cell.start(-1);
    const map = TableMap.get(table);
    const col = map.findCell($cell.pos - tableStart).left;
    const positions: number[] = [];
    for (let row = 0; row < map.height; row++) positions.push(tableStart + map.positionAt(row, col, table));
    dispatch(state.tr.setMeta(SET_CELL_COLOR_META, { positions, color }));
    return true;
  };
}

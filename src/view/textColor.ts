import type { Command, EditorState } from "prosemirror-state";
import type { MarkType } from "prosemirror-model";
import { $markSchema, $remark } from "@milkdown/kit/utils";

export interface TextColorOption {
  id: string;
  label: string;
  color: string;
}

// Small fixed palette, not a free-form color picker -- consistent with this
// app's established minimalism elsewhere (fixed 3x3 table insert instead of
// a size picker, etc.) and with the closest existing precedent, DrawLayer's
// PEN_STYLES.
export const TEXT_COLORS: TextColorOption[] = [
  { id: "red", label: "Red", color: "#e53935" },
  { id: "orange", label: "Orange", color: "#fb8c00" },
  { id: "green", label: "Green", color: "#43a047" },
  { id: "blue", label: "Blue", color: "#1e88e5" },
  { id: "purple", label: "Purple", color: "#8e24aa" },
  { id: "gray", label: "Gray", color: "#757575" },
];

const MARK_NAME = "text_color";
// The mdast node type this mark round-trips through -- see colorSpanRemark
// below. Named differently from the ProseMirror mark (camelCase, matching
// mdast convention) purely so the two namespaces (ProseMirror schema names
// vs. mdast node types) don't get confused while reading this file.
const MDAST_TYPE = "textColor";

// Matches this module's own serialized output (`<span style="color: X">`),
// tolerant of minor formatting variance (no space after the colon, a
// trailing `;`, single quotes) since hand-edited or externally-written
// markdown could plausibly use any of those -- but deliberately not a full
// HTML/CSS parser. Round-tripping THIS module's own output is the actual
// requirement; anything else present as raw inline HTML is simply left
// alone (rendered as literal text, the same as any other HTML this editor
// doesn't specifically understand).
const OPEN_TAG_RE = /^<span\s+style=(["'])\s*color:\s*([^"';]+?)\s*;?\s*\1\s*>$/i;
const CLOSE_TAG = "</span>";

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  [key: string]: unknown;
}

// Merges `html` "<span style=\"color:X\">", ...content..., `html` "</span>"
// sibling triples into one `textColor` node with the color stored as an
// attribute and the in-between nodes as its children. Needed because
// CommonMark (via remark-parse, not a GFM extension -- raw inline HTML is
// core CommonMark) tokenizes a run like `<span style="color:red">text</span>`
// as THREE UNRELATED SIBLING NODES (an opening-tag `html` node, a `text`
// node, a closing-tag `html` node), not one node wrapping the content the
// way `strong`/`emphasis`/`delete` nodes already do -- confirmed directly
// against remark's actual tokenization, not assumed. Every other mark in
// this app's schema sidesteps this because remark-gfm/remark-parse already
// hands Milkdown a single ready-made wrapping node for `**bold**`/`~~del~~`;
// color has no such native syntax, so this reassembly has to happen by hand,
// recursively, at every level of the tree that has phrasing-content
// children (paragraphs, headings, list items, table cells, ...).
function mergeColorSpans(node: MdastNode): void {
  if (!Array.isArray(node.children)) return;

  const merged: MdastNode[] = [];
  const children = node.children;
  let i = 0;
  while (i < children.length) {
    const child = children[i]!;
    const match = child.type === "html" && typeof child.value === "string" ? OPEN_TAG_RE.exec(child.value.trim()) : null;
    if (match) {
      let closeIndex = -1;
      for (let j = i + 1; j < children.length; j++) {
        const candidate = children[j]!;
        if (candidate.type === "html" && typeof candidate.value === "string" && candidate.value.trim() === CLOSE_TAG) {
          closeIndex = j;
          break;
        }
      }
      if (closeIndex !== -1) {
        merged.push({ type: MDAST_TYPE, color: match[2]!.trim(), children: children.slice(i + 1, closeIndex) });
        i = closeIndex + 1;
        continue;
      }
      // No matching close tag found in this same children array -- leave
      // the lone open-tag node as-is rather than guessing; it'll just
      // render as literal text, the same as any unrecognized raw HTML.
    }
    merged.push(child);
    i++;
  }

  node.children = merged;
  for (const child of merged) mergeColorSpans(child);
}

interface ToMarkdownState {
  createTracker: (info: unknown) => { move: (value: string) => string; current: () => unknown };
  containerPhrasing: (node: MdastNode, options: unknown) => string;
}

function serializeTextColor(node: MdastNode, _parent: unknown, state: ToMarkdownState, info: unknown): string {
  const tracker = state.createTracker(info);
  const open = `<span style="color: ${node.color}">`;
  let value = tracker.move(open);
  value += state.containerPhrasing(node, { ...(tracker.current() as object), before: value, after: CLOSE_TAG });
  value += tracker.move(CLOSE_TAG);
  return value;
}

// Registers both halves of the round-trip on one unified/remark processor
// (the same pattern remark-gfm itself uses -- one plugin, parse-side and
// stringify-side together): mergeColorSpans runs as a tree transform after
// parsing, and the toMarkdownExtensions handler teaches remark-stringify how
// to serialize the `textColor` node type back out, since it's not a
// standard mdast type any built-in handler already knows.
export const textColorRemark = $remark("text-color", () => {
  return function textColorPlugin(this: { data: (key: string, value?: unknown) => unknown }) {
    const existing = (this.data("toMarkdownExtensions") as unknown[] | undefined) ?? [];
    this.data("toMarkdownExtensions", [...existing, { handlers: { [MDAST_TYPE]: serializeTextColor } }]);
    // Typed `any` at this one boundary rather than fighting the real
    // mdast Root/RootContent types into matching this file's own looser
    // MdastNode shape (used throughout below purely as a convenient,
    // locally-defined view of "a node with a type and maybe children") --
    // mergeColorSpans only ever reads `.type`/`.value`/`.children`, which
    // every real mdast node has.
    return (tree: any) => {
      mergeColorSpans(tree);
    };
  };
});

function normalizeColor(value: string): string {
  // Browsers normalize an inline `style.color` read back from a live DOM
  // element to `rgb(r, g, b)` regardless of how it was originally written
  // (e.g. after paste, or ProseMirror reconstructing a mark via parseDOM) --
  // converting back to hex keeps attrs.color consistent with this module's
  // own hex-based TEXT_COLORS palette, so active-swatch highlighting and
  // markdown serialization don't silently diverge from what the user
  // actually picked.
  const match = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(value.trim());
  if (!match) return value;
  const toHex = (n: string) => Number(n).toString(16).padStart(2, "0");
  return `#${toHex(match[1]!)}${toHex(match[2]!)}${toHex(match[3]!)}`;
}

export const textColorMarkSchema = $markSchema(MARK_NAME, () => ({
  attrs: { color: { default: "" } },
  parseDOM: [
    {
      tag: "span[style*=color]",
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) return false;
        const color = dom.style.color;
        return color ? { color: normalizeColor(color) } : false;
      },
    },
  ],
  toDOM: (mark) => ["span", { style: `color: ${mark.attrs.color}` }, 0],
  parseMarkdown: {
    match: (node) => node.type === MDAST_TYPE,
    runner: (state, node, markType) => {
      state.openMark(markType, { color: node.color });
      state.next((node as MdastNode).children as never);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === MARK_NAME,
    runner: (state, mark) => {
      state.withMark(mark, MDAST_TYPE, undefined, { color: mark.attrs.color });
    },
  },
}));

// Explicit remove-then-add rather than a plain toggleMark: multiple swatch
// buttons share this one mark type, and picking a different color on an
// already-colored selection should replace it, not stack attrs or no-op
// (toggleMark's own "already active" check compares the exact attrs object,
// so it wouldn't reliably switch colors on its own).
export function setTextColor(markType: MarkType, color: string): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    if (empty) return false;
    if (dispatch) dispatch(state.tr.removeMark(from, to, markType).addMark(from, to, markType.create({ color })));
    return true;
  };
}

export function clearTextColor(markType: MarkType): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    if (empty || !state.doc.rangeHasMark(from, to, markType)) return false;
    if (dispatch) dispatch(state.tr.removeMark(from, to, markType));
    return true;
  };
}

// Attrs-aware active-state check (plain isMarkActive in commands.ts only
// checks mark-type presence, not which color) -- used to highlight whichever
// swatch matches the current selection's actual color.
export function isTextColorActive(state: EditorState, markType: MarkType, color: string): boolean {
  const { from, to, empty, $from } = state.selection;
  if (empty) {
    const mark = markType.isInSet(state.storedMarks ?? $from.marks());
    return !!mark && mark.attrs.color === color;
  }
  let active = false;
  state.doc.nodesBetween(from, to, (node) => {
    const mark = markType.isInSet(node.marks);
    if (mark && mark.attrs.color === color) active = true;
  });
  return active;
}

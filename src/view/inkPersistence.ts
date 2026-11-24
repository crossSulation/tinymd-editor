import type { Node as ProseNode, NodeType } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $nodeSchema, $remark } from "@milkdown/kit/utils";

// Persisted shape of a single PM-anchored ink point/stroke -- deliberately
// NOT the same shape as DrawLayer.tsx's own live `PmPoint`/`Stroke`: this is
// the on-disk/wire format (base64-JSON inside the markdown), DrawLayer.tsx
// converts to/from its own internal representation at the boundary (see its
// readInkData/writeInkData call sites). Only PM-anchored points are ever
// persisted -- scroll-anchored ones (virtualized documents, or anything
// drawn before the single instance finishes mounting) have no stable
// cross-session meaning (a raw scrollTop means nothing on a different
// device/viewport) and stay session-only, same scope line already drawn for
// reflow-anchoring itself.
export interface InkPoint {
  pos: number;
  dx: number;
  dy: number;
}

export interface InkStroke {
  penStyle: { color: string; width: number; opacity?: number };
  points: InkPoint[];
  /**
   * True for a "pin"-mode (Word-style whole-block-anchored, rigid) stroke --
   * omitted (falsy) for an ordinary "markup"-mode (per-point reflow-
   * anchored) one. Added as a new optional field rather than a `v` bump
   * (still `1`): every existing document without this field already means
   * exactly what it meant before (ordinary per-point anchoring), so this is
   * fully backward compatible with no migration needed. See
   * DrawLayer.tsx's PmRigidPoint/PmChunkRigidPoint for how this flag
   * round-trips to/from the live in-memory point kind.
   */
  rigid?: boolean;
}

export interface InkData {
  v: 1;
  strokes: InkStroke[];
}

function encodeInkData(data: InkData): string {
  return btoa(encodeURIComponent(JSON.stringify(data)));
}

function decodeInkData(raw: string): InkData | null {
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(atob(raw)));
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as InkData).v === 1 &&
      Array.isArray((parsed as InkData).strokes)
    ) {
      return parsed as InkData;
    }
    return null;
  } catch {
    // Malformed/foreign data (hand-edited markdown, a future format version)
    // shouldn't block the editor from loading -- just means no ink to show.
    return null;
  }
}

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  data?: string;
  [key: string]: unknown;
}

const INK_MDAST_TYPE = "inkPersisted";

// A bare `<ink data="...">` on a line by itself (nothing else, no closing
// tag) is what CommonMark calls an HTML block "type 7": any unrecognized
// tag's complete open tag, alone on a line, surrounded by blank lines --
// this is the whole reason the format has no closing tag at all. Adding one
// on the SAME line (`<ink data="...">...</ink>`) would make the line fail
// type 7's "nothing else on this line" start condition and fall back to
// ordinary inline-HTML tokenization instead (the same path that split
// mediaEmbed.ts's video/audio tags into separate sibling nodes requiring a
// merge step) -- deliberately avoided here by never emitting a closing tag,
// so remark-parse hands this back as ONE opaque `html` mdast node already,
// no sibling-pair merging needed the way mediaEmbed.ts's inline case
// required.
const INK_TAG_RE = /^<ink\s+data="([^"]*)">$/;

function matchInkTag(htmlNode: MdastNode): string | null {
  if (htmlNode.type !== "html" || typeof htmlNode.value !== "string") return null;
  const match = INK_TAG_RE.exec(htmlNode.value.trim());
  return match ? match[1]! : null;
}

function convertInkNodes(node: MdastNode): void {
  if (!Array.isArray(node.children)) return;
  node.children = node.children.map((child) => {
    // @milkdown/preset-commonmark ships its own remark plugin
    // (remark-html-transformer.ts, registered automatically by `.use(commonmark)`)
    // that normalizes EVERY html node whose parent is a block container --
    // which a standalone, CommonMark html-block-type-7 top-level `<ink>` tag's
    // parent (the document root) always is -- into a paragraph wrapping a
    // single html child with the original value preserved. Confirmed
    // directly against that plugin's source, not assumed: `node.children =
    // [cloneLeaf(node)]; node.type = "paragraph";`. This is the exact same
    // shape CommonMark's own implicit-paragraph-wrapping already produces
    // for genuinely inline html (the case mediaEmbed.ts's video/audio tags
    // hit and had to unwrap) -- so a bare top-level `<ink>` block ends up
    // looking identical by the time ANY custom remark plugin sees it,
    // regardless of registration order relative to commonmark's own
    // transformer. Checking for this paragraph-wrapped shape (not just a
    // bare top-level html node, kept below as a fallback in case that
    // transformer's behavior or registration order ever changes) is what
    // actually works, confirmed directly via a real reload round trip --
    // checking only the bare top-level case left `readInkData` always
    // finding a plain paragraph instead, a real bug, not a theoretical one.
    if (child.type === "paragraph" && Array.isArray(child.children) && child.children.length === 1) {
      const data = matchInkTag(child.children[0]!);
      if (data !== null) return { type: INK_MDAST_TYPE, data };
    }
    const data = matchInkTag(child);
    if (data !== null) return { type: INK_MDAST_TYPE, data };
    return child;
  });
  for (const child of node.children) convertInkNodes(child);
}

// Registered on the same unified remark processor as every other custom
// markdown feature here (same $remark pattern as textColor.ts/mediaEmbed.ts).
// No toMarkdownExtensions registration needed -- the serialize side
// (inkNodeSchema.toMarkdown below) re-emits through Milkdown's own already-
// registered "html" mdast node type, same reasoning as mediaEmbed.ts.
export const inkRemark = $remark("ink-persistence", () => {
  return function inkPersistencePlugin() {
    // `any` at this one boundary for the same reason as textColor.ts's/
    // mediaEmbed.ts's own plugin functions -- convertInkNodes only reads
    // `.type`/`.value`/`.children`, which every real mdast node has.
    return (tree: any) => {
      convertInkNodes(tree);
    };
  };
});

// Invisible, atom, unselectable -- this node carries data, not visible
// content. No parseDOM: there's no legitimate paste scenario for a raw
// `<div data-ink>` the way there plausibly is for a pasted `<video>` tag
// (mediaEmbed.ts), so there's nothing worth handling there.
export const inkNodeSchema = $nodeSchema("ink", () => ({
  group: "block",
  atom: true,
  selectable: false,
  attrs: { data: { default: "" } },
  // Nothing from `attrs` needs to reach the DOM -- this node's data is only
  // ever read back via `view.state.doc` directly (readInkData/writeInkData),
  // never from the rendered element, so there's no reason to duplicate a
  // potentially large base64 string into the (hidden) DOM tree too.
  // NOT display:none -- confirmed directly as a real bug: a display:none
  // node is removed from the layout tree entirely, and ProseMirror's own
  // DOM<->position mapping (used to resolve every later click/tap anywhere
  // in the document, not just near this node) relies on every node
  // actually participating in layout. With display:none here, clicking
  // ANYWHERE in the document after this node existed silently failed to
  // move the selection to the clicked position -- it stayed wherever it
  // was before, so a subsequent edit (typing, pressing Enter to split a
  // line) landed at that stale position instead of where the user actually
  // tapped. This is what was actually behind "ink strokes visually stretch
  // when editing/adding lines" -- the EDIT itself was landing somewhere
  // unexpected relative to the stroke's own anchored points, not a flaw in
  // the position-remapping math itself. `position:absolute` + zero size +
  // `overflow:hidden` keeps the same zero visual footprint (confirmed,
  // same as before, not interfering with click-past-end) while still
  // giving the node a real (if zero-size) box in the layout tree.
  toDOM: () => ["div", { style: "position:absolute;width:0;height:0;overflow:hidden", "data-ink": "true" }],
  parseMarkdown: {
    match: (node) => node.type === INK_MDAST_TYPE,
    runner: (state, node, type) => {
      state.addNode(type, { data: (node as MdastNode).data ?? "" });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "ink",
    runner: (state, node) => {
      // data is base64 (see encodeInkData) -- URL-safe alphabet plus `+/=`,
      // none of which need HTML-attribute escaping inside a double-quoted
      // value.
      state.addNode("html", undefined, `<ink data="${node.attrs.data}">`);
    },
  },
}));

// Tags the transaction `writeInkData` dispatches so DrawLayer's own
// transaction-remapping subscriber (handleTransaction in DrawLayer.tsx) can
// recognize and skip it -- same pattern as milkdown-chunk-editor's own
// CONTENT_REPLACE_META, for the same reason: without this, a stroke
// anchored at the click-past-end position (`pos === doc.content.size`,
// capturePoint's own fallback for drawing below the last line) collides
// with the ink node's OWN insertion point, which is ALSO always
// `doc.content.size` (see writeInkData below). Confirmed directly as a
// real bug, not theoretical: ProseMirror's default position-mapping bias
// (`assoc = 1`) pushes a position sitting exactly AT an insertion point to
// AFTER the newly inserted content -- so every time the ink node was
// written, any point anchored at the document's end got bumped to sit
// after (effectively inside/past) the very metadata node carrying its own
// data, corrupting that point's position and triggering a feedback loop of
// further (also-corrupting) writes. Excluding this transaction from
// remapping entirely is correct, not just a workaround: writing ink data
// never changes any REAL content a stroke could legitimately need to
// track, so there is nothing for DrawLayer's own points to remap against
// here regardless.
export const INK_SYNC_META = "tinymdInkSync";

function findInkNode(doc: ProseNode, inkNodeType: NodeType): { pos: number; node: ProseNode } | null {
  let result: { pos: number; node: ProseNode } | null = null;
  doc.forEach((node, pos) => {
    if (!result && node.type === inkNodeType) result = { pos, node };
  });
  return result;
}

/** Load-time rehydration: reads whatever ink data is currently stored in the document, or null if there's none (or it's unreadable). */
export function readInkData(doc: ProseNode, inkNodeType: NodeType): InkData | null {
  const found = findInkNode(doc, inkNodeType);
  if (!found) return null;
  return decodeInkData(found.node.attrs.data as string);
}

/**
 * Writes the current ink data back into the document -- inserting the node
 * (if none exists yet and there's data to store), updating it in place (if
 * one exists and the data actually changed), or removing it (if one exists
 * but there's no data left to store, e.g. after Clear). No-ops if nothing
 * actually needs to change, so this is safe to call after every stroke
 * without worrying about spamming empty transactions.
 *
 * Dispatches with `addToHistory: false` -- persisting a drawing isn't a
 * text edit, and shouldn't show up on the undo stack as one. **Important
 * consequence, confirmed directly against `@milkdown/plugin-listener`'s own
 * source**: that plugin's `apply()` explicitly skips any transaction where
 * `tr.getMeta("addToHistory") === false` (`if (... || tr.getMeta("addToHistory")
 * === false) return;`), so this transaction NEVER reaches the `listener`
 * plugin's `markdownUpdated` callback -- Editor.tsx's existing autosave
 * chain (`onMarkdownUpdated` -> `onChange` -> debounced SQLite save) will
 * NOT fire for an ink-only change on its own. Confirmed as a real bug this
 * way, not just reasoned about: the save-on-draw-only path failed entirely
 * before callers started reacting to this function's return value (see
 * DrawLayer.tsx's `onInkPersisted` prop) to explicitly trigger a save
 * through a separate path instead of relying on the listener plugin.
 *
 * @returns whether a transaction was actually dispatched (false means
 * nothing needed to change, e.g. called again with identical data).
 */
export function writeInkData(view: EditorView, inkNodeType: NodeType, data: InkData | null): boolean {
  const existing = findInkNode(view.state.doc, inkNodeType);
  const encoded = data && data.strokes.length > 0 ? encodeInkData(data) : null;

  if (existing && existing.node.attrs.data === encoded) return false;
  if (!existing && encoded === null) return false;

  let tr = view.state.tr;
  if (existing && encoded === null) {
    tr = tr.delete(existing.pos, existing.pos + existing.node.nodeSize);
  } else if (existing && encoded !== null) {
    tr = tr.setNodeMarkup(existing.pos, undefined, { data: encoded });
  } else if (encoded !== null) {
    tr = tr.insert(tr.doc.content.size, inkNodeType.create({ data: encoded }));
  }
  view.dispatch(tr.setMeta("addToHistory", false).setMeta(INK_SYNC_META, true));
  return true;
}

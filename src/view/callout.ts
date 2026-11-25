import { $nodeSchema, $remark } from "@milkdown/kit/utils";

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  [key: string]: unknown;
}

const MARKER_RE = /^\[!(\w+)\]\s*$/;
const MDAST_TYPE = "callout";

// GitHub's own "alert" convention (`> [!NOTE]` as a blockquote's first
// line) -- not a remark-gfm built-in (GitHub's own rendering of this is a
// post-processing layer on top of plain blockquote syntax, confirmed
// directly: remark-gfm only covers tables/strikethrough/autolinks/
// footnotes/task-list-items, nothing alert-specific). Reusing it rather
// than inventing a raw-HTML round-trip (textColor.ts's approach) means a
// callout degrades gracefully to a plain blockquote in any other markdown
// tool, and round-trips as real, recognizable markdown. Only one callout
// "type" is actually surfaced by this app's own UI for now (always "note"
// on insert) -- the attr/marker format supports more, but there's no
// type-switcher UI yet; not asked for, not built.
function calloutTypeOf(node: MdastNode): string | null {
  const first = node.children?.[0];
  if (!first || first.type !== "paragraph" || !Array.isArray(first.children) || first.children.length !== 1) return null;
  const only = first.children[0];
  if (!only || only.type !== "text" || typeof only.value !== "string") return null;
  const match = MARKER_RE.exec(only.value.trim());
  return match ? match[1]!.toLowerCase() : null;
}

// Runs as a tree transform BEFORE Milkdown's own node-schema parseMarkdown
// rules see the tree (same stage textColor.ts's mergeColorSpans runs at) --
// reclassifying the mdast node's own `.type` from "blockquote" to "callout"
// here is what lets this schema (matching on `type === "callout"`) and the
// commonmark preset's own unconditional blockquote schema (matching on
// `type === "blockquote"`, with no further check) both apply correctly to
// the right nodes, without either one needing to know about the other.
function markCallouts(node: MdastNode): void {
  if (!Array.isArray(node.children)) return;
  for (const child of node.children) {
    if (child.type === "blockquote") {
      const calloutType = calloutTypeOf(child);
      if (calloutType) {
        child.type = MDAST_TYPE;
        child.calloutType = calloutType;
        child.children = child.children!.slice(1); // drop the "[!NOTE]" marker paragraph
      }
    }
    markCallouts(child);
  }
}

export const calloutRemark = $remark("callout", () => {
  return () => (tree: any) => {
    markCallouts(tree);
  };
});

export const calloutNodeSchema = $nodeSchema("callout", () => ({
  content: "block+",
  group: "block",
  defining: true,
  attrs: { calloutType: { default: "note" } },
  parseDOM: [
    {
      tag: "div[data-callout]",
      getAttrs: (dom) => (dom instanceof HTMLElement ? { calloutType: dom.getAttribute("data-callout") || "note" } : false),
    },
  ],
  toDOM: (node) => [
    "div",
    { class: `callout callout-${node.attrs.calloutType}`, "data-callout": node.attrs.calloutType },
    ["span", { class: "callout-icon", "aria-hidden": "true" }, "ℹ"],
    ["div", { class: "callout-body" }, 0],
  ],
  parseMarkdown: {
    match: (node) => node.type === MDAST_TYPE,
    runner: (state, node, type) => {
      state.openNode(type, { calloutType: (node as MdastNode).calloutType ?? "note" });
      state.next((node as MdastNode).children as never);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "callout",
    runner: (state, node) => {
      state.openNode("blockquote");
      state.addNode("paragraph", [{ type: "text", value: `[!${String(node.attrs.calloutType).toUpperCase()}]` }] as never);
      state.next(node.content);
      state.closeNode();
    },
  },
}));

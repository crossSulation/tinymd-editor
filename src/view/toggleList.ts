import type { Node as ProseNode } from "prosemirror-model";
import type { EditorView, NodeView } from "prosemirror-view";
import { $nodeSchema, $remark, $view } from "@milkdown/kit/utils";

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  [key: string]: unknown;
}

const OPEN_RE = /^<details>\s*(?:<summary>([\s\S]*?)<\/summary>)?\s*$/i;
const CLOSE_RE = /^<\/details>\s*$/i;
const MDAST_TYPE = "toggleList";

// Bare remark-parse+remark-gfm (confirmed directly, standalone) leaves a
// top-level `<details>...` HTML block as a plain, unwrapped "html" node.
// But @milkdown/preset-commonmark ships its own remark plugin (registered
// automatically by `.use(commonmark)` in createMilkdownEditor.ts) that
// normalizes EVERY html node whose parent is a block container into a
// paragraph wrapping a single html child, with the original value
// preserved -- confirmed directly against that plugin's source (the exact
// same finding inkPersistence.ts's own convertInkNodes documents for its
// `<ink>` tag) -- and this happens regardless of registration order
// relative to this plugin. `htmlValueOf` checks both shapes.
function htmlValueOf(node: MdastNode): string | null {
  if (node.type === "html" && typeof node.value === "string") return node.value;
  if (node.type === "paragraph" && Array.isArray(node.children) && node.children.length === 1) {
    const only = node.children[0]!;
    if (only.type === "html" && typeof only.value === "string") return only.value;
  }
  return null;
}

// With a blank line after the opening marker, everything up to the
// matching `</details>` parses as ORDINARY, REAL mdast nodes (paragraphs,
// lists, etc.), confirmed directly via a real parse, not assumed -- so a
// toggle list's body keeps full markdown fidelity, not an opaque blob.
// This transform spans an ARBITRARY NUMBER of intervening siblings (unlike
// mergeColorSpans/mergeEmbedTags' fixed small pairs), collecting
// everything between the open/close markers as the toggle's own body.
function mergeToggleLists(node: MdastNode): void {
  if (!Array.isArray(node.children)) return;

  const merged: MdastNode[] = [];
  const children = node.children;
  let i = 0;
  while (i < children.length) {
    const child = children[i]!;
    const childHtml = htmlValueOf(child);
    const openMatch = childHtml !== null ? OPEN_RE.exec(childHtml.trim()) : null;
    if (openMatch) {
      let closeIndex = -1;
      for (let j = i + 1; j < children.length; j++) {
        const candidateHtml = htmlValueOf(children[j]!);
        if (candidateHtml !== null && CLOSE_RE.test(candidateHtml.trim())) {
          closeIndex = j;
          break;
        }
      }
      if (closeIndex !== -1) {
        merged.push({ type: MDAST_TYPE, summary: openMatch[1]?.trim() ?? "", children: children.slice(i + 1, closeIndex) });
        i = closeIndex + 1;
        continue;
      }
      // No matching close found in this children array -- leave as-is
      // rather than guessing; it renders as literal/inert HTML, same as
      // any other HTML this editor doesn't specifically understand.
    }
    merged.push(child);
    i++;
  }

  node.children = merged;
  for (const child of merged) mergeToggleLists(child);
}

export const toggleListRemark = $remark("toggle-list", () => {
  return () => (tree: any) => {
    mergeToggleLists(tree);
  };
});

// Two child node types (toggle_summary/toggle_body) rather than one node
// with a plain string attr -- the same structural pattern the GFM table
// schema itself uses for its header/body row split (separate node types
// for separate structural slots). This gives a REAL, directly-editable
// ProseMirror content area for both the summary text and the body, with no
// custom NodeView/contentEditable-wrangling needed for the title the way a
// plain-attr design would have required.
export const toggleListNodeSchema = $nodeSchema("toggle_list", () => ({
  content: "toggle_summary toggle_body",
  group: "block",
  defining: true,
  // Live editing state only (like tableCosmetics.ts's header-column/cell
  // color) -- collapse/expand has no markdown representation to persist
  // either; every toggle list reloads expanded regardless of how it was
  // left. Needed as a real attr (not just DOM state) so ToggleListNodeView
  // below can keep a user's native open/close click in sync across
  // ProseMirror re-renders, rather than toDOM silently re-expanding it.
  attrs: { collapsed: { default: false } },
  toDOM: (node) => ["details", { class: "toggle-list", ...(node.attrs.collapsed ? {} : { open: "true" }) }, 0],
  parseDOM: [{ tag: "details", getAttrs: (dom) => (dom instanceof HTMLDetailsElement ? { collapsed: !dom.open } : false) }],
  parseMarkdown: {
    match: (node) => node.type === MDAST_TYPE,
    runner: (state, node, type) => {
      const mdastNode = node as MdastNode;
      state.openNode(type);
      // Dispatches to toggle_summary's/toggle_body's own parseMarkdown
      // rules via synthetic mdast node types, same mechanism the GFM table
      // schema uses to route a "tableRow" mdast node to either
      // table_header_row or table_row based on an extra flag.
      state.next([
        { type: "toggleSummary", value: mdastNode.summary ?? "" },
        { type: "toggleBody", children: mdastNode.children ?? [] },
      ] as never);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "toggle_list",
    runner: (state, node) => {
      // Built directly here (not delegated to toggle_summary's own
      // toMarkdown) because remark-stringify inserts a blank line between
      // SEPARATE sibling "html" nodes by default (confirmed directly) --
      // which would split "<details>" and "<summary>...</summary>" onto
      // two separate HTML blocks on round-trip, breaking OPEN_RE above
      // (which expects them combined, no blank line between). Emitting
      // them as ONE "html" node's value with an internal newline sidesteps
      // that entirely -- confirmed directly that stringify leaves a single
      // node's own internal newlines untouched.
      const summaryText = node.firstChild?.textContent ?? "";
      state.addNode("html", undefined, `<details>\n<summary>${summaryText}</summary>`);
      state.next(node.lastChild!.content);
      state.addNode("html", undefined, "</details>");
    },
  },
}));

// Plain text only (no marks) -- markdown inside the opaque `<summary>` tag
// text is never interpreted as markdown by remark at all (confirmed
// directly: it's part of ONE opaque html-block value, not parsed), so
// letting the schema allow marks here would silently fail to round-trip
// them, a misleading UI. "text*" makes the schema itself refuse marks,
// which the Toolbar's own isMarkActive/command-disabled checks already
// respect for free.
export const toggleSummaryNodeSchema = $nodeSchema("toggle_summary", () => ({
  content: "text*",
  toDOM: () => ["summary", { class: "toggle-summary" }, 0],
  parseDOM: [{ tag: "summary" }],
  parseMarkdown: {
    match: (node) => node.type === "toggleSummary",
    runner: (state, node, type) => {
      const text = (node as MdastNode).value as string | undefined;
      state.openNode(type);
      if (text) state.addText(text);
      state.closeNode();
    },
  },
  // Never actually invoked by this app's own serialization path (toggle_list's
  // own runner above reads .textContent directly instead), but
  // NodeSchema.toMarkdown is a required field -- a real, working
  // implementation here is harmless and more robust than dead code that
  // can't run, should anything else ever call state.next on this node type.
  toMarkdown: {
    match: (node) => node.type.name === "toggle_summary",
    runner: (state, node) => {
      state.addNode("html", undefined, `<summary>${node.textContent}</summary>`);
    },
  },
}));

export const toggleBodyNodeSchema = $nodeSchema("toggle_body", () => ({
  content: "block+",
  toDOM: () => ["div", { class: "toggle-body" }, 0],
  parseMarkdown: {
    match: (node) => node.type === "toggleBody",
    runner: (state, node, type) => {
      state.openNode(type);
      state.next((node as MdastNode).children as never);
      state.closeNode();
    },
  },
  // Same note as toggle_summary above -- not invoked by this app's own
  // round-trip (toggle_list's runner calls state.next(node.lastChild.content)
  // directly), kept as a real fallback regardless.
  toMarkdown: {
    match: (node) => node.type.name === "toggle_body",
    runner: (state, node) => {
      state.next(node.content);
    },
  },
}));

// toDOM alone can't track a native open/close click back into the
// `collapsed` attr -- ProseMirror has no built-in hook for a plain DOM
// "toggle" event on a toDOM-only node, so this needs a real NodeView.
// `contentDOM` is the `<details>` element itself (not a separate wrapper):
// toggle_summary's own `<summary>` and toggle_body's own `<div>` render as
// its direct children, exactly matching native `<details><summary>...
// </summary><div>...</div></details>` structure -- no extra DOM layer
// needed since content syncing is otherwise identical to a plain toDOM node.
class ToggleListNodeView implements NodeView {
  dom: HTMLDetailsElement;
  contentDOM: HTMLElement;
  private node: ProseNode;

  constructor(node: ProseNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node;
    const details = document.createElement("details");
    details.className = "toggle-list";
    details.open = !node.attrs.collapsed;
    details.addEventListener("toggle", () => {
      const pos = getPos();
      if (pos === undefined || details.open === !this.node.attrs.collapsed) return;
      view.dispatch(view.state.tr.setNodeAttribute(pos, "collapsed", !details.open));
    });
    this.dom = details;
    this.contentDOM = details;
  }

  update(node: ProseNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.dom.open = !node.attrs.collapsed;
    return true;
  }
}

export const toggleListNodeView = $view(
  toggleListNodeSchema.node,
  () => (node: ProseNode, view: EditorView, getPos: () => number | undefined) => new ToggleListNodeView(node, view, getPos),
);

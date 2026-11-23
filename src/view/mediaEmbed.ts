import type { Node as ProseNode } from "prosemirror-model";
import type { EditorView, NodeView } from "prosemirror-view";
import { $nodeSchema, $remark, $view } from "@milkdown/kit/utils";

export type MediaEmbedTag = "video" | "audio";

// Reused from commands.ts's own escaping need (video/audio URLs end up
// inside an HTML attribute in the saved markdown) -- duplicated rather than
// imported to keep this file's only dependency on commands.ts-side code at
// zero (commands.ts already imports from here, not the other way around).
function escapeHtmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  [key: string]: unknown;
}

// Reassembles a `<video src="...">`/`<audio src="...">` ... `</video>`/
// `</audio>` sibling pair into one `{ type: mdastType, url }` node, THEN
// unwraps it out of its enclosing paragraph where that paragraph contains
// nothing else. Both steps are needed, not just the first: remark-parse
// tokenizes a standalone inline-level `<video src="x" controls></video>` as
// TWO SEPARATE sibling `html` nodes (open tag, close tag) wrapped in an
// IMPLICIT PARAGRAPH -- confirmed directly, not assumed (`video`/`audio`
// aren't in CommonMark's fixed list of block-level HTML tag names, so this
// never becomes a single opaque HTML-block node the way e.g. `<div>...</div>`
// would; CommonMark wraps any otherwise-unstructured inline content in an
// implicit paragraph regardless). This app's own video/audio ProseMirror
// nodes are `group: "block"`, so leaving the merged embed node nested
// inside that implicit paragraph -- a block-type node as a paragraph's
// child -- produced a real `MilkdownError: "Cannot create node for
// paragraph"` on reload, confirmed directly (not assumed): paragraph's own
// content expression only allows inline content, and Milkdown's generic
// paragraph parseMarkdown runner fails constructing the node once it holds
// an invalid block-type child. There's never meaningful content *between*
// the two tags here (this app's own insertVideo/insertAudio never put any),
// so the merge only needs to look for the close tag immediately following
// the open tag, not collect arbitrary in-between children -- and the
// unwrap only fires when the paragraph's children reduce to *exactly* the
// one embed node (nothing else), leaving any paragraph that also has real
// surrounding text alone, falling back to the ordinary inert html-passthrough
// rendering for that case rather than guessing.
function mergeOpenClosePair(children: MdastNode[], openRe: RegExp, closeTag: string, mdastType: string): MdastNode[] {
  const merged: MdastNode[] = [];
  let i = 0;
  while (i < children.length) {
    const child = children[i]!;
    const match = child.type === "html" && typeof child.value === "string" ? openRe.exec(child.value.trim()) : null;
    const next = children[i + 1];
    if (match && next && next.type === "html" && typeof next.value === "string" && next.value.trim() === closeTag) {
      merged.push({ type: mdastType, url: match[2] });
      i += 2;
      continue;
    }
    merged.push(child);
    i++;
  }
  return merged;
}

function mergeEmbedTags(node: MdastNode, tag: MediaEmbedTag, mdastType: string): void {
  if (!Array.isArray(node.children)) return;

  const openRe = new RegExp(`^<${tag}\\s+src=(["'])([^"']*)\\1[^>]*>$`, "i");
  const closeTag = `</${tag}>`;

  const result: MdastNode[] = [];
  for (const child of node.children) {
    if (child.type === "paragraph" && Array.isArray(child.children)) {
      const mergedParaChildren = mergeOpenClosePair(child.children, openRe, closeTag, mdastType);
      if (mergedParaChildren.length === 1 && mergedParaChildren[0]!.type === mdastType) {
        result.push(mergedParaChildren[0]!); // unwrap: the embed replaces the whole paragraph
        continue;
      }
      child.children = mergedParaChildren;
      result.push(child);
      continue;
    }
    result.push(child);
  }

  node.children = result;
  for (const child of result) mergeEmbedTags(child, tag, mdastType);
}

const VIDEO_MDAST_TYPE = "videoEmbed";
const AUDIO_MDAST_TYPE = "audioEmbed";

// One plugin, both tags -- registered on the same unified processor as
// everything else (same `$remark` pattern as textColor.ts's
// textColorRemark). No toMarkdownExtensions registration is needed here,
// unlike textColor.ts: the serialize side below re-emits through Milkdown's
// own already-registered "html" mdast node type directly (see
// createMediaNodeSchema's toMarkdown), which mdast-util-to-markdown already
// knows how to handle natively -- there's no new mdast type to teach it.
export const mediaEmbedRemark = $remark("media-embed", () => {
  return function mediaEmbedPlugin() {
    // `any` at this one boundary for the same reason as textColor.ts's
    // textColorPlugin -- mergeEmbedTags only reads `.type`/`.value`/
    // `.children`, which every real mdast node has; fighting the real
    // Root/RootContent types into matching this file's own looser MdastNode
    // shape isn't worth it.
    return (tree: any) => {
      mergeEmbedTags(tree, "video", VIDEO_MDAST_TYPE);
      mergeEmbedTags(tree, "audio", AUDIO_MDAST_TYPE);
    };
  };
});

// Minimal NodeView -- not a Mermaid/CodeMirror-scale custom component.
// `stopEvent` returning true for every event is the one genuinely necessary
// piece: without it, ProseMirror's own click/mousedown handling (which
// normally decides selection for atom nodes) intercepts taps meant for the
// native play/pause button and scrubber *inside* this element, since this
// node's DOM is otherwise just handed to the browser via a declarative
// toDOM -- a well-known ProseMirror gotcha for any atom node containing its
// own interactive controls, confirmed directly against ProseMirror's own
// NodeView docs (`stopEvent` exists specifically for this). Native
// `<video controls>`/`<audio controls>` already provide full play/pause/
// seek interactivity on their own; no custom JS behavior needed beyond
// getting out of their way.
class MediaNodeView implements NodeView {
  dom: HTMLElement;

  constructor(node: ProseNode, tag: MediaEmbedTag) {
    const el = document.createElement(tag);
    el.src = node.attrs.src;
    el.controls = true;
    el.style.maxWidth = "100%";
    this.dom = el;
  }

  stopEvent(): boolean {
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }
}

function createMediaNodeSchema(tag: MediaEmbedTag, mdastType: string) {
  return $nodeSchema(tag, () => ({
    group: "block",
    atom: true,
    selectable: true,
    attrs: { src: { default: "" } },
    parseDOM: [
      {
        tag: `${tag}[src]`,
        getAttrs: (dom) => (dom instanceof HTMLElement ? { src: dom.getAttribute("src") || "" } : false),
      },
    ],
    toDOM: (node) => [tag, { src: node.attrs.src, controls: "true" }],
    parseMarkdown: {
      match: (node) => node.type === mdastType,
      runner: (state, node, type) => {
        state.addNode(type, { src: (node as MdastNode).url });
      },
    },
    toMarkdown: {
      match: (node) => node.type.name === tag,
      runner: (state, node) => {
        // Re-emits through Milkdown's own "html" mdast node type (the same
        // one its built-in html-passthrough node already uses) rather than
        // `mdastType` -- see mediaEmbedRemark's comment above for why that
        // needs no extra serializer registration. The output string is
        // byte-for-byte what this app's original (pre-NodeView)
        // insertVideo/insertAudio commands already produced, so documents
        // saved before this change still load correctly -- they just
        // become real players now instead of inert text.
        state.addNode("html", undefined, `<${tag} src="${escapeHtmlAttr(node.attrs.src)}" controls></${tag}>`);
      },
    },
  }));
}

export const videoNodeSchema = createMediaNodeSchema("video", VIDEO_MDAST_TYPE);
export const audioNodeSchema = createMediaNodeSchema("audio", AUDIO_MDAST_TYPE);

export const videoNodeView = $view(videoNodeSchema.node, () => (node: ProseNode, _view: EditorView, _getPos: () => number | undefined) => new MediaNodeView(node, "video"));
export const audioNodeView = $view(audioNodeSchema.node, () => (node: ProseNode, _view: EditorView, _getPos: () => number | undefined) => new MediaNodeView(node, "audio"));

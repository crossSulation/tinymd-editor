import { $markSchema, $remark } from "@milkdown/kit/utils";

// Same situation as textColor.ts, simpler: markdown has no native underline
// syntax at all (deliberately -- most markdown flavors omit it specifically
// to avoid visual confusion with links), so this needs the same custom-mark
// + remark-plugin round-trip textColor.ts already built and verified, just
// without an attribute to carry (a fixed `<u>`/`</u>` wrapper, not a
// `<span style="...">` one).

const MARK_NAME = "underline";
const MDAST_TYPE = "underline";
const OPEN_TAG = "<u>";
const CLOSE_TAG = "</u>";

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  [key: string]: unknown;
}

// Same CommonMark quirk as textColor.ts's mergeColorSpans: remark-parse
// tokenizes a standalone `<u>text</u>` as three sibling nodes (open-tag
// `html`, `text`, close-tag `html`), not one wrapping node -- reassembled
// here the same way, minus the attribute extraction textColor.ts needed.
function mergeUnderlineSpans(node: MdastNode): void {
  if (!Array.isArray(node.children)) return;

  const children = node.children;
  const merged: MdastNode[] = [];
  let i = 0;
  while (i < children.length) {
    const child = children[i]!;
    if (child.type === "html" && typeof child.value === "string" && child.value.trim() === OPEN_TAG) {
      let closeIndex = -1;
      for (let j = i + 1; j < children.length; j++) {
        const candidate = children[j]!;
        if (candidate.type === "html" && typeof candidate.value === "string" && candidate.value.trim() === CLOSE_TAG) {
          closeIndex = j;
          break;
        }
      }
      if (closeIndex !== -1) {
        merged.push({ type: MDAST_TYPE, children: children.slice(i + 1, closeIndex) });
        i = closeIndex + 1;
        continue;
      }
      // No matching close tag in this children array -- leave the lone
      // open-tag node as-is rather than guessing (same policy as
      // textColor.ts/mediaEmbed.ts).
    }
    merged.push(child);
    i++;
  }

  node.children = merged;
  for (const child of merged) mergeUnderlineSpans(child);
}

interface ToMarkdownState {
  createTracker: (info: unknown) => { move: (value: string) => string; current: () => unknown };
  containerPhrasing: (node: MdastNode, options: unknown) => string;
}

function serializeUnderline(node: MdastNode, _parent: unknown, state: ToMarkdownState, info: unknown): string {
  const tracker = state.createTracker(info);
  let value = tracker.move(OPEN_TAG);
  value += state.containerPhrasing(node, { ...(tracker.current() as object), before: value, after: CLOSE_TAG });
  value += tracker.move(CLOSE_TAG);
  return value;
}

// Same "one plugin, both directions" pattern as textColorRemark: a tree
// transform for parsing (mergeUnderlineSpans) plus a toMarkdownExtensions
// registration (via this.data(...) at .use() time) for serializing the
// custom "underline" mdast type back out, since no built-in handler knows
// a type it doesn't recognize.
export const underlineRemark = $remark("underline", () => {
  return function underlinePlugin(this: { data: (key: string, value?: unknown) => unknown }) {
    const existing = (this.data("toMarkdownExtensions") as unknown[] | undefined) ?? [];
    this.data("toMarkdownExtensions", [...existing, { handlers: { [MDAST_TYPE]: serializeUnderline } }]);
    // `any` at this one boundary for the same reason as textColor.ts/
    // mediaEmbed.ts's own plugin functions.
    return (tree: any) => {
      mergeUnderlineSpans(tree);
    };
  };
});

export const underlineMarkSchema = $markSchema(MARK_NAME, () => ({
  parseDOM: [{ tag: "u" }, { style: "text-decoration=underline" }],
  toDOM: () => ["u", 0],
  parseMarkdown: {
    match: (node) => node.type === MDAST_TYPE,
    runner: (state, node, markType) => {
      state.openMark(markType);
      state.next((node as MdastNode).children as never);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === MARK_NAME,
    runner: (state, mark) => {
      state.withMark(mark, MDAST_TYPE);
    },
  },
}));

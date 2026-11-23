import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import remarkGfm from "remark-gfm";
import type { Root, RootContent } from "mdast";

// GFM (tables, task lists, strikethrough) matches what Crepe's own schema
// supports (@milkdown/preset-gfm); without it, e.g. a table parses as an
// inert paragraph instead of a real table node (harmless for round-tripping
// but loses the ability to reason about it structurally).
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkStringify);

// One row per top-level markdown block (paragraph, heading, list, table,
// code block, etc.), matching how `blocks` rows are stored in SQLite.
export function splitMarkdownIntoBlocks(markdown: string): string[] {
  const root = processor.parse(markdown) as Root;
  return root.children.map((child: RootContent) => {
    const wrapper: Root = { type: "root", children: [child] };
    return String(processor.stringify(wrapper)).replace(/\n+$/, "");
  });
}

// Inverse of splitMarkdownIntoBlocks: each block was serialized
// independently, so a blank line between them reconstructs valid CommonMark
// block flow.
export function joinBlocksIntoMarkdown(blocks: string[]): string {
  return blocks.join("\n\n");
}

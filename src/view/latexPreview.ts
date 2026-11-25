import katex from "katex";
import type { Ctx } from "@milkdown/kit/ctx";
import { commandsCtx } from "@milkdown/kit/core";
import { addBlockTypeCommand, clearTextInCurrentBlockCommand, codeBlockSchema } from "@milkdown/kit/preset/commonmark";

// The CodeMirror feature's `renderPreview` config slot is a single value --
// whichever feature's config runs last wins outright (no composition), so a
// custom renderPreview (see mermaidPreview.ts) risks silently clobbering
// Crepe's own LaTeX-preview wiring depending on internal feature-registration
// order. Reimplementing LaTeX's preview here (identical to what Crepe's own
// LaTeX feature does internally) and composing both in Editor.tsx makes this
// correct regardless of that order.
// Equation numbering ("(1)", "(2)", ...) is pure CSS (`counter-increment`/
// `content: counter(...)` on .latex-eq-wrap, see code-block-layout.css) --
// not computed here, since this callback has no access to its own node's
// position/index in the document (the code-block component calls it with
// only `language`+`content`, confirmed directly against its source), so
// there's no reliable way to number blocks from inside it, especially with
// duplicate content. CSS counters number in DOCUMENT order automatically,
// correct regardless of insertion/deletion/reordering, with no bookkeeping
// needed here at all -- scoped per `.milkdown` root, so each virtualized
// chunk (its own separate Milkdown instance/DOM subtree) numbers its own
// LaTeX blocks independently rather than continuing across chunk
// boundaries, a known limitation consistent with this app's other
// documented cross-chunk gaps (no cross-chunk undo/selection either).
export function renderLatexPreview(language: string, content: string): string | null {
  if (language.toLowerCase() !== "latex" || !content.trim()) return null;
  const html = katex.renderToString(content, { throwOnError: false, displayMode: true });
  return `<div class="latex-eq-wrap">${html}</div>`;
}

// Mirrors insertMermaidBlock's pattern exactly (mermaidPreview.ts) -- a
// code block pre-set to the "LaTeX" language, called directly from a
// toolbar/slash-menu item.
export function insertLatexBlock(ctx: Ctx): void {
  const commands = ctx.get(commandsCtx);
  const codeBlock = codeBlockSchema.type(ctx);

  commands.call(clearTextInCurrentBlockCommand.key);
  commands.call(addBlockTypeCommand.key, {
    nodeType: codeBlock,
    attrs: { language: "LaTeX" },
  });
}

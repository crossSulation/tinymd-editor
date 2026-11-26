import katex from "katex";
// KaTeX's own stylesheet -- required, not cosmetic: without it, the
// accessibility MathML tree `renderToString` always emits alongside the
// visible HTML rendering (`<span class="katex-mathml">`) has no CSS telling
// it to stay visually hidden, so it rendered as a second, plain-text copy of
// the equation directly underneath the real one. Confirmed directly via
// screenshot -- not assumed -- while verifying CodeBlockEditorModal.tsx's
// own LaTeX preview pane visually matched the Math.dc.html design: both this
// inline preview AND the editor modal's live preview showed the duplicate
// text, since neither had ever loaded this stylesheet.
import "katex/dist/katex.min.css";

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

// No insertLatexBlock here anymore -- inserting a new LaTeX block now
// opens CodeBlockEditorModal.tsx first (Toolbar.tsx's "LaTeX block" item
// calls onOpenCodeEditor directly, same as "Code block"), since LaTeX
// blocks are read-only inline now too; the modal's own "Done" calls
// codeBlockEdit.ts's insertCodeBlock with language="LaTeX" once the user
// has actually authored an equation.

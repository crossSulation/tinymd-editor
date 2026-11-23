import katex from "katex";

// The CodeMirror feature's `renderPreview` config slot is a single value --
// whichever feature's config runs last wins outright (no composition), so a
// custom renderPreview (see mermaidPreview.ts) risks silently clobbering
// Crepe's own LaTeX-preview wiring depending on internal feature-registration
// order. Reimplementing LaTeX's preview here (identical to what Crepe's own
// LaTeX feature does internally) and composing both in Editor.tsx makes this
// correct regardless of that order.
export function renderLatexPreview(language: string, content: string): string | null {
  if (language.toLowerCase() !== "latex" || !content.trim()) return null;
  return katex.renderToString(content, { throwOnError: false, displayMode: true });
}

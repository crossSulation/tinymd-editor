// Quick-insert data for CodeBlockEditorModal.tsx's LaTeX editing mode --
// the "Math.dc.html"/"PortraitMath.dc.html" Claude Design artboards'
// snippet-bar row (requested directly: "align to design... add some quick
// action"). Mirrors mermaidEditorKit.ts's own SNIPPETS/NODE_SHAPES split --
// plain insert-at-cursor buttons for the common structures (fraction, sqrt,
// sub/superscript, sum, integral, matrix) vs. two dropdowns (Greek letters,
// relation symbols) for the many-small-choices case, same reasoning Mermaid's
// own Shape dropdown already established over a flat button row.
//
// Deliberately NOT built from this same design pass: the "Block"/"Inline"
// display-mode toggle (would need a real inline-math node type + remark
// round-trip -- the "Inline math is still NOT built" gap UX_PLAN.md's Phase
// 7 already flags as its own follow-up, not something to half-build here),
// the "Number (N)" per-equation checkbox (today's equation numbering is an
// unconditional CSS-counter applied to every LaTeX block -- see
// latexPreview.ts -- making it individually toggleable needs a real schema
// attribute, disproportionate to this pass), the command-suggestion
// autocomplete dropdown (a real feature, but a much larger one -- a LaTeX
// command database wired into CodeMirror's own autocomplete extension,
// Mermaid-autocomplete-sized effort on its own), and "Handwrite" (decision 6
// already resolved: handwriting recognition is deferred entirely, no engine
// decided).

export interface LatexSnippet {
  id: string;
  ariaLabel: string;
  insertText: string;
}

// Plain insert-at-cursor buttons -- literal placeholder text (`a`, `b`, `n`,
// `x`...) the user types over, same "insert a template, don't try to guess
// where the cursor should land inside it" philosophy Mermaid's own
// NODE_SHAPES snippets already use (e.g. `A[Text]`), rather than smart
// nested-cursor placement.
export const LATEX_SNIPPETS: LatexSnippet[] = [
  { id: "fraction", ariaLabel: "Fraction", insertText: "\\frac{a}{b}" },
  { id: "sqrt", ariaLabel: "Square root", insertText: "\\sqrt{x}" },
  { id: "superscript", ariaLabel: "Superscript", insertText: "x^{n}" },
  { id: "subscript", ariaLabel: "Subscript", insertText: "x_{i}" },
  { id: "sum", ariaLabel: "Sum", insertText: "\\sum_{i=1}^{n}" },
  { id: "integral", ariaLabel: "Integral", insertText: "\\int_{a}^{b}" },
  { id: "matrix", ariaLabel: "Matrix", insertText: "\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}" },
];

export interface LatexSymbol {
  id: string;
  display: string;
  insertText: string;
}

export const GREEK_LETTERS: LatexSymbol[] = [
  { id: "alpha", display: "α", insertText: "\\alpha" },
  { id: "beta", display: "β", insertText: "\\beta" },
  { id: "gamma", display: "γ", insertText: "\\gamma" },
  { id: "delta", display: "δ", insertText: "\\delta" },
  { id: "epsilon", display: "ε", insertText: "\\epsilon" },
  { id: "theta", display: "θ", insertText: "\\theta" },
  { id: "lambda", display: "λ", insertText: "\\lambda" },
  { id: "mu", display: "μ", insertText: "\\mu" },
  { id: "pi", display: "π", insertText: "\\pi" },
  { id: "sigma", display: "σ", insertText: "\\sigma" },
  { id: "phi", display: "φ", insertText: "\\phi" },
  { id: "omega", display: "ω", insertText: "\\omega" },
  { id: "Delta", display: "Δ", insertText: "\\Delta" },
  { id: "Omega", display: "Ω", insertText: "\\Omega" },
];

export const RELATION_SYMBOLS: LatexSymbol[] = [
  { id: "leq", display: "≤", insertText: "\\leq" },
  { id: "geq", display: "≥", insertText: "\\geq" },
  { id: "neq", display: "≠", insertText: "\\neq" },
  { id: "approx", display: "≈", insertText: "\\approx" },
  { id: "pm", display: "±", insertText: "\\pm" },
  { id: "times", display: "×", insertText: "\\times" },
  { id: "cdot", display: "·", insertText: "\\cdot" },
  { id: "to", display: "→", insertText: "\\to" },
  { id: "in", display: "∈", insertText: "\\in" },
  { id: "infty", display: "∞", insertText: "\\infty" },
];

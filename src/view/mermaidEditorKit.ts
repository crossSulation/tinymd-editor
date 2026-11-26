import { StreamLanguage, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { StreamParser } from "@codemirror/language";
import { autocompletion, type CompletionSource } from "@codemirror/autocomplete";
import { tags } from "@lezer/highlight";

// No official CodeMirror grammar for Mermaid exists (confirmed: no
// `@codemirror/lang-mermaid` package, same gap `mermaidPreview.ts`'s own
// `mermaidLanguage` comment already notes for the inline code-block path).
// This is a deliberately simple, line-heuristic StreamParser -- covers the
// common flowchart/sequence patterns the design's own mockup shows
// (keywords, arrow operators, bracketed labels, bare identifiers), not a
// complete Mermaid grammar. Good enough for readable syntax color in this
// dedicated editor; not meant to validate or fully parse every Mermaid
// diagram type's own syntax.
const KEYWORD_RE =
  /^(flowchart|graph|subgraph|end|sequenceDiagram|classDiagram|stateDiagram-v2|stateDiagram|pie|gantt|erDiagram|journey|gitGraph|mindmap|timeline|title|participant|actor|class|state|section|LR|RL|TD|TB|BT)\b/;
const ARROW_RE = /^(-->>|-->|<-->|-\.->|-\.-|==>|===|--x|--o|->>|-x|--)/;
const LABEL_RE = /^(\[[^\]\n]*\]|\{[^}\n]*\}|\([^)\n]*\))/;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
const COMMENT_RE = /^%%.*/;

const mermaidStreamParser: StreamParser<null> = {
  token(stream) {
    if (stream.match(COMMENT_RE)) return "comment";
    if (stream.match(KEYWORD_RE)) return "keyword";
    if (stream.match(ARROW_RE)) return "operator";
    if (stream.match(LABEL_RE)) return "string";
    if (stream.match(IDENT_RE)) return "variableName";
    stream.next();
    return null;
  },
};

export const mermaidLanguageSupport = StreamLanguage.define(mermaidStreamParser);

// Colors match Mermaid.dc.html's own `.k`/`.id`/`.lb`/`.ar` classes exactly
// (`#7C3AED`/`#1D4ED8`/`#A44A0A`/`#0F766E`) -- a generic CodeMirror theme
// wouldn't reproduce the design's specific palette, so this maps each tag
// explicitly rather than relying on a built-in highlight style.
export const mermaidHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "#7C3AED" },
  { tag: tags.variableName, color: "#1D4ED8", fontWeight: "500" },
  { tag: tags.string, color: "#A44A0A" },
  { tag: tags.operator, color: "#0F766E" },
  { tag: tags.comment, color: "#6B717A", fontStyle: "italic" },
]);

export function mermaidHighlighting() {
  return syntaxHighlighting(mermaidHighlightStyle);
}

// Deliberately simple: a flat keyword/arrow-style word list, not a
// context-aware completion engine (e.g. "suggest only valid next tokens
// given the current line's own diagram type") -- matches the design's own
// example (suggesting arrow STYLES after the user starts typing one), not
// a full language server.
interface MermaidCompletionItem {
  label: string;
  type: "keyword" | "operator";
  detail?: string;
  apply?: string;
}

const COMPLETION_ITEMS: MermaidCompletionItem[] = [
  { label: "-->", type: "operator", detail: "Arrow" },
  { label: "-.->", type: "operator", detail: "Dotted arrow" },
  { label: "==>", type: "operator", detail: "Thick arrow" },
  { label: "--x", type: "operator", detail: "Cross arrow" },
  { label: "--o", type: "operator", detail: "Circle arrow" },
  { label: "->>", type: "operator", detail: "Sequence message" },
  { label: "-->>", type: "operator", detail: "Sequence dotted reply" },
  { label: "flowchart", type: "keyword" },
  { label: "subgraph", type: "keyword" },
  { label: "end", type: "keyword" },
  { label: "sequenceDiagram", type: "keyword" },
  { label: "classDiagram", type: "keyword" },
  { label: "participant", type: "keyword" },
];

export const mermaidCompletionSource: CompletionSource = (context) => {
  const word = context.matchBefore(/[-.=>\w]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  return {
    from: word.from,
    options: COMPLETION_ITEMS.map((item) => ({
      label: item.label,
      type: item.type,
      detail: item.detail,
      apply: item.apply ?? item.label,
    })),
  };
};

export function mermaidAutocompletion() {
  return autocompletion({ override: [mermaidCompletionSource] });
}

export type MermaidDiagramType = "flowchart" | "sequence" | "class" | "state" | "pie" | "gantt";

export interface MermaidDiagramTypeOption {
  id: MermaidDiagramType;
  label: string;
  /** Starter source for a NEW diagram of this type -- selecting a type in the editor REPLACES the current source with this, the same way Mermaid Live Editor's own type picker works, not a content-preserving conversion between types (switching an existing flowchart's own accumulated nodes into valid sequence-diagram syntax isn't generally even well-defined). */
  template: string;
  /** Whether this type's own syntax has a direction line (`flowchart`/`graph` only) -- gates the Direction toggle. */
  supportsDirection: boolean;
}

export const DIAGRAM_TYPES: MermaidDiagramTypeOption[] = [
  { id: "flowchart", label: "Flowchart", supportsDirection: true, template: "flowchart LR\n    A[Start] --> B[End]\n" },
  {
    id: "sequence",
    label: "Sequence",
    supportsDirection: false,
    template: "sequenceDiagram\n    Alice->>Bob: Hello Bob, how are you?\n    Bob-->>Alice: I am good thanks!\n",
  },
  {
    id: "class",
    label: "Class",
    supportsDirection: false,
    template: "classDiagram\n    class Animal {\n      +String name\n      +makeSound()\n    }\n",
  },
  {
    id: "state",
    label: "State",
    supportsDirection: false,
    template: "stateDiagram-v2\n    [*] --> Idle\n    Idle --> Running\n    Running --> [*]\n",
  },
  { id: "pie", label: "Pie", supportsDirection: false, template: 'pie title Distribution\n    "A" : 40\n    "B" : 60\n' },
  {
    id: "gantt",
    label: "Gantt",
    supportsDirection: false,
    template: "gantt\n    title Project\n    section Phase 1\n    Task A :a1, 2024-01-01, 7d\n",
  },
];

const DIRECTION_RE = /^(flowchart|graph)\s+(LR|RL|TD|TB|BT)\b/m;

/** Detects which {@link DIAGRAM_TYPES} entry a source's first real line belongs to, if any -- used to decide which controls (Direction) apply and which Diagram-type option should show as selected. */
export function detectDiagramType(source: string): MermaidDiagramType | null {
  const firstLine = source
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("%%"));
  if (!firstLine) return null;
  if (/^(flowchart|graph)\b/.test(firstLine)) return "flowchart";
  if (/^sequenceDiagram\b/.test(firstLine)) return "sequence";
  if (/^classDiagram\b/.test(firstLine)) return "class";
  if (/^stateDiagram/.test(firstLine)) return "state";
  if (/^pie\b/.test(firstLine)) return "pie";
  if (/^gantt\b/.test(firstLine)) return "gantt";
  return null;
}

export type MermaidDirection = "LR" | "TD";

export function detectDirection(source: string): MermaidDirection {
  const match = DIRECTION_RE.exec(source);
  const found = match?.[2];
  return found === "TB" || found === "TD" ? "TD" : "LR";
}

/** Rewrites the `flowchart`/`graph` declaration line's own direction code -- a no-op (returns `source` unchanged) if the source isn't a flowchart/graph diagram at all. */
export function setDirection(source: string, direction: MermaidDirection): string {
  if (!DIRECTION_RE.test(source)) return source;
  return source.replace(DIRECTION_RE, (_match, kind: string) => `${kind} ${direction}`);
}

export type MermaidTheme = "default" | "neutral" | "dark" | "forest";

export const THEME_OPTIONS: { id: MermaidTheme; label: string }[] = [
  { id: "default", label: "Default" },
  { id: "neutral", label: "Neutral" },
  { id: "dark", label: "Dark" },
  { id: "forest", label: "Forest" },
];

const THEME_DIRECTIVE_RE = /^%%\{\s*init\s*:\s*\{[^}]*'theme'\s*:\s*'([a-zA-Z]+)'[^}]*\}\s*\}%%\n?/;

/** Mermaid's own documented front-matter-style directive for setting a diagram's theme (`%%{init: {'theme': '...'}}%%`, first line) -- not a custom convention invented here. */
export function detectTheme(source: string): MermaidTheme {
  const match = THEME_DIRECTIVE_RE.exec(source.trimStart());
  const found = match?.[1];
  return found === "neutral" || found === "dark" || found === "forest" ? found : "default";
}

export function setTheme(source: string, theme: MermaidTheme): string {
  const withoutExisting = source.replace(THEME_DIRECTIVE_RE, "");
  if (theme === "default") return withoutExisting;
  return `%%{init: {'theme': '${theme}'}}%%\n${withoutExisting}`;
}

export interface MermaidSnippet {
  id: string;
  label: string;
  /** Inserted at the cursor, verbatim. */
  text: string;
}

export const SNIPPETS: MermaidSnippet[] = [
  { id: "node", label: "Node", text: "N[Label]" },
  { id: "decision", label: "Decision", text: "D{Decision?}" },
  { id: "edge", label: "Edge", text: "A --> B" },
  { id: "subgraph", label: "Subgraph", text: "subgraph Group\n    \nend" },
];

// Mermaid flowchart's own documented node-shape syntax (classic
// bracket-pair style, not the newer `@{ shape: ... }` metadata form) --
// requested directly ("basic shapes like [], (), {}") after the snippet
// bar only covered one shape each for Node/Decision above. These live in a
// separate dropdown (MermaidEditorModal.tsx's "Shape" picker) rather than
// as 13 more flat chips -- the existing chip row already needs to
// horizontally scroll on a narrow phone with just 4 items; cramming the
// full shape set in there too would make Edge/Subgraph hard to reach.
// Node/Decision above stay as quick-access chips for the two most common
// shapes (matching the design's own mockup), duplicated here too so the
// full set is discoverable in one place.
export const NODE_SHAPES: MermaidSnippet[] = [
  { id: "rectangle", label: "Rectangle [ ]", text: "A[Text]" },
  { id: "rounded", label: "Rounded ( )", text: "A(Text)" },
  { id: "stadium", label: "Stadium ([ ])", text: "A([Text])" },
  { id: "subroutine", label: "Subroutine [[ ]]", text: "A[[Text]]" },
  { id: "cylinder", label: "Cylinder [( )]", text: "A[(Text)]" },
  { id: "circle", label: "Circle (( ))", text: "A((Text))" },
  { id: "asymmetric", label: "Asymmetric >]", text: "A>Text]" },
  { id: "rhombus", label: "Rhombus { }", text: "A{Text}" },
  { id: "hexagon", label: "Hexagon {{ }}", text: "A{{Text}}" },
  { id: "parallelogram", label: "Parallelogram [/ /]", text: "A[/Text/]" },
  { id: "parallelogram-alt", label: "Parallelogram [\\\\ \\\\]", text: "A[\\Text\\]" },
  { id: "trapezoid", label: "Trapezoid [/ \\\\]", text: "A[/Text\\]" },
  { id: "trapezoid-alt", label: "Trapezoid [\\\\ /]", text: "A[\\Text/]" },
];

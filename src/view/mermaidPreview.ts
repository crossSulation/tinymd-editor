import { LanguageDescription, type LanguageSupport } from "@codemirror/language";
import type { Ctx } from "@milkdown/kit/ctx";
import { insertCodeBlock, replaceCodeBlock } from "./codeBlockEdit";

// mermaid (and the diagram-layout libraries it pulls in) is sizable, so it's
// only fetched the first time a mermaid block actually needs rendering.
let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;

// Exported so MermaidEditorModal.tsx's own live preview can reuse the exact
// same lazy-loaded, already-initialized instance rather than importing and
// re-initializing a second one.
export function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((mod) => {
      mod.default.initialize({ startOnLoad: false, securityLevel: "strict" });
      return mod.default;
    });
  }
  return mermaidPromise;
}

let mermaidIdCounter = 0;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

// `renderPreview` is Crepe's/@milkdown/components' code-block extension point
// for exactly this (its own preview-panel sanitizer explicitly handles
// Mermaid's SVG `foreignObject` usage) -- no custom NodeView/plugin needed.
// Returning `undefined` tells it the result is async; it shows a loading
// placeholder until `applyPreview` is called.
export function renderMermaidPreview(
  language: string,
  content: string,
  applyPreview: (value: null | string | HTMLElement) => void,
): void | null | string | HTMLElement {
  if (language.toLowerCase() !== "mermaid") return null;
  if (!content.trim()) return null;

  loadMermaid()
    .then((mermaid) => mermaid.render(`mermaid-${++mermaidIdCounter}`, content))
    .then(({ svg }) => applyPreview(svg))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Invalid diagram";
      applyPreview(`<pre class="mermaid-error">${escapeHtml(message)}</pre>`);
    });

  return undefined;
}

// Lets users pick "Mermaid" from the code block's language picker, which
// otherwise only lists real CodeMirror grammars. It has no actual syntax
// highlighting (there's no CodeMirror grammar for Mermaid, and none is
// needed -- the diagram is rendered via renderMermaidPreview above instead).
export const mermaidLanguage = LanguageDescription.of({
  name: "Mermaid",
  alias: ["mermaid"],
  load: () => Promise.resolve(undefined as unknown as LanguageSupport),
});

// What Toolbar.tsx's "Mermaid diagram" insert action and its "Edit" button
// (shown for a selected Mermaid code block) both hand to Editor.tsx's
// `onOpenMermaidEditor` to open MermaidEditorModal.tsx -- `replace: null`
// means "insert a new diagram at the current cursor", otherwise it's the
// exact position/size of the existing code_block node being edited
// (captured from its NodeSelection at the moment the button was pressed).
export interface MermaidEditRequest {
  initialSource: string;
  replace: { pos: number; nodeSize: number } | null;
}

// Thin wrappers over codeBlockEdit.ts's generic insertCodeBlock/
// replaceCodeBlock (language hardcoded to "Mermaid") -- see that file for
// why each is shaped the way it is (reusing Milkdown's own
// addBlockTypeCommand for insertion, a direct tr.replaceWith for
// replacement, and moving the selection past the block afterward rather
// than leaving it inside, which was a real bug found via CDP).
export function insertMermaidDiagram(ctx: Ctx, source: string): void {
  insertCodeBlock(ctx, "Mermaid", source);
}

export function replaceMermaidDiagram(ctx: Ctx, pos: number, nodeSize: number, source: string): void {
  replaceCodeBlock(ctx, pos, nodeSize, "Mermaid", source);
}

import { LanguageDescription, type LanguageSupport } from "@codemirror/language";
import type { Ctx } from "@milkdown/kit/ctx";
import { commandsCtx } from "@milkdown/kit/core";
import { addBlockTypeCommand, clearTextInCurrentBlockCommand, codeBlockSchema } from "@milkdown/kit/preset/commonmark";

// mermaid (and the diagram-layout libraries it pulls in) is sizable, so it's
// only fetched the first time a mermaid block actually needs rendering.
let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;

function loadMermaid() {
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

// Inserts a code block pre-set to the Mermaid language. Called directly from
// a toolbar button (see Toolbar.tsx) -- must only actually mutate the
// document when invoked for real, never during a Command's dry-run
// applicability check (no `dispatch`), so Toolbar.tsx wraps this in a plain
// Command rather than calling it eagerly in a disabled-state check.
export function insertMermaidBlock(ctx: Ctx): void {
  const commands = ctx.get(commandsCtx);
  const codeBlock = codeBlockSchema.type(ctx);

  commands.call(clearTextInCurrentBlockCommand.key);
  commands.call(addBlockTypeCommand.key, {
    nodeType: codeBlock,
    attrs: { language: "Mermaid" },
  });
}

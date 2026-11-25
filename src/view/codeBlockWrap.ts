import { Compartment } from "@codemirror/state";
import { EditorView as CodeMirrorView } from "@codemirror/view";

// @milkdown/components' code-block NodeView ships a fixed Vue template with
// no slot/config hook for a custom per-block button (confirmed directly
// against its source: CodeBlockConfig has no such option, and the component
// itself is a closed `defineComponent`) -- so a real "Wrap" toggle *inside*
// each code block's own tools row, as the design shows, isn't buildable
// without forking the library. This is instead a single, document-wide
// toggle (one Toolbar button -- see Toolbar.tsx) applied to every currently
// mounted code block's own raw CodeMirror view, found via `findFromDOM`
// (CodeMirror 6's own public API for recovering a view from its DOM, no
// private/internal access needed).
export const codeWrapCompartment = new Compartment();

export function wrapExtension(enabled: boolean) {
  return enabled ? [CodeMirrorView.lineWrapping] : [];
}

// A code block created AFTER the toggle is flipped still starts from this
// compartment's static initial value (baked into codeBlockConfig.extensions
// once, at editor-build time -- see createMilkdownEditor.ts), so newly
// inserted blocks don't automatically pick up a later toggle. Toolbar.tsx
// re-applies the current state right after inserting a new code
// block/Mermaid diagram to cover the one place this app itself creates new
// code blocks; a block pasted or created some other way may not pick up
// the current state until the toggle is pressed again -- a known, minor gap
// given there's no hook into "a code block NodeView just mounted".
export function applyCodeWrapToAll(root: HTMLElement, enabled: boolean) {
  root.querySelectorAll<HTMLElement>(".milkdown-code-block .cm-editor").forEach((dom) => {
    const view = CodeMirrorView.findFromDOM(dom);
    view?.dispatch({ effects: codeWrapCompartment.reconfigure(wrapExtension(enabled)) });
  });
}

import type { Node } from "prosemirror-model";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { Plugin } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";

// A decoration-only placeholder: shown via CSS (::before on the decorated
// node) while the doc is a single empty paragraph, and gone the instant real
// content exists. The placeholder text is never part of the document itself.
function placeholderDecorations(doc: Node, text: string): DecorationSet {
  if (!text || doc.childCount !== 1) return DecorationSet.empty;
  const only = doc.firstChild!;
  if (!only.isTextblock || only.content.size > 0) return DecorationSet.empty;
  return DecorationSet.create(doc, [
    Decoration.node(0, only.nodeSize, { class: "is-editor-empty", "data-placeholder": text }),
  ]);
}

export function createPlaceholderPlugin(text: string) {
  return $prose(
    () =>
      new Plugin({
        props: {
          decorations: (state) => placeholderDecorations(state.doc, text),
        },
      }),
  );
}

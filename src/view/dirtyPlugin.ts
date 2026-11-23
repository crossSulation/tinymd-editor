import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { CONTENT_REPLACE_META } from "milkdown-chunk-editor";

export { CONTENT_REPLACE_META };

const dirtyPluginKey = new PluginKey("tinymdChunkDirty");

// A direct ProseMirror plugin watching `tr.docChanged`, not Milkdown's own
// `listener` plugin -- ported from milkdown-chunk-editor's own
// mount-chunk.ts (see its README's "dirty 标记" section). `listener`'s
// `markdownUpdated` callback has its own internal 200ms debounce and
// compares via `prevDoc.eq(doc)`, both of which delay the "did this chunk
// actually change" signal past the point chunkMount.ts needs it to gate
// flush()'s remark stringify precisely (see that file). Transactions tagged
// CONTENT_REPLACE_META (chunkMount.ts's own cache-driven content swaps on
// recycle/rebind) or addToHistory:false are deliberately not treated as
// edits, same as upstream.
export function createDirtyPlugin(onChange: () => void): Plugin {
  return new Plugin({
    key: dirtyPluginKey,
    state: {
      init: () => null,
      apply: (tr) => {
        if (tr.docChanged && tr.getMeta("addToHistory") !== false && !tr.getMeta(CONTENT_REPLACE_META)) {
          onChange();
        }
        return null;
      },
    },
  });
}

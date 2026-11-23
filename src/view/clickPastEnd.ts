import { Plugin, TextSelection } from "@milkdown/kit/prose/state";
import { exitCode } from "@milkdown/kit/prose/commands";
import { $prose } from "@milkdown/kit/utils";

// A short document leaves a lot of empty vertical space below its last block
// (editor-base.css gives .ProseMirror a `min-height: 60vh` precisely so that
// space is tappable at all), but ProseMirror can't resolve a sensible
// document position for a tap that doesn't land on any actual content, so by
// default nothing happens there -- no caret, no focus. Enter on the keyboard
// still works fine (that's just inserting at the existing selection), it's
// only touch targeting empty space below everything that's missing.
//
// view.posAtCoords() is NOT a reliable way to detect this: browsers' native
// caretRangeFromPoint (which it's built on) clamps an out-of-bounds point to
// the *nearest* existing text rather than failing, so a click well below a
// one-line document can resolve to some position mid-line instead of
// indicating "nothing here" -- confirmed directly (a click ~300px below a
// single line landed mid-word, not at the end, before this was fixed to
// compare against the last block's own bounding rect instead). Comparing the
// click's Y coordinate against the last rendered block's actual bottom edge
// is the precise, intent-matching check: anything below that is unambiguously
// "past the end," regardless of X. Fixes it the same way other editors
// (Google Docs, Notion) handle clicking past the end of their content.
export function createClickPastEndPlugin() {
  return $prose(
    () =>
      new Plugin({
        props: {
          handleDOMEvents: {
            mousedown(view, event) {
              if (!view.editable) return false;

              const lastChild = view.dom.lastElementChild;
              if (!lastChild) return false;
              const rect = lastChild.getBoundingClientRect();
              if (event.clientY <= rect.bottom) return false;

              // Without this, the browser's own native mousedown handling
              // still runs (placing the real DOM caret via its own
              // caretRangeFromPoint-based hit-testing -- clamped to the
              // nearest text, same clamping problem posAtCoords has), and
              // ProseMirror's selectionchange listener then syncs its state
              // FROM that native caret, overwriting the dispatch below.
              // Confirmed directly: without preventDefault, the dispatched
              // end-of-document selection was silently discarded.
              event.preventDefault();

              const endPos = view.state.doc.content.size;
              const selection = TextSelection.near(view.state.doc.resolve(endPos), -1);
              view.dispatch(view.state.tr.setSelection(selection));

              const $head = view.state.selection.$head;

              // If the document's last block is a code block, landing a
              // plain text selection there (above) just puts the cursor back
              // INSIDE the code -- not useful for "tap below everything to
              // keep writing prose." Follow up with the same exitCode
              // command the code-block component's own Mod-Enter shortcut
              // uses (prosemirror-commands): with the selection now inside
              // the code node, it inserts a real new paragraph after it and
              // moves the cursor there.
              if ($head.parent.type.spec.code) {
                exitCode(view.state, view.dispatch);
              } else {
                // Same problem for a trailing table: the resolved position
                // lands inside the last cell's paragraph, which has no
                // "exit" the way a code block does (exitCode above only
                // checks `spec.code`). Walk up from $head looking for a
                // "table" ancestor (the node name @milkdown/preset-gfm's
                // tableSchema registers, confirmed against its schema.d.ts)
                // and, if found, insert a real paragraph right after the
                // table and move the cursor there.
                let tableDepth = -1;
                for (let d = $head.depth; d > 0; d--) {
                  if ($head.node(d).type.name === "table") {
                    tableDepth = d;
                    break;
                  }
                }
                if (tableDepth > 0) {
                  const pos = $head.after(tableDepth);
                  const paragraph = view.state.schema.nodes.paragraph!.createAndFill();
                  if (paragraph) {
                    const tr = view.state.tr.replaceWith(pos, pos, paragraph);
                    tr.setSelection(TextSelection.near(tr.doc.resolve(pos), 1));
                    view.dispatch(tr.scrollIntoView());
                  }
                }
              }

              view.focus();
              return true;
            },
          },
        },
      }),
  );
}

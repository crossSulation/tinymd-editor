import { Prec, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { editorViewCtx } from "@milkdown/kit/core";
import { exitCode } from "@milkdown/kit/prose/commands";
import type { Ctx } from "@milkdown/kit/ctx";

// The code-block component's own CodeMirror keymap already binds Mod-Enter
// to prosemirror-commands' exitCode (see @milkdown/components' node-view.ts)
// -- it correctly inserts a new paragraph after the code block even when the
// code block is the document's last node (exitCode does `tr.replaceWith(pos,
// pos, ...)`, an insert, not a move into existing content). But Mod-Enter
// has no convenient touch-keyboard equivalent, and when the code block IS
// the last node there's also no following paragraph to tap into as a
// fallback (clickPastEnd.ts's "click past the end" just lands back inside
// the code block, since it still accepts a ProseMirror text selection).
//
// So: pressing plain Enter on an already-empty line at the very end of the
// code's content exits the block instead of inserting yet another blank
// line -- the same "blank line + Enter" convention GitHub/Notion/Obsidian
// use. Wrapped in Prec.highest so it's checked before CodeMirror's own
// default Enter handling (basicSetup/defaultKeymap), which would otherwise
// just insert a newline first.
export function createCodeBlockExitKeymap(ctx: Ctx): Extension {
  return Prec.highest(
    keymap.of([
      {
        key: "Enter",
        run: (cmView) => {
          const { state } = cmView;
          const { head } = state.selection.main;
          const line = state.doc.lineAt(head);
          const atLastLine = line.number === state.doc.lines;
          const lineIsEmpty = line.length === 0;
          const atLineEnd = head === line.to;
          if (!atLastLine || !lineIsEmpty || !atLineEnd) return false;

          const view = ctx.get(editorViewCtx);
          if (!exitCode(view.state, view.dispatch)) return false;
          view.focus();
          return true;
        },
      },
    ]),
  );
}

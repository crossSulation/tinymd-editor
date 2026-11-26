import type { Ctx } from "@milkdown/kit/ctx";
import { commandsCtx, editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import { addBlockTypeCommand, clearTextInCurrentBlockCommand, codeBlockSchema } from "@milkdown/kit/preset/commonmark";

// What every dedicated code-editing modal (CodeBlockEditorModal.tsx,
// MermaidEditorModal.tsx) hands to Editor.tsx's own `onOpen*Editor`
// callback to request opening itself -- `replace: null` means "insert a
// new block at the current cursor", otherwise it's the exact position/
// size of the existing code_block node being edited (captured from its
// NodeSelection at the moment "Edit" was pressed -- see Toolbar.tsx's
// selectedMediaType handling).
export interface CodeBlockEditRequest {
  language: string;
  initialSource: string;
  replace: { pos: number; nodeSize: number } | null;
}

// Generalized from mermaidPreview.ts's own insertMermaidDiagram/
// replaceMermaidDiagram (its own two functions are now thin wrappers over
// these, language hardcoded to "Mermaid") -- see those functions' own
// history for why each piece here is shaped the way it is:
//
// - Insertion reuses Milkdown's own `addBlockTypeCommand` (via
//   `clearTextInCurrentBlockCommand` + `addBlockTypeCommand`) for the
//   actual block-creation step rather than a raw `tr.replaceSelectionWith`,
//   since that command already handles "insert a block-type node at an
//   arbitrary cursor position" correctly (e.g. mid-paragraph) in ways this
//   app hasn't independently re-verified -- this only adds filling in the
//   text afterward.
// - Replacement uses a direct `tr.replaceWith`, safe because the exact
//   position/size being replaced is already known precisely (same as
//   Toolbar.tsx's own `deleteSelectedMedia`).
// - Both move the selection to just past the block and let the caller
//   blur/focus as needed, rather than leaving it inside -- a real bug
//   found via CDP (see UX_PLAN.md's Phase 6 entry): leaving the selection
//   inside the fresh block, combined with Editor.tsx's own post-close
//   `view.focus()` (itself needed to fix an EARLIER bug, auto-mode falling
//   to Draw), routed real DOM focus into the block's embedded CodeMirror
//   instance, which `@milkdown/components`' own `forwardUpdate` listener
//   then used to silently revert any NodeSelection dispatched moments
//   later (e.g. a long-press to re-select the same block). Landing the
//   selection just past the block's end avoids that political entirely,
//   and is also just better UX regardless (continuing to type after the
//   block, not stuck trying to edit inline content that's now read-only).
export function insertCodeBlock(ctx: Ctx, language: string, source: string): void {
  const commands = ctx.get(commandsCtx);
  const codeBlockType = codeBlockSchema.type(ctx);

  commands.call(clearTextInCurrentBlockCommand.key);
  commands.call(addBlockTypeCommand.key, {
    nodeType: codeBlockType,
    attrs: { language },
  });

  const view = ctx.get(editorViewCtx);
  const $pos = view.state.selection.$from;
  let depth = $pos.depth;
  while (depth > 0 && $pos.node(depth).type !== codeBlockType) depth--;
  if (depth === 0) return; // defensive -- addBlockTypeCommand always leaves the selection inside the new block
  const blockPos = $pos.before(depth);
  const node = $pos.node(depth);
  let tr = view.state.tr;
  if (source) tr = tr.insertText(source, blockPos + 1, blockPos + 1 + node.content.size);
  const afterPos = tr.mapping.map(blockPos + node.nodeSize);
  tr = tr.setSelection(TextSelection.near(tr.doc.resolve(afterPos)));
  view.dispatch(tr);
}

export function replaceCodeBlock(ctx: Ctx, pos: number, nodeSize: number, language: string, source: string): void {
  const view = ctx.get(editorViewCtx);
  const codeBlockType = codeBlockSchema.type(ctx);
  const node = codeBlockType.create({ language }, source ? view.state.schema.text(source) : undefined);
  const tr = view.state.tr.replaceWith(pos, pos + nodeSize, node);
  // A REAL, confirmed bug lived here: this used to be
  // `tr.mapping.map(pos + node.nodeSize)`, copying insertCodeBlock's own
  // pattern above without noticing it doesn't apply here. In
  // insertCodeBlock, `node`/`blockPos` are captured from the OLD document
  // (before `tr.insertText` ran), so mapping `blockPos + node.nodeSize`
  // through `tr.mapping` correctly translates a genuinely OLD position
  // into the post-edit document. Here, `node` is a BRAND NEW node created
  // from scratch -- it was never part of the old document at all, so
  // `pos + node.nodeSize` isn't an old position to map; it's already the
  // exact end of the freshly-placed node in the POST-replace document
  // (`tr.doc`), since `replaceWith(pos, pos + nodeSize, node)` places
  // `node` starting exactly at `pos`. Passing it through `tr.mapping.map()`
  // anyway treated it as a pre-edit position instead, which stayed
  // accidentally in-bounds only when the edited content happened to come
  // out no longer than the ORIGINAL block -- confirmed directly via CDP
  // (temporary instrumentation): editing an existing Mermaid diagram to
  // something with a LONGER source threw `RangeError: Position N out of
  // range` synchronously inside this function, BEFORE `view.dispatch(tr)`
  // ever ran -- so the real document update was silently dropped entirely
  // (not just a bad cursor position), the modal never closed, and the
  // main editor kept showing the diagram's PRE-edit content/error
  // indefinitely. This is the generic path every "Edit" button uses
  // (Mermaid, LaTeX, and plain code), so it affected all three whenever an
  // edit made the block's content longer, not just Mermaid specifically.
  const afterPos = pos + node.nodeSize;
  view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(afterPos))));
}

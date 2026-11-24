import { NodeSelection, Plugin } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 10;

// Touch has no secondary-click/context-menu/hover affordance, and
// @milkdown/components' code-block NodeView's own `stopEvent()` returns
// `true` unconditionally (confirmed directly against its source, not
// assumed) -- meaning EVERY native event anywhere inside a code block's DOM
// (its gray padding, the language/copy buttons, the embedded CodeMirror
// content, all of it) is swallowed before ProseMirror's own click handling
// -- or any plugin's `handleDOMEvents`/`handleClick` props, which run
// through that same internal dispatch -- ever see it. There is no "tap in
// the right spot" way to select a code block as a whole node (a
// `NodeSelection`) the way tapping an image/video/audio node already does
// (see Toolbar.tsx's `selectedMediaType`) -- confirmed directly by reading
// the NodeView source, not assumed from the symptom alone.
//
// A long-press (the standard mobile convention for "select this whole
// block," matching how e.g. Notion's own mobile app handles block
// selection) is the one touch gesture left that can still work, and it has
// to be wired as a RAW native event listener attached directly on
// `view.dom` in this plugin's own `view()` lifecycle -- `handleDOMEvents`
// wouldn't fire here either, for the identical `stopEvent` reason.
// `stopEvent()` only suppresses ProseMirror's OWN internal processing of an
// event, not the event's native DOM bubbling, so a plain `addEventListener`
// on `view.dom` still receives it regardless.
export function createCodeBlockLongPressPlugin() {
  return $prose(
    () =>
      new Plugin({
        view(editorView) {
          let timer: ReturnType<typeof setTimeout> | null = null;
          let startX = 0;
          let startY = 0;

          function clearTimer() {
            if (timer !== null) {
              clearTimeout(timer);
              timer = null;
            }
          }

          // `posAtDOM(domNode, 0)` resolves to a position somewhere INSIDE
          // the code block's own content (its depth may vary slightly
          // depending on exactly which child was pressed), so this walks
          // back UP looking for the nearest `code_block` ancestor and
          // returns `$pos.before(d)` -- the position NodeSelection.create
          // expects (pointing AT the node itself, not inside it).
          function resolveCodeBlockPos(domNode: HTMLElement): number | null {
            try {
              const pos = editorView.posAtDOM(domNode, 0);
              const $pos = editorView.state.doc.resolve(pos);
              for (let d = $pos.depth; d >= 0; d--) {
                if ($pos.node(d).type.name === "code_block") return $pos.before(d);
              }
              return null;
            } catch {
              return null;
            }
          }

          function onPointerDown(event: PointerEvent) {
            if (!editorView.editable) return;
            const target = event.target;
            const codeBlockEl = target instanceof HTMLElement ? target.closest<HTMLElement>(".milkdown-code-block") : null;
            if (!codeBlockEl) return;
            startX = event.clientX;
            startY = event.clientY;
            clearTimer();
            timer = setTimeout(() => {
              timer = null;
              const pos = resolveCodeBlockPos(codeBlockEl);
              if (pos === null) return;
              const tr = editorView.state.tr.setSelection(NodeSelection.create(editorView.state.doc, pos));
              editorView.dispatch(tr);
            }, LONG_PRESS_MS);
          }

          function onPointerMove(event: PointerEvent) {
            if (timer === null) return;
            if (Math.abs(event.clientX - startX) > MOVE_TOLERANCE_PX || Math.abs(event.clientY - startY) > MOVE_TOLERANCE_PX) {
              clearTimer();
            }
          }

          function onPointerEnd() {
            clearTimer();
          }

          editorView.dom.addEventListener("pointerdown", onPointerDown);
          editorView.dom.addEventListener("pointermove", onPointerMove);
          editorView.dom.addEventListener("pointerup", onPointerEnd);
          editorView.dom.addEventListener("pointercancel", onPointerEnd);

          return {
            destroy() {
              clearTimer();
              editorView.dom.removeEventListener("pointerdown", onPointerDown);
              editorView.dom.removeEventListener("pointermove", onPointerMove);
              editorView.dom.removeEventListener("pointerup", onPointerEnd);
              editorView.dom.removeEventListener("pointercancel", onPointerEnd);
            },
          };
        },
      }),
  );
}

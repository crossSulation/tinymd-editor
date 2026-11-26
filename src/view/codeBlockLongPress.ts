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
            // `target instanceof Element`, not `HTMLElement` -- a real,
            // confirmed gap found once Mermaid/LaTeX blocks became
            // preview-only (see code-block-layout.css): their content is
            // now almost entirely SVG (Mermaid) or KaTeX's own MathML/HTML
            // mix, and `event.target` for a press landing on the rendered
            // diagram/equation itself is an SVGElement -- which does NOT
            // satisfy `instanceof HTMLElement` (SVG elements are a
            // completely separate DOM interface branch), even though
            // `.closest()` works identically on any Element regardless.
            // Confirmed directly via CDP: `document.elementFromPoint()` at
            // the center of a rendered diagram returned an `<svg>` element
            // with `isHTMLElement: false`, silently no-opping every
            // long-press that landed anywhere on the diagram/equation
            // itself -- i.e. almost the entire block now that there's no
            // source pane left to press on instead.
            const codeBlockEl = target instanceof Element ? target.closest<HTMLElement>(".milkdown-code-block") : null;
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
              // A real, confirmed race, not a defensive habit: the NodeView's
              // own `selectNode()` (called automatically by ProseMirror as
              // part of the dispatch above, since the new selection targets
              // this node) calls `this.cm.focus()` as a documented side
              // effect. If this code block's embedded CodeMirror instance
              // had never been focused before (e.g. it was just inserted via
              // some OTHER authoring surface, never directly typed into --
              // MermaidEditorModal.tsx's own insert/edit flow is exactly
              // this), that focus() call is a genuine focus-GAIN, which
              // triggers CodeMirror's own `forwardUpdate` listener
              // (@milkdown/components' code-block component) -- confirmed
              // directly via temporary instrumentation, not assumed: that
              // listener runs whenever its CM instance `hasFocus`, compares
              // PM's current selection against CM's own (unrelated) cursor
              // position, finds them "out of sync" (a NodeSelection vs. a
              // plain text cursor), and "corrects" PM's selection back to a
              // TextSelection -- silently reverting the very NodeSelection
              // this plugin just dispatched, within ~100-200ms, with no
              // visible error. The SAME long-press on a code block that was
              // already focused once before (e.g. the user had typed into
              // it directly) never hits this: `cm.focus()` on an
              // already-focused element is a no-op, no fresh focus event,
              // nothing for forwardUpdate to react to. Blurring immediately
              // after this dispatch pre-empts `selectNode()`'s own
              // `cm.focus()` effect from taking hold long enough to trigger
              // that listener -- confirmed via the same instrumentation that
              // the selection then stays a NodeSelection indefinitely. Safe
              // to do unconditionally (not just for the never-focused case):
              // Toolbar.tsx's own mode derivation keeps `textEditingActive`
              // true via `selectedMediaType` regardless of DOM focus once a
              // code_block is selected, so this doesn't drop back to Draw
              // mode or hide the contextual Delete/Edit-diagram bar.
              (document.activeElement as HTMLElement | null)?.blur();
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

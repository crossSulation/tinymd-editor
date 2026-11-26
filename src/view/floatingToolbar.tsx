import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import type { Editor as MilkdownEditor } from "@milkdown/kit/core";
import { editorViewCtx, schemaCtx } from "@milkdown/kit/core";
import { TextSelection, type EditorState } from "@milkdown/kit/prose/state";
import { TooltipProvider } from "@milkdown/plugin-tooltip";
import { isMarkActive, type EditorCommands } from "./commands";

export interface FloatingToolbarProps {
  editor: MilkdownEditor;
  commands: EditorCommands;
}

// Selection-driven mini toolbar (Bold/Italic/Code/Link), re-added per
// UX_PLAN.md's decision 2 -- built once before, removed because it
// collided with Android's own native text-selection action-mode toolbar
// (Copy/Share/etc., which renders outside the page's DOM/z-index stacking
// entirely -- see CLAUDE.md's "No floating selection toolbar" entry).
// Gated out via FLOATING_TOOLBAR_AVAILABLE (Editor.tsx) using
// isTauriAndroid(), not bare isTauri() -- the collision was specifically
// Android's native selection UI, which Tauri desktop has no equivalent of,
// so there's no actual reason to withhold this from desktop testing too
// (the same reasoning Phase 2's slash menu already used for its own gate;
// UX_PLAN.md's own decision-2 prose says "isTauri()" but that doesn't
// match what Sidebar.tsx's exportAvailable -- the precedent it cites --
// actually computes, which IS isTauriAndroid()).
export function FloatingToolbar({ editor, commands }: FloatingToolbarProps) {
  const view = editor.ctx.get(editorViewCtx);
  const schema = editor.ctx.get(schemaCtx);
  // TooltipProvider sets `left`/`top` directly on THIS element -- same
  // position:fixed-has-to-live-here precedent as SlashMenu.tsx's own
  // .slash-menu-root (see that file's comment for why: floating-ui
  // repositions the element it was constructed with, not whatever's
  // rendered inside it via the portal).
  const element = useMemo(() => {
    const el = document.createElement("div");
    el.className = "floating-toolbar-root";
    return el;
  }, []);
  const providerRef = useRef<TooltipProvider | null>(null);
  const prevStateRef = useRef<EditorState | undefined>(undefined);

  useEffect(() => {
    const provider = new TooltipProvider({
      content: element,
      debounce: 0,
      // A real, non-empty TEXT selection only -- NOT a NodeSelection (an
      // image/video/audio/code-block node already gets its own contextual
      // Delete/Preview bar from Toolbar.tsx; this toolbar's Bold/Italic/
      // Code/Link commands don't apply to a selected node at all).
      shouldShow: (v) => v.hasFocus() && v.editable && v.state.selection instanceof TextSelection && !v.state.selection.empty,
    });
    providerRef.current = provider;
    return () => provider.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [element]);

  useEffect(() => {
    providerRef.current?.update(view, prevStateRef.current);
    prevStateRef.current = view.state;
  });

  function run(command: EditorCommands["toggleBold"]) {
    command(view.state, view.dispatch);
    view.focus();
  }

  const state = view.state;

  return createPortal(
    <div className="floating-toolbar-panel" role="toolbar" aria-label="Format selection">
      <button
        type="button"
        className="floating-toolbar-button"
        title="Bold"
        aria-label="Bold"
        data-active={isMarkActive(state, schema.marks.strong!) || undefined}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => run(commands.toggleBold)}
      >
        B
      </button>
      <button
        type="button"
        className="floating-toolbar-button"
        title="Italic"
        aria-label="Italic"
        data-active={isMarkActive(state, schema.marks.emphasis!) || undefined}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => run(commands.toggleItalic)}
      >
        I
      </button>
      <button
        type="button"
        className="floating-toolbar-button"
        title="Inline code"
        aria-label="Inline code"
        data-active={isMarkActive(state, schema.marks.inlineCode!) || undefined}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => run(commands.toggleInlineCode)}
      >
        {"</>"}
      </button>
      <button
        type="button"
        className="floating-toolbar-button"
        title="Link"
        aria-label="Link"
        data-active={isMarkActive(state, schema.marks.link!) || undefined}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => run(commands.toggleLink)}
      >
        🔗
      </button>
    </div>,
    element,
  );
}

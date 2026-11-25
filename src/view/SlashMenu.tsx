import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor as MilkdownEditor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import type { EditorView } from "prosemirror-view";
import type { EditorState } from "prosemirror-state";
import { SlashProvider } from "@milkdown/plugin-slash";
import type { EditorCommands } from "./commands";
import { insertMermaidBlock } from "./mermaidPreview";
import { insertLatexBlock } from "./latexPreview";

export interface SlashMenuProps {
  editor: MilkdownEditor;
  commands: EditorCommands;
}

const TRIGGER = "/";

interface SlashQuery {
  /** Absolute position of the "/" character itself. */
  from: number;
  /** Absolute position of the cursor (end of the query text). */
  to: number;
  text: string;
}

// Finds an active "/query" run ending at the cursor, within the current
// textblock only. No whitespace is allowed in `text` -- the same rule every
// Notion-style slash menu uses to decide "still typing a query" vs. "moved
// on, this is just a literal slash in prose now".
function findSlashQuery(view: EditorView): SlashQuery | null {
  const { selection } = view.state;
  if (!selection.empty) return null;
  const $from = selection.$from;
  if (!$from.parent.isTextblock) return null;
  const parentStart = $from.pos - $from.parentOffset;
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
  const slashIndex = textBefore.lastIndexOf(TRIGGER);
  if (slashIndex === -1) return null;
  const text = textBefore.slice(slashIndex + 1);
  if (/\s/.test(text)) return null;
  return { from: parentStart + slashIndex, to: $from.pos, text };
}

interface SlashItem {
  id: string;
  label: string;
  keywords: string;
  /** Markdown shortcut shown next to the label (design's own convention), e.g. "##", "```". Empty for items with no direct markdown trigger. */
  hint: string;
  /** SVG path `d` data for the item's tile icon -- reused directly from the Claude Design "Insert menu" artboard's own icon set. */
  icon: string;
  group: "Basic" | "Rich blocks";
  run: (view: EditorView, editor: MilkdownEditor, commands: EditorCommands) => void;
}

const ITEMS: SlashItem[] = [
  // Basic
  { id: "text", label: "Text", keywords: "text paragraph", hint: "", icon: "M5 6h14M12 6v13", group: "Basic", run: (view, _e, commands) => commands.setParagraph(view.state, view.dispatch) },
  { id: "h1", label: "Heading 1", keywords: "heading h1 title", hint: "#", icon: "M4 5v14M13 5v14M4 12h9M17 10l3-2v11", group: "Basic", run: (view, _e, commands) => commands.setHeading(1)(view.state, view.dispatch) },
  { id: "h2", label: "Heading 2", keywords: "heading h2", hint: "##", icon: "M4 5v14M12 5v14M4 12h8M16 10a2.5 2.5 0 0 1 5 0c0 2.5-5 4-5 7h5", group: "Basic", run: (view, _e, commands) => commands.setHeading(2)(view.state, view.dispatch) },
  { id: "h3", label: "Heading 3", keywords: "heading h3", hint: "###", icon: "M4 5v14M12 5v14M4 12h8M16 8h4l-2.5 4a2.5 2.5 0 1 1-1.8 4.2", group: "Basic", run: (view, _e, commands) => commands.setHeading(3)(view.state, view.dispatch) },
  { id: "bullet", label: "Bulleted list", keywords: "bulleted list ul", hint: "-", icon: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01", group: "Basic", run: (view, _e, commands) => commands.toggleBulletList(view.state, view.dispatch) },
  { id: "ordered", label: "Numbered list", keywords: "numbered list ordered ol", hint: "1.", icon: "M10 6h10M10 12h10M10 18h10M4 4h1.5v4M4 8h3M4 14.5a1.5 1.5 0 0 1 3 0c0 1.5-3 2-3 3.5h3", group: "Basic", run: (view, _e, commands) => commands.toggleOrderedList(view.state, view.dispatch) },
  { id: "toggle", label: "Toggle list", keywords: "toggle collapsible details", hint: ">", icon: "M4 7l3 3-3 3M11 10h9M11 16h9", group: "Basic", run: (view, _e, commands) => commands.insertToggleList(view.state, view.dispatch) },
  { id: "quote", label: "Quote", keywords: "blockquote quote", hint: '"', icon: "M5 6h5v6H6v3M14 6h5v6h-4v3", group: "Basic", run: (view, _e, commands) => commands.toggleBlockquote(view.state, view.dispatch) },
  { id: "callout", label: "Callout", keywords: "callout note alert", hint: "!", icon: "M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 8v5M12 16h.01", group: "Basic", run: (view, _e, commands) => commands.insertCallout(view.state, view.dispatch) },
  { id: "divider", label: "Divider", keywords: "divider hr rule", hint: "---", icon: "M3 12h18", group: "Basic", run: (view, _e, commands) => commands.insertHorizontalRule(view.state, view.dispatch) },
  // Rich blocks
  { id: "table", label: "Table", keywords: "table grid", hint: "|", icon: "M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 10h18M3 15h18M10 4v16", group: "Rich blocks", run: (view, editor, commands) => commands.insertTable(editor.ctx, 3, 3)(view.state, view.dispatch) },
  { id: "code", label: "Code block", keywords: "code block", hint: "```", icon: "m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14", group: "Rich blocks", run: (view, _e, commands) => commands.setCodeBlock(view.state, view.dispatch) },
  { id: "latex", label: "LaTeX block", keywords: "latex math equation", hint: "$$", icon: "M18 5H6l6 7-6 7h12", group: "Rich blocks", run: (_view, editor) => insertLatexBlock(editor.ctx) },
  { id: "mermaid", label: "Mermaid diagram", keywords: "mermaid diagram chart flowchart", hint: "```", icon: "M3 3h7v5H3zM14 3h7v5h-7zM14 16h7v5h-7zM10 5.5h4M17.5 8v8", group: "Rich blocks", run: (_view, editor) => insertMermaidBlock(editor.ctx) },
  { id: "image", label: "Image", keywords: "image picture photo", hint: "", icon: "M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM21 16l-5-5-8 9M9 8.5h.01", group: "Rich blocks", run: (view, _e, commands) => commands.insertImage(view.state, view.dispatch) },
];

const GROUPS: SlashItem["group"][] = ["Basic", "Rich blocks"];

function ItemIcon({ d }: { d: string }) {
  return (
    <svg className="slash-menu-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

// Web/desktop only -- gated by Editor.tsx's !isTauriAndroid() check before
// this is even mounted. A second insert path alongside Toolbar.tsx's
// existing tap-to-open Insert group, which stays the only insert path on
// the Android build: a "/" menu is a keyboard-centric affordance with no
// clear mobile-touch equivalent.
export function SlashMenu({ editor, commands }: SlashMenuProps) {
  const view = editor.ctx.get(editorViewCtx);
  // SlashProvider sets `left`/`top` directly on THIS element (the portal
  // target it positions via floating-ui) -- same precedent as the code-block
  // language picker (code-block-layout.css: "floating-ui repositions THIS
  // element, not the inner visible box"). `position: fixed` has to live on
  // this same element (slash-menu.css's `.slash-menu-root`), not on
  // `.slash-menu-panel` below -- confirmed directly as a real bug: without
  // it, `left`/`top` on a `position: static` element are no-ops, and the
  // menu rendered wherever it happened to fall in normal document flow
  // instead of anywhere near the caret.
  const element = useMemo(() => {
    const el = document.createElement("div");
    el.className = "slash-menu-root";
    return el;
  }, []);
  const providerRef = useRef<SlashProvider | null>(null);
  const prevStateRef = useRef<EditorState | undefined>(undefined);
  const [highlighted, setHighlighted] = useState(0);
  const lastQueryTextRef = useRef<string | null>(null);

  useEffect(() => {
    // Only drives the floating position + data-show CSS toggle (see
    // slash-menu.css) -- the actual decision to render list content at all
    // is React's own `query` state below, computed fresh every render, not
    // this provider's debounced show/hide.
    const provider = new SlashProvider({
      content: element,
      debounce: 0,
      shouldShow: (v) => v.hasFocus() && v.editable && findSlashQuery(v) !== null,
    });
    providerRef.current = provider;
    return () => provider.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [element]);

  useEffect(() => {
    providerRef.current?.update(view, prevStateRef.current);
    prevStateRef.current = view.state;
  });

  const rawQuery = findSlashQuery(view);
  // Escape dismisses the menu without deleting the "/" (same convention
  // every slash menu uses) -- it must stay dismissed even though the query
  // itself (same position, same text) still matches on every subsequent
  // render, or it would instantly reappear. Keyed by the query's own start
  // position so a NEW "/" elsewhere (or the cursor leaving and a fresh one
  // starting) isn't permanently suppressed by an unrelated earlier dismissal.
  // A real useState, not a ref -- Escape itself dispatches no ProseMirror
  // transaction and nothing else would otherwise trigger a re-render to
  // pick up a ref mutation, so the dismissal would silently never take
  // visible effect (confirmed directly: the menu stayed in the DOM after
  // Escape with a ref-only version of this).
  const [dismissedFrom, setDismissedFrom] = useState<number | null>(null);
  const query = rawQuery && dismissedFrom === rawQuery.from ? null : rawQuery;

  useEffect(() => {
    if (query?.text !== lastQueryTextRef.current) {
      setHighlighted(0);
      lastQueryTextRef.current = query?.text ?? null;
    }
  });

  const q = query?.text.toLowerCase() ?? "";
  const matches = (item: SlashItem) => item.keywords.includes(q) || item.label.toLowerCase().includes(q);
  // Flat list (basic items before rich ones, matching the design's own
  // "first matching item, basic group first" precedence) drives keyboard
  // nav/highlighting; grouped-by-section rendering below is purely visual.
  const filtered = query ? ITEMS.filter(matches) : [];

  function runItem(item: SlashItem) {
    if (!query) return;
    view.dispatch(view.state.tr.delete(query.from, query.to));
    item.run(view, editor, commands);
    view.focus();
  }

  // Capture-phase so this runs before ProseMirror's own keymap handling
  // (same technique DrawLayer/codeBlockLongPress already use for "intercept
  // before the normal handler sees it") -- otherwise Enter would just split
  // the paragraph and ArrowUp/Down would move the real text cursor.
  useEffect(() => {
    const dom = view.dom;
    function onKeyDown(event: KeyboardEvent) {
      const liveQuery = findSlashQuery(view);
      if (!liveQuery) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDismissedFrom(liveQuery.from);
        providerRef.current?.hide();
        return;
      }
      if (dismissedFrom === liveQuery.from) return;
      if (filtered.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        setHighlighted((i) => (i + 1) % filtered.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        setHighlighted((i) => (i - 1 + filtered.length) % filtered.length);
      } else if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        runItem(filtered[highlighted] ?? filtered[0]!);
      }
    }
    dom.addEventListener("keydown", onKeyDown, { capture: true });
    return () => dom.removeEventListener("keydown", onKeyDown, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, filtered, highlighted]);

  return createPortal(
    query ? (
      <div className="slash-menu-panel" role="listbox" aria-label="Insert block">
        <div className="slash-menu-filter">
          <svg className="slash-menu-search-icon" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <span className="slash-menu-filter-text">{query.text || "Filter blocks…"}</span>
          <span className="slash-menu-filter-hint">↵ to insert</span>
        </div>
        <div className="slash-menu-body">
          {filtered.length === 0 ? (
            <div className="slash-menu-empty">No blocks match &ldquo;{query.text}&rdquo;</div>
          ) : (
            GROUPS.map((group) => {
              const groupItems = filtered.filter((item) => item.group === group);
              if (groupItems.length === 0) return null;
              return (
                <div key={group} className="slash-menu-group">
                  <div className="slash-menu-group-label">{group}</div>
                  <div className="slash-menu-grid">
                    {groupItems.map((item) => {
                      const index = filtered.indexOf(item);
                      return (
                        <button
                          key={item.id}
                          type="button"
                          role="option"
                          aria-selected={index === highlighted}
                          className="slash-menu-item"
                          data-highlighted={index === highlighted || undefined}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => runItem(item)}
                        >
                          <span className="slash-menu-tile">
                            <ItemIcon d={item.icon} />
                          </span>
                          <span className="slash-menu-item-label">{item.label}</span>
                          {item.hint && <span className="slash-menu-item-hint">{item.hint}</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    ) : null,
    element,
  );
}

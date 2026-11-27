import { useEffect, useRef, useState } from "react";
import type { Command, EditorState } from "prosemirror-state";
import { NodeSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx, schemaCtx } from "@milkdown/kit/core";
import { isMarkActive, isNodeActive, type EditorCommands } from "./commands";
import { type MermaidEditRequest } from "./mermaidPreview";
import { type CodeBlockEditRequest } from "./codeBlockEdit";
import { useKeyboardInset } from "./useKeyboardInset";
import { TEXT_COLORS, isTextColorActive } from "./textColor";
import { applyCodeWrapToAll } from "./codeBlockWrap";
import { CELL_COLORS, toggleHeaderColumn, setCellColor, fillColumnColor } from "./tableCosmetics";
import { PEN_STYLES, type EditorMode, type PenStyle, type DrawAnchorMode } from "./drawTypes";

// Best-guess group-panel height for the very first open, before any real
// keyboard height has been observed on this device (e.g. the editor was
// never focused yet) -- a typical phone keyboard's rough height in CSS px.
const FALLBACK_PANEL_HEIGHT = 280;

// Suppressed while focus is inside a code block's embedded CodeMirror
// instance (see Editor.tsx's codeBlockComponent config) -- none of this
// toolbar's markdown-formatting commands apply to code. CodeMirror's own DOM
// lives inside the code-block NodeView's `.milkdown-code-block` wrapper
// (confirmed against @milkdown/components' NodeView source) and is still a
// descendant of view.dom regardless of which CodeMirror internals end up
// focused, so a view.dom-scoped focusin/focusout listener reliably tracks it.
function useToolbarSuppressed(view: EditorView | null, selection: EditorState["selection"] | undefined): boolean {
  // Tracks ONLY whether DOM focus geometrically sits inside a code block --
  // purely a function of focus events, with no opinion on selection type.
  // The final suppression decision below combines this with `selection`
  // (read fresh from the component's own render-time `state` on every
  // render, not cached here), since a long-press-selected code block (a
  // NodeSelection -- see codeBlockLongPress.ts) can change `state.selection`
  // WITHOUT any new focus event firing at all: the NodeView's own
  // `selectNode()` lifecycle method calls `this.cm.focus()` (confirmed
  // directly against @milkdown/components' source), which is a no-op --
  // no new `focusin` -- if the user long-presses a code block they were
  // ALREADY editing inside (CodeMirror already had focus). Relying on
  // focus events alone left `suppressed` stuck at its previous (correctly
  // suppressed, since they'd been typing) value in exactly that case,
  // hiding the Delete button the long-press exists to surface.
  const [focusInsideCodeBlock, setFocusInsideCodeBlock] = useState(false);

  useEffect(() => {
    if (!view) return;
    const dom = view.dom;
    const update = () => {
      const active = document.activeElement;
      setFocusInsideCodeBlock(!!active && dom.contains(active) && !!active.closest(".milkdown-code-block"));
    };
    update();
    dom.addEventListener("focusin", update);
    dom.addEventListener("focusout", update);
    return () => {
      dom.removeEventListener("focusin", update);
      dom.removeEventListener("focusout", update);
    };
  }, [view]);

  return focusInsideCodeBlock && !(selection instanceof NodeSelection);
}

// Whether DOM focus currently sits anywhere inside the editor's own view --
// the signal `mode` is now derived from (see `effectiveMode` below), instead
// of a user-flippable toggle. Deliberately NOT keyboardInset: keyboardInset
// tracks an actual on-screen keyboard's height for layout purposes only
// (see useKeyboardInset.ts) and stays 0 on desktop/a hardware keyboard even
// while the editor is genuinely focused and being typed into -- confirmed
// directly against that hook's own source before relying on it here, since
// using it as the mode signal would have silently made Text mode
// unreachable on any device without an on-screen keyboard.
function useViewFocused(view: EditorView | null): boolean {
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!view) {
      setFocused(false);
      return;
    }
    const dom = view.dom;
    const update = () => setFocused(!!document.activeElement && dom.contains(document.activeElement));
    update();
    dom.addEventListener("focusin", update);
    dom.addEventListener("focusout", update);
    return () => {
      dom.removeEventListener("focusin", update);
      dom.removeEventListener("focusout", update);
    };
  }, [view]);

  return focused;
}

export interface ToolbarProps {
  /**
   * Null during either editor path's own brief startup window -- the
   * single-instance editor before Milkdown's `.create()` resolves, or the
   * virtualized path before any chunk has received focus yet (see
   * Editor.tsx's `anyChunkMounted`/`onActiveChange`). The draw-tools row
   * below (pen style, Pin/Sketch, Paging, "Edit text") still renders in
   * this case -- it doesn't depend on either -- only the rich
   * editor-command toolbar (format buttons, Insert/Table/Color groups)
   * needs them and is skipped until they're available.
   */
  editor: Editor | null;
  commands: EditorCommands | null;
  /**
   * There is no longer a manual Text/Draw toggle -- mode is derived
   * entirely from whether text-editing is actually happening right now
   * (the editor has DOM focus, a group panel is open, or a media node is
   * selected) vs. not (idle, blurred, nothing selected), so a stroke can
   * start immediately with no mode switch required. This callback is a
   * one-way report of that computed value, fired from a `useEffect` below
   * -- not a request the parent should feed back in as a `mode` prop.
   */
  onModeChange: (mode: EditorMode) => void;
  penStyle: PenStyle;
  onPenStyleChange: (style: PenStyle) => void;
  /** See `DrawAnchorMode`'s own doc comment. Only rendered/relevant in Draw mode. */
  anchorMode: DrawAnchorMode;
  onAnchorModeChange: (mode: DrawAnchorMode) => void;
  /**
   * True only during either path's own brief startup window (see `editor`'s
   * own doc comment above) -- clamps the computed mode to "text" for that
   * window instead of letting it default to "draw" the way idle/blurred
   * normally would, since DrawLayer.tsx's own position-anchoring needs a
   * live editor/chunk to capture a stroke as reflow-anchored (and
   * therefore persistable); drawing before that falls back to scroll-only
   * anchoring with NO visible difference on screen, so a stroke drawn in
   * that window looked identical to a normal one but silently never got
   * saved -- confirmed directly as a real user-visible gap on a real
   * (slower) device, not just a theoretical race. (Irrelevant to -- not to
   * be confused with -- "sketch" mode above, which is a deliberate,
   * permanent choice, not a startup-window gap.)
   */
  drawDisabled?: boolean;
  /**
   * Whole-viewport pagination mode (see PagingLayer.tsx) -- deliberately
   * independent of the virtualized editor's own chunk/heading-based
   * "Page N / Total" nav bar (`Editor.tsx`'s `virtualizedPage`): this is a
   * fresh, separate concept that defines a "page" as whatever currently
   * fits the viewport, works on ANY document regardless of size/
   * virtualization, and layers scroll-snap-to-next-page behavior on top of
   * the existing scroller rather than restructuring how content is
   * rendered. Always visible (not gated on `mode === "draw"`) since it
   * governs how the CONTENT scrolls, which is relevant in both text and
   * draw mode.
   */
  pagingMode: boolean;
  onPagingModeChange: (enabled: boolean) => void;
  /** Clears every stroke -- moved here from DrawLayer.tsx's own floating controls (requested directly), which still owns the actual clearing logic; this just triggers it. */
  onClearDrawing: () => void;
  /** Opens MermaidEditorModal.tsx (Editor.tsx owns the actual modal/state) -- called both by the Insert group's "Mermaid diagram" item (`replace: null`, a new diagram) and by the generic "Edit" button below when the selected code_block's own language is Mermaid. */
  onOpenMermaidEditor: (request: MermaidEditRequest) => void;
  /** Opens CodeBlockEditorModal.tsx -- the same pattern as onOpenMermaidEditor above, for every OTHER code_block (plain code in any language, and LaTeX): the Insert group's "Code block"/"LaTeX block" items, and the generic "Edit" button when the selected block's language ISN'T Mermaid. */
  onOpenCodeEditor: (request: CodeBlockEditRequest) => void;
  /**
   * True whenever SearchBar.tsx is open (Editor.tsx's own `searchOpen`
   * state). Forces this toolbar fully hidden regardless of `keyboardInset`
   * or `effectiveMode` -- find/replace's own `<input>` elements aren't part
   * of the ProseMirror view at all, but focusing any text input still
   * brings up the same on-screen keyboard and therefore the same
   * `visualViewport` resize `useKeyboardInset()` reacts to, which would
   * otherwise pop this toolbar's own format/draw row up underneath the
   * search bar for no reason -- none of its commands apply to the search
   * input's own text. The request was specifically "only the keyboard
   * should show," not this toolbar too.
   */
  searchOpen?: boolean;
}

interface ToolbarItem {
  label: string;
  title: string;
  command: Command;
  isActive?: (state: EditorState) => boolean;
  /** Renders a colored swatch dot instead of `label` text -- same visual pattern as ModeHeader.tsx's pen-style swatches. */
  swatchColor?: string;
}

interface ToolbarRow {
  label: string;
  items: ToolbarItem[];
}

interface ToolbarGroup {
  key: string;
  label: string;
  title: string;
  /** Items grouped into labeled rows -- each renders as its own row in the panel. */
  rows: ToolbarRow[];
}

function ToolbarItemButton({
  item,
  state,
  view,
  onApplied,
}: {
  item: ToolbarItem;
  state: EditorState;
  view: EditorView;
  onApplied: () => void;
}) {
  return (
    <button
      type="button"
      className="toolbar-button"
      title={item.title}
      aria-label={item.title}
      data-active={item.isActive?.(state) || undefined}
      disabled={!item.command(state)}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        item.command(view.state, view.dispatch);
        onApplied();
      }}
    >
      {item.swatchColor ? <span className="toolbar-swatch" style={{ background: item.swatchColor }} /> : item.label}
    </button>
  );
}

// Bottom toolbar: hidden whenever the keyboard is hidden, visible whenever
// the keyboard is -- tied to the same keyboardInset signal that positions it
// (see `visible` below), not to editor focus, since focus and the keyboard's
// actual on-screen presence aren't the same thing (a hardware/Bluetooth
// keyboard, or the brief moment before the on-screen keyboard's open
// animation finishes, can both leave the editor focused with no keyboard
// actually covering anything). Also hidden whenever focus is inside a code
// block (see useToolbarSuppressed above) -- none of these commands apply to
// code, regardless of whether the keyboard happens to be up for it.
// Horizontally scrollable if it doesn't fit, 44px-minimum touch targets,
// never :hover-revealed (see Claude.md for why). This is the primary way to
// format text and insert blocks on touch, replacing Crepe's hover-revealed
// drag handle and floating menus.
//
// Less-frequent items are bucketed into named groups (see `groups` below).
// Tapping a group's trigger button blurs the editor -- dismissing the
// on-screen keyboard -- and swaps the toolbar row for a grid panel of that
// group's items, since the keyboard's screen space is exactly what the grid
// needs. Picking an item (or closing the panel) returns focus to the editor,
// which brings the keyboard back. The toolbar/panel stays visible for that
// deliberate blur regardless of keyboardInset (see `visible` below) -- it's
// only once no group is expanded that visibility goes back to tracking the
// keyboard.
export function Toolbar({
  editor,
  commands,
  onModeChange,
  penStyle,
  onPenStyleChange,
  anchorMode,
  onAnchorModeChange,
  drawDisabled,
  pagingMode,
  onPagingModeChange,
  onClearDrawing,
  onOpenMermaidEditor,
  onOpenCodeEditor,
  searchOpen,
}: ToolbarProps) {
  const view = editor?.ctx.get(editorViewCtx) ?? null;
  const schema = editor?.ctx.get(schemaCtx) ?? null;
  const state = view?.state;
  const keyboardInset = useKeyboardInset();
  const toolbarSuppressed = useToolbarSuppressed(view, state?.selection);
  const hasFocus = useViewFocused(view);
  const [activeGroupKey, setActiveGroupKey] = useState<string | null>(null);
  const [panelHeight, setPanelHeight] = useState(FALLBACK_PANEL_HEIGHT);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  // Document-wide, not per-code-block -- see codeBlockWrap.ts for why a real
  // per-block toggle (as the design shows) isn't buildable against
  // @milkdown/components' fixed code-block template.
  const [codeWrapEnabled, setCodeWrapEnabled] = useState(false);

  // Remember the last real keyboard height seen while it was actually open,
  // since by the time a group panel needs a height, blur() has already
  // started closing the keyboard and keyboardInset is on its way back to 0.
  const lastKeyboardHeightRef = useRef(FALLBACK_PANEL_HEIGHT);
  useEffect(() => {
    if (keyboardInset > 0) lastKeyboardHeightRef.current = keyboardInset;
  }, [keyboardInset]);

  // Computed here (not after schema/editor are confirmed non-null below)
  // since it only needs `state`/`schema`, both already optional-chained --
  // `effectiveMode` needs this before the early-return, and a NodeSelection
  // on an image/video/audio/code_block counts as "text editing" the same
  // as DOM focus does (see `textEditingActive` below), even though it alone
  // doesn't require the editor to currently have DOM focus.
  const mediaSelection = state?.selection instanceof NodeSelection ? state.selection : null;
  const selectedMediaType =
    mediaSelection && schema && [schema.nodes.image, schema.nodes.video, schema.nodes.audio, schema.nodes.code_block].includes(mediaSelection.node.type)
      ? mediaSelection.node.type
      : null;

  // No manual Text/Draw toggle -- "something that needs text-editing UI is
  // actually happening right now": the editor has DOM focus (typing, or a
  // selection even without an on-screen keyboard up), a group panel is
  // open (which deliberately blurs the view itself -- see `openGroup`
  // below -- so `activeGroupKey` has to count on its own), or a media/
  // code-block node is selected. Deliberately NOT gated on
  // `toolbarSuppressed` (typing inside a code block) -- that only hides
  // the rich formatting row (see `showRichContent` below), it doesn't mean
  // text-editing stopped.
  const textEditingActive = hasFocus || activeGroupKey !== null || selectedMediaType !== null;

  // Mode starts in Text (opening a document should land you ready to
  // edit, not staring at pen tools) and only becomes Draw on the FALLING
  // EDGE of `textEditingActive` -- i.e. once you deliberately stop (hide
  // the keyboard, close a group without reselecting, deselect a node),
  // not merely "whatever happens to be true on any given render while
  // nothing is currently active." A purely functional `textEditingActive
  // ? "text" : "draw"` recomputed fresh every render made idle-on-load
  // default to Draw too (nothing has been focused yet, which reads
  // identically to "just finished editing") -- confirmed directly as a
  // real, reported regression, not what's wanted. Re-entering Text mode
  // afterward works the same either way: the "Edit text" button below (or
  // reopening a group/selecting media) makes `textEditingActive` true
  // again, which this effect picks up on its very next run.
  const [derivedMode, setDerivedMode] = useState<EditorMode>("text");
  const wasTextEditingActiveRef = useRef(false);
  useEffect(() => {
    if (drawDisabled) {
      setDerivedMode("text");
      return;
    }
    if (textEditingActive) {
      setDerivedMode("text");
    } else if (wasTextEditingActiveRef.current) {
      setDerivedMode("draw");
    }
    wasTextEditingActiveRef.current = textEditingActive;
  }, [textEditingActive, drawDisabled]);
  const effectiveMode = derivedMode;

  useEffect(() => {
    onModeChange(effectiveMode);
  }, [effectiveMode, onModeChange]);

  // Pen style, Pin/Sketch, Paging, and the one explicit way back to Text
  // mode -- formerly ModeHeader.tsx, a separate always-visible bar pinned
  // above the content area, then (Phase 4) a permanently-visible row
  // stacked above the rich toolbar. Now the single row shown while
  // `effectiveMode === "draw"` -- see the final return below, which shows
  // either this or the rich/default row, never both at once (one row,
  // aligned to the design). None of this references `editor`/`commands`/
  // `schema`, which is exactly why it's computed before the early-return
  // below rather than after it -- it must stay reachable even when those
  // are still null (the single-instance startup window, or the
  // virtualized path before any chunk has received focus yet), though in
  // practice `effectiveMode` is clamped to "text" during that exact window
  // (via `drawDisabled`), so this specific row isn't actually reachable
  // until then anyway.
  const drawModeRow = (
    <div className="toolbar-mode-row" role="group" aria-label="Draw tools">
      <button
        type="button"
        className="mode-header-button"
        title="Edit text"
        aria-label="Edit text"
        disabled={!view}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => view?.focus()}
      >
        ⌨
      </button>
      <span className="mode-header-separator" aria-hidden="true" />
      <button
        type="button"
        className="mode-header-button"
        title={pagingMode ? "Paged view (scroll to flip pages)" : "Continuous scroll"}
        aria-label="Paging mode"
        aria-pressed={pagingMode}
        data-active={pagingMode || undefined}
        onClick={() => onPagingModeChange(!pagingMode)}
      >
        📑
      </button>
      <span className="mode-header-separator" aria-hidden="true" />
      <div className="toolbar-pencil-group" role="group" aria-label="Pen style">
        {PEN_STYLES.map((style) => (
          <button
            key={style.id}
            type="button"
            className="mode-header-pen-button"
            title={style.label}
            aria-label={style.label}
            aria-pressed={penStyle.id === style.id}
            data-active={penStyle.id === style.id || undefined}
            onClick={() => onPenStyleChange(style)}
          >
            <span className="mode-header-pen-swatch" style={{ background: style.color, opacity: style.opacity ?? 1 }} />
          </button>
        ))}
      </div>
      <span className="mode-header-separator" aria-hidden="true" />
      <button
        type="button"
        className="mode-header-button"
        title="Pin (moves with its paragraph, keeps its shape, saved)"
        aria-label="Pin"
        aria-pressed={anchorMode === "pin"}
        data-active={anchorMode === "pin" || undefined}
        onClick={() => onAnchorModeChange("pin")}
      >
        📌
      </button>
      <button
        type="button"
        className="mode-header-button"
        title="Sketch (fixed position, not saved)"
        aria-label="Sketch"
        aria-pressed={anchorMode === "sketch"}
        data-active={anchorMode === "sketch" || undefined}
        onClick={() => onAnchorModeChange("sketch")}
      >
        ☁
      </button>
      <span className="mode-header-separator" aria-hidden="true" />
      <button
        type="button"
        className="mode-header-button"
        title="Clear drawing"
        aria-label="Clear drawing"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClearDrawing}
      >
        🧹
      </button>
    </div>
  );

  // Rich, editor-command-dependent content (format buttons, Insert/Table/
  // Color groups) needs a live editor/schema/commands triple -- see
  // ToolbarProps' own doc comment for when this is null. `effectiveMode`
  // is already clamped to "text" for this exact window (via `drawDisabled`),
  // so `drawModeRow` is never actually reached here -- just nothing rich to
  // show yet either.
  if (!editor || !commands || !view || !schema || !state) {
    return (
      <div className="toolbar" role="toolbar" data-mode={effectiveMode} style={{ bottom: 0 }}>
        <div className="toolbar-row" style={{display: "none"}}/>
      </div>
    );
  }

  // Opens a dedicated modal rather than inserting an empty block directly
  // (UX_PLAN.md Phase 6, generalized to every code_block per a direct
  // follow-up request) -- the modal itself calls back through Editor.tsx's
  // `onDone` to perform the actual insert once the user has authored real
  // content, not before.
  const insertMermaid: Command = (_state, dispatch) => {
    if (dispatch) onOpenMermaidEditor({ initialSource: "", replace: null });
    return true;
  };

  const insertCode: Command = (_state, dispatch) => {
    if (dispatch) onOpenCodeEditor({ language: "", initialSource: "", replace: null });
    return true;
  };

  const insertLatex: Command = (_state, dispatch) => {
    if (dispatch) onOpenCodeEditor({ language: "LaTeX", initialSource: "", replace: null });
    return true;
  };

  // Not a real ProseMirror command (nothing in the document changes) -- a
  // plain Command shape just so this toggle fits the same ToolbarItem/
  // ToolbarItemButton model as everything else in the Code row.
  const toggleCodeWrap: Command = (_state, dispatch) => {
    if (dispatch) {
      const next = !codeWrapEnabled;
      setCodeWrapEnabled(next);
      applyCodeWrapToAll(view.dom, next);
    }
    return true;
  };

  // Frequent, single-tap toggles -- kept directly on the toolbar row.
  const defaultItems: ToolbarItem[] = [
    { label: "B", title: "Bold", command: commands.toggleBold, isActive: (s) => isMarkActive(s, schema.marks.strong!) },
    { label: "I", title: "Italic", command: commands.toggleItalic, isActive: (s) => isMarkActive(s, schema.marks.emphasis!) },
    { label: "</>", title: "Inline code", command: commands.toggleInlineCode, isActive: (s) => isMarkActive(s, schema.marks.inlineCode!) },
    { label: "S", title: "Strikethrough", command: commands.toggleStrikethrough, isActive: (s) => isMarkActive(s, schema.marks.strike_through!) },
    { label: "U", title: "Underline", command: commands.toggleUnderline, isActive: (s) => isMarkActive(s, schema.marks.underline!) },
    { label: "🔗", title: "Link", command: commands.toggleLink, isActive: (s) => isMarkActive(s, schema.marks.link!) },
    { label: "↷", title: "Redo", command: commands.redo },
  ];

  const groups: ToolbarGroup[] = [
    {
      key: "insert",
      label: "+",
      title: "Insert",
      rows: [
        {
          label: "Media",
          items: [
            { label: "🖼", title: "Image", command: commands.insertImage },
            { label: "▶", title: "Video", command: commands.insertVideo },
            { label: "♪", title: "Audio", command: commands.insertAudio },
          ],
        },
        {
          label: "Code",
          items: [
            { label: "{ }", title: "Code block", command: insertCode, isActive: (s) => isNodeActive(s, schema.nodes.code_block!) },
            { label: "◇", title: "Mermaid diagram", command: insertMermaid },
            { label: "∑", title: "LaTeX block", command: insertLatex },
            { label: "Wrap", title: "Wrap long lines in code blocks", command: toggleCodeWrap, isActive: () => codeWrapEnabled },
          ],
        },
        {
          label: "Structure",
          items: [
            { label: "▦", title: "Insert table", command: commands.insertTable(editor.ctx, 3, 3) },
            { label: "—", title: "Horizontal rule", command: commands.insertHorizontalRule },
          ],
        },
        {
          label: "Blocks",
          items: [
            { label: "ℹ", title: "Callout", command: commands.insertCallout },
            { label: "▸", title: "Toggle list", command: commands.insertToggleList },
            { label: "☑", title: "Checklist", command: commands.insertTaskList },
          ],
        },
      ],
    },
    {
      key: "table",
      label: "▦+",
      title: "Table",
      rows: [
        {
          label: "Row",
          items: [
            { label: "↑Row", title: "Insert row above", command: commands.insertRowAbove },
            { label: "↓Row", title: "Insert row below", command: commands.insertRowBelow },
            { label: "✕Row", title: "Delete row", command: commands.deleteRow },
            { label: "Row▲", title: "Move row up", command: commands.moveRowUp },
            { label: "Row▼", title: "Move row down", command: commands.moveRowDown },
          ],
        },
        {
          label: "Column",
          items: [
            { label: "←Col", title: "Insert column left", command: commands.insertColumnLeft },
            { label: "→Col", title: "Insert column right", command: commands.insertColumnRight },
            { label: "✕Col", title: "Delete column", command: commands.deleteColumn },
            { label: "Col◀", title: "Move column left", command: commands.moveColumnLeft },
            { label: "Col▶", title: "Move column right", command: commands.moveColumnRight },
          ],
        },
        {
          label: "Cells",
          items: [
            { label: "Merge→", title: "Combine with cell to the right", command: commands.combineRight },
            { label: "Merge↓", title: "Combine with cell below", command: commands.combineDown },
            { label: "Split", title: "Split cell", command: commands.splitCell },
          ],
        },
        {
          label: "Column format",
          items: [
            { label: "⯇", title: "Align column left", command: commands.setColumnAlign("left") },
            { label: "☰", title: "Align column center", command: commands.setColumnAlign("center") },
            { label: "⯈", title: "Align column right", command: commands.setColumnAlign("right") },
            { label: "Sort", title: "Sort column A→Z", command: commands.sortColumnAscending },
          ],
        },
        {
          // Cosmetic-only, not persisted -- see tableCosmetics.ts.
          label: "Cell color",
          items: [
            ...CELL_COLORS.map((option) => ({
              label: option.label,
              title: `Cell color: ${option.label}`,
              command: setCellColor(option.color),
              swatchColor: option.color,
            })),
            { label: "✕", title: "Clear cell color", command: setCellColor(null) },
          ],
        },
        {
          label: "Column fill",
          items: [
            ...CELL_COLORS.map((option) => ({
              label: option.label,
              title: `Fill column: ${option.label}`,
              command: fillColumnColor(option.color),
              swatchColor: option.color,
            })),
            { label: "✕", title: "Clear column fill", command: fillColumnColor(null) },
          ],
        },
        {
          label: "Header column",
          items: [{ label: "Header col", title: "Toggle header-column style (not saved)", command: toggleHeaderColumn() }],
        },
      ],
    },
    {
      key: "text",
      label: "T",
      title: "Text styles",
      rows: [
        {
          label: "Headings",
          items: [
            { label: "¶", title: "Paragraph", command: commands.setParagraph, isActive: (s) => isNodeActive(s, schema.nodes.paragraph!) },
            { label: "H1", title: "Heading 1", command: commands.setHeading(1), isActive: (s) => isNodeActive(s, schema.nodes.heading!, { level: 1 }) },
            { label: "H2", title: "Heading 2", command: commands.setHeading(2), isActive: (s) => isNodeActive(s, schema.nodes.heading!, { level: 2 }) },
            { label: "H3", title: "Heading 3", command: commands.setHeading(3), isActive: (s) => isNodeActive(s, schema.nodes.heading!, { level: 3 }) },
            { label: "H4", title: "Heading 4", command: commands.setHeading(4), isActive: (s) => isNodeActive(s, schema.nodes.heading!, { level: 4 }) },
            { label: "H5", title: "Heading 5", command: commands.setHeading(5), isActive: (s) => isNodeActive(s, schema.nodes.heading!, { level: 5 }) },
          ],
        },
        {
          label: "Lists",
          items: [
            { label: "“”", title: "Blockquote", command: commands.toggleBlockquote, isActive: (s) => isNodeActive(s, schema.nodes.blockquote!) },
            { label: "•", title: "Bullet list", command: commands.toggleBulletList, isActive: (s) => isNodeActive(s, schema.nodes.bullet_list!) },
            { label: "1.", title: "Ordered list", command: commands.toggleOrderedList, isActive: (s) => isNodeActive(s, schema.nodes.ordered_list!) },
            { label: "⯇⯇", title: "Outdent", command: commands.outdentListItem },
            { label: "⯈⯈", title: "Indent", command: commands.indentListItem },
          ],
        },
      ],
    },
    {
      key: "color",
      label: "🎨",
      title: "Text color",
      rows: [
        {
          label: "Color",
          items: [
            ...TEXT_COLORS.map((option) => ({
              label: option.label,
              title: option.label,
              command: commands.setTextColor(option.color),
              isActive: (s: EditorState) => isTextColorActive(s, schema.marks.text_color!, option.color),
              swatchColor: option.color,
            })),
            { label: "✕", title: "Clear color", command: commands.clearTextColor },
          ],
        },
      ],
    },
  ];

  const activeGroup = groups.find((group) => group.key === activeGroupKey) ?? null;

  // Tapping an image/video/audio node (selectable: true on all three)
  // creates a NodeSelection without focusing any text or bringing up the
  // keyboard -- so unlike every other toolbar state, this has to be its own
  // extra `visible` condition, not just riding on keyboardInset > 0. Takes
  // priority over the default row but not over an explicitly opened group
  // panel (selecting media while a panel happens to be open is not a normal
  // flow, but if it occurs, the panel the user deliberately opened wins).
  //
  // `code_block` rides this exact same mechanism (same contextual bar,
  // Delete only -- no Preview, same as video/audio below) even though it
  // reaches a NodeSelection a completely different way: a code block has
  // its own embedded CodeMirror NodeView whose `stopEvent()` always returns
  // `true` (confirmed directly against @milkdown/components' source),
  // meaning an ordinary tap can never produce a NodeSelection on it the
  // way tapping an atom image/video/audio node already does -- there was
  // no way to select, and therefore no way to delete, a code block at all
  // before this. codeBlockLongPress.ts's long-press gesture is what
  // produces the NodeSelection here; this file doesn't need to know how.
  // (`mediaSelection`/`selectedMediaType` themselves are computed earlier,
  // above the early-return, since `effectiveMode` needs them too.)

  const openGroup = (key: string) => {
    setPanelHeight(keyboardInset > 0 ? keyboardInset : lastKeyboardHeightRef.current);
    view.dom.blur();
    setActiveGroupKey(key);
  };

  const closeGroup = () => {
    setActiveGroupKey(null);
    view.focus();
  };

  const deleteSelectedMedia = () => {
    view.dispatch(view.state.tr.deleteSelection());
  };

  // The rich, editor-command content (format row / group panel / media row)
  // only ever makes sense in Text mode, and is additionally suppressed
  // while focus is inside a code block (see useToolbarSuppressed above) --
  // none of these commands apply to code, regardless of whether a keyboard
  // happens to be up for it. Text mode with suppression active renders an
  // empty row below (same placeholder the startup-window early-return
  // uses), not `drawModeRow` -- the user is still actively editing text
  // (code), DrawLayer must stay inactive, there's just nothing useful for
  // THIS toolbar to show for it.
  const showRichContent = !searchOpen && effectiveMode === "text" && !toolbarSuppressed && (keyboardInset > 0 || activeGroup !== null || selectedMediaType !== null);
  const hiddenRow = <div className="toolbar-row" style={{ display: "none" }} />;

  return (
    <div className="toolbar" role="toolbar" data-mode={effectiveMode} style={{ bottom: effectiveMode === "text" ? keyboardInset : 0 }}>
      {searchOpen ? hiddenRow : effectiveMode === "draw" ? drawModeRow : !showRichContent ? (
        hiddenRow
      ) : (activeGroup ? (
        <div className="toolbar-group-panel" style={{ height: panelHeight }}>
          <div className="toolbar-group-panel-header">
            <span>{activeGroup.title}</span>
            <button type="button" className="toolbar-group-close" aria-label="Close" onClick={closeGroup}>
              ✕
            </button>
          </div>
          <div className="toolbar-group-rows">
            {activeGroup.rows.map((row) => (
              <div className="toolbar-group-row" key={row.label}>
                <span className="toolbar-group-row-label">{row.label}</span>
                <div className="toolbar-group-row-items">
                  {row.items.map((item) => (
                    <ToolbarItemButton key={item.title} item={item} state={state} view={view} onApplied={closeGroup} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : selectedMediaType ? (
        // Contextual bar for a selected image/video/audio node (see
        // mediaSelection above) -- not one of the icon-grid groups above,
        // since it's driven by selection state rather than an explicit
        // tap-to-open trigger, and Preview isn't a document-mutating
        // ProseMirror command the way every other toolbar action is (it
        // just opens the lightbox overlay below), so it doesn't fit
        // ToolbarItem/ToolbarItemButton's command-based model either.
        <div className="toolbar-row toolbar-media-row">
          {selectedMediaType === schema.nodes.image && (
            <button
              type="button"
              className="toolbar-button"
              title="Preview image"
              aria-label="Preview image"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setPreviewSrc(mediaSelection!.node.attrs.src)}
            >
              👁
            </button>
          )}
          {/* Every code_block is read-only inline now (CodeMirrorView.editable.of(false), createMilkdownEditor.ts) -- "Edit" is the
              only way to change its content, for ANY language, not just Mermaid. Routes to MermaidEditorModal.tsx specifically for a
              Mermaid-language block (its own diagram-type/direction/theme controls don't apply to anything else) and
              CodeBlockEditorModal.tsx for everything else (plain code in any language, and LaTeX). */}
          {selectedMediaType === schema.nodes.code_block &&
            (() => {
              const language = typeof mediaSelection!.node.attrs.language === "string" ? mediaSelection!.node.attrs.language : "";
              const replace = { pos: mediaSelection!.from, nodeSize: mediaSelection!.node.nodeSize };
              const initialSource = mediaSelection!.node.textContent;
              return (
                <button
                  type="button"
                  className="toolbar-button"
                  title="Edit"
                  aria-label="Edit"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() =>
                    language.toLowerCase() === "mermaid"
                      ? onOpenMermaidEditor({ initialSource, replace })
                      : onOpenCodeEditor({ language, initialSource, replace })
                  }
                >
                  ✎
                </button>
              );
            })()}
          <button
            type="button"
            className="toolbar-button"
            title="Delete"
            aria-label="Delete"
            onMouseDown={(event) => event.preventDefault()}
            onClick={deleteSelectedMedia}
          >
            🗑
          </button>
        </div>
      ) : (
        <div className="toolbar-row">
          <div className="toolbar-scroll">
            {groups.map((group) => (
              <button
                key={group.key}
                type="button"
                className="toolbar-button toolbar-group-trigger"
                title={group.title}
                aria-label={group.title}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => openGroup(group.key)}
              >
                {group.label}
              </button>
            ))}
            <span className="toolbar-sep" aria-hidden="true" />
            {defaultItems.map((item) => (
              <ToolbarItemButton key={item.title} item={item} state={state} view={view} onApplied={() => view.focus()} />
            ))}
          </div>
          {/* Pinned outside the scrollable row (not just appended to it) so
              Undo and Hide-keyboard are always reachable regardless of how
              many items overflow -- some on-screen keyboards have no
              dismiss/close key of their own, and Undo is frequent enough to
              be worth never having to scroll for. */}
          <ToolbarItemButton item={{ label: "↶", title: "Undo", command: commands.undo }} state={state} view={view} onApplied={() => view.focus()} />
          {/* Paging is relevant in both modes (decision 10, UX_PLAN.md) --
              it governs how content scrolls, not text-editing itself --
              so it's pinned here too, alongside its twin in drawModeRow. */}
          <button
            type="button"
            className="toolbar-button"
            title={pagingMode ? "Paged view (scroll to flip pages)" : "Continuous scroll"}
            aria-label="Paging mode"
            aria-pressed={pagingMode}
            data-active={pagingMode || undefined}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPagingModeChange(!pagingMode)}
          >
            📑
          </button>
          <button
            type="button"
            className="toolbar-button toolbar-dismiss-keyboard"
            title="Hide keyboard"
            aria-label="Hide keyboard"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => view.dom.blur()}
          >
            ⌨
          </button>
          {/* Explicit, discoverable way to start drawing from Text mode,
              distinct from "Hide keyboard" above even though both end up
              blurring the view -- blurring is what the falling-edge mode
              derivation above reacts to (textEditingActive goes false, with
              nothing else to keep it true here: this button only renders in
              the default row, which itself only renders when neither a
              group panel is open nor a node is selected), so no separate
              mode-setting call is needed here. */}
          <button
            type="button"
            className="toolbar-button"
            title="Draw"
            aria-label="Draw"
            disabled={drawDisabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => view.dom.blur()}
          >
            ✎
          </button>
        </div>
      ))}
      {previewSrc && (
        <div className="media-preview-overlay" onClick={() => setPreviewSrc(null)}>
          <img src={previewSrc} alt="" className="media-preview-image" />
          <button
            type="button"
            className="media-preview-close"
            aria-label="Close preview"
            onClick={() => setPreviewSrc(null)}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

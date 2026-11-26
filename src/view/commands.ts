import type { Command, EditorState } from "prosemirror-state";
import type { MarkType, NodeType, Schema } from "prosemirror-model";
import { lift, setBlockType, toggleMark, wrapIn } from "@milkdown/kit/prose/commands";
import { liftListItem, sinkListItem, wrapInList } from "@milkdown/kit/prose/schema-list";
import { undo, redo } from "@milkdown/kit/prose/history";
import type { Ctx } from "@milkdown/kit/ctx";
import { createTable } from "@milkdown/kit/preset/gfm";
import { createTableCommands, type TableCommands } from "./tableCommands";
import { setTextColor as setTextColorBase, clearTextColor as clearTextColorBase } from "./textColor";

export function isMarkActive(state: EditorState, type: MarkType): boolean {
  const { from, to, empty, $from } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks ?? $from.marks());
  return state.doc.rangeHasMark(from, to, type);
}

export function isNodeActive(state: EditorState, type: NodeType, attrs: Record<string, unknown> = {}): boolean {
  const { $from } = state.selection;
  for (let d = $from.depth; d >= 0; d--) {
    const node = $from.node(d);
    if (node.type === type && Object.entries(attrs).every(([k, v]) => node.attrs[k] === v)) return true;
  }
  return false;
}

// Wrap in `nodeType` if not already inside one, otherwise lift back out.
function toggleWrap(nodeType: NodeType): Command {
  return (state, dispatch) => {
    const { $from } = state.selection;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type === nodeType) return lift(state, dispatch);
    }
    return wrapIn(nodeType)(state, dispatch);
  };
}

function toggleList(listType: NodeType, itemType: NodeType): Command {
  return (state, dispatch) => {
    const { $from } = state.selection;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type === listType) return liftListItem(itemType)(state, dispatch);
    }
    return wrapInList(listType)(state, dispatch);
  };
}

export interface EditorCommands extends TableCommands {
  toggleBold: Command;
  toggleItalic: Command;
  toggleInlineCode: Command;
  toggleStrikethrough: Command;
  toggleUnderline: Command;
  setTextColor: (color: string) => Command;
  clearTextColor: Command;
  setParagraph: Command;
  setHeading: (level: number) => Command;
  toggleBlockquote: Command;
  toggleBulletList: Command;
  toggleOrderedList: Command;
  outdentListItem: Command;
  indentListItem: Command;
  insertHorizontalRule: Command;
  insertCallout: Command;
  insertToggleList: Command;
  insertTable: (ctx: Ctx, rows: number, cols: number) => Command;
  insertImage: Command;
  insertVideo: Command;
  insertAudio: Command;
  toggleLink: Command;
  undo: Command;
  redo: Command;
}

// Built once per editor instance (schema is stable for its lifetime) and
// handed to the toolbar components. Node/mark names here are Milkdown's own
// (verified against @milkdown/preset-commonmark/gfm source) -- notably
// "emphasis"/"inlineCode", not the "em"/"code" names a plain prosemirror-markdown
// schema would use.
export function createCommands(schema: Schema): EditorCommands {
  const toggleBold = toggleMark(schema.marks.strong!);
  const toggleItalic = toggleMark(schema.marks.emphasis!);
  const toggleInlineCode = toggleMark(schema.marks.inlineCode!);
  // GFM's own mark, already part of this schema via .use(gfm) -- verified
  // directly against @milkdown/preset-gfm's source: schema name
  // "strike_through", round-trips through markdown as `~~text~~` already.
  const toggleStrikethrough = toggleMark(schema.marks.strike_through!);
  // Custom mark (underline.ts) -- markdown has no native underline syntax,
  // see that file for the custom remark-plugin round-trip this needed.
  const toggleUnderline = toggleMark(schema.marks.underline!);
  const textColorMarkType = schema.marks.text_color!;
  const setTextColor = (color: string) => setTextColorBase(textColorMarkType, color);
  const clearTextColor = clearTextColorBase(textColorMarkType);

  const setParagraph = setBlockType(schema.nodes.paragraph!);
  const setHeading = (level: number): Command => setBlockType(schema.nodes.heading!, { level });
  // No setCodeBlock here anymore -- every code_block insertion now opens
  // CodeBlockEditorModal.tsx first (Toolbar.tsx's "Code block" item calls
  // onOpenCodeEditor directly), since code blocks are read-only inline
  // and this command's own "convert current paragraph into an empty code
  // block in place" semantics no longer fit that flow.

  const toggleBlockquote = toggleWrap(schema.nodes.blockquote!);
  const toggleBulletList = toggleList(schema.nodes.bullet_list!, schema.nodes.list_item!);
  const toggleOrderedList = toggleList(schema.nodes.ordered_list!, schema.nodes.list_item!);
  // Same item type regardless of whether the cursor is in a bullet or
  // ordered list -- liftListItem/sinkListItem only care about list_item.
  const outdentListItem = liftListItem(schema.nodes.list_item!);
  const indentListItem = sinkListItem(schema.nodes.list_item!);

  const insertHorizontalRule: Command = (state, dispatch) => {
    if (dispatch) dispatch(state.tr.replaceSelectionWith(schema.nodes.hr!.create()));
    return true;
  };

  const insertCallout: Command = (state, dispatch) => {
    if (dispatch) {
      const paragraph = schema.nodes.paragraph!.createAndFill();
      const callout = schema.nodes.callout!.create({ calloutType: "note" }, paragraph ?? undefined);
      dispatch(state.tr.replaceSelectionWith(callout).scrollIntoView());
    }
    return true;
  };

  const insertToggleList: Command = (state, dispatch) => {
    if (dispatch) {
      const summary = schema.nodes.toggle_summary!.create();
      const bodyParagraph = schema.nodes.paragraph!.createAndFill();
      const body = schema.nodes.toggle_body!.create(null, bodyParagraph ?? undefined);
      const toggle = schema.nodes.toggle_list!.create(null, [summary, body]);
      dispatch(state.tr.replaceSelectionWith(toggle).scrollIntoView());
    }
    return true;
  };

  const insertTable = (ctx: Ctx, rows: number, cols: number): Command => {
    return (state, dispatch) => {
      if (dispatch) dispatch(state.tr.replaceSelectionWith(createTable(ctx, rows, cols)).scrollIntoView());
      return true;
    };
  };

  // Opens the platform's native file picker (no custom dialog UI in P0) and
  // inlines the chosen image as a base64 `data:` URL -- there's no file
  // storage/hosting layer in this app (see Claude.md), so the image bytes
  // themselves have to live in the markdown src rather than a path/URL
  // pointing at them. Milkdown's `image` node has real schema support and
  // round-trips through markdown as `![alt](src)` regardless of what that src
  // string contains (verified directly against
  // @milkdown/preset-commonmark's node/image.ts source) -- unlike
  // video/audio below, this needs no workaround. File reading is
  // asynchronous (unlike the synchronous `window.prompt` other insert
  // commands use), so `dispatch` is invoked later from the input's
  // `change`/`FileReader` callbacks rather than before this command returns;
  // ProseMirror commands don't require dispatch to happen synchronously.
  const insertImage: Command = (state, dispatch) => {
    if (!dispatch) return true;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const src = reader.result;
        if (typeof src !== "string") return;
        const alt = file.name.replace(/\.[^./]+$/, "");
        dispatch(state.tr.replaceSelectionWith(schema.nodes.image!.create({ src, alt })).scrollIntoView());
      };
      reader.readAsDataURL(file);
    };
    input.click();
    return true;
  };

  // Real <video>/<audio> nodes (mediaEmbed.ts) with their own NodeView --
  // see that file for why a real player is achievable here without
  // Mermaid-scale effort (native browser controls handle all the actual
  // interactivity; the one real requirement was a NodeView `stopEvent`
  // guard so ProseMirror's own click handling doesn't steal taps meant for
  // the native play button). Prompts for a URL (no custom dialog UI in
  // P0, same as toggleLink's own prompt).
  function insertEmbed(tag: "video" | "audio", promptLabel: string): Command {
    return (state, dispatch) => {
      if (!dispatch) return true;
      const src = window.prompt(promptLabel);
      if (!src) return false;
      dispatch(state.tr.replaceSelectionWith(schema.nodes[tag]!.create({ src })).scrollIntoView());
      return true;
    };
  }
  const insertVideo = insertEmbed("video", "Video URL");
  const insertAudio = insertEmbed("audio", "Audio URL");

  // Requires a text selection; prompts for a URL via the browser (no custom
  // dialog UI in P0). Toggling an existing link on the selection removes it.
  // With no `dispatch` (an applicability check) this must have no side
  // effects -- in particular, no prompt.
  const toggleLink: Command = (state, dispatch) => {
    const { from, to } = state.selection;
    if (from === to) return false;
    const linkType = schema.marks.link!;
    if (state.doc.rangeHasMark(from, to, linkType)) {
      if (dispatch) dispatch(state.tr.removeMark(from, to, linkType));
      return true;
    }
    if (!dispatch) return true;
    const href = window.prompt("Link URL");
    if (!href) return false;
    dispatch(state.tr.addMark(from, to, linkType.create({ href })));
    return true;
  };

  return {
    toggleBold,
    toggleItalic,
    toggleInlineCode,
    toggleStrikethrough,
    toggleUnderline,
    setTextColor,
    clearTextColor,
    setParagraph,
    setHeading,
    toggleBlockquote,
    toggleBulletList,
    toggleOrderedList,
    outdentListItem,
    indentListItem,
    insertHorizontalRule,
    insertCallout,
    insertToggleList,
    insertTable,
    insertImage,
    insertVideo,
    insertAudio,
    toggleLink,
    undo,
    redo,
    ...createTableCommands(),
  };
}

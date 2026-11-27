import { Plugin } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

// TODO.md item 3 -- clipboard image paste (and, since it's essentially free
// once the "insert a File as an image node" helper exists, drag-and-drop of
// an image file too -- both named in that TODO entry's own gap description,
// not just paste alone). Mirrors `commands.ts`'s `insertImage` exactly: no
// file storage/hosting layer exists in this app (see Claude.md), so a
// pasted/dropped image's bytes are inlined as a base64 `data:` URL directly
// in the `image` node's own `src`, the same as a file-picker-selected image
// already is -- same async-dispatch-from-a-FileReader-callback pattern too
// (a ProseMirror command/plugin hook has no synchronicity requirement on
// when `dispatch` actually runs).
//
// `pos`, when given, is where to insert (a real document position --
// computed from the drop's own screen coordinates via `posAtCoords`, since
// a drop can land anywhere, not necessarily where the cursor already was).
// Omitted for paste, which inserts at the CURRENT selection instead --
// `replaceSelectionWith` reads that fresh off `view.state` at the moment
// the FileReader resolves, not a stale snapshot captured when the paste
// event first fired, in case anything else happened to change the
// selection in the (normally near-instant) time it takes to read the file.
function insertImageFile(view: EditorView, file: File, pos?: number) {
  const reader = new FileReader();
  reader.onload = () => {
    const src = reader.result;
    if (typeof src !== "string") return;
    const imageType = view.state.schema.nodes.image;
    if (!imageType) return;
    const alt = file.name.replace(/\.[^./]+$/, "") || "pasted image";
    const node = imageType.create({ src, alt });
    const tr = pos === undefined ? view.state.tr.replaceSelectionWith(node) : view.state.tr.insert(pos, node);
    view.dispatch(tr.scrollIntoView());
  };
  reader.readAsDataURL(file);
}

// `DataTransfer.files` isn't reliably populated for every source a
// clipboard/drop image can come from (confirmed against common "paste an
// image" implementations elsewhere on the web) -- `.items` (a
// `DataTransferItemList`) plus `getAsFile()` is the more complete, standard
// way to find an image regardless of source.
function findImageFile(data: DataTransfer | null): File | null {
  if (!data) return null;
  for (const item of data.items) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}

export const imagePastePlugin = $prose(
  () =>
    new Plugin({
      props: {
        // Returning `true` tells ProseMirror this event is fully handled --
        // no `event.preventDefault()` needed here the way handleDrop below
        // needs it: ProseMirror already owns/suppresses the native paste
        // event for its own contenteditable before invoking this hook at
        // all. Falls through (`false`) to the existing `clipboard` plugin's
        // own markdown-aware text paste handling when there's no image to
        // find, unaffected by this plugin's presence.
        handlePaste(view, event) {
          const file = findImageFile(event.clipboardData);
          if (!file) return false;
          insertImageFile(view, file);
          return true;
        },
        // Unlike paste, a drop's own default browser behavior (navigating
        // the whole page to the dropped file) is NOT something ProseMirror
        // suppresses on this hook's behalf -- `preventDefault()` is
        // required here specifically, a well-known requirement for any
        // custom web drop handler, not optional polish.
        handleDrop(view, event) {
          const file = findImageFile(event.dataTransfer);
          if (!file) return false;
          event.preventDefault();
          const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
          insertImageFile(view, file, coords?.pos);
          return true;
        },
      },
    }),
);

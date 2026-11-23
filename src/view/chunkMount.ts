import { type Editor as MilkdownEditor, editorViewCtx, schemaCtx, serializerCtx } from "@milkdown/kit/core";
import { replaceAll } from "@milkdown/kit/utils";
import { Node as PMNode, Slice } from "@milkdown/kit/prose/model";
import { TextSelection, type Transaction } from "@milkdown/kit/prose/state";
import type { Chunk, DocCache, DocCacheEntry } from "milkdown-chunk-editor";
import { buildMilkdownEditor } from "./createMilkdownEditor";
import { createCommands, type EditorCommands } from "./commands";
import { CONTENT_REPLACE_META } from "./dirtyPlugin";

export interface MountedEditorChunk {
  /** The chunk this instance currently represents -- a live getter, not a snapshot: stays accurate across rebind() calls. */
  readonly chunkId: string;
  editor: MilkdownEditor;
  commands: EditorCommands;
  root: HTMLElement;
  /** Serializes the chunk's current content and reports it immediately -- used before destroying/rebinding a scrolled-out instance so its edits aren't lost. */
  flush: () => void;
  destroy: () => Promise<void>;
  /**
   * Re-targets this already-live instance at a different chunk by swapping
   * its document in place -- Milkdown's own `replaceAll(markdown, true)`
   * parses the new markdown and calls `view.updateState()` with a fresh
   * `EditorState` on the SAME `EditorView`, reusing the already-initialized
   * CodeMirror/Mermaid/KaTeX setup instead of tearing it
   * all down and rebuilding it via a fresh `mountEditorChunk` call. This is
   * the "ViewHolder reuse" path `VirtualizedEditorController.sync()` uses
   * whenever an outgoing chunk and an incoming chunk can be paired up
   * (the common case while scrolling) -- measured directly on a real
   * device as the dominant cost of a scroll-triggered chunk swap, since
   * `flush(true)` resetting to a brand-new `EditorState` also resets
   * plugin state (undo history included), which is what we want: there's
   * no cross-chunk undo in this design regardless of whether an instance
   * is reused or freshly created.
   */
  rebind: (chunk: Chunk, isLastChunk: boolean) => Promise<void>;
}

export interface ChunkMountOptions {
  chunk: Chunk;
  /** Whether `chunk` is the document's final chunk -- see the `data-is-last-chunk` handling below. */
  isLastChunk: boolean;
  container: HTMLElement;
  placeholder: string;
  onChange: (chunkId: string, markdown: string) => void;
  onFocus: (chunkId: string, editor: MilkdownEditor, commands: EditorCommands) => void;
  onBlur: (chunkId: string) => void;
  /** Called (debounced to animation frames, not the 400ms content-save debounce) whenever this chunk's content changes, since its rendered height may have too -- lets the controller re-measure and correct VirtualLayout's recorded height, otherwise it stays frozen at whatever it was at mount/rebind time and the next chunk's slot ends up positioned mid-content or with a dead gap before it. */
  onContentResize: (chunkId: string) => void;
  /**
   * Shared doc-JSON cache, owned by VirtualizedEditorController (outlives
   * any single chunk instance -- a chunk destroyed and later remounted
   * fresh should still benefit from a cache entry left by its earlier
   * instance). Ported from milkdown-chunk-editor's own doc-cache.ts
   * (DocCache/fingerprint are pure and exported directly from that
   * package, same as VirtualLayout/splitIntoChunks/joinChunks already are
   * -- see virtualizedEditorController.ts). Keyed by chunk id, with a
   * content fingerprint guarding each entry: a hit means "this chunk's
   * markdown hasn't changed since we last parsed it," letting both initial
   * mount and rebind() skip remark parse entirely via Node.fromJSON.
   */
  cache: DocCache;
  /**
   * Forwards this instance's own transaction stream, tagged with WHICHEVER
   * chunk it currently represents (reads `currentChunk.id` fresh each call,
   * same pattern as onFocus/onBlur below, so this stays correct across
   * rebind() retargeting). Wired straight through to
   * createMilkdownEditor.ts's `onTransaction` option -- lets DrawLayer.tsx
   * remap chunk-anchored ink strokes through each chunk's own edits, the
   * per-chunk analogue of what Editor.tsx already does for the
   * single-instance path.
   */
  onTransaction?: (chunkId: string, tr: Transaction) => void;
  /**
   * Called once this instance's content is ready to read -- after every
   * later `rebind()` (since a recycled instance's content, and therefore
   * whatever ink data lives in it, is entirely different each time).
   * DrawLayer.tsx uses this to (re)rehydrate whatever ink is already stored
   * for whichever chunk this instance now represents. Deliberately NOT
   * called from inside this function for the INITIAL mount -- see the
   * comment at that specific call site (there isn't one here) for why the
   * controller calls it itself instead, at a point where its own
   * `this.mounted` bookkeeping is guaranteed to already be in place.
   */
  onChunkReady?: (chunkId: string, editor: MilkdownEditor) => void;
}

// This app's own equivalent of milkdown-chunk-editor's mountChunk: same
// lazy-mount-on-scroll-into-view, flush-before-destroy contract, but built
// on buildMilkdownEditor (this app's full plugin stack) instead of that
// package's bare commonmark+gfm+history+listener chain, and with
// onFocus/onBlur plus rebind() added -- onFocus/onBlur because, unlike the
// package's own ChunkedEditor (which has no shared toolbar UI to drive),
// Toolbar.tsx needs to know which chunk's editor/commands to bind to as
// focus moves between chunks; rebind() because scroll-triggered swaps
// should reuse a live instance rather than destroy-and-recreate it (see
// VirtualizedEditorController).
export async function mountEditorChunk(opts: ChunkMountOptions): Promise<MountedEditorChunk> {
  const { chunk: initialChunk, isLastChunk: initialIsLastChunk, container, placeholder, onChange, onFocus, onBlur, onContentResize, cache, onTransaction, onChunkReady } = opts;
  // Mutable so rebind() can retarget which chunk this instance represents
  // without the onChange/onFocus/onBlur closures below going stale.
  let currentChunk = initialChunk;

  const root = document.createElement("div");
  root.className = "milkdown-chunk-root";
  root.dataset.chunkId = currentChunk.id;
  // Marks whichever live instance currently represents the document's final
  // chunk -- editor-base.css gives ONLY that one's .ProseMirror the same
  // large min-height the single-editor path always has, so there's tappable
  // space past the actual end of the document (click-past-end's own
  // purpose) without giving every short chunk a dead zone below it (see
  // .editor-mount-virtualized .ProseMirror's min-height: 0 below).
  root.dataset.isLastChunk = String(initialIsLastChunk);
  // Placeholder height prevents the scrollbar from collapsing the instant
  // this chunk mounts, before its real content has laid out -- released
  // (see releaseMinHeight below) once editor.create() actually resolves.
  root.style.minHeight = `${Math.round(currentChunk.estimatedHeight)}px`;
  container.appendChild(root);

  let destroyed = false;
  let debounceTimer: number | undefined;
  // Replaces the old "serialize unconditionally, then compare strings"
  // approach: ported from milkdown-chunk-editor's own dirty flag (see its
  // README's "dirty 标记" section, measured there as a 3.7x win in
  // isolation). A scrolled-away, never-edited chunk now costs zero remark
  // stringify calls at flush()/destroy() time instead of one per
  // debounce-interval or teardown -- the dominant waste the package's own
  // benchmark calls out ("用户只是滚了一下,内容根本没变").
  let dirty = false;

  // MUST be released one frame after real content exists, not left in
  // place: estimatedHeight (the crude char-count estimateHeight()
  // heuristic -- see split.ts) counts every blank source line (the normal
  // paragraph separator in markdown) as a full line-height, which the
  // renderer collapses, so it routinely OVER-estimates real content --
  // confirmed directly as a ~170px dead zone within an otherwise-correctly
  // -sized chunk, between its real (shorter) .ProseMirror content and its
  // own wrapper's bottom edge. That dead zone sits inside
  // .milkdown-chunk-root but outside .ProseMirror's own DOM box, so a tap
  // there never reaches clickPastEnd.ts's handler (attached directly to
  // view.dom) at all. Called once after editor.create() resolves (initial
  // mount) and once after each rebind()'s synchronous replaceAll (content
  // is already updated by the time this runs either way).
  //
  // Returns a promise so callers can await the release before measuring
  // this chunk's real height -- without that, the controller's own
  // post-mount/post-rebind measure() call raced this rAF (two
  // independently-scheduled rAFs with no ordering guarantee between them)
  // and could capture the height BEFORE release, locking VirtualLayout's
  // recorded height at the inflated estimate permanently (nothing else
  // ever re-measures an untouched chunk) -- confirmed directly as a real,
  // non-self-correcting bug, not a transient one.
  const releaseMinHeight = () =>
    new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        if (!destroyed) root.style.minHeight = "0";
        resolve();
      });
    });

  const flush = () => {
    if (destroyed) return;
    window.clearTimeout(debounceTimer);
    // Nothing to serialize if the doc was never actually edited since the
    // last flush/mount/rebind -- the whole point of the dirty flag.
    if (!dirty) return;
    try {
      const md = editor.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc));
      dirty = false;
      onChange(currentChunk.id, md);
    } catch {
      // View already released (destroy raced the debounce timer).
    }
  };

  // A direct ProseMirror plugin (dirtyPlugin.ts), not Milkdown's own
  // markdownUpdated listener -- see that file for why the listener's own
  // 200ms debounce + doc-equality check made the "did this chunk actually
  // change" signal too delayed/imprecise for gating flush()'s stringify.
  const handleDocChanged = () => {
    if (destroyed) return;
    dirty = true;
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(flush, 400);
    onContentResize(currentChunk.id);
  };

  // Writes this instance's current doc back into the shared cache, keyed by
  // whichever chunk it currently represents. Called after every successful
  // mount/rebind regardless of whether that mount/rebind was itself a cache
  // hit -- cheap (just a fingerprint + JSON.stringify-for-size), and keeps
  // the entry's LRU position fresh either way.
  const updateCache = () => {
    try {
      const doc = editor.ctx.get(editorViewCtx).state.doc;
      cache.set(currentChunk.id, currentChunk.markdown, doc.toJSON());
    } catch {
      // Instance mid-teardown.
    }
  };

  // Swaps the live view's document via Node.fromJSON + tr.replace instead
  // of remark-parsing markdown -- ~40x faster per milkdown-chunk-editor's
  // own benchmark. Must report failure rather than silently leaving the old
  // doc in place: a schema-incompatible cache entry (shouldn't normally
  // happen here, since every chunk shares the exact same plugin stack, but
  // worth guarding) would otherwise look like a successful swap while the
  // wrong chunk's content stays on screen -- real data corruption, not a
  // cosmetic bug. Ported directly from milkdown-chunk-editor's own
  // mount-chunk.ts replaceContent().
  const replaceFromCachedJson = (json: DocCacheEntry["json"]): boolean => {
    try {
      const view = editor.ctx.get(editorViewCtx);
      const schema = editor.ctx.get(schemaCtx);
      const newDoc = PMNode.fromJSON(schema, json as never);
      const tr = view.state.tr
        .replace(0, view.state.doc.content.size, new Slice(newDoc.content, 0, 0))
        .setMeta(CONTENT_REPLACE_META, true)
        // Replacing content isn't a user edit -- keep it out of undo, same
        // as replaceAll(markdown, true)'s own addToHistory:true-but-reset
        // contract below (no cross-chunk undo exists regardless).
        .setMeta("addToHistory", false);
      view.dispatch(tr);

      // Reset selection to the first inline position. Position 0 (the
      // doc's own top level) isn't inline content and would throw; a plain
      // position-mapped carry-over of the old selection isn't guaranteed
      // valid in the new doc either.
      const doc = view.state.doc;
      let inlinePos = 1;
      doc.descendants((node, pos) => {
        if (node.isText) {
          inlinePos = pos;
          return false;
        }
        return true;
      });
      view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, inlinePos)));
      return true;
    } catch {
      return false;
    }
  };

  const initialCached = cache.get(initialChunk.id, initialChunk.markdown);

  // Reads currentChunk.id fresh at call time (not initialChunk.id) --
  // same reasoning as onFocus/onBlur below: this same closure stays
  // correct across rebind() retargeting this instance at a different chunk.
  const handleTransaction = (tr: Transaction) => onTransaction?.(currentChunk.id, tr);

  let editor = buildMilkdownEditor({
    mount: root,
    initialMarkdown: currentChunk.markdown,
    initialDocJson: initialCached?.json,
    placeholder,
    onDocChanged: handleDocChanged,
    onTransaction: handleTransaction,
  });

  try {
    await editor.create();
  } catch (err) {
    // Cached JSON turned out to be schema-incompatible -- shouldn't
    // normally happen (every chunk shares the exact same plugin stack) but
    // not worth risking a hard failure over a cache fast path. Retry clean.
    if (!initialCached) throw err;
    editor = buildMilkdownEditor({
      mount: root,
      initialMarkdown: currentChunk.markdown,
      placeholder,
      onDocChanged: handleDocChanged,
      onTransaction: handleTransaction,
    });
    await editor.create();
  }
  await releaseMinHeight();
  updateCache();
  // NOT called here for the INITIAL mount -- unlike every other callback in
  // this file, `onChunkReady` is deliberately NOT fired from inside this
  // function for a fresh mount. `VirtualizedEditorController.sync()` itself
  // calls it instead, AFTER its own `this.mounted.set(box.id, inst)` --
  // calling it from here would fire BEFORE that bookkeeping runs (this
  // function's Promise hasn't resolved yet, which is what gates
  // `this.mounted.set()` in the controller), so `getChunkEditor(chunkId)`
  // -- DrawLayer.tsx's own lookup, backed directly by that same map --
  // would still return null at the exact moment ink rehydration tries to
  // resolve a point's on-screen position and paint it. Confirmed directly
  // as a real bug, not theoretical: ink correctly persisted and reloaded
  // into the document every time, but silently failed to ever become
  // VISIBLE after a reload until some LATER event (a scroll, a transaction)
  // triggered a second redraw once the mapping had caught up. `rebind()`
  // below has no equivalent problem -- see its own call to this same
  // callback -- since the controller's recycle step in `sync()` already
  // updates `this.mounted` synchronously BEFORE calling `rebind()` at all.

  const commands = createCommands(editor.ctx.get(schemaCtx));
  const view = editor.ctx.get(editorViewCtx);
  const handleFocusIn = () => onFocus(currentChunk.id, editor, commands);
  const handleFocusOut = () => onBlur(currentChunk.id);
  view.dom.addEventListener("focusin", handleFocusIn);
  view.dom.addEventListener("focusout", handleFocusOut);

  const destroy = async () => {
    if (destroyed) return;
    flush();
    destroyed = true;
    window.clearTimeout(debounceTimer);
    view.dom.removeEventListener("focusin", handleFocusIn);
    view.dom.removeEventListener("focusout", handleFocusOut);
    try {
      await editor.destroy();
    } catch {
      // Already destroyed.
    }
    root.remove();
  };

  const rebind = async (nextChunk: Chunk, isLastChunk: boolean) => {
    // Flush the outgoing chunk's content under ITS OWN id before switching
    // what chunk this instance represents -- otherwise its last edits
    // would be silently dropped instead of reported via onChange.
    flush();
    window.clearTimeout(debounceTimer);

    currentChunk = nextChunk;
    root.dataset.chunkId = nextChunk.id;
    root.dataset.isLastChunk = String(isLastChunk);
    root.style.minHeight = `${Math.round(nextChunk.estimatedHeight)}px`;

    const cached = cache.get(nextChunk.id, nextChunk.markdown);
    if (!cached || !replaceFromCachedJson(cached.json)) {
      // Cache miss (or a failed swap) -- fall back to a full markdown
      // parse. The actual document swap here is synchronous (replaceAll
      // dispatches immediately); only releaseMinHeight's own
      // settle-then-measure handshake below needs awaiting.
      editor.action(replaceAll(nextChunk.markdown, true));
    }
    dirty = false;

    await releaseMinHeight();
    updateCache();
    onChunkReady?.(currentChunk.id, editor);
  };

  return {
    get chunkId() {
      return currentChunk.id;
    },
    editor,
    commands,
    root,
    flush,
    destroy,
    rebind,
  };
}

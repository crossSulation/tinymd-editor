import { VirtualLayout, splitIntoChunks, joinChunks, DocCache, type ChunkStore } from "milkdown-chunk-editor";
import type { Editor as MilkdownEditor } from "@milkdown/kit/core";
import type { Transaction } from "@milkdown/kit/prose/state";
import { mountEditorChunk, type MountedEditorChunk } from "./chunkMount";
import type { EditorCommands } from "./commands";

export interface ActiveChunkEditor {
  editor: MilkdownEditor;
  commands: EditorCommands;
}

export interface VirtualizedEditorControllerOptions {
  /** Scroll container; must have a determinate height. Given `position: relative` automatically if it isn't already positioned. */
  scroller: HTMLElement;
  content: string;
  placeholder: string;
  /** Heading-level split granularity passed through to milkdown-chunk-editor's splitIntoChunks (1 = H1 only, 2 = H1/H2, default 2). */
  splitLevel?: number;
  /** Extra screens worth of chunks to keep mounted outside the viewport. */
  overscan?: number;
  /** Full joined markdown, called whenever any chunk's content changes. */
  onChange?: (markdown: string) => void;
  /** Called with the focused chunk's editor/commands, or null once focus leaves every mounted chunk -- Toolbar.tsx binds to whatever this reports. */
  onActiveChange: (active: ActiveChunkEditor | null) => void;
  /**
   * Called whenever the "current page" (the chunk nearest the top of the
   * viewport) changes, including once on initial mount. Purely a
   * navigation affordance layered on top of the existing continuous-scroll
   * virtualization -- VirtualLayout/the chunk split/the recycling
   * machinery are all unchanged; "page N" just means "chunk index N",
   * and scrollToPage() below is a thin wrapper over the already-existing
   * scrollToChunk(), which already does the real work (VirtualLayout's own
   * scrollTargetFor() + a smooth scrollTo()).
   */
  onPageChange?: (pageIndex: number, totalPages: number) => void;
  /**
   * Forwards every transaction from every mounted chunk's own instance,
   * tagged with whichever chunk it currently represents -- the chunked
   * analogue of the single-instance path's own `onTransaction`
   * (createMilkdownEditor.ts). DrawLayer.tsx uses this to remap
   * chunk-anchored ink strokes through each chunk's own edits.
   */
  onChunkTransaction?: (chunkId: string, tr: Transaction) => void;
  /**
   * Called whenever a chunk instance's content becomes ready to read --
   * after its initial mount AND after every later recycle/rebind (a
   * recycled instance holds entirely different content each time).
   * DrawLayer.tsx uses this to (re)rehydrate whatever ink is already stored
   * for whichever chunk this instance now represents.
   */
  onChunkReady?: (chunkId: string, editor: MilkdownEditor) => void;
}

// Orchestration ported from milkdown-chunk-editor's own ChunkedEditor class
// (split + virtual layout + per-chunk instance lifecycle: see that
// package's chunked-editor.ts, kept as the reference this was adapted
// from) -- reusing its splitIntoChunks/joinChunks/VirtualLayout utilities
// directly since those are pure and DOM-free, but mounting chunks through
// mountEditorChunk (this app's full plugin stack) instead of the package's
// own bare mountChunk, and adding activeChunkId tracking: the package has
// no notion of a single "active" editor since it wasn't built around one
// shared toolbar the way this app's Toolbar.tsx is.
export class VirtualizedEditorController {
  private store: ChunkStore;
  private layout = new VirtualLayout();
  // Shared across every chunk instance this controller mounts over its
  // lifetime (not per-instance -- a chunk destroyed and later remounted
  // fresh should still benefit from an entry left by its earlier instance).
  // Ported directly from milkdown-chunk-editor's own doc-cache.ts, same as
  // VirtualLayout/splitIntoChunks/joinChunks above -- pure, DOM-free, and
  // exported straight from the package. See chunkMount.ts for how a hit
  // skips remark parse via Node.fromJSON on mount/rebind.
  private cache = new DocCache();
  private mounted = new Map<string, MountedEditorChunk>();
  private slots = new Map<string, HTMLElement>();
  private spacer: HTMLElement;
  private ro?: ResizeObserver;
  private frame = 0;
  private disposed = false;
  private activeChunkId: string | null = null;
  /** One pending remeasure frame per chunk (see handleChunkResize) -- coalesces fast typing into a single rAF instead of scheduling a new one per keystroke. */
  private resizeFrames = new Map<string, number>();
  private lastReportedPageIndex: number | null = null;

  private readonly scroller: HTMLElement;
  private readonly placeholder: string;
  private readonly overscan: number;
  private readonly onChange?: (markdown: string) => void;
  private readonly onActiveChange: (active: ActiveChunkEditor | null) => void;
  private readonly onPageChange?: (pageIndex: number, totalPages: number) => void;
  private readonly onChunkTransaction?: (chunkId: string, tr: Transaction) => void;
  private readonly onChunkReady?: (chunkId: string, editor: MilkdownEditor) => void;

  constructor(opts: VirtualizedEditorControllerOptions) {
    this.scroller = opts.scroller;
    this.placeholder = opts.placeholder;
    this.onChunkTransaction = opts.onChunkTransaction;
    this.onChunkReady = opts.onChunkReady;
    this.overscan = opts.overscan ?? 1;
    this.onChange = opts.onChange;
    this.onActiveChange = opts.onActiveChange;
    this.onPageChange = opts.onPageChange;

    this.store = splitIntoChunks(opts.content, opts.splitLevel ?? 2);
    this.layout.setItems(this.store.chunks.map((c) => ({ id: c.id, height: c.estimatedHeight })));

    // Static for the life of this controller -- the chunk count never
    // changes after splitIntoChunks() runs (only chunk.markdown content
    // does), so this only needs setting once. editor-base.css keys its
    // per-chunk viewport-height min-height rule off this, scoped to only
    // when there's actually more than one page to page through.
    this.scroller.dataset.hasMultiplePages = String(this.store.chunks.length > 1);

    this.spacer = document.createElement("div");
    this.spacer.className = "chunked-spacer";
    this.spacer.style.position = "absolute";
    this.spacer.style.left = "0";
    this.spacer.style.right = "0";
    this.spacer.style.top = "0";
    this.spacer.style.height = "0px";
    this.spacer.style.pointerEvents = "none";
    this.scroller.appendChild(this.spacer);

    if (getComputedStyle(this.scroller).position === "static") {
      this.scroller.style.position = "relative";
    }
  }

  async mount() {
    if (this.disposed) return;
    this.updateViewportHeightVar();
    this.spacer.style.height = `${this.layout.getTotalHeight()}px`;
    this.ro = new ResizeObserver(() => this.handleResize());
    this.ro.observe(this.scroller);
    this.scroller.addEventListener("scroll", this.onScroll, { passive: true });
    await this.sync();
  }

  /**
   * Keeps `--chunk-viewport-height` (editor-base.css's per-chunk min-height,
   * active only when `data-has-multiple-pages="true"` -- see the
   * constructor) in sync with the scroller's own available height, then
   * re-measures every CURRENTLY MOUNTED chunk. The re-measure matters:
   * changing this CSS var changes every mounted chunk's real rendered
   * height simultaneously (keyboard open/close, window resize), but
   * nothing else re-triggers measure() for an already-mounted, untouched
   * chunk -- without this, VirtualLayout's recorded positions would go
   * just as stale as the bug fixed earlier for unmeasured estimate-vs-real
   * mismatches, just triggered by resize instead of by a missed release.
   */
  private handleResize() {
    this.updateViewportHeightVar();
    for (const id of this.mounted.keys()) {
      const slot = this.slots.get(id);
      if (slot) this.measure(id, slot);
    }
    void this.sync();
  }

  private updateViewportHeightVar() {
    this.scroller.style.setProperty("--chunk-viewport-height", `${this.scroller.clientHeight}px`);
  }

  private onScroll = () => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      void this.sync();
    });
  };

  /** Core sync: compute the visible range -> mount/unmount instances. */
  private async sync() {
    if (this.disposed) return;

    const scrollTop = this.scroller.scrollTop;
    const viewportHeight = this.scroller.clientHeight;
    const { items } = this.layout.getRange(scrollTop, viewportHeight, this.overscan);
    if (items.length === 0) return;

    // "Current page" = the last chunk whose top has been reached, i.e. the
    // chunk nearest the top of the viewport -- found by scanning `items`
    // (already overscan-padded, so this excludes the overscan-only entries
    // above the real viewport) for the LAST one whose own top is at or
    // before the current scroll position. The `+ 2` tolerance matters:
    // scrollToPage()/scrollToChunk() target `box.top - 1` (VirtualLayout's
    // own EPS, see scrollTargetFor), so after scrolling TO a chunk,
    // scrollTop sits ~1px short of that chunk's own top -- plus up to
    // ~1px more from `scrollTop` itself being reported as a rounded
    // integer while `box.top` can be sub-pixel, confirmed directly (a
    // 217.21875px-tall chunk-0 left scrollTop at 216, a 1.21875px gap --
    // enough to exceed a bare `+1`). Without this tolerance, the chunk you
    // just navigated to wouldn't be recognized as "current" until extra
    // scroll happened to occur, which is why Next/Prev looked stuck.
    // Independent of the mount/unmount bookkeeping below; just a
    // navigation affordance on top of it.
    //
    // Exception: once scrolled to (or within a pixel of) the absolute
    // bottom, report the document's actual LAST chunk outright, even if
    // its own top hasn't technically been "reached" by this definition --
    // a short final chunk's top can sit past the max reachable scrollTop
    // entirely (maxScrollTop = totalHeight - viewportHeight, which is LESS
    // than the last chunk's own top whenever that chunk is shorter than
    // the viewport), which would otherwise leave the indicator stuck one
    // page short of the end even though there's nowhere further to scroll.
    const maxScrollTop = this.scroller.scrollHeight - this.scroller.clientHeight;
    const atBottom = maxScrollTop <= 0 || scrollTop >= maxScrollTop - 2;
    let currentChunk = atBottom ? this.store.chunks[this.store.chunks.length - 1] : undefined;
    if (!currentChunk) {
      let currentBox = items[0];
      for (const box of items) {
        if (box.top > scrollTop + 2) break;
        currentBox = box;
      }
      currentChunk = currentBox ? this.store.byId.get(currentBox.id) : undefined;
    }
    if (currentChunk && currentChunk.index !== this.lastReportedPageIndex) {
      this.lastReportedPageIndex = currentChunk.index;
      this.onPageChange?.(currentChunk.index, this.store.chunks.length);
    }

    const visibleIds = new Set(items.map((i) => i.id));
    const leaving = [...this.mounted].filter(([id]) => !visibleIds.has(id));
    // Checked against `this.slots`, not `this.mounted` -- sync() isn't
    // guarded against running concurrently with itself (nothing stops a
    // new scroll-triggered call from starting while a previous one is
    // still awaiting an in-flight mountEditorChunk()), and `this.slots`
    // gets its entry set SYNCHRONOUSLY, before that await, while
    // `this.mounted` only gets its entry after the await resolves. Filtering
    // on `this.mounted` left a window where a second, overlapping sync()
    // call would see "chunk-0 isn't mounted yet" and create a SECOND slot
    // for the same chunk -- confirmed directly as the cause of duplicate
    // chunk slots appearing when scrolling back onto an already-mounting
    // chunk.
    const needed = items.filter((box) => !this.slots.has(box.id) && this.store.byId.has(box.id));

    // 1. Recycle: pair up outgoing instances with incoming slots and swap
    // each one's document in place via inst.rebind() (Milkdown's own
    // replaceAll(markdown, true) -- see chunkMount.ts) instead of
    // destroying and recreating. This reuses the already-initialized
    // Milkdown/ProseMirror/CodeMirror/Mermaid/KaTeX stack -- the
    // "ViewHolder" pattern a recycler view uses, applied here because
    // measured directly on a real device, that stack's construction (not
    // the markdown parsing itself) was the dominant cost of every
    // scroll-triggered chunk swap, dwarfing anything parallelizing
    // create/destroy alone could fix.
    const recycleCount = Math.min(leaving.length, needed.length);
    const toRecycleFrom = leaving.slice(0, recycleCount);
    const toRecycleInto = needed.slice(0, recycleCount);
    const toDestroy = leaving.slice(recycleCount);
    const toCreate = needed.slice(recycleCount);

    const recyclePromises: Promise<void>[] = [];
    for (let i = 0; i < recycleCount; i++) {
      const [oldId, inst] = toRecycleFrom[i]!;
      const box = toRecycleInto[i]!;
      const chunk = this.store.byId.get(box.id);
      if (!chunk) continue;

      this.mounted.delete(oldId);
      if (this.activeChunkId === oldId) {
        this.activeChunkId = null;
        this.onActiveChange(null);
      }

      const slot = this.slots.get(oldId);
      if (!slot) continue;
      this.slots.delete(oldId);
      slot.dataset.slotFor = box.id;
      slot.style.top = `${box.top}px`;
      slot.style.containIntrinsicSize = `${Math.round(box.height)}px`;
      this.slots.set(box.id, slot);
      this.mounted.set(box.id, inst);

      // rebind() itself (the actual document swap) is synchronous -- only
      // its returned promise (settling the minHeight placeholder) needs
      // awaiting, and only so the measure() call below reads this chunk's
      // TRUE post-release height. Measuring before that settles previously
      // locked VirtualLayout's recorded height at the inflated estimate
      // permanently, since nothing else re-measures an untouched chunk
      // (confirmed directly, not a transient race).
      recyclePromises.push(
        inst.rebind(chunk, this.isLastChunk(chunk)).then(() => this.measure(box.id, slot)),
      );
    }

    // 2. Unmount whatever's left over (pool shrinking -- fewer chunks
    // visible now than before, e.g. a smaller overscan or the document's
    // end) and mount whatever's left over (pool growing -- e.g. the very
    // first sync(), where there's nothing yet to recycle from). Both run
    // concurrently via one combined Promise.all, same reasoning as the
    // recycle step above: destroy's own teardown work doesn't yield
    // promptly enough for "void"-calling it in a loop to actually overlap.
    const unmountPromises = toDestroy.map(([id, inst]) => {
      this.mounted.delete(id);
      this.slots.get(id)?.remove();
      this.slots.delete(id);
      if (this.activeChunkId === id) {
        this.activeChunkId = null;
        this.onActiveChange(null);
      }
      return inst.destroy();
    });

    const mountPromises = toCreate.map(async (box) => {
      const chunk = this.store.byId.get(box.id);
      if (!chunk) return;

      const slot = document.createElement("div");
      slot.className = "chunk-slot";
      slot.dataset.slotFor = box.id;
      slot.style.position = "absolute";
      slot.style.left = "0";
      slot.style.right = "0";
      slot.style.top = `${box.top}px`;
      // Mounted-but-offscreen chunks skip paint/layout; the browser restores
      // them automatically as the scroll position approaches. `auto` rather
      // than `hidden` so find-in-page and the accessibility tree still work.
      slot.style.contentVisibility = "auto";
      slot.style.containIntrinsicSize = `${Math.round(box.height)}px`;
      this.scroller.appendChild(slot);
      this.slots.set(box.id, slot);

      const inst = await mountEditorChunk({
        chunk,
        isLastChunk: this.isLastChunk(chunk),
        container: slot,
        placeholder: this.placeholder,
        onChange: this.handleChunkChange,
        onContentResize: this.handleChunkResize,
        onFocus: this.handleChunkFocus,
        onBlur: this.handleChunkBlur,
        cache: this.cache,
        onTransaction: this.onChunkTransaction,
        onChunkReady: this.onChunkReady,
      });

      // The user may have scrolled away during the await -- reclaim this
      // chunk immediately. Other chunks in this batch mount independently
      // (each is its own Promise.all entry), unaffected by this one.
      if (this.disposed || !this.store.byId.has(box.id) || !visibleIds.has(box.id)) {
        void inst.destroy();
        slot.remove();
        this.slots.delete(box.id);
        return;
      }
      this.mounted.set(box.id, inst);
      // Fired here, not from inside mountEditorChunk() itself, specifically
      // so getChunkEditor(box.id) (backed directly by this.mounted) already
      // resolves by the time DrawLayer.tsx's own ink-rehydration handler
      // runs -- see chunkMount.ts's own comment on why calling it any
      // earlier (before this line) was a real, confirmed bug.
      this.onChunkReady?.(box.id, inst.editor);

      // No extra requestAnimationFrame hop needed here: mountEditorChunk()
      // already awaits its own minHeight-release handshake internally
      // before resolving (see chunkMount.ts), so this chunk's real height
      // is already settled by the time this line runs.
      this.measure(box.id, slot);
    });

    await Promise.all([...unmountPromises, ...mountPromises, ...recyclePromises]);

    // 3. Reposition after any height corrections.
    this.reposition();
  }

  /** Backfills the measured height (in either direction) and compensates scroll position to avoid a visible jump. */
  private measure(chunkId: string, slot: HTMLElement) {
    // content-visibility: auto's own "is this relevant" determination
    // (browser-internal, not synchronized with any single rAF or a
    // getBoundingClientRect()-forced reflow) can still be in its "skipped"
    // state at this point, even right after mount/rebind -- while skipped,
    // getBoundingClientRect() returns the containIntrinsicSize placeholder
    // (the same crude char-count estimate as root's own minHeight, see
    // chunkMount.ts) instead of the real rendered height. Confirmed
    // directly: measuring without this forced-visible bracket read back
    // the stale estimate 100% of the time on initial mount, permanently
    // mis-positioning every later sibling. Force "visible" to get a real
    // layout read, then restore "auto" immediately after.
    const prevVisibility = slot.style.contentVisibility;
    slot.style.contentVisibility = "visible";
    const h = slot.getBoundingClientRect().height;
    slot.style.contentVisibility = prevVisibility;
    if (h <= 0) return;

    const before = this.layout.getBox(chunkId);
    if (!before) return;

    // Correct in both directions, not just "shorter than estimated" --
    // `estimateHeight()` is a crude char-count heuristic (see split.ts) and
    // routinely underestimates real content (headings, code blocks,
    // images, tables all render taller than their source text would
    // suggest), especially right after rebind() swaps in a different
    // chunk's content under an old box's size. Leaving an under-measured
    // chunk's recorded height too small left the NEXT chunk's slot
    // positioned (via `top`) starting partway through this chunk's actual
    // rendered content -- an unreachable, un-editable gap between where
    // this chunk visually ends and where the next slot begins, confirmed
    // directly as a real bug, not just a cosmetic one. The
    // containIntrinsicSize set on the slot itself is only ever a
    // content-visibility:auto placeholder for the "not currently relevant"
    // state (see sync()) -- it's this per-chunk layout bookkeeping, not
    // that attribute, that actually determines sibling positions.
    if (h === before.height) return;

    const scrollTop = this.scroller.scrollTop;
    const isAboveViewport = before.top + before.height <= scrollTop;
    const delta = h - before.height;

    if (!this.layout.updateHeight(chunkId, h)) return;

    this.spacer.style.height = `${this.layout.getTotalHeight()}px`;
    this.reposition();

    if (isAboveViewport) {
      this.scroller.scrollTop = Math.max(0, scrollTop + delta);
    }
  }

  /** Whether `chunk` is the document's final chunk -- see chunkMount.ts's `data-is-last-chunk` handling and editor-base.css's matching min-height rule. */
  private isLastChunk(chunk: { index: number }): boolean {
    return chunk.index === this.store.chunks.length - 1;
  }

  /**
   * Re-measures a chunk's height after its content changes (not just at
   * mount/rebind time, which is all sync() itself schedules a measure()
   * for). Without this, editing a chunk you're not currently
   * scrolling past -- typing more text, adding/removing a code block,
   * deleting lines -- changes its real rendered height while
   * VirtualLayout's recorded height for it stays frozen at whatever it
   * was last measured as, so the next chunk's slot ends up positioned
   * either overlapping this chunk's now-taller content or leaving a real,
   * un-tappable dead gap before it if this chunk got shorter.
   */
  private handleChunkResize = (chunkId: string) => {
    const existing = this.resizeFrames.get(chunkId);
    if (existing) cancelAnimationFrame(existing);
    const frame = requestAnimationFrame(() => {
      this.resizeFrames.delete(chunkId);
      const slot = this.slots.get(chunkId);
      if (slot) this.measure(chunkId, slot);
    });
    this.resizeFrames.set(chunkId, frame);
  };

  /**
   * Not just an internal event handler -- also a public entry point DrawLayer.tsx
   * (via Editor.tsx) calls directly after persisting ink into a chunk's own
   * document. That write happens outside this class entirely (DrawLayer
   * dispatches straight into the chunk's own live view via `writeInkData`,
   * obtained through `getChunkEditor`), with `addToHistory: false` --
   * `chunkMount.ts`'s own dirty-tracking plugin explicitly excludes such
   * transactions (the whole reason the single-instance path needed its own
   * `onInkPersisted` bypass), so an ink-only change would otherwise never
   * reach this method at all through the normal onChange wiring. Reusing
   * this exact method (re-serialize, then report) is correct, not just
   * convenient: an ink-only change IS a chunk content change as far as
   * persistence is concerned, the identical case this method already
   * handles for text edits.
   */
  handleChunkChange = (chunkId: string, markdown: string) => {
    const chunk = this.store.byId.get(chunkId);
    if (!chunk || chunk.markdown === markdown) return;
    chunk.markdown = markdown;
    // Not strictly required for correctness -- DocCache.get() already
    // guards each entry behind a content fingerprint, so a stale entry left
    // here would simply miss on its own next lookup -- but dropping it
    // immediately avoids holding onto a JSON blob for content that's now
    // known-stale, matching milkdown-chunk-editor's own handleChunkChange.
    this.cache.delete(chunkId);
    this.onChange?.(joinChunks(this.store.chunks));
  };

  private handleChunkFocus = (chunkId: string, editor: MilkdownEditor, commands: EditorCommands) => {
    this.activeChunkId = chunkId;
    this.onActiveChange({ editor, commands });
  };

  // Deliberately a no-op: the active chunk is "sticky" across blur, exactly
  // like the single-editor path's own editor/commands (set once, never
  // nulled by focus changes). Toolbar.tsx's own group-panel buttons call
  // `view.dom.blur()` on purpose (see openGroup()) to dismiss the keyboard
  // while keeping the toolbar/panel visible -- if blur cleared the active
  // chunk here, that would null Editor.tsx's editor/commands state, which
  // unmounts <Toolbar> entirely (its render guard is
  // `editor && commands && <Toolbar .../>`), wiping out the
  // activeGroupKey state it was in the middle of setting. Confirmed
  // directly as why tapping "+" right after focusing a chunk never opened
  // the Insert panel. Clearing the active chunk is only ever needed when
  // its instance stops representing that chunk at all -- already handled
  // separately, at the moment of unmount/recycle in sync() -- so there's
  // nothing left for a blur handler to do.
  private handleChunkBlur = (_chunkId: string) => {};

  private reposition() {
    for (const [id, slot] of this.slots) {
      const box = this.layout.getBox(id);
      if (box) slot.style.top = `${box.top}px`;
    }
  }

  /**
   * The live editor for a given chunk id, or null if that chunk isn't
   * currently mounted. Backed directly by `this.mounted`, the same map
   * `sync()` itself keeps correct across mount/unmount/recycle -- a stroke
   * anchored to a chunk that's since scrolled away (or been recycled into
   * representing a different chunk) naturally resolves to null here with
   * no extra bookkeeping, since `sync()`'s own recycle step already
   * deletes the old chunk id's entry before reassigning the instance to
   * its new one.
   */
  getChunkEditor(chunkId: string): MilkdownEditor | null {
    return this.mounted.get(chunkId)?.editor ?? null;
  }

  scrollToChunk(chunkId: string, align: "start" | "center" = "start") {
    const target = this.layout.scrollTargetFor(chunkId, this.scroller.clientHeight, align);
    if (target === null) return;
    this.scroller.scrollTo({ top: target, behavior: "smooth" });
  }

  /** Page-navigation convenience over scrollToChunk() -- "page N" is just "chunk index N"; clamps to the valid range so Prev/Next buttons don't need their own bounds-checking. */
  scrollToPage(pageIndex: number, align: "start" | "center" = "start") {
    const clamped = Math.max(0, Math.min(pageIndex, this.store.chunks.length - 1));
    const chunk = this.store.chunks[clamped];
    if (chunk) this.scrollToChunk(chunk.id, align);
  }

  getTotalPages(): number {
    return this.store.chunks.length;
  }

  getMarkdown(): string {
    for (const inst of this.mounted.values()) inst.flush();
    return joinChunks(this.store.chunks);
  }

  destroy() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    for (const frame of this.resizeFrames.values()) cancelAnimationFrame(frame);
    this.resizeFrames.clear();
    this.ro?.disconnect();
    this.scroller.removeEventListener("scroll", this.onScroll);
    for (const inst of this.mounted.values()) void inst.destroy();
    this.mounted.clear();
    this.slots.clear();
    this.spacer.remove();
  }
}

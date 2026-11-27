import { Editor as MilkdownEditor, rootCtx, defaultValueCtx, prosePluginsCtx, editorViewOptionsCtx } from "@milkdown/kit/core";
import type { Transaction } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { history } from "@milkdown/kit/plugin/history";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { cursor } from "@milkdown/kit/plugin/cursor";
import { codeBlockComponent, codeBlockConfig } from "@milkdown/kit/component/code-block";
import { listItemBlockComponent } from "@milkdown/kit/component/list-item-block";
import type { DocCacheEntry } from "milkdown-chunk-editor";
import { languages } from "@codemirror/language-data";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { keymap, EditorView as CodeMirrorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { mermaidLanguage, renderMermaidPreview } from "./mermaidPreview";
import { renderLatexPreview } from "./latexPreview";
import { createPlaceholderPlugin } from "./placeholder";
import { createClickPastEndPlugin } from "./clickPastEnd";
import { createCodeBlockExitKeymap } from "./codeBlockExitKeymap";
import { createCodeBlockLongPressPlugin } from "./codeBlockLongPress";
import { codeWrapCompartment, wrapExtension } from "./codeBlockWrap";
import { textColorMarkSchema, textColorRemark } from "./textColor";
import { videoNodeSchema, videoNodeView, audioNodeSchema, audioNodeView, mediaEmbedRemark } from "./mediaEmbed";
import { underlineMarkSchema, underlineRemark } from "./underline";
import { inkNodeSchema, inkRemark } from "./inkPersistence";
import { createDirtyPlugin } from "./dirtyPlugin";
import { createTableCosmeticsPlugin } from "./tableCosmetics";
import { calloutNodeSchema, calloutRemark } from "./callout";
import { toggleListNodeSchema, toggleListNodeView, toggleSummaryNodeSchema, toggleBodyNodeSchema, toggleListRemark } from "./toggleList";
import { searchPlugin } from "./searchPlugin";
import { imagePastePlugin } from "./imagePaste";

export interface BuildMilkdownEditorOptions {
  mount: HTMLElement;
  initialMarkdown: string;
  /**
   * A pre-parsed ProseMirror doc JSON (a DocCache hit -- see chunkMount.ts),
   * typed via DocCache's own entry shape rather than pulling in
   * `@milkdown/transformer` as a separate direct dependency just for
   * `JSONRecord`. When given, Milkdown loads it via `Node.fromJSON`
   * (`defaultValueCtx`'s `{type: 'json'}` variant) instead of remark-parsing
   * `initialMarkdown` -- ~40x faster per milkdown-chunk-editor's own
   * benchmark. `initialMarkdown` is still required even then, since it's
   * what a schema-incompatibility fallback would parse instead.
   */
  initialDocJson?: DocCacheEntry["json"];
  placeholder: string;
  onMarkdownUpdated?: (markdown: string) => void;
  onSelectionUpdated?: () => void;
  /**
   * Fires synchronously whenever a real (non-internal) edit changes the doc
   * -- see dirtyPlugin.ts for why this is a direct ProseMirror plugin
   * rather than the `listener` plugin's own (debounced, delayed)
   * `markdownUpdated` callback.
   */
  onDocChanged?: () => void;
  /**
   * Fires synchronously after every doc-changing transaction has already
   * been applied to the view (DOM included) -- i.e. after
   * `view.updateState()`, not during `state.apply()`. Wired via a
   * `dispatchTransaction` override on `editorViewOptionsCtx` rather than a
   * `Plugin`'s own `state.apply()` hook (the mechanism `dirtyPlugin.ts`
   * uses) specifically because consumers of this (DrawLayer's
   * position-anchoring) need `view.coordsAtPos()` to reflect the ALREADY-
   * updated DOM -- calling it from inside `state.apply()` (before
   * `view.updateState()` has run) would read stale, pre-edit layout.
   * Milkdown's own core sets no `dispatchTransaction` of its own (confirmed
   * directly against its source) and keeps `editorStateCtx` in sync via a
   * separate internal Plugin's `state.apply()`, unaffected by this
   * override as long as it still performs the equivalent
   * `view.updateState(view.state.apply(tr))` sequence, which it does.
   */
  onTransaction?: (tr: Transaction) => void;
}

// The one plugin stack every Milkdown instance in this app is built from --
// factored out of Editor.tsx so a chunk's own instance (see chunkMount.ts,
// used once a document is large enough to trigger VirtualizedEditorBody)
// gets the exact same Mermaid/LaTeX preview, placeholder, and code-block/
// table tap-past-end + exit-on-Enter behavior as the normal single-editor
// path, rather than silently losing them.
// Returns the built-but-not-yet-`.create()`'d editor (same as Editor.tsx's
// previous inline construction) so callers keep full control over when
// `.create()`/`.destroy()` run -- matters for React effect cleanup timing.
export function buildMilkdownEditor(opts: BuildMilkdownEditorOptions): MilkdownEditor {
  const { mount, initialMarkdown, initialDocJson, placeholder, onMarkdownUpdated, onSelectionUpdated, onDocChanged, onTransaction } = opts;

  return MilkdownEditor.make()
    .config((ctx) => {
      ctx.set(rootCtx, mount);
      ctx.set(defaultValueCtx, initialDocJson ? { type: "json", value: initialDocJson } : initialMarkdown);

      const listenerManager = ctx.get(listenerCtx);
      if (onMarkdownUpdated) listenerManager.markdownUpdated((_ctx, markdown) => onMarkdownUpdated(markdown));
      if (onSelectionUpdated) listenerManager.selectionUpdated(() => onSelectionUpdated());

      if (onDocChanged) {
        ctx.update(prosePluginsCtx, (prev) => [...prev, createDirtyPlugin(onDocChanged)]);
      }

      if (onTransaction) {
        ctx.update(editorViewOptionsCtx, (prev) => ({
          ...prev,
          // Not an arrow function -- ProseMirror calls this as
          // `dispatchTransaction.call(view, tr)` (verified directly against
          // prosemirror-view's own EditorView.prototype.dispatch source),
          // so `this` must bind dynamically to the view.
          dispatchTransaction(this: EditorView, tr: Transaction) {
            this.updateState(this.state.apply(tr));
            if (tr.docChanged) onTransaction(tr);
          },
        }));
      }

      ctx.update(codeBlockConfig.key, (prev) => ({
        ...prev,
        languages: [...languages, mermaidLanguage],
        // CodeMirrorView.editable.of(false), not a Compartment -- unlike
        // Wrap (a real, user-toggleable setting), this is permanent: ALL
        // code/LaTeX/Mermaid editing now happens exclusively in a dedicated
        // modal (CodeBlockEditorModal.tsx/MermaidEditorModal.tsx), requested
        // directly, so the inline instance every code block still mounts
        // (via @milkdown/components' own codeBlockComponent, unchanged --
        // there's still no slot/config hook to swap in a different NodeView
        // entirely, same limitation codeBlockWrap.ts's own comment already
        // documents) is downgraded to a read-only PREVIEW: still selectable/
        // copyable (CodeMirror's `editable: false` only blocks edits, not
        // selection) and still syntax-highlighted via whichever real
        // CodeMirror grammar the block's language resolves to, just never
        // directly typeable. codeBlockLongPress.ts's existing blur-after-
        // NodeSelection-dispatch fix (originally found via Mermaid) already
        // applies unconditionally to every code_block regardless of
        // language, so selecting any of them to reach "Edit" continues to
        // work the same way without any further change there.
        extensions: [
          keymap.of(defaultKeymap.concat(indentWithTab)),
          basicSetup,
          createCodeBlockExitKeymap(ctx),
          codeWrapCompartment.of(wrapExtension(false)),
          CodeMirrorView.editable.of(false),
        ],
        renderPreview: (language, content, applyPreview) => {
          const mermaid = renderMermaidPreview(language, content, applyPreview);
          return mermaid !== null ? mermaid : renderLatexPreview(language, content);
        },
        // Requested directly: Mermaid/LaTeX blocks should show ONLY their
        // rendered preview inline, never the raw source alongside it, and
        // the component's own built-in "Hide"/"Edit" source toggle button
        // should be gone entirely -- consistent with the read-only change
        // above, since there's nothing left to edit inline either way.
        // `previewOnlyByDefault` (confirmed directly against the
        // component's own source, @milkdown/components/lib/code-block) is
        // read ONCE into a Vue ref at mount (`previewOnlyMode`); the toggle
        // button only renders at all when `preview.value` is truthy, i.e.
        // only for languages with an actual preview (Mermaid/LaTeX) -- a
        // plain code block never has one, so this changes nothing for it.
        // The button itself can't be omitted from here (no slot/config hook
        // for that, same limitation documented throughout this file/
        // codeBlockWrap.ts) -- see code-block-layout.css's own
        // `:has(.codemirror-host.hidden) .tools` rule for how it's hidden.
        previewOnlyByDefault: true,
      }));
    })
    .use(commonmark)
    .use(gfm)
    .use(listener)
    .use(history)
    .use(clipboard)
    .use(cursor)
    .use(codeBlockComponent)
    // Real, tap-to-toggle checkboxes for GFM task-list items (TODO.md item
    // 5) -- `.use(gfm)` above already registers the task-list_item schema
    // extension/input rule (`extendListItemSchemaForTask`/
    // `wrapInTaskListInputRule`, confirmed directly against
    // @milkdown/preset-gfm's own source), but renders a task item as a
    // plain `<li data-item-type="task" data-checked="...">` with no actual
    // checkbox element or click handling -- same "zero CSS/interaction
    // shipped" gap `codeBlockComponent` already had before this app wrote
    // its own chrome for it. `listItemBlockComponent` is `@milkdown/kit`'s
    // own ready-made NodeView for list_item (bullet/ordered/task alike,
    // confirmed directly against its source): it renders a real clickable
    // label element whose `onPointerdown` (not `:hover`) calls
    // `setAttr("checked", !checked)`, dispatching a real transaction --
    // exactly the "no keyboard-only affordance" touch handling this app's
    // own design rule requires, and not something worth re-implementing by
    // hand against a `::before` CSS pseudo-element (confirmed elsewhere in
    // this codebase, inkPersistence.ts's own history, that a pseudo-element
    // has no DOM identity for event targeting). Registering this replaces
    // EVERY list item's rendering (not just task items) with this
    // component's own label glyph (bullet/ordered/checkbox) in place of the
    // browser's native `<li>` marker -- see list-item-block.css for the
    // from-scratch styling this needs, same "ships zero CSS" precedent as
    // codeBlockComponent above.
    .use(listItemBlockComponent)
    .use(textColorMarkSchema)
    .use(textColorRemark)
    .use(underlineMarkSchema)
    .use(underlineRemark)
    .use(videoNodeSchema)
    .use(videoNodeView)
    .use(audioNodeSchema)
    .use(audioNodeView)
    .use(mediaEmbedRemark)
    .use(inkNodeSchema)
    .use(inkRemark)
    .use(calloutNodeSchema)
    .use(calloutRemark)
    .use(toggleListNodeSchema)
    .use(toggleListNodeView)
    .use(toggleSummaryNodeSchema)
    .use(toggleBodyNodeSchema)
    .use(toggleListRemark)
    .use(createPlaceholderPlugin(placeholder))
    .use(createClickPastEndPlugin())
    .use(createCodeBlockLongPressPlugin())
    .use(createTableCosmeticsPlugin())
    .use(searchPlugin)
    .use(imagePastePlugin);
}

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Editor as MilkdownEditor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import type { Command } from "prosemirror-state";
import { SearchQuery, setSearchState, getMatchHighlights, findNext, findPrev, replaceNext, replaceAll } from "prosemirror-search";

export interface SearchBarProps {
  editor: MilkdownEditor;
  onClose: () => void;
}

// TODO.md item 1 -- find/replace in the currently-open document. Bound to
// whichever editor Editor.tsx is already resolving for the Toolbar/SlashMenu
// (the single instance, or the virtualized path's currently-focused chunk):
// a document over CHUNK_SIZE_THRESHOLD is searched one chunk at a time, same
// known, accepted limitation as cross-chunk undo/selection already
// documented elsewhere (no single shared position space exists to search
// across). Matching/replace logic itself is entirely `prosemirror-search`'s
// own (see searchPlugin.ts) -- this component is just a thin controller
// over its query/command API plus a match counter read back from its own
// decorations, not a reimplementation of any of that.
export function SearchBar({ editor, onClose }: SearchBarProps) {
  const view = editor.ctx.get(editorViewCtx);
  const [queryText, setQueryText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Forces this component to re-render right after IT dispatches a
  // transaction, independent of Editor.tsx's own listener-driven `bumpTick`
  // (which only fires from the `listener` plugin's own markdownUpdated/
  // selectionUpdated callbacks -- markdownUpdated specifically carries a
  // 200ms internal debounce, confirmed elsewhere in this app, e.g.
  // dirtyPlugin.ts's own doc comment -- and doesn't fire at all for a
  // search-query-only transaction, since neither the doc nor the selection
  // actually changed). Without this, the match counter below would lag a
  // query update by up to 200ms, or never update at all for one.
  const [, forceRender] = useState(0);

  // Find-as-you-type: re-dispatch a fresh query (SearchQuery is immutable --
  // a new instance is the only way `prosemirror-search` itself supports
  // changing what's searched/replaced for) whenever either input changes.
  // This only ever touches the plugin's own state field via `setSearchState`'s
  // transaction meta -- never adds to undo history on its own (confirmed
  // directly against the plugin's `apply()`: it reads the meta and returns
  // early, not a doc-changing transaction at all).
  useEffect(() => {
    const query = new SearchQuery({ search: queryText, replace: replaceText });
    view.dispatch(setSearchState(view.state.tr, query));
    forceRender((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryText, replaceText]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Deliberately does NOT call `view.focus()` afterward (unlike
  // floatingToolbar.tsx's own `run()`, which this was first modeled on) --
  // that would move DOM focus from this bar's own input into the
  // ProseMirror view, which (a) pops the MAIN editor's on-screen keyboard
  // up in place of whichever input the user was just typing into, and (b)
  // breaks "type a query, keep pressing Enter/Next" by stealing focus away
  // after the very first match. The dispatched transaction still moves and
  // highlights the active match in the document regardless of which
  // element has DOM focus.
  function run(command: Command) {
    command(view.state, view.dispatch);
    forceRender((n) => n + 1);
  }

  // Buttons normally take DOM focus on click, same default FloatingToolbar's
  // own buttons already work around (`onMouseDown` preventDefault, applied
  // identically below) -- without it, tapping Next/Previous/Replace would
  // blur whichever search/replace input the user was just typing into,
  // closing the on-screen keyboard and requiring a second tap to reopen it
  // before continuing to type.
  function preventFocusSteal(event: { preventDefault: () => void }) {
    event.preventDefault();
  }

  function handleClose() {
    // Clear the query so match highlights disappear immediately along with
    // the bar itself -- an empty SearchQuery is simply "not valid" (its own
    // `valid` getter), which the plugin's decoration-building already
    // treats as "nothing to highlight" on its own.
    view.dispatch(setSearchState(view.state.tr, new SearchQuery({ search: "" })));
    onClose();
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      run(event.shiftKey ? findPrev : findNext);
    } else if (event.key === "Escape") {
      event.preventDefault();
      handleClose();
    }
  }

  // The plugin's own decorations are the single source of truth for "what's
  // currently highlighted" -- reusing them for the counter (rather than
  // re-running the search loop a second time here) guarantees the number
  // shown always matches what's actually painted on screen. Sorted by
  // position explicitly: DecorationSet.find()'s own return order isn't
  // documented as position-stable, so the "active" match's 1-based index
  // shouldn't rely on it being so.
  //
  // Decoration's own public API exposes `from`/`to`/`spec` but NOT the
  // `class` string itself (that's the `attrs` constructor argument, which
  // has no public getter -- confirmed directly against prosemirror-view's
  // own .d.ts) -- so "which one is active" can't be read back off the
  // decoration object. Replicated instead via the exact same comparison the
  // plugin itself uses internally to decide that in the first place (a
  // match's range equals the current selection's range, confirmed directly
  // against its own source), which needs no access to decoration internals
  // at all.
  const decorations = getMatchHighlights(view.state).find().sort((a, b) => a.from - b.from);
  const total = decorations.length;
  const { from: selFrom, to: selTo } = view.state.selection;
  const activeIndex = decorations.findIndex((d) => d.from === selFrom && d.to === selTo);
  const countLabel = queryText.trim() === "" ? "" : total === 0 ? "No results" : `${activeIndex >= 0 ? activeIndex + 1 : "–"}/${total}`;

  return (
    <div className="search-bar" role="search">
      <div className="search-bar-row">
        <input
          ref={inputRef}
          type="text"
          className="search-bar-input"
          placeholder="Find"
          value={queryText}
          onChange={(event) => setQueryText(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <span className="search-bar-count">{countLabel}</span>
        <button type="button" className="search-bar-icon-button" aria-label="Previous match" disabled={total === 0} onMouseDown={preventFocusSteal} onClick={() => run(findPrev)}>
          ‹
        </button>
        <button type="button" className="search-bar-icon-button" aria-label="Next match" disabled={total === 0} onMouseDown={preventFocusSteal} onClick={() => run(findNext)}>
          ›
        </button>
        <button
          type="button"
          className="search-bar-icon-button"
          aria-label={showReplace ? "Hide replace" : "Show replace"}
          data-active={showReplace || undefined}
          onMouseDown={preventFocusSteal}
          onClick={() => setShowReplace((prev) => !prev)}
        >
          ⇄
        </button>
        <button type="button" className="search-bar-icon-button" aria-label="Close search" onMouseDown={preventFocusSteal} onClick={handleClose}>
          ✕
        </button>
      </div>
      {showReplace && (
        <div className="search-bar-row">
          <input
            type="text"
            className="search-bar-input"
            placeholder="Replace"
            value={replaceText}
            onChange={(event) => setReplaceText(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button type="button" className="search-bar-text-button" disabled={total === 0} onMouseDown={preventFocusSteal} onClick={() => run(replaceNext)}>
            Replace
          </button>
          <button type="button" className="search-bar-text-button" disabled={total === 0} onMouseDown={preventFocusSteal} onClick={() => run(replaceAll)}>
            Replace All
          </button>
        </div>
      )}
    </div>
  );
}

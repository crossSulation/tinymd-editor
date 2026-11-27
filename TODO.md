# TODO

Gaps identified against "must-have" editor functions (not nice-to-haves) — none of these are implemented yet. Ranked by how fundamental they are, not by effort.

## 1. Find/replace in document — DONE
The header's Search button (`EditorPage.tsx`) now opens a real find/replace bar (`SearchBar.tsx`), built on the official `prosemirror-search` contrib package rather than hand-rolled matching logic. Supports find-as-you-type, next/previous navigation (wraps around), a live match counter, and Replace/Replace All. Bound to whichever editor instance is currently active (the single instance, or the virtualized path's currently-focused chunk), so a very large (chunked) document is searched one chunk at a time — a known, accepted limitation consistent with this app's existing cross-chunk undo/selection trade-offs. See `UX_PLAN.md`'s "Unplanned follow-up" entry for the full writeup.

## 2. Rename a document — DONE
Click the document title in `EditorPage.tsx`'s header to edit it inline — Enter or clicking away commits, Escape discards. Saved immediately via `saveDoc` (not the debounced content-save path, since renaming is a deliberate one-off action, not a keystroke stream), and reported up to `AppShell.tsx` so the sidebar's tree reflects the new title without a full `listDocs()` refetch. `author`/`tags`/`customProperties` remain write-once — only `title` gained an editing path, since that was the specific, concrete gap ("a typo'd title can never be fixed"). See `UX_PLAN.md`'s "Unplanned follow-up" entry and CLAUDE.md's updated Persistence section.

## 3. Clipboard image paste
No `handlePaste`/`handleDrop`/`DataTransfer` handling anywhere in `src/view/`. The only way to insert an image is the file picker (`commands.ts`'s `insertImage`). Pasting a screenshot does nothing.

## 4. Import an existing markdown file
Export exists (web-only); nothing reads a `.md` file in. One-directional today.

## 5. Task-list touch affordance — DONE
Added a "Checklist" entry to both the Toolbar's Insert group and the slash menu (`commands.ts`'s `insertTaskList`), and registered `@milkdown/kit/component/list-item-block` so task checkboxes are real, tap-to-toggle elements (`onPointerdown`, not `:hover`) instead of inert `data-checked` attributes with no interaction at all. Verified end-to-end: insert via toolbar/slash menu, tap-to-check/uncheck, plain bullet/ordered lists still render correctly (not converted to checkboxes), and checked state + text survive a save/reload round trip. See `UX_PLAN.md`'s "Unplanned follow-up" entry for the full writeup, including a necessary side effect: every list item's rendering (not just task items) now goes through this component, since it registers against the shared `list_item` node type.

## 6. Inline math (`$...$`)
Still not built — an already-flagged open item from UX_PLAN.md's Phase 7 (block-level LaTeX exists with a dedicated editor; inline math needs its own schema + remark round-trip, same pattern as `textColor.ts`/`underline.ts`).

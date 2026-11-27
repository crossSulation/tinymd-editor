import { search } from "prosemirror-search";
import { $prose } from "@milkdown/kit/utils";

// TODO.md item 1 -- find/replace in document. `prosemirror-search` is the
// official ProseMirror contrib package (same author/project as every other
// `prosemirror-*` dependency this app already pulls in transitively through
// Milkdown) handling the actually-hard parts of this correctly already:
// position-aware regex/plain-text matching across node boundaries, replace
// (including `$1`/`$&`-style capture-group substitution), and wrap-around
// next/prev navigation -- not something worth re-implementing by hand
// (confirmed directly against its own source rather than assumed: its
// `findNext`/`findPrev`/`replaceAll` commands already handle the position-
// mapping edge cases a naive re-implementation would get wrong).
// `$prose(() => plugin)` is the same "wrap a plain ProseMirror Plugin for
// Milkdown's own `.use()` chain" pattern `placeholder.ts`/
// `tableCosmetics.ts` already establish -- `search()` itself needs no
// config here (SearchBar.tsx drives it entirely via `setSearchState`).
export const searchPlugin = $prose(() => search());

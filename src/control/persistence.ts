import type { DocumentMeta } from "../model";
import { saveDoc } from "./db";

export interface DebouncedSave {
  (meta: DocumentMeta, blocks: string[]): void;
  /**
   * Immediately performs the pending scheduled save (if any), bypassing the
   * debounce delay -- a no-op if nothing is pending. Needed because a plain
   * `setTimeout` keeps running regardless of React component lifecycle: if
   * the user leaves this document and reopens it before the debounce window
   * elapses, a fresh `EditorPage`/`createDebouncedSave` instance's own
   * `loadDoc` can read SQLite *before* the previous instance's pending write
   * lands, silently loading stale content (confirmed directly as a real,
   * reproducible bug, not theoretical -- draw a stroke, then quickly
   * navigate back to the list and immediately reopen the same document,
   * before this fix). `EditorPage.tsx` calls this on unmount and on the
   * page being hidden/backgrounded, so leaving the editor always saves
   * immediately rather than racing the debounce timer.
   */
  flush: () => void;
}

// Debounces autosave so rapid edits (every keystroke) coalesce into one
// SQLite write after a short quiet period, instead of writing on every change.
export function createDebouncedSave(docId: string, delayMs = 800): DebouncedSave {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { meta: DocumentMeta; blocks: string[] } | null = null;

  function commit() {
    timer = null;
    const toSave = pending;
    pending = null;
    if (toSave) void saveDoc(docId, toSave.meta, toSave.blocks);
  }

  const scheduleSave = ((meta: DocumentMeta, blocks: string[]) => {
    pending = { meta, blocks };
    if (timer) clearTimeout(timer);
    timer = setTimeout(commit, delayMs);
  }) as DebouncedSave;

  scheduleSave.flush = () => {
    if (timer) clearTimeout(timer);
    commit();
  };

  return scheduleSave;
}

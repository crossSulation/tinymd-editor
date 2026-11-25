import { isTauri } from "@tauri-apps/api/core";

// Tauri currently only ships this app for Android (CLAUDE.md: "Android is
// the only native target") -- but `tauri dev`/`tauri build` can ALSO run
// as a desktop app (Windows/macOS/Linux) with no Android device involved
// at all, and plain `isTauri()` can't tell those apart (it only answers
// "is this wrapped in Tauri at all", which is still the right check for
// e.g. picking the SQLite backend in db.ts, regardless of desktop/mobile).
// Gates that actually mean "is this the touch-only Android build" need
// this instead. A plain User-Agent check, not a new Tauri plugin (e.g.
// @tauri-apps/plugin-os) -- desktop Tauri is local testing convenience
// only here, not a supported second target, so a heavier dependency isn't
// justified.
export function isTauriAndroid(): boolean {
  return isTauri() && /android/i.test(navigator.userAgent);
}

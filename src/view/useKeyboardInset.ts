import { useEffect, useState } from "react";

// On a touch device the on-screen keyboard overlays fixed-position content
// instead of resizing the layout viewport, so anything fixed to the bottom
// (the toolbar) or the editor's own bottom padding needs a manual nudge to
// stay above it. Two independent sources feed this, whichever platform
// actually provides one:
//
// 1. window.visualViewport, which shrinks (and/or offsets) when the keyboard
//    opens while window.innerHeight doesn't -- the standard web mechanism,
//    verified working via CDP in a real browser context.
// 2. A "tinymd:keyboard-inset" CustomEvent with a `{ height }` detail (CSS
//    px), dispatched by the Tauri/Android host (see MainActivity.kt's
//    onWebViewCreate) via WindowInsetsCompat.Type.ime() -- needed because
//    Android's edge-to-edge mode deliberately doesn't resize the window for
//    the keyboard, and this WebView's visualViewport doesn't reliably report
//    that inset either (confirmed on-device). Kept generic (not Tauri-named)
//    so this stays usable outside this app, same as the rest of src/view/.
//
// Where neither fires, this resolves to 0 (today's behavior).
const KEYBOARD_INSET_EVENT = "tinymd:keyboard-inset";

export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const viewport = window.visualViewport;
    const updateFromViewport = () => {
      if (!viewport) return;
      setInset(Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop));
    };
    const updateFromBridge = (event: Event) => {
      const height = (event as CustomEvent<{ height: number }>).detail?.height;
      if (typeof height === "number") setInset(Math.max(0, height));
    };

    updateFromViewport();
    viewport?.addEventListener("resize", updateFromViewport);
    viewport?.addEventListener("scroll", updateFromViewport);
    window.addEventListener(KEYBOARD_INSET_EVENT, updateFromBridge);
    return () => {
      viewport?.removeEventListener("resize", updateFromViewport);
      viewport?.removeEventListener("scroll", updateFromViewport);
      window.removeEventListener(KEYBOARD_INSET_EVENT, updateFromBridge);
    };
  }, []);

  return inset;
}

package com.tinymdeditor.app

import android.content.res.Configuration
import android.os.Bundle
import android.view.ActionMode
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  // Captured in onWebViewCreate -- needed by onConfigurationChanged below,
  // which fires well after that (on every later rotation), not at the same
  // time.
  private var webViewRef: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    hideSystemBars()
  }

  override fun onStart() {
    super.onStart()
    window.decorView.post {
       disableWebViewLongClick(window.decorView)
    }
  }

  // Default full-screen/immersive: hide BOTH the status bar and the
  // navigation bar, not just draw edge-to-edge behind them (enableEdgeToEdge
  // above only stops the window from resizing for them -- the bars
  // themselves stay visible until actually hidden here). BEHAVIOR_SHOW_
  // TRANSIENT_BARS_BY_SWIPE is the standard "immersive sticky" mode: a
  // swipe from a screen edge still temporarily reveals the system bars
  // (so the user isn't ever fully locked out of them), after which they
  // auto-hide again rather than staying shown -- this does NOT re-fire
  // hideSystemBars() itself; onWindowFocusChanged below is what re-applies
  // the hidden state once the transient reveal (or any other focus loss,
  // e.g. backgrounding the app or a system dialog) ends, since Android
  // does not guarantee the hidden state otherwise survives those.
  private fun hideSystemBars() {
    val controller = WindowInsetsControllerCompat(window, window.decorView)
    controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    controller.hide(WindowInsetsCompat.Type.systemBars())
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) hideSystemBars()
  }
  // enableEdgeToEdge() means the window deliberately does NOT resize when the
  // soft keyboard appears (that's the whole point of edge-to-edge), and this
  // WebView's visualViewport does not reliably report the IME inset either
  // (confirmed on-device -- window.visualViewport.height stays unchanged when
  // the keyboard shows). So the real keyboard height is read here, natively,
  // via WindowInsetsCompat.Type.ime(), and relayed into the web content as a
  // plain DOM CustomEvent -- keeps src/view/ (the reusable Editor) unaware of
  // Tauri/Android specifically; it just listens for a generically-named
  // window event, the same way it listens for visualViewport's own events on
  // the web, where that API does work (verified via CDP in that context).
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webViewRef = webView
    val density = resources.displayMetrics.density
    ViewCompat.setOnApplyWindowInsetsListener(webView) { _, insets ->
      val imeHeightPx = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      val imeHeightDp = (imeHeightPx / density).toInt()
      webView.evaluateJavascript(
        "window.dispatchEvent(new CustomEvent('tinymd:keyboard-inset', { detail: { height: $imeHeightDp } }));",
        null,
      )
      insets
    }
    // ATTEMPT, not yet confirmed: suppress the native long-press text-
    // selection action-mode toolbar (Copy/Share/etc. -- see CLAUDE.md's
    // "No floating selection toolbar" section) via the GENERIC Android
    // View.OnLongClickListener, returning true to mark the long-press
    // "consumed" so the platform doesn't perform its own default handling
    // for it -- a different, much cheaper mechanism than the
    // already-ruled-out approach (overriding startActionMode, which needs
    // a custom WebView subclass wry doesn't expose without a fork).
    // UNCERTAIN this actually intercepts a long-press ON SELECTABLE TEXT
    // specifically: WebView's own content rendering (Chromium) does its
    // own internal touch-to-gesture translation for text selection
    // directly against the raw touch stream, which may invoke its
    // ActionMode-based selection UI without ever going through the outer
    // View's generic long-click dispatch at all -- this is exactly the
    // mechanism the prior, already-documented investigation found no
    // durable hook into. Left in to actually test on a real device rather
    // than ruling it out by reasoning alone; remove if it doesn't help.
    webView.setOnLongClickListener { true }
    // `View` has no such thing as `setOnDoubleTapListener` -- double-tap/
    // pinch zoom on a WebView is governed by WebSettings, not a generic
    // View gesture listener. This is the actual, documented API for it,
    // and more robust than relying on index.html's viewport meta tag
    // (`user-scalable=no`) alone -- that already should suppress it at
    // the web-content level, but this disables it natively regardless of
    // whatever Chromium's own gesture recognition does with the page's
    // viewport meta (the same category of "web-standard CSS/meta isn't
    // always fully respected by WebView's own native gesture handling"
    // issue already confirmed for two-finger pinch/pan -- see
    // DrawLayer.tsx's own two-finger-scroll entry in CLAUDE.md).
    webView.settings.setSupportZoom(false)
  }

  // AndroidManifest.xml declares android:configChanges including
  // "orientation|screenSize" (needed so the Activity -- and the whole React
  // app's in-memory state -- survives a rotation instead of being torn down
  // and recreated), which means Android does NOT automatically relayout
  // everything for us the way it would on a default (non-configChanges)
  // activity; it delivers this callback instead and expects the app to
  // handle any resize itself. Without an explicit requestLayout() here, the
  // WebView's own View doesn't reliably get re-measured against the new
  // window bounds after rotation on this WebView -- its CSS layout (text,
  // buttons, flex layout) still resizes correctly since that's normal page
  // reflow, but a <canvas> element's own backing-buffer resolution (its
  // width/height attributes, set in JS from the container's
  // getBoundingClientRect()) was captured against the PRE-rotation size and
  // never gets told to re-measure, since the ResizeObserver driving that in
  // DrawLayer.tsx never fires without a real layout pass happening first.
  // The browser then visually stretches that stale bitmap to fit the
  // post-rotation CSS box -- same as resizing an <img> without matching its
  // intrinsic dimensions -- which is exactly "ink strokes stretch after
  // rotating the device, and never correct themselves" (confirmed directly
  // as a real, reproducible, non-self-correcting bug on a physical device;
  // not reproducible via a desktop browser's instant viewport resize, which
  // doesn't go through this native codepath at all). requestLayout() forces
  // Android to re-measure the WebView against the Activity's now-updated
  // window bounds, which lets the page's own ResizeObserver fire with
  // correct final dimensions and resize/redraw the canvas from its own
  // vector stroke data (see DrawLayer.tsx's resize effect).
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    webViewRef?.requestLayout()
  }

  // A DIFFERENT, more promising hook than subclassing WebView itself (the
  // already-ruled-out approach, which needs a wry fork): Activity already
  // implements Window.Callback, and View.startActionMode(...) -- what
  // WebView's own internal Chromium code calls to show its text-selection
  // toolbar -- walks UP to the hosting Activity's onWindowStartingActionMode
  // when nothing closer in the view hierarchy handles it first. WebView's
  // selection toolbar has used ActionMode.TYPE_FLOATING since Android M, so
  // overriding the type-aware overload specifically targets that case;
  // the legacy (type-less) overload is overridden too for completeness,
  // in case some code path still goes through it. Returning null tells
  // the platform "no action mode created" -- suppresses it outright,
  // rather than customizing its contents. No WebView subclass needed, so
  // this survives gen/android regeneration the same way the rest of this
  // file already does (MainActivity.kt is the one legitimate, durable
  // customization point -- see CLAUDE.md's Tauri/Android section).
  // NOT YET CONFIRMED on a real device whether WebView's selection UI
  // actually routes through this standard Android mechanism at all, or
  // implements its own popup entirely outside it -- worth testing
  // directly rather than ruling out by reasoning alone.
  override fun onWindowStartingActionMode(callback: ActionMode.Callback?): ActionMode? {
    return null
  }

  override fun onWindowStartingActionMode(callback: ActionMode.Callback?, type: Int): ActionMode? {
    return null
  }

  // Reactive fallback to the preventive onWindowStartingActionMode above,
  // which returning null from did NOT stop WebView's selection toolbar
  // (confirmed on-device). THIS one, by contrast, IS confirmed to fire for
  // WebView's selection action mode -- apparently a separate notification
  // path, not gated by the same creation-veto point as the other hook --
  // and `finish()` does dismiss it. But it's a NOTIFICATION-only callback
  // (the mode, and its own platform-controlled show animation, already
  // exist by the time this fires), so there's still a brief visible flash
  // before it closes, confirmed directly on-device -- including re-firing
  // (and re-flashing) on every selection CHANGE, not just the initial
  // long-press, since Android treats dragging a selection handle as a
  // fresh onActionModeStarted each time. Clearing the menu first means
  // that flash is an empty bar, not one showing Copy/Share buttons -- a
  // small mitigation, not a fix for the flash itself: there's no public
  // API to disable ActionMode's own entrance animation, and going further
  // than this (reflection into private fields) would be a worse trade
  // than even forking wry.
  override fun onActionModeStarted(mode: ActionMode) {
    mode.menu.clear() // so the brief flash shows an empty bar, not Copy/Share
    mode.finish()
    super.onActionModeStarted(mode)
  }

  override fun onDestroy() {
    super.onDestroy()
    webViewRef = null
  }

  private fun disableWebViewLongClick(view: View) {
        if (view is WebView) {
            view.isLongClickable = false
            view.setOnLongClickListener { true } // 返回 true 消费掉长按事件，不再向上传递
        } else if (view is ViewGroup) {
            for (i in 0 until view.childCount) {
                disableWebViewLongClick(view.getChildAt(i))
            }
        }
    }
}

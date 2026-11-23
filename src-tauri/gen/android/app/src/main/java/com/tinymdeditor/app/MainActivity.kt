package com.tinymdeditor.app

import android.content.res.Configuration
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  // Captured in onWebViewCreate -- needed by onConfigurationChanged below,
  // which fires well after that (on every later rotation), not at the same
  // time.
  private var webViewRef: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
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
}

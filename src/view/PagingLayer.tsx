import { useEffect, useRef, useState } from "react";

export interface PagingLayerProps {
  /** Whether paging mode is active -- owned by Editor.tsx's ModeHeader, not this component itself. */
  active: boolean;
}

// How long the cosmetic spinner shows before the "swipe" (a smooth scroll
// to the next/previous page boundary) starts.
const SPINNER_DELAY_MS = 300;
// How long the smooth-scroll transition itself is assumed to take --
// there's no reliable cross-browser "scrollTo finished" event, so this is
// a fixed estimate the spinner stays visible for afterward, not a measured
// value. Generous enough to cover a typical one-viewport-height smooth
// scroll without the spinner disappearing mid-animation.
const TRANSITION_MS = 400;
// How far past a page boundary the user has to scroll before it counts as
// "left the current page" -- a small tolerance so sub-pixel scroll
// jitter/rounding doesn't spuriously retrigger a transition right at the
// boundary.
const BOUNDARY_EPS_PX = 4;

// A whole-viewport pagination mode, independent of the virtualized
// editor's own chunk/heading-based "Page N / Total" nav bar (see
// Editor.tsx's `virtualizedPage`) -- that one only exists for documents
// over CHUNK_SIZE_THRESHOLD, with page boundaries fixed by heading
// structure. This is a separate, simpler concept that applies to ANY
// document: "page" just means "whatever currently fits the viewport, at
// the moment paging mode was toggled on (or the previous page transition
// landed)". Deliberately layered on top of the EXISTING scroller (whichever
// one is live -- same ".milkdown, .editor-mount-virtualized" lookup
// DrawLayer.tsx's own getScrollTop already uses) rather than introducing a
// separate rendering/virtualization architecture: normal scrolling, text
// selection, and editing all keep working completely unchanged underneath
// this. All this does is watch scroll position and, once the user scrolls
// past the current page's own boundary, show a brief cosmetic spinner then
// smooth-scroll to snap exactly onto the next (or previous) page boundary.
export function PagingLayer({ active }: PagingLayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [transitioning, setTransitioning] = useState(false);
  // The scrollTop marking the top of the CURRENT page -- "current visible
  // content is one page" means this is simply wherever the scroller
  // happened to be when paging mode was turned on, or wherever the last
  // transition landed. Re-established fresh every time `active` flips on,
  // and after every resize (see below) -- never reactively recomputed from
  // content structure, since a "page" here has no relationship to
  // document structure at all, only to the viewport's own height.
  const pageTopRef = useRef(0);
  const viewportHeightRef = useRef(0);
  const transitioningRef = useRef(false);

  useEffect(() => {
    if (!active) return;
    const content = containerRef.current?.closest(".editor-content");
    const scroller = content?.querySelector<HTMLElement>(".milkdown, .editor-mount-virtualized");
    if (!scroller) return;

    pageTopRef.current = scroller.scrollTop;
    viewportHeightRef.current = scroller.clientHeight;

    function goToPage(targetTop: number) {
      if (!scroller) return;
      transitioningRef.current = true;
      setTransitioning(true);
      const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const clampedTop = Math.min(Math.max(targetTop, 0), maxTop);
      window.setTimeout(() => {
        scroller.scrollTo({ top: clampedTop, behavior: "smooth" });
      }, SPINNER_DELAY_MS);
      window.setTimeout(() => {
        pageTopRef.current = clampedTop;
        transitioningRef.current = false;
        setTransitioning(false);
      }, SPINNER_DELAY_MS + TRANSITION_MS);
    }

    function handleScroll() {
      if (!scroller || transitioningRef.current) return;
      const pageTop = pageTopRef.current;
      const viewportHeight = viewportHeightRef.current;
      const scrollTop = scroller.scrollTop;
      if (scrollTop > pageTop + viewportHeight + BOUNDARY_EPS_PX) {
        // Scrolled past the bottom of the current page -- "out of current
        // visible content" -- advance to the next page.
        goToPage(pageTop + viewportHeight);
      } else if (scrollTop < pageTop - BOUNDARY_EPS_PX) {
        // Scrolled back above the current page's own top -- go to the
        // previous page (the symmetric, expected completion of the same
        // behavior; nothing works without this once you've advanced at
        // least one page).
        goToPage(pageTop - viewportHeight);
      }
    }

    // Keyboard open/close (or any other resize) changes how much content
    // actually fits -- re-anchor BOTH the viewport height and the current
    // page's own top to wherever the scroller already is, rather than
    // trying to preserve the old page boundaries against a new viewport
    // size they were never measured for.
    function handleResize() {
      if (!scroller) return;
      viewportHeightRef.current = scroller.clientHeight;
      pageTopRef.current = scroller.scrollTop;
    }

    scroller.addEventListener("scroll", handleScroll, { passive: true });
    const observer = new ResizeObserver(handleResize);
    observer.observe(scroller);

    return () => {
      scroller.removeEventListener("scroll", handleScroll);
      observer.disconnect();
    };
  }, [active]);

  if (!active) return null;

  return (
    <div ref={containerRef} className="paging-layer" data-transitioning={transitioning || undefined}>
      {transitioning && (
        <div className="paging-layer-spinner" role="status" aria-label="Loading next page">
          <span className="paging-layer-spinner-icon" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}

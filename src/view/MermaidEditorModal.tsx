import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { EditorView as CodeMirrorView, lineNumbers, keymap } from "@codemirror/view";
import { EditorState as CodeMirrorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  mermaidLanguageSupport,
  mermaidHighlighting,
  mermaidAutocompletion,
  DIAGRAM_TYPES,
  THEME_OPTIONS,
  SNIPPETS,
  NODE_SHAPES,
  detectDiagramType,
  detectDirection,
  detectTheme,
  setDirection,
  setTheme,
  type MermaidDirection,
  type MermaidTheme,
} from "./mermaidEditorKit";
import { loadMermaid } from "./mermaidPreview";
import { useKeyboardInset } from "./useKeyboardInset";

export interface MermaidEditorModalProps {
  initialSource: string;
  onDone: (source: string) => void;
  onClose: () => void;
}

const MIN_ZOOM = 25;
const MAX_ZOOM = 400;
const PREVIEW_DEBOUNCE_MS = 300;
let mermaidRenderIdCounter = 0;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

// Full-screen dedicated Mermaid authoring surface (UX_PLAN.md Phase 6,
// `Mermaid.dc.html`/`PortraitMermaid.dc.html`) -- a separate editing
// surface from the inline code-block + side-by-side preview
// `mermaidPreview.ts` already renders for every Mermaid code block; this
// modal is what Toolbar.tsx's "Mermaid diagram" insert action and a
// selected Mermaid code block's new "Edit diagram" button both open,
// with `onDone`'s caller (Editor.tsx) responsible for actually inserting/
// replacing the code block in the real document -- this component only
// ever deals in plain markdown-less Mermaid source text, no ProseMirror
// position of its own.
export function MermaidEditorModal({ initialSource, onDone, onClose }: MermaidEditorModalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const shapeDetailsRef = useRef<HTMLDetailsElement | null>(null);
  const cmViewRef = useRef<CodeMirrorView | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [source, setSource] = useState(initialSource);
  // Same bridge this app's own editor-mount/Toolbar already rely on --
  // without it, nothing here reserves space for a real on-screen keyboard
  // (confirmed directly: the snippet-chip row and most of the preview pane
  // sit well within where a typical ~300px keyboard would cover them, since
  // this modal otherwise assumes the full viewport height is always usable
  // for its own content).
  const keyboardInset = useKeyboardInset();
  const [zoom, setZoom] = useState(100);
  const [previewLine, setPreviewLine] = useState<number | null>(null);

  const diagramType = detectDiagramType(source);
  const currentTypeOption = DIAGRAM_TYPES.find((option) => option.id === diagramType) ?? null;
  const direction = detectDirection(source);
  const theme = detectTheme(source);

  function replaceSource(next: string) {
    const view = cmViewRef.current;
    if (!view) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
    setSource(next);
  }

  function insertAtCursor(text: string) {
    const view = cmViewRef.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
    view.focus();
    setSource(view.state.doc.toString());
  }

  // Picking a shape is a one-tap insert, the same "nothing left to do once
  // you've picked" semantics CodeBlockEditorModal.tsx's language picker has
  // (unlike Type/Theme above, which stay open across several quick taps as
  // the user compares options) -- so it gets the same close-on-select fix.
  function handleInsertShape(text: string) {
    insertAtCursor(text);
    if (shapeDetailsRef.current) shapeDetailsRef.current.open = false;
  }

  // Mount CodeMirror once; never re-mounted for prop changes (initialSource
  // only seeds it, same "not reactive after mount" contract Editor.tsx's
  // own `initialMarkdown` prop already uses).
  useEffect(() => {
    if (!containerRef.current) return;
    const view = new CodeMirrorView({
      state: CodeMirrorState.create({
        doc: initialSource,
        extensions: [
          lineNumbers(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          mermaidLanguageSupport,
          mermaidHighlighting(),
          mermaidAutocompletion(),
          CodeMirrorView.theme({
            "&": { height: "100%", fontSize: "15px" },
            ".cm-scroller": { fontFamily: "'JetBrains Mono', ui-monospace, Menlo, monospace", lineHeight: "26px", overflow: "auto" },
          }),
          CodeMirrorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const text = update.state.doc.toString();
            setSource(text);
            const line = update.state.doc.lineAt(update.state.selection.main.head).number;
            setPreviewLine(line);
          }),
        ],
      }),
      parent: containerRef.current,
    });
    cmViewRef.current = view;
    view.focus();
    return () => {
      view.destroy();
      cmViewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced live preview -- re-renders on every source change, but not
  // on every keystroke (mermaid.render() is real parsing/layout work, not
  // worth paying for faster than a human can usefully watch it update).
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const host = previewRef.current;
      if (!host) return;
      if (!source.trim()) {
        host.innerHTML = "";
        return;
      }
      loadMermaid()
        .then((mermaid) => mermaid.render(`mermaid-editor-${++mermaidRenderIdCounter}`, source))
        .then(({ svg }) => {
          if (previewRef.current) previewRef.current.innerHTML = svg;
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "Invalid diagram";
          if (previewRef.current) previewRef.current.innerHTML = `<pre class="mermaid-editor-error">${escapeHtml(message)}</pre>`;
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [source]);

  function handleSelectDiagramType(option: (typeof DIAGRAM_TYPES)[number]) {
    if (option.id === diagramType) return;
    if (source.trim() && !window.confirm(`Replace the current diagram with a new ${option.label} template? This discards what's written.`)) {
      return;
    }
    replaceSource(option.template);
    setZoom(100);
  }

  function handleSetDirection(next: MermaidDirection) {
    replaceSource(setDirection(source, next));
  }

  function handleSetTheme(next: MermaidTheme) {
    replaceSource(setTheme(source, next));
  }

  function handleFit() {
    const svg = previewRef.current?.querySelector("svg");
    const container = previewRef.current?.parentElement;
    if (!svg || !container) return;
    const svgBox = svg.getBoundingClientRect();
    const naturalWidth = svgBox.width / (zoom / 100);
    const naturalHeight = svgBox.height / (zoom / 100);
    if (naturalWidth === 0 || naturalHeight === 0) return;
    const available = container.getBoundingClientRect();
    const padding = 48;
    const scale = Math.min((available.width - padding) / naturalWidth, (available.height - padding) / naturalHeight, 1);
    setZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(scale * 100))));
  }

  return createPortal(
    <div
      className="mermaid-editor-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Edit diagram"
      data-keyboard-open={keyboardInset > 0 || undefined}
      style={{ "--mermaid-editor-keyboard-inset": `${keyboardInset}px` } as CSSProperties}
    >
      <header className="mermaid-editor-header">
        <button type="button" className="mermaid-editor-icon-button" aria-label="Close editor" onClick={onClose}>
          ✕
        </button>
        <div className="mermaid-editor-title">
          <span className="mermaid-editor-title-main">Edit diagram</span>
          <span className="mermaid-editor-title-sub">{currentTypeOption?.label ?? "Mermaid"} diagram · Mermaid</span>
        </div>
        <div className="mermaid-editor-header-controls">
          <details className="mermaid-editor-dropdown">
            <summary>{currentTypeOption?.label ?? "Type"}</summary>
            <div className="mermaid-editor-dropdown-menu" role="listbox" aria-label="Diagram type">
              {DIAGRAM_TYPES.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="option"
                  aria-selected={option.id === diagramType}
                  data-active={option.id === diagramType || undefined}
                  onClick={() => handleSelectDiagramType(option)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </details>
          {currentTypeOption?.supportsDirection && (
            <div className="mermaid-editor-segmented" role="group" aria-label="Direction">
              <button type="button" aria-pressed={direction === "LR"} data-active={direction === "LR" || undefined} onClick={() => handleSetDirection("LR")}>
                Left → right
              </button>
              <button type="button" aria-pressed={direction === "TD"} data-active={direction === "TD" || undefined} onClick={() => handleSetDirection("TD")}>
                Top → down
              </button>
            </div>
          )}
          <details className="mermaid-editor-dropdown">
            <summary>Theme: {THEME_OPTIONS.find((option) => option.id === theme)?.label}</summary>
            <div className="mermaid-editor-dropdown-menu" role="listbox" aria-label="Theme">
              {THEME_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="option"
                  aria-selected={option.id === theme}
                  data-active={option.id === theme || undefined}
                  onClick={() => handleSetTheme(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </details>
          <button type="button" className="mermaid-editor-done" onClick={() => onDone(source)}>
            Done
          </button>
        </div>
      </header>

      <div className="mermaid-editor-body">
        <section className="mermaid-editor-source" aria-label="Source">
          <div className="mermaid-editor-pane-label">Source</div>
          <div className="mermaid-editor-cm-host" ref={containerRef} />
          <div className="mermaid-editor-snippets">
            {SNIPPETS.map((snippet) => (
              <button key={snippet.id} type="button" className="mermaid-editor-chip" onClick={() => insertAtCursor(snippet.text)}>
                {snippet.label}
              </button>
            ))}
            {/* Full flowchart node-shape set (requested directly: "basic
                shapes like [], (), {}") -- a dropdown rather than more flat
                chips, since the chip row already needs to scroll on a
                narrow phone with just the 4 above. Same insert-at-cursor
                behavior as the chips, just via a picker instead of a
                direct tap -- unlike the header's Type/Theme dropdowns,
                which replace/rewrite the whole source. */}
            <details className="mermaid-editor-dropdown mermaid-editor-shape-dropdown" ref={shapeDetailsRef}>
              <summary>Shape ▾</summary>
              <div className="mermaid-editor-dropdown-menu" role="listbox" aria-label="Node shape">
                {NODE_SHAPES.map((shape) => (
                  <button key={shape.id} type="button" role="option" onClick={() => handleInsertShape(shape.text)}>
                    {shape.label}
                  </button>
                ))}
              </div>
            </details>
          </div>
        </section>

        <section className="mermaid-editor-preview" aria-label="Live preview">
          <div className="mermaid-editor-pane-label">
            Live preview
            <span className="mermaid-editor-rendered-badge">✓ Rendered</span>
          </div>
          <div className="mermaid-editor-preview-canvas">
            <div className="mermaid-editor-preview-svg-host" style={{ transform: `scale(${zoom / 100})` }} ref={previewRef} />
          </div>
          <div className="mermaid-editor-preview-footer">
            <span className="mermaid-editor-preview-status">{previewLine ? `Editing · line ${previewLine}` : ""}</span>
            <div className="mermaid-editor-zoom" role="group" aria-label="Zoom">
              <button type="button" className="mermaid-editor-icon-button" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z - 10))}>
                −
              </button>
              <span className="mermaid-editor-zoom-value">{zoom}%</span>
              <button type="button" className="mermaid-editor-icon-button" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + 10))}>
                +
              </button>
              <button type="button" className="mermaid-editor-fit" onClick={handleFit}>
                Fit
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>,
    document.body,
  );
}

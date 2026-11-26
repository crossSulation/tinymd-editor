import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { EditorView as CodeMirrorView, lineNumbers, keymap } from "@codemirror/view";
import { EditorState as CodeMirrorState, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { languages } from "@codemirror/language-data";
import { LanguageDescription, defaultHighlightStyle, syntaxHighlighting, type LanguageSupport } from "@codemirror/language";
import katex from "katex";
// See latexPreview.ts's own import of this for why it's required, not
// cosmetic -- this component renders KaTeX output independently of that
// file's inline preview, so it needs its own import rather than relying on
// load order/another module having already pulled it in.
import "katex/dist/katex.min.css";
import { useKeyboardInset } from "./useKeyboardInset";
import { LATEX_SNIPPETS, GREEK_LETTERS, RELATION_SYMBOLS } from "./latexEditorKit";
import "./mermaid-editor.css";

export interface CodeBlockEditorModalProps {
  /** The code_block node's own `language` attribute -- "" for a brand-new plain code block, "LaTeX" (case-insensitive) for an equation. Mermaid is handled entirely by MermaidEditorModal.tsx instead; this component never sees it. */
  language: string;
  initialSource: string;
  onDone: (language: string, source: string) => void;
  onClose: () => void;
}

const PREVIEW_DEBOUNCE_MS = 300;
const MIN_ZOOM = 25;
const MAX_ZOOM = 400;
const languageCompartment = new Compartment();

function isLatex(language: string): boolean {
  return language.toLowerCase() === "latex";
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

// Dedicated full-screen authoring surface for every code_block that ISN'T
// Mermaid (that has its own modal, MermaidEditorModal.tsx, with its own
// diagram-type/direction/theme controls that don't apply here) -- plain
// code in any real CodeMirror-supported language, and LaTeX equations.
// Requested directly: no code/LaTeX block is directly editable inline
// anymore (see createMilkdownEditor.ts's CodeMirrorView.editable.of(false)
// on the shared codeBlockConfig) -- this is the only place editing
// actually happens now, mirroring Mermaid's own already-established
// pattern exactly (same header/Done/Close shell, same
// useKeyboardInset()-driven keyboard-aware layout, same mermaid-editor.css
// classes reused directly rather than duplicated into a parallel
// stylesheet, since none of that CSS was ever Mermaid-specific in the
// first place -- just named after its first consumer).
export function CodeBlockEditorModal({ language: initialLanguage, initialSource, onDone, onClose }: CodeBlockEditorModalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const greekDetailsRef = useRef<HTMLDetailsElement | null>(null);
  const relationsDetailsRef = useRef<HTMLDetailsElement | null>(null);
  const cmViewRef = useRef<CodeMirrorView | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [language, setLanguage] = useState(initialLanguage);
  const [source, setSource] = useState(initialSource);
  const [zoom, setZoom] = useState(100);
  const [cursorLine, setCursorLine] = useState<number | null>(null);
  const keyboardInset = useKeyboardInset();
  const latex = isLatex(language);

  const sortedLanguages = useMemo(() => [...languages].sort((a, b) => a.name.localeCompare(b.name)), []);

  async function loadLanguageExtension(name: string): Promise<LanguageSupport | null> {
    if (!name || isLatex(name)) return null;
    const desc = LanguageDescription.matchLanguageName(sortedLanguages, name, true);
    if (!desc) return null;
    try {
      return await desc.load();
    } catch {
      return null;
    }
  }

  // Mount CodeMirror once; language changes afterward reconfigure the same
  // instance via languageCompartment rather than remounting it (same
  // Compartment-based reconfigure pattern codeBlockWrap.ts already
  // established for the inline editor's own Wrap toggle).
  useEffect(() => {
    if (!containerRef.current) return;
    let destroyed = false;
    const view = new CodeMirrorView({
      state: CodeMirrorState.create({
        doc: initialSource,
        extensions: [
          lineNumbers(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          languageCompartment.of([]),
          // A loaded LanguageDescription supplies the GRAMMAR (what's a
          // keyword/string/etc.) but not a color for any of it -- that's a
          // separate, composable piece (syntaxHighlighting + a
          // HighlightStyle), confirmed directly after shipping this
          // without it and seeing real code render with zero color at
          // all despite the correct language loading successfully.
          // defaultHighlightStyle is CodeMirror's own bundled one (same
          // one `basicSetup`, from the `codemirror` package, already
          // includes for the main document's inline code blocks), so
          // this matches that look rather than inventing a new palette.
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          CodeMirrorView.theme({
            "&": { height: "100%", fontSize: "15px" },
            ".cm-scroller": { fontFamily: "ui-monospace, Menlo, monospace", lineHeight: "22px", overflow: "auto" },
          }),
          CodeMirrorView.updateListener.of((update) => {
            if (update.docChanged) setSource(update.state.doc.toString());
            if (update.docChanged || update.selectionSet) {
              setCursorLine(update.state.doc.lineAt(update.state.selection.main.head).number);
            }
          }),
        ],
      }),
      parent: containerRef.current,
    });
    cmViewRef.current = view;
    view.focus();
    loadLanguageExtension(initialLanguage).then((ext) => {
      if (destroyed) return;
      view.dispatch({ effects: languageCompartment.reconfigure(ext ? [ext] : []) });
    });
    return () => {
      destroyed = true;
      view.destroy();
      cmViewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleSelectLanguage(name: string) {
    setLanguage(name);
    loadLanguageExtension(name).then((ext) => {
      cmViewRef.current?.dispatch({ effects: languageCompartment.reconfigure(ext ? [ext] : []) });
    });
    // Picking a language is this dropdown's whole purpose -- unlike
    // Mermaid's Type/Direction/Theme dropdowns (which stay open for several
    // quick taps in a row), there's nothing left to do here once one is
    // chosen, so close it immediately rather than leaving the 320px sheet
    // covering the editor until the user taps elsewhere to dismiss it.
    if (detailsRef.current) detailsRef.current.open = false;
  }

  // Quick-action snippet/symbol insert (LaTeX only) -- same insert-at-
  // cursor-then-focus pattern MermaidEditorModal.tsx's own snippet chips and
  // Shape dropdown already use; CodeMirror's own updateListener above (not a
  // manual call here) picks up the resulting doc change into `source`.
  function insertAtCursor(text: string) {
    const view = cmViewRef.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
    view.focus();
  }

  // Picking a Greek letter or relation symbol is a one-tap insert (same
  // "nothing left to do once you've picked" reasoning as the language
  // picker above and MermaidEditorModal.tsx's own Shape dropdown) -- close
  // immediately rather than leaving the panel open.
  function handleInsertSymbol(ref: RefObject<HTMLDetailsElement | null>, text: string) {
    insertAtCursor(text);
    if (ref.current) ref.current.open = false;
  }

  function handleFit() {
    // previewRef's own content is plain KaTeX-rendered HTML (a `.katex`
    // span), not an SVG -- same natural-size-from-current-zoom math
    // MermaidEditorModal.tsx's handleFit already uses, just measuring a
    // different node type.
    const node = previewRef.current?.querySelector(".katex") as HTMLElement | null;
    const container = previewRef.current?.parentElement;
    if (!node || !container) return;
    const box = node.getBoundingClientRect();
    const naturalWidth = box.width / (zoom / 100);
    const naturalHeight = box.height / (zoom / 100);
    if (naturalWidth === 0 || naturalHeight === 0) return;
    const available = container.getBoundingClientRect();
    const padding = 48;
    const scale = Math.min((available.width - padding) / naturalWidth, (available.height - padding) / naturalHeight, 1);
    setZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(scale * 100))));
  }

  // Live KaTeX preview, LaTeX only -- synchronous (unlike Mermaid's lazy-
  // loaded async render), so just debounced, no promise chain needed.
  useEffect(() => {
    if (!latex) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const host = previewRef.current;
      if (!host) return;
      if (!source.trim()) {
        host.innerHTML = "";
        return;
      }
      try {
        host.innerHTML = katex.renderToString(source, { throwOnError: true, displayMode: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid equation";
        host.innerHTML = `<pre class="mermaid-editor-error">${escapeHtml(message)}</pre>`;
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [latex, source]);

  return createPortal(
    <div
      className="mermaid-editor-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={latex ? "Edit equation" : "Edit code"}
      data-keyboard-open={keyboardInset > 0 || undefined}
      data-no-preview={!latex || undefined}
      style={{ "--mermaid-editor-keyboard-inset": `${keyboardInset}px` } as CSSProperties}
    >
      <header className="mermaid-editor-header">
        <button type="button" className="mermaid-editor-icon-button" aria-label="Close editor" onClick={onClose}>
          ✕
        </button>
        <div className="mermaid-editor-title">
          <span className="mermaid-editor-title-main">{latex ? "Edit equation" : "Edit code"}</span>
          <span className="mermaid-editor-title-sub">{latex ? "LaTeX" : language || "Plain text"}</span>
        </div>
        <div className="mermaid-editor-header-controls">
          {!latex && (
            <details className="mermaid-editor-dropdown" ref={detailsRef}>
              <summary>{language || "Plain text"} ▾</summary>
              <div className="code-block-editor-language-menu" role="listbox" aria-label="Language">
                <button type="button" role="option" aria-selected={!language} data-active={!language || undefined} onClick={() => handleSelectLanguage("")}>
                  Plain text
                </button>
                {sortedLanguages.map((desc) => (
                  <button
                    key={desc.name}
                    type="button"
                    role="option"
                    aria-selected={desc.name === language}
                    data-active={desc.name === language || undefined}
                    onClick={() => handleSelectLanguage(desc.name)}
                  >
                    {desc.name}
                  </button>
                ))}
              </div>
            </details>
          )}
          <button type="button" className="mermaid-editor-done" onClick={() => onDone(language, source)}>
            Done
          </button>
        </div>
      </header>

      <div className="mermaid-editor-body">
        <section className="mermaid-editor-source" aria-label="Source">
          <div className="mermaid-editor-pane-label">Source</div>
          <div className="mermaid-editor-cm-host" ref={containerRef} />
          {latex && (
            <div className="mermaid-editor-snippets">
              {LATEX_SNIPPETS.map((snippet) => (
                <button
                  key={snippet.id}
                  type="button"
                  className="latex-editor-key"
                  aria-label={snippet.ariaLabel}
                  onClick={() => insertAtCursor(snippet.insertText)}
                >
                  {snippet.id === "fraction" ? (
                    <span className="latex-editor-frac">
                      <span>a</span>
                      <span>b</span>
                    </span>
                  ) : snippet.id === "sqrt" ? (
                    "√x"
                  ) : snippet.id === "superscript" ? (
                    <>
                      <i>x</i>
                      <sup style={{ fontSize: 11 }}>n</sup>
                    </>
                  ) : snippet.id === "subscript" ? (
                    <>
                      <i>x</i>
                      <sub style={{ fontSize: 11 }}>i</sub>
                    </>
                  ) : snippet.id === "sum" ? (
                    "Σ"
                  ) : snippet.id === "integral" ? (
                    "∫"
                  ) : (
                    <span style={{ fontFamily: "Inter, sans-serif", fontSize: 13 }}>[⋮]</span>
                  )}
                </button>
              ))}
              <details className="mermaid-editor-dropdown mermaid-editor-shape-dropdown" ref={greekDetailsRef}>
                <summary>Greek ▾</summary>
                <div className="mermaid-editor-dropdown-menu" role="listbox" aria-label="Greek letters">
                  {GREEK_LETTERS.map((symbol) => (
                    <button key={symbol.id} type="button" className="latex-editor-symbol-button" role="option" onClick={() => handleInsertSymbol(greekDetailsRef, symbol.insertText)}>
                      <span className="latex-editor-symbol-glyph">{symbol.display}</span>
                      <span className="latex-editor-symbol-command">{symbol.insertText}</span>
                    </button>
                  ))}
                </div>
              </details>
              <details className="mermaid-editor-dropdown mermaid-editor-shape-dropdown" ref={relationsDetailsRef}>
                <summary>Relations ▾</summary>
                <div className="mermaid-editor-dropdown-menu" role="listbox" aria-label="Relation symbols">
                  {RELATION_SYMBOLS.map((symbol) => (
                    <button key={symbol.id} type="button" className="latex-editor-symbol-button" role="option" onClick={() => handleInsertSymbol(relationsDetailsRef, symbol.insertText)}>
                      <span className="latex-editor-symbol-glyph">{symbol.display}</span>
                      <span className="latex-editor-symbol-command">{symbol.insertText}</span>
                    </button>
                  ))}
                </div>
              </details>
            </div>
          )}
        </section>

        {latex && (
          <section className="mermaid-editor-preview" aria-label="Live preview">
            <div className="mermaid-editor-pane-label">
              Live preview
              <span className="mermaid-editor-rendered-badge">✓ Rendered</span>
            </div>
            <div className="mermaid-editor-preview-canvas">
              <div className="mermaid-editor-preview-svg-host" style={{ transform: `scale(${zoom / 100})` }} ref={previewRef} />
            </div>
            <div className="mermaid-editor-preview-footer">
              <span className="mermaid-editor-preview-status">{cursorLine ? `Editing · line ${cursorLine}` : ""}</span>
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
        )}
      </div>
    </div>,
    document.body,
  );
}

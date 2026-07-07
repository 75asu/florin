// Runs INSIDE the webview (browser context), bundled separately by esbuild into
// media/editor.js. Wraps CodeMirror 6 with SQL highlighting + schema-aware
// autocomplete, and exposes a tiny API on window for the console's inline script.
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment, Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { sql, PostgreSQL } from '@codemirror/lang-sql';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

export interface FlorinEditorApi {
  getValue(): string;
  getSelection(): string;
  setValue(v: string): void;
  setSchema(schema: Record<string, string[]>): void;
  focus(): void;
}

// Readable on both light and dark backgrounds (webview theme can be either).
const highlight = HighlightStyle.define([
  { tag: t.keyword, color: '#4f9cf9', fontWeight: '600' },
  { tag: [t.string, t.special(t.string)], color: '#4caf50' },
  { tag: t.comment, color: '#8a94a6', fontStyle: 'italic' },
  { tag: [t.number, t.bool, t.null], color: '#c586c0' },
  { tag: [t.function(t.variableName), t.labelName], color: '#c9a26d' },
  { tag: t.operator, color: 'inherit' },
]);

const theme = EditorView.theme({
  '&': {
    color: 'var(--vscode-input-foreground)',
    backgroundColor: 'var(--vscode-input-background)',
    fontSize: 'var(--vscode-editor-font-size, 13px)',
    borderRadius: '6px',
    border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))',
    height: '100%',
  },
  '&.cm-focused': { outline: 'none', borderColor: 'var(--vscode-focusBorder)' },
  '.cm-content': {
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    caretColor: 'var(--vscode-editorCursor-foreground, var(--vscode-foreground))',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--vscode-editorCursor-foreground, var(--vscode-foreground))' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--vscode-editorLineNumber-foreground)',
    border: 'none',
  },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--vscode-editor-selectionBackground)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--vscode-editorSuggestWidget-background, var(--vscode-editorWidget-background))',
    border: '1px solid var(--vscode-editorSuggestWidget-border, var(--vscode-editorWidget-border))',
    color: 'var(--vscode-editorSuggestWidget-foreground, var(--vscode-foreground))',
    borderRadius: '4px',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--vscode-editorSuggestWidget-selectedBackground, var(--vscode-list-activeSelectionBackground))',
    color: 'var(--vscode-editorSuggestWidget-selectedForeground, var(--vscode-list-activeSelectionForeground))',
  },
  '.cm-completionIcon': { opacity: '0.7' },
});

function create(parent: HTMLElement, opts: { doc?: string; onRun: () => void }): FlorinEditorApi {
  const schemaCompartment = new Compartment();

  const runKeymap = Prec.highest(
    keymap.of([
      {
        key: 'Mod-Enter',
        run: () => {
          opts.onRun();
          return true;
        },
      },
    ]),
  );

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: opts.doc ?? '',
      extensions: [
        runKeymap,
        basicSetup,
        schemaCompartment.of(sql({ dialect: PostgreSQL, upperCaseKeywords: false })),
        syntaxHighlighting(highlight),
        theme,
        EditorView.lineWrapping,
      ],
    }),
  });

  return {
    getValue: () => view.state.doc.toString(),
    getSelection: () => {
      const r = view.state.selection.main;
      return view.state.sliceDoc(r.from, r.to);
    },
    setValue: (v: string) =>
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } }),
    setSchema: (schema: Record<string, string[]>) =>
      view.dispatch({
        effects: schemaCompartment.reconfigure(
          sql({ dialect: PostgreSQL, upperCaseKeywords: false, schema }),
        ),
      }),
    focus: () => view.focus(),
  };
}

declare global {
  interface Window {
    FlorinEditor: { create: typeof create };
  }
}

window.FlorinEditor = { create };

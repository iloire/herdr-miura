import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { EditorState, RangeSetBuilder, StateEffect, StateField, type Text } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, highlightSpecialChars, keymap, lineNumbers } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { indentOf } from "../files/edits";
import type { Token } from "../files/highlight";
import { highlightOffThread } from "../files/offThread";

/// A pause in typing, before the file is tokenized again.
const REHIGHLIGHT_MS = 300;

const setColors = StateEffect.define<DecorationSet>();

/// The tokens' colors. Edits carry them along until the next tokens arrive.
const colors = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    const effect = transaction.effects.find((e) => e.is(setColors));
    return effect ? (effect.value as DecorationSet) : value.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

function colorMarks(doc: Text, tokens: Token[][]): DecorationSet {
  const marks = new Map<string, Decoration>();
  const builder = new RangeSetBuilder<Decoration>();
  tokens.slice(0, doc.lines).forEach((line, i) => {
    let at = doc.line(i + 1).from;
    for (const { content, color } of line) {
      if (color && content) {
        let mark = marks.get(color);
        if (!mark) marks.set(color, (mark = Decoration.mark({ attributes: { style: `color: ${color}` } })));
        builder.add(at, at + content.length, mark);
      }
      at += content.length;
    }
  });
  return builder.finish();
}

const look = EditorView.theme({
  "&": { height: "100%", background: "var(--ink)", color: "var(--text)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { font: "calc(12px * var(--ui-scale))/1.55 var(--mono)" },
  ".cm-content": { padding: "8px 0", caretColor: "var(--lantern)" },
  ".cm-gutters": { background: "var(--ink)", color: "var(--faint)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "40px", padding: "0 12px 0 0" },
});

/// A file's text to edit. It takes `text` once: remount it, with a `key`, for
/// other text. File content is untrusted, and here it is drawn as text with
/// control characters as visible marks, not stripped: they must survive a save.
export default function CodeEditor({
  text,
  path,
  lineBreak,
  active,
  onChange,
}: {
  text: string;
  path: string;
  /// The file's line ending, or `null` when it must stay as it is.
  lineBreak: string | null;
  /// Shown, so it takes the keyboard.
  active: boolean;
  onChange: (text: string) => void;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(null);
  const changed = useRef(onChange);
  changed.current = onChange;

  useEffect(() => {
    let stale = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const paint = (editor: EditorView) => {
      const { signal } = stale;
      const doc = editor.state.doc;
      void highlightOffThread(doc.toString(), path, signal).then((tokens) => {
        if (tokens && !signal.aborted) editor.dispatch({ effects: setColors.of(colorMarks(doc, tokens)) });
      });
    };

    const editor = new EditorView({
      parent: parent.current!,
      doc: text,
      extensions: [
        lineNumbers(),
        highlightSpecialChars(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        indentUnit.of(indentOf(text)),
        EditorState.tabSize.of(4),
        EditorState.readOnly.of(lineBreak === null),
        EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
        colors,
        look,
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          changed.current(update.state.doc.sliceString(0, undefined, lineBreak ?? "\n"));
          stale.abort();
          stale = new AbortController();
          clearTimeout(timer);
          timer = setTimeout(() => paint(update.view), REHIGHLIGHT_MS);
        }),
      ],
    });
    view.current = editor;
    paint(editor);
    return () => {
      stale.abort();
      clearTimeout(timer);
      view.current = null;
      editor.destroy();
    };
    // Mounted once per text; see the doc comment.
  }, []);

  useEffect(() => {
    if (active) view.current?.focus();
  }, [active]);

  return <div className="file-editor" ref={parent} hidden={!active} />;
}

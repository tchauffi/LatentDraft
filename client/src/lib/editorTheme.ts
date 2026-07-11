import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/**
 * Light, warm editor theme matching the LatentDraft design:
 * purple control sequences, gray braces, teal environments, gold math.
 */
const theme = EditorView.theme(
  {
    "&": {
      color: "#2b2926",
      backgroundColor: "#fdfcfb",
      fontSize: "12.5px",
    },
    ".cm-content": {
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
      caretColor: "#7c5cff",
      padding: "8px 0 40px",
      lineHeight: "21px",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#7c5cff", borderLeftWidth: "1.5px" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "rgba(124,92,255,0.16)",
    },
    ".cm-gutters": {
      backgroundColor: "#fdfcfb",
      color: "#bdb7ad",
      border: "none",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      padding: "0 14px 0 10px",
      minWidth: "40px",
    },
    ".cm-activeLine": { backgroundColor: "rgba(124,92,255,0.07)" },
    ".cm-activeLineGutter": {
      backgroundColor: "rgba(124,92,255,0.07)",
      color: "#7c5cff",
      fontWeight: "600",
    },
    ".cm-line": { padding: "0 16px" },
    "&.cm-focused": { outline: "none" },
    ".cm-matchingBracket": {
      backgroundColor: "rgba(124,92,255,0.18)",
      color: "inherit",
      outline: "none",
    },
  },
  { dark: false },
);

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.tagName, t.controlKeyword, t.moduleKeyword, t.meta], color: "#8b5cf6" },
  { tag: [t.bracket, t.squareBracket, t.brace, t.paren, t.separator, t.punctuation], color: "#a8a29e" },
  { tag: [t.typeName, t.className, t.namespace, t.labelName], color: "#0e8a9c" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#0e8a9c" },
  { tag: [t.number, t.atom, t.bool, t.unit], color: "#c2870b" },
  { tag: [t.variableName, t.propertyName, t.operator], color: "#b9770a" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#a39b8d", fontStyle: "italic" },
]);

export const latexLight = [theme, syntaxHighlighting(highlight)];

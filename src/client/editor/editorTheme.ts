import { EditorView } from "@codemirror/view";
import { HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { inkChoiceTextTag } from "./inkLanguage";

/**
 * Colors come from CSS custom properties so light/dark switching is pure CSS
 * and the editor never needs reconfiguring when the OS theme flips.
 */

export const inkEditorTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "var(--editor-font-size)",
    color: "var(--color-ink)",
    backgroundColor: "var(--color-paper)",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-editor)",
    fontVariationSettings: '"MONO" 1, "CASL" 0',
    lineHeight: "1.6",
    overscrollBehavior: "contain",
  },
  ".cm-content": { padding: "16px 0 40vh", caretColor: "var(--color-verdigris)" },
  ".cm-line": { padding: "0 20px 0 12px" },
  ".cm-gutters": {
    backgroundColor: "var(--color-paper)",
    color: "var(--color-ink-faint)",
    border: "none",
    borderRight: "1px solid var(--color-rule)",
  },
  ".cm-activeLine": { backgroundColor: "var(--color-active-line)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--color-active-line)", color: "var(--color-ink-soft)" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--color-verdigris)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--color-selection) !important",
  },
  ".cm-searchMatch": { backgroundColor: "var(--color-search-match)", outline: "1px solid var(--color-lamplight)" },
  ".cm-tooltip": {
    backgroundColor: "var(--color-surface)",
    color: "var(--color-ink)",
    border: "1px solid var(--color-rule-strong)",
    borderRadius: "6px",
    fontFamily: "var(--font-ui)",
  },
  ".cm-tooltip-autocomplete > ul > li": { padding: "6px 10px", minHeight: "32px" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--color-verdigris)", color: "var(--color-on-verdigris)" },
  ".cm-diagnostic": { fontFamily: "var(--font-ui)", padding: "6px 10px" },
  ".cm-diagnostic-error": { borderLeftColor: "var(--color-error)" },
  ".cm-diagnostic-warning": { borderLeftColor: "var(--color-lamplight)" },
  ".cm-diagnostic-info": { borderLeftColor: "var(--color-verdigris)" },
  ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--color-error)", textUnderlineOffset: "4px" },
  ".cm-lintRange-warning": { backgroundImage: "none", textDecoration: "underline wavy var(--color-lamplight)", textUnderlineOffset: "4px" },
  ".cm-lintRange-info": { backgroundImage: "none", textDecoration: "underline dotted var(--color-verdigris)", textUnderlineOffset: "4px" },
  // Gutter markers as small dots in the house colors, replacing CodeMirror's default icons.
  ".cm-lint-marker": { width: "8px", height: "8px", margin: "7px 4px 0", borderRadius: "50%" },
  ".cm-lint-marker-info": { content: "normal", backgroundColor: "var(--color-verdigris)" },
  ".cm-lint-marker-warning": { content: "normal", backgroundColor: "var(--color-lamplight)" },
  ".cm-lint-marker-error": { content: "normal", backgroundColor: "var(--color-error)" },
  ".cm-panels": { backgroundColor: "var(--color-surface)", color: "var(--color-ink)" },
  ".cm-panel.cm-search input, .cm-panel.cm-search button": { fontSize: "15px", minHeight: "32px" },
  ".cm-flash-line": { backgroundColor: "var(--color-flash)", transition: "background-color 1.2s ease-out" },
});

export const inkHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, color: "var(--color-verdigris)", fontWeight: "700" },
  { tag: tags.heading2, color: "var(--color-verdigris)", fontWeight: "600" },
  { tag: tags.keyword, color: "var(--color-verdigris-deep)", fontWeight: "600" },
  { tag: tags.operator, color: "var(--color-verdigris)", fontWeight: "600" },
  { tag: tags.labelName, color: "var(--color-verdigris)", textDecoration: "underline", textDecorationColor: "var(--color-rule-strong)" },
  { tag: tags.atom, color: "var(--color-error)", fontWeight: "600" },
  { tag: tags.comment, color: "var(--color-ink-faint)", fontStyle: "italic", fontVariationSettings: '"CASL" 1, "MONO" 1, "slnt" -8' },
  { tag: tags.meta, color: "var(--color-tag)" },
  { tag: tags.brace, color: "var(--color-lamplight-deep)", fontWeight: "700" },
  { tag: tags.squareBracket, color: "var(--color-lamplight-deep)", fontWeight: "700" },
  { tag: tags.variableName, color: "var(--color-lamplight-deep)" },
  { tag: tags.string, color: "var(--color-tag)" },
  { tag: tags.number, color: "var(--color-tag)" },
  { tag: inkChoiceTextTag, color: "var(--color-choice-text)" },
]);

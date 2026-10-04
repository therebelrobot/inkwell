import { StreamLanguage, type StringStream } from "@codemirror/language";
import { Tag } from "@lezer/highlight";

/** Choice text gets its own tag so the theme can tint it like the play pane's choices. */
export const inkChoiceTextTag = Tag.define();

/**
 * Line-oriented ink highlighter. ink's structure is almost entirely decided by
 * what a line starts with (=== knot, = stitch, * + choices, - gathers, ~ logic,
 * VAR/CONST/LIST/INCLUDE/EXTERNAL), so a stream tokenizer with a little state
 * for block comments and brace nesting is enough; no full parser needed.
 */

interface InkTokenizerState {
  insideBlockComment: boolean;
  braceNestingDepth: number;
  insideLogicLine: boolean;
  /** After a choice bullet, text is choice text until the line ends. */
  insideChoiceLine: boolean;
  expectingDivertTarget: boolean;
}

const DECLARATION_KEYWORDS = /^(VAR|CONST|LIST|INCLUDE|EXTERNAL|TODO:)/;
const LOGIC_KEYWORDS = /^(temp|return|not|and|or|true|false|mod|has|hasnt|function|else)\b/;
const BUILT_IN_DIVERT_TARGETS = /^(END|DONE)\b/;
const IDENTIFIER_OR_DOTTED_PATH = /^[\p{L}\p{N}_]+(\.[\p{L}\p{N}_]+)*/u;

function tokenizeInk(stream: StringStream, state: InkTokenizerState): string | null {
  if (stream.sol()) {
    state.insideLogicLine = false;
    state.insideChoiceLine = false;
    state.expectingDivertTarget = false;
  }

  if (state.insideBlockComment) {
    if (stream.skipTo("*/")) {
      stream.match("*/");
      state.insideBlockComment = false;
    } else {
      stream.skipToEnd();
    }
    return "comment";
  }

  if (stream.sol()) {
    stream.eatSpace();
    if (stream.match(/^={2,}.*$/)) return "heading";
    if (stream.match(/^=(?!=)\s*[\p{L}\p{N}_]+.*$/u)) return "heading2";
    if (stream.match(/^([*+]\s*)+/)) {
      state.insideChoiceLine = true;
      return "keyword";
    }
    if (stream.match(/^(-(?!>)\s*)+/)) return "keyword";
    if (stream.match("~")) {
      state.insideLogicLine = true;
      return "keyword";
    }
    if (stream.match(DECLARATION_KEYWORDS)) {
      state.insideLogicLine = true;
      return "keyword";
    }
    if (stream.eol()) return null;
  }

  if (stream.eatSpace()) return null;

  if (state.expectingDivertTarget) {
    state.expectingDivertTarget = false;
    if (stream.match(BUILT_IN_DIVERT_TARGETS)) return "atom";
    if (stream.match(IDENTIFIER_OR_DOTTED_PATH)) return "labelName";
  }

  if (stream.match("//")) {
    stream.skipToEnd();
    return "comment";
  }
  if (stream.match("/*")) {
    state.insideBlockComment = true;
    return "comment";
  }
  if (stream.match("->->") || stream.match("->") || stream.match("<-")) {
    state.expectingDivertTarget = true;
    return "operator";
  }
  if (stream.match("<>")) return "operator";
  if (stream.peek() === "#") {
    // A tag runs to the next tag, the end of the line, or a comment.
    stream.next();
    while (!stream.eol() && stream.peek() !== "#" && !stream.match("//", false)) stream.next();
    return "meta";
  }
  if (stream.peek() === "{") {
    stream.next();
    state.braceNestingDepth += 1;
    return "brace";
  }
  if (stream.peek() === "}") {
    stream.next();
    state.braceNestingDepth = Math.max(0, state.braceNestingDepth - 1);
    return "brace";
  }
  if (state.insideChoiceLine && (stream.peek() === "[" || stream.peek() === "]")) {
    stream.next();
    return "squareBracket";
  }
  if (state.insideChoiceLine && stream.match(/^\(\s*[\p{L}\p{N}_]+\s*\)/u)) return "labelName";

  const inCodeContext = state.insideLogicLine || state.braceNestingDepth > 0;
  if (inCodeContext) {
    if (stream.peek() === '"') {
      stream.next();
      while (!stream.eol() && stream.next() !== '"') {
        /* consume string */
      }
      return "string";
    }
    if (stream.match(/^\d+(\.\d+)?/)) return "number";
    if (stream.match(LOGIC_KEYWORDS)) return "keyword";
    if (stream.match(IDENTIFIER_OR_DOTTED_PATH)) return "variableName";
    if (stream.match(/^(==|!=|<=|>=|&&|\|\||\+=|-=|\+\+|--|[=<>!+\-*/%?:|^])/)) return "operator";
    stream.next();
    return null;
  }

  // Plain prose: consume up to the next character that could start something interesting.
  if (stream.match(/^[^{}#\[\]\-<\/(]+/)) return state.insideChoiceLine ? "inkChoiceText" : null;
  stream.next();
  return state.insideChoiceLine ? "inkChoiceText" : null;
}

export const inkStreamLanguage = StreamLanguage.define<InkTokenizerState>({
  name: "ink",
  startState: () => ({
    insideBlockComment: false,
    braceNestingDepth: 0,
    insideLogicLine: false,
    insideChoiceLine: false,
    expectingDivertTarget: false,
  }),
  copyState: (state) => ({ ...state }),
  token: tokenizeInk,
  // Brace depth must not leak across lines when a brace is left unclosed by mistake.
  blankLine: (state) => {
    state.braceNestingDepth = 0;
  },
  languageData: { commentTokens: { line: "//", block: { open: "/*", close: "*/" } } },
  tokenTable: { inkChoiceText: inkChoiceTextTag },
});

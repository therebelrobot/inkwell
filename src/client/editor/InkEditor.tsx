import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionContext } from "@codemirror/autocomplete";
import { lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { inkStreamLanguage } from "./inkLanguage";
import { inkEditorTheme, inkHighlightStyle } from "./editorTheme";
import type { InkDiagnostic } from "../../shared/inkProjectCompiler";
import type { ProjectWorkspace } from "../workspace/projectWorkspace";
import type { StoryOutline } from "../story/storyOutline";

export interface InkEditorHandle {
  revealLine(lineNumber: number): void;
  insertText(text: string, cursorOffsetFromInsertStart?: number): void;
  focus(): void;
}

interface InkEditorProps {
  workspace: ProjectWorkspace;
  activeFilePath: string;
  diagnosticsForActiveFile: InkDiagnostic[];
  getOutline: () => StoryOutline | null;
  onFocusChange?: (editorHasFocus: boolean) => void;
}

// -- a brief highlight on the line you jumped to (from the map or problems list) ----

const flashLineEffect = StateEffect.define<number | null>();
const flashedLineField = StateField.define({
  create: () => Decoration.none,
  update(decorations, transaction) {
    for (const effect of transaction.effects) {
      if (!effect.is(flashLineEffect)) continue;
      if (effect.value === null) return Decoration.none;
      const lineStart = transaction.state.doc.line(effect.value).from;
      return Decoration.set([Decoration.line({ class: "cm-flash-line" }).range(lineStart)]);
    }
    return decorations.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

// -- iPad smart punctuation ----------------------------------------------------------
//
// iOS "Smart Punctuation" turns " into curly quotes and -- into an em dash as
// you type. In prose that's welcome; in ink syntax it silently breaks things:
// a curly-quoted string in {logic} fails to compile, and "—" at the start of a
// line is no longer a nested gather. So straighten them only where ink reads
// them as syntax: inside {braces}, on ~ logic lines, and at the start of a line.

const SMART_DOUBLE_QUOTES = /[\u201C\u201D]/g;
const SMART_SINGLE_QUOTES = /[\u2018\u2019]/g;

const straightenSmartPunctuationInSyntax = EditorView.inputHandler.of((editorView, from, to, insertedText) => {
  if (!/[\u2018\u2019\u201C\u201D\u2013\u2014]/.test(insertedText)) return false;
  const currentLine = editorView.state.doc.lineAt(from);
  const textBeforeInsert = editorView.state.sliceDoc(currentLine.from, from);
  const insideBraces = textBeforeInsert.lastIndexOf("{") > textBeforeInsert.lastIndexOf("}");
  const onLogicLine = /^\s*~/.test(textBeforeInsert);
  const atLineStartAfterBullets = /^[\s\-*+]*$/.test(textBeforeInsert);
  let correctedText = insertedText;
  if (insideBraces || onLogicLine) {
    correctedText = correctedText.replace(SMART_DOUBLE_QUOTES, '"').replace(SMART_SINGLE_QUOTES, "'");
  }
  if (atLineStartAfterBullets) correctedText = correctedText.replace(/\u2014/g, "- -").replace(/\u2013/g, "-");
  if (correctedText === insertedText) return false;
  editorView.dispatch({ changes: { from, to, insert: correctedText }, selection: { anchor: from + correctedText.length }, userEvent: "input.type" });
  return true;
});

// -- completions: knot/stitch names after a divert, variables inside {} or ~ lines --

function buildCompletionSource(getOutline: () => StoryOutline | null, getAllText: () => string) {
  return (completionContext: CompletionContext) => {
    const outline = getOutline();
    const divertMatch = completionContext.matchBefore(/(->|<-)\s*[\p{L}\p{N}_.]*$/u);
    if (divertMatch && outline) {
      const typedStart = divertMatch.from + divertMatch.text.search(/[\p{L}\p{N}_.]*$/u);
      const divertOptions = [
        { label: "END", type: "keyword", detail: "end the story" },
        { label: "DONE", type: "keyword", detail: "end this flow/thread" },
      ];
      for (const knot of outline.knots) {
        divertOptions.push({ label: knot.name, type: knot.isFunction ? "function" : "class", detail: knot.filePath });
        for (const stitchName of knot.stitchNames) {
          divertOptions.push({ label: `${knot.name}.${stitchName}`, type: "property", detail: "stitch" });
        }
      }
      return { from: typedStart, options: divertOptions, validFor: /^[\p{L}\p{N}_.]*$/u };
    }

    const lineBeforeCursor = completionContext.state.sliceDoc(completionContext.state.doc.lineAt(completionContext.pos).from, completionContext.pos);
    const insideLogic = /^\s*~/.test(lineBeforeCursor) || lineBeforeCursor.lastIndexOf("{") > lineBeforeCursor.lastIndexOf("}");
    const wordMatch = completionContext.matchBefore(/[\p{L}_][\p{L}\p{N}_]*/u);
    if (!insideLogic || !wordMatch || (wordMatch.from === wordMatch.to && !completionContext.explicit)) return null;
    const declaredNames = new Set<string>();
    for (const declarationMatch of getAllText().matchAll(/^\s*(?:VAR|CONST|LIST)\s+([\p{L}\p{N}_]+)/gmu)) declaredNames.add(declarationMatch[1]);
    return {
      from: wordMatch.from,
      options: [...declaredNames].map((variableName) => ({ label: variableName, type: "variable" })),
      validFor: /^[\p{L}\p{N}_]*$/u,
    };
  };
}

function toCodeMirrorDiagnostics(state: EditorState, inkDiagnostics: InkDiagnostic[]): Diagnostic[] {
  return inkDiagnostics.map((inkDiagnostic) => {
    const safeLineNumber = Math.min(Math.max(inkDiagnostic.lineNumber, 1), state.doc.lines);
    const line = state.doc.line(safeLineNumber);
    const firstNonSpaceOffset = line.text.search(/\S|$/);
    return {
      from: line.from + firstNonSpaceOffset,
      to: line.to,
      severity: inkDiagnostic.severity,
      source: inkDiagnostic.ruleId ? `${inkDiagnostic.ruleId}` : "ink",
      message: inkDiagnostic.message,
    };
  });
}

export const InkEditor = forwardRef<InkEditorHandle, InkEditorProps>(function InkEditor(
  { workspace, activeFilePath, diagnosticsForActiveFile, getOutline, onFocusChange },
  forwardedRef,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  // One EditorState per file keeps undo history and cursor when switching tabs.
  const statesByFilePathRef = useRef(new Map<string, EditorState>());
  const activeFilePathRef = useRef(activeFilePath);
  const getOutlineRef = useRef(getOutline);
  getOutlineRef.current = getOutline;
  const onFocusChangeRef = useRef(onFocusChange);
  onFocusChangeRef.current = onFocusChange;

  const sharedExtensionsRef = useRef<Extension[] | null>(null);
  if (!sharedExtensionsRef.current) {
    sharedExtensionsRef.current = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      drawSelection(),
      history(),
      indentUnit.of("    "),
      EditorState.tabSize.of(4),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      highlightSelectionMatches(),
      search({ top: true }),
      inkStreamLanguage,
      syntaxHighlighting(inkHighlightStyle),
      inkEditorTheme,
      EditorView.lineWrapping,
      lintGutter(),
      flashedLineField,
      straightenSmartPunctuationInSyntax,
      autocompletion({
        override: [buildCompletionSource(() => getOutlineRef.current(), () => Object.values(workspace.currentFileTexts()).join("\n"))],
        activateOnTyping: true,
      }),
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            void workspace.saveFile(activeFilePathRef.current);
            return true;
          },
        },
        ...closeBracketsKeymap,
        ...completionKeymap,
        ...searchKeymap,
        ...historyKeymap,
        indentWithTab,
        ...defaultKeymap,
      ]),
      EditorView.updateListener.of((viewUpdate) => {
        if (viewUpdate.docChanged) workspace.updateContent(activeFilePathRef.current, viewUpdate.state.doc.toString());
        if (viewUpdate.focusChanged) onFocusChangeRef.current?.(viewUpdate.view.hasFocus);
      }),
      EditorView.contentAttributes.of({ autocapitalize: "sentences", autocorrect: "on", spellcheck: "true" }),
    ];
  }

  const stateForFile = (filePath: string): EditorState => {
    const existingState = statesByFilePathRef.current.get(filePath);
    if (existingState) return existingState;
    const freshState = EditorState.create({ doc: workspace.getBuffer(filePath)?.content ?? "", extensions: sharedExtensionsRef.current! });
    statesByFilePathRef.current.set(filePath, freshState);
    return freshState;
  };

  useEffect(() => {
    const editorView = new EditorView({ state: stateForFile(activeFilePath), parent: containerRef.current! });
    editorViewRef.current = editorView;
    return () => {
      editorView.destroy();
      editorViewRef.current = null;
    };
    // The view is created once; file switches swap its state below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const editorView = editorViewRef.current;
    if (!editorView || activeFilePathRef.current === activeFilePath) return;
    statesByFilePathRef.current.set(activeFilePathRef.current, editorView.state);
    activeFilePathRef.current = activeFilePath;
    editorView.setState(stateForFile(activeFilePath));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFilePath]);

  // When another device's edit is pulled in, replace the text (clean buffers only, or a "take theirs").
  useEffect(
    () =>
      workspace.onExternalReplacement((replacedFilePath, replacementContent) => {
        const editorView = editorViewRef.current;
        if (editorView && replacedFilePath === activeFilePathRef.current) {
          if (editorView.state.doc.toString() !== replacementContent) {
            editorView.dispatch({ changes: { from: 0, to: editorView.state.doc.length, insert: replacementContent } });
          }
        } else {
          statesByFilePathRef.current.delete(replacedFilePath);
        }
      }),
    [workspace],
  );

  useEffect(() => {
    const editorView = editorViewRef.current;
    if (!editorView) return;
    editorView.dispatch(setDiagnostics(editorView.state, toCodeMirrorDiagnostics(editorView.state, diagnosticsForActiveFile)));
  }, [diagnosticsForActiveFile, activeFilePath]);

  useImperativeHandle(forwardedRef, () => ({
    revealLine(lineNumber: number) {
      const editorView = editorViewRef.current;
      if (!editorView) return;
      const safeLineNumber = Math.min(Math.max(lineNumber, 1), editorView.state.doc.lines);
      const targetLine = editorView.state.doc.line(safeLineNumber);
      editorView.dispatch({
        selection: { anchor: targetLine.from },
        effects: [EditorView.scrollIntoView(targetLine.from, { y: "center" }), flashLineEffect.of(safeLineNumber)],
      });
      window.setTimeout(() => editorViewRef.current?.dispatch({ effects: flashLineEffect.of(null) }), 1400);
      // With a mouse, put the caret there so you can type straight away. On touch, focusing
      // would throw up the on-screen keyboard over the line you just asked to see.
      if (!window.matchMedia("(pointer: coarse)").matches) editorView.focus();
    },
    insertText(text: string, cursorOffsetFromInsertStart?: number) {
      const editorView = editorViewRef.current;
      if (!editorView) return;
      const { from, to } = editorView.state.selection.main;
      editorView.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + (cursorOffsetFromInsertStart ?? text.length) },
        scrollIntoView: true,
      });
      editorView.focus();
    },
    focus() {
      editorViewRef.current?.focus();
    },
  }));

  return <div className="ink-editor" ref={containerRef} />;
});

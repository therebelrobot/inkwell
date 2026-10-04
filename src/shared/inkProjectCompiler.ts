import { Compiler, CompilerOptions } from "inkjs/full";
import type { Story } from "inkjs/full";
import { directoryOfProjectRelativePath, joinProjectRelativePaths } from "./projectPaths";

/**
 * Compiles a whole multi-file project from an in-memory map, used by both the
 * browser (live, on every pause in typing, unsaved buffers included) and the
 * server (JSON export). Same code on both sides means "it compiled in the
 * editor" and "the exported JSON" can't disagree.
 */

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface InkDiagnostic {
  severity: DiagnosticSeverity;
  filePath: string;
  /** 1-based; 0 when the compiler gave no line. */
  lineNumber: number;
  message: string;
  source: "compiler" | "linter";
  ruleId?: string;
}

export interface ProjectCompilationResult {
  story: Story | null;
  compiledJson: string | null;
  diagnostics: InkDiagnostic[];
}

// inkjs messages look like: ERROR: 'chapters/one.ink' line 3: Divert target not found: '-> nowhere'
const COMPILER_MESSAGE_PATTERN = /^(?:(ERROR|WARNING|TODO|RUNTIME ERROR|RUNTIME WARNING):\s*)?(?:'([^']+)'\s+)?(?:line\s+(\d+):\s*)?([\s\S]*)$/;

// inkjs ErrorType enum: 0 Author (TODO), 1 Warning, 2 Error
function severityFromErrorType(errorTypeNumber: number): DiagnosticSeverity {
  if (errorTypeNumber === 2) return "error";
  if (errorTypeNumber === 1) return "warning";
  return "info";
}

export function parseCompilerMessage(rawMessage: string, errorTypeNumber: number, mainFilePath: string): InkDiagnostic {
  const messageMatch = COMPILER_MESSAGE_PATTERN.exec(rawMessage.trim());
  return {
    severity: severityFromErrorType(errorTypeNumber),
    filePath: messageMatch?.[2] ?? mainFilePath,
    lineNumber: messageMatch?.[3] ? Number.parseInt(messageMatch[3], 10) : 0,
    message: (messageMatch?.[4] ?? rawMessage).trim(),
    source: "compiler",
  };
}

function findIncludeLineNumber(fileText: string | undefined, includedName: string): number {
  if (fileText === undefined) return 0;
  const lineIndex = fileText.split(/\r?\n/).findIndex((lineText) => /^\s*INCLUDE\s+/.test(lineText) && lineText.includes(includedName));
  return lineIndex === -1 ? 0 : lineIndex + 1;
}

export function compileInkProject(filesByPath: Record<string, string>, mainFilePath: string): ProjectCompilationResult {
  const diagnostics: InkDiagnostic[] = [];
  const mainFileText = filesByPath[mainFilePath];
  if (mainFileText === undefined) {
    return {
      story: null,
      compiledJson: null,
      diagnostics: [{ severity: "error", filePath: mainFilePath, lineNumber: 0, message: "Main file not found", source: "compiler" }],
    };
  }

  // ink resolves every INCLUDE relative to the main file's folder, not the including file's.
  const includeBaseDirectory = directoryOfProjectRelativePath(mainFilePath);
  const inMemoryFileHandler = {
    ResolveInkFilename: (includedName: string) => joinProjectRelativePaths(includeBaseDirectory, includedName),
    LoadInkFileContents: (resolvedPath: string, includingFilePath?: string | null) => {
      const includedText = filesByPath[resolvedPath];
      if (includedText !== undefined) return includedText;
      const includingFile = includingFilePath ?? mainFilePath;
      diagnostics.push({
        severity: "error",
        filePath: includingFile,
        lineNumber: findIncludeLineNumber(filesByPath[includingFile], resolvedPath.split("/").pop() ?? resolvedPath),
        message: `INCLUDE target not found: ${resolvedPath}`,
        source: "compiler",
      });
      return "";
    },
  };

  const compilerOptions = new CompilerOptions(
    mainFilePath,
    [],
    false,
    (rawMessage: string, errorTypeNumber: number) => {
      diagnostics.push(parseCompilerMessage(rawMessage, errorTypeNumber, mainFilePath));
    },
    inMemoryFileHandler,
  );

  let compiledStory: Story | null = null;
  try {
    compiledStory = new Compiler(mainFileText, compilerOptions).Compile();
  } catch (compileFailure) {
    const failureMessage = compileFailure instanceof Error ? compileFailure.message : String(compileFailure);
    // "Compilation failed." just summarizes errors already reported through the handler.
    if (!diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      diagnostics.push({ severity: "error", filePath: mainFilePath, lineNumber: 0, message: failureMessage, source: "compiler" });
    }
    compiledStory = null;
  }

  const hasErrors = diagnostics.some((diagnostic) => diagnostic.severity === "error");
  const compiledJson = compiledStory && !hasErrors ? (compiledStory.ToJson() as string) : null;
  return { story: hasErrors ? null : compiledStory, compiledJson, diagnostics };
}

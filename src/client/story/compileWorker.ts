/// <reference lib="webworker" />
import { compileInkProject, type InkDiagnostic } from "../../shared/inkProjectCompiler";
import { analyseStory } from "../../shared/inkLinter";

/**
 * Compiling runs off the main thread: inkjs's compiler is synchronous and a
 * long story can take long enough to make typing stutter on an iPad.
 */

export interface CompileRequest {
  requestId: number;
  fileTextByPath: Record<string, string>;
  mainFilePath: string;
}

export interface CompileResponse {
  requestId: number;
  compiledJson: string | null;
  diagnostics: InkDiagnostic[];
  compileDurationMilliseconds: number;
}

self.onmessage = (messageEvent: MessageEvent<CompileRequest>) => {
  const { requestId, fileTextByPath, mainFilePath } = messageEvent.data;
  const compileStartedAt = performance.now();
  const compilationResult = compileInkProject(fileTextByPath, mainFilePath);

  let linterDiagnostics: InkDiagnostic[] = [];
  try {
    linterDiagnostics = analyseStory(mainFilePath, (filePath) => fileTextByPath[filePath])
      .filter((finding) => finding.ruleId !== "IO") // the compiler already reports missing INCLUDEs
      .map((finding) => ({
        severity: finding.severity,
        filePath: finding.filePath,
        lineNumber: finding.lineNumber,
        message: finding.message,
        source: "linter" as const,
        ruleId: finding.ruleId,
      }));
  } catch (linterFailure) {
    console.warn("ink linter failed", linterFailure);
  }

  const compileResponse: CompileResponse = {
    requestId,
    compiledJson: compilationResult.compiledJson,
    diagnostics: [...compilationResult.diagnostics, ...linterDiagnostics],
    compileDurationMilliseconds: Math.round(performance.now() - compileStartedAt),
  };
  self.postMessage(compileResponse);
};

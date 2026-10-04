/**
 * Ported from the ink-narrative skill's scripts/check-ink.ts: identical rules,
 * but file loading goes through a callback so it runs in the browser against
 * the editor's in-memory buffers (unsaved edits included).
 */
/**
 * check-ink.ts — zero-dependency static linter for ink (.ink) stories.
 *
 * Catches runtime hazards that the ink compiler accepts silently (each one was
 * reproduced in inkjs 2.4.0). It is line-based and heuristic: it does not
 * evaluate conditions. Confirm doubtful findings with run-ink.ts --explore.
 *
 * Usage:
 *   node scripts/check-ink.ts path/to/main.ink [--json] [--quiet-info]
 *
 * Exit code: 1 if any error-severity finding, 2 on usage/IO problems, else 0.
 *
 * Rules:
 *   INK001 error    single "=" used as a comparison inside {...:}
 *   INK002 warning  loop whose choices are all once-only with no sticky, fallback or exit
 *   INK003 warning  tunnel target that never returns with ->->
 *   INK004 warning  thread target whose top-level flow reaches -> END
 *   INK005 info     EXTERNAL without an ink fallback function
 *   INK006 info     knot or stitch that nothing diverts, tunnels or threads to
 *   INK007 warning  {variable} printing a divert-target variable
 */

import { normalizeProjectRelativePath, directoryOfProjectRelativePath, joinProjectRelativePaths } from "./projectPaths";

/** Returns file text for a project-relative path, or undefined when the file does not exist. */
export type ReadProjectFileText = (projectRelativePath: string) => string | undefined;

export type Severity = "error" | "warning" | "info";

export interface Finding {
  ruleId: string;
  severity: Severity;
  filePath: string;
  lineNumber: number;
  message: string;
}

interface SourceLine {
  filePath: string;
  lineNumber: number;
  codeText: string; // comment-stripped, trimmed
}

type ScopeKind = "root" | "knot" | "function" | "stitch";

interface Scope {
  kind: ScopeKind;
  knotName: string; // owning knot ("" for root)
  stitchName: string; // "" unless kind === "stitch"
  headerLine: SourceLine | null;
  bodyLines: SourceLine[];
}

interface DivertReference {
  targetName: string;
  kind: "flow" | "tunnel-call" | "tunnel-return-redirect" | "value" | "thread";
  sourceLine: SourceLine;
  owningKnotName: string;
}

// ink identifiers may start with a digit ("2tests") but must contain a letter or underscore.
const IDENTIFIER_PATTERN = String.raw`[\p{L}\p{N}_]*[\p{L}_][\p{L}\p{N}_]*`;
const DOTTED_IDENTIFIER_PATTERN = String.raw`${IDENTIFIER_PATTERN}(?:\.${IDENTIFIER_PATTERN})*`;
const KNOT_HEADER_REGEX = new RegExp(
  String.raw`^={2,}\s*(function\s+)?(${IDENTIFIER_PATTERN})\s*(\([^)]*\))?\s*=*\s*$`,
  "u",
);
const STITCH_HEADER_REGEX = new RegExp(String.raw`^=(?!=)\s*(${IDENTIFIER_PATTERN})\s*(\([^)]*\))?\s*$`, "u");
const CHOICE_BULLETS_REGEX = /^((?:[*+]\s*)+)/;
const GATHER_BULLETS_REGEX = /^((?:-(?!>)\s*)+)/;
const LABEL_AT_START_REGEX = new RegExp(String.raw`^\(\s*(${IDENTIFIER_PATTERN})\s*\)`, "u");
const INCLUDE_REGEX = /^INCLUDE\s+(.+?)\s*$/;
const EXTERNAL_REGEX = new RegExp(String.raw`^EXTERNAL\s+(${IDENTIFIER_PATTERN})\s*\(`, "u");
const VARIABLE_DECLARATION_REGEX = new RegExp(String.raw`^(?:VAR|CONST)\s+(${IDENTIFIER_PATTERN})\s*=\s*(.*)$`, "u");
const ASSIGNMENT_IN_CONDITION_REGEX = new RegExp(
  String.raw`\{\s*(?:not\s+)?(${DOTTED_IDENTIFIER_PATTERN})\s*=(?!=)[^{}]*?:`,
  "u",
);
const BUILT_IN_DIVERT_TARGETS = new Set(["END", "DONE"]);

// ---------------------------------------------------------------------------
// Loading and comment stripping
// ---------------------------------------------------------------------------

function loadStoryLines(mainFilePath: string, readProjectFileText: ReadProjectFileText, findings: Finding[]): SourceLine[] {
  const collectedLines: SourceLine[] = [];
  const visitedFilePaths = new Set<string>();

  function loadFile(absoluteFilePath: string, includedFrom: SourceLine | null): void {
    if (visitedFilePaths.has(absoluteFilePath)) return;
    visitedFilePaths.add(absoluteFilePath);
    const fileTextOrUndefined = readProjectFileText(absoluteFilePath);
    if (fileTextOrUndefined === undefined) {
      findings.push({
        ruleId: "IO",
        severity: "error",
        filePath: includedFrom?.filePath ?? absoluteFilePath,
        lineNumber: includedFrom?.lineNumber ?? 0,
        message: `Cannot read included file ${absoluteFilePath}`,
      });
      return;
    }
    const rawText = fileTextOrUndefined.replace(/^\uFEFF/, "");
    const rawLines = rawText.split(/\r?\n/);
    let insideBlockComment = false;
    const pendingIncludes: { includePath: string; sourceLine: SourceLine }[] = [];

    rawLines.forEach((rawLine, zeroBasedIndex) => {
      const strippedResult = stripComments(rawLine, insideBlockComment);
      insideBlockComment = strippedResult.stillInsideBlockComment;
      let codeText = strippedResult.codeText.trim();
      if (/^TODO:/.test(codeText)) codeText = "";
      const sourceLine: SourceLine = { filePath: absoluteFilePath, lineNumber: zeroBasedIndex + 1, codeText };
      const includeMatch = INCLUDE_REGEX.exec(codeText);
      if (includeMatch) {
        pendingIncludes.push({ includePath: includeMatch[1], sourceLine });
        return;
      }
      collectedLines.push(sourceLine);
    });

    // ink resolves INCLUDE paths relative to the main file's folder.
    const includeBaseFolder = directoryOfProjectRelativePath(normalizeProjectRelativePath(mainFilePath));
    for (const pendingInclude of pendingIncludes) {
      loadFile(joinProjectRelativePaths(includeBaseFolder, pendingInclude.includePath), pendingInclude.sourceLine);
    }
  }

  loadFile(normalizeProjectRelativePath(mainFilePath), null);
  return collectedLines;
}

function stripComments(
  rawLine: string,
  startsInsideBlockComment: boolean,
): { codeText: string; stillInsideBlockComment: boolean } {
  let codeText = "";
  let insideBlockComment = startsInsideBlockComment;
  let insideStringLiteral = false;
  for (let characterIndex = 0; characterIndex < rawLine.length; characterIndex++) {
    const currentCharacter = rawLine[characterIndex];
    const nextCharacter = rawLine[characterIndex + 1];
    if (insideBlockComment) {
      if (currentCharacter === "*" && nextCharacter === "/") {
        insideBlockComment = false;
        characterIndex++;
      }
      continue;
    }
    if (currentCharacter === "\\" && nextCharacter !== undefined) {
      codeText += currentCharacter + nextCharacter;
      characterIndex++;
      continue;
    }
    if (currentCharacter === '"') insideStringLiteral = !insideStringLiteral;
    if (!insideStringLiteral && currentCharacter === "/" && nextCharacter === "/") break;
    if (!insideStringLiteral && currentCharacter === "/" && nextCharacter === "*") {
      insideBlockComment = true;
      characterIndex++;
      continue;
    }
    codeText += currentCharacter;
  }
  return { codeText, stillInsideBlockComment: insideBlockComment };
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

function buildScopes(storyLines: SourceLine[]): Scope[] {
  const scopes: Scope[] = [];
  let currentScope: Scope = { kind: "root", knotName: "", stitchName: "", headerLine: null, bodyLines: [] };
  scopes.push(currentScope);
  let currentKnotName = "";
  let currentKnotIsFunction = false;

  for (const sourceLine of storyLines) {
    const knotMatch = KNOT_HEADER_REGEX.exec(sourceLine.codeText);
    if (knotMatch) {
      currentKnotName = knotMatch[2];
      currentKnotIsFunction = Boolean(knotMatch[1]);
      currentScope = {
        kind: currentKnotIsFunction ? "function" : "knot",
        knotName: currentKnotName,
        stitchName: "",
        headerLine: sourceLine,
        bodyLines: [],
      };
      scopes.push(currentScope);
      continue;
    }
    const stitchMatch = STITCH_HEADER_REGEX.exec(sourceLine.codeText);
    if (stitchMatch && currentKnotName !== "" && !currentKnotIsFunction) {
      currentScope = {
        kind: "stitch",
        knotName: currentKnotName,
        stitchName: stitchMatch[1],
        headerLine: sourceLine,
        bodyLines: [],
      };
      scopes.push(currentScope);
      continue;
    }
    currentScope.bodyLines.push(sourceLine);
  }
  return scopes;
}

function choiceDepthOf(codeText: string): { depth: number; isSticky: boolean; afterBullets: string } | null {
  const bulletMatch = CHOICE_BULLETS_REGEX.exec(codeText);
  if (!bulletMatch) return null;
  const bulletCharacters = bulletMatch[1].replace(/\s/g, "");
  return {
    depth: bulletCharacters.length,
    isSticky: bulletCharacters.includes("+"),
    afterBullets: codeText.slice(bulletMatch[0].length),
  };
}

function gatherDepthOf(codeText: string): { depth: number; afterBullets: string } | null {
  const bulletMatch = GATHER_BULLETS_REGEX.exec(codeText);
  if (!bulletMatch) return null;
  return { depth: bulletMatch[1].replace(/\s/g, "").length, afterBullets: codeText.slice(bulletMatch[0].length) };
}

function stripLeadingLabelAndConditions(textAfterBullets: string): { labelName: string; remainingText: string } {
  let remainingText = textAfterBullets.trim();
  let labelName = "";
  const labelMatch = LABEL_AT_START_REGEX.exec(remainingText);
  if (labelMatch) {
    labelName = labelMatch[1];
    remainingText = remainingText.slice(labelMatch[0].length).trim();
  }
  // Choice conditions: one or more {...} groups before the text.
  while (remainingText.startsWith("{")) {
    const closingIndex = findMatchingBrace(remainingText, 0);
    if (closingIndex < 0) break;
    remainingText = remainingText.slice(closingIndex + 1).trim();
  }
  return { labelName, remainingText };
}

function findMatchingBrace(text: string, openingIndex: number): number {
  let braceDepth = 0;
  for (let characterIndex = openingIndex; characterIndex < text.length; characterIndex++) {
    if (text[characterIndex] === "\\") {
      characterIndex++;
      continue;
    }
    if (text[characterIndex] === "{") braceDepth++;
    if (text[characterIndex] === "}") {
      braceDepth--;
      if (braceDepth === 0) return characterIndex;
    }
  }
  return -1;
}

/** Extract every divert-ish reference on a line. */
function extractDivertReferences(sourceLine: SourceLine, owningKnotName: string): DivertReference[] {
  const references: DivertReference[] = [];
  const codeText = sourceLine.codeText;

  const threadRegex = new RegExp(String.raw`<-\s*(${DOTTED_IDENTIFIER_PATTERN})`, "gu");
  for (const threadMatch of codeText.matchAll(threadRegex)) {
    references.push({ targetName: threadMatch[1], kind: "thread", sourceLine, owningKnotName });
  }

  const TUNNEL_RETURN_SENTINEL = "\u0000";
  const textWithSentinels = codeText.replace(/->\s*->/g, TUNNEL_RETURN_SENTINEL).replace(/<-/g, "  ");
  // Walk arrows left to right, carrying whether the previous token was a tunnel return.
  const arrowRegex = new RegExp(String.raw`(\u0000|->)\s*(\(\s*)?(${DOTTED_IDENTIFIER_PATTERN})?`, "gu");
  const arrowMatches = [...textWithSentinels.matchAll(arrowRegex)];
  arrowMatches.forEach((arrowMatch, arrowIndex) => {
    const arrowToken = arrowMatch[1];
    const targetName = arrowMatch[3];
    if (!targetName) return;
    const arrowStartIndex = arrowMatch.index ?? 0;
    if (arrowToken === TUNNEL_RETURN_SENTINEL) {
      references.push({ targetName, kind: "tunnel-return-redirect", sourceLine, owningKnotName });
      return;
    }
    // Value references: "-> x" used as an argument or assigned: preceded by "(", "," or "=".
    const textBeforeArrow = textWithSentinels.slice(0, arrowStartIndex).trimEnd();
    const precedingCharacter = textBeforeArrow.slice(-1);
    if (precedingCharacter === "(" || precedingCharacter === "," || precedingCharacter === "=") {
      references.push({ targetName, kind: "value", sourceLine, owningKnotName });
      return;
    }
    // Tunnel call: target (with optional args) immediately followed by another "->" (not a tunnel return).
    let textAfterTarget = textWithSentinels.slice(arrowStartIndex + arrowMatch[0].length);
    if (textAfterTarget.trimStart().startsWith("(")) {
      const argumentsStart = textAfterTarget.indexOf("(");
      let parenthesisDepth = 0;
      let argumentsEnd = -1;
      for (let characterIndex = argumentsStart; characterIndex < textAfterTarget.length; characterIndex++) {
        if (textAfterTarget[characterIndex] === "(") parenthesisDepth++;
        if (textAfterTarget[characterIndex] === ")") {
          parenthesisDepth--;
          if (parenthesisDepth === 0) {
            argumentsEnd = characterIndex;
            break;
          }
        }
      }
      if (argumentsEnd >= 0) textAfterTarget = textAfterTarget.slice(argumentsEnd + 1);
    }
    const isTunnelCall = textAfterTarget.trimStart().startsWith("->");
    references.push({ targetName, kind: isTunnelCall ? "tunnel-call" : "flow", sourceLine, owningKnotName });
    void arrowIndex;
  });
  return references;
}

// ---------------------------------------------------------------------------
// Main analysis
// ---------------------------------------------------------------------------

export function analyseStory(mainFilePath: string, readProjectFileText: ReadProjectFileText): Finding[] {
  const findings: Finding[] = [];
  const storyLines = loadStoryLines(mainFilePath, readProjectFileText, findings);
  const scopes = buildScopes(storyLines);

  const knotNames = new Set<string>();
  const functionNames = new Set<string>();
  const stitchNamesByKnot = new Map<string, string[]>();
  const knotScopesByName = new Map<string, Scope[]>(); // knot + its stitches, in order
  for (const scope of scopes) {
    if (scope.kind === "knot") knotNames.add(scope.knotName);
    if (scope.kind === "function") functionNames.add(scope.knotName);
    if (scope.kind === "stitch") {
      const existingStitchNames = stitchNamesByKnot.get(scope.knotName) ?? [];
      existingStitchNames.push(scope.stitchName);
      stitchNamesByKnot.set(scope.knotName, existingStitchNames);
    }
    if (scope.kind !== "root") {
      const knotScopeList = knotScopesByName.get(scope.knotName) ?? [];
      knotScopeList.push(scope);
      knotScopesByName.set(scope.knotName, knotScopeList);
    }
  }

  /** Resolve a reference to "knot" or "knot.stitch"; null when it is a label, variable or unknown. */
  function resolveTarget(targetName: string, owningKnotName: string): string | null {
    if (BUILT_IN_DIVERT_TARGETS.has(targetName)) return targetName;
    const nameParts = targetName.split(".");
    if (nameParts.length >= 2) {
      const [knotPart, stitchPart] = nameParts;
      if ((stitchNamesByKnot.get(knotPart) ?? []).includes(stitchPart)) return `${knotPart}.${stitchPart}`;
      if (knotNames.has(knotPart)) return knotPart; // knot.label
      return null;
    }
    if ((stitchNamesByKnot.get(owningKnotName) ?? []).includes(targetName)) return `${owningKnotName}.${targetName}`;
    if (knotNames.has(targetName) || functionNames.has(targetName)) return targetName;
    return null;
  }

  // Collect all references.
  const allReferences: DivertReference[] = [];
  const divertTargetVariableNames = new Set<string>();
  const externalDeclarations: { functionName: string; sourceLine: SourceLine }[] = [];
  for (const scope of scopes) {
    for (const sourceLine of scope.bodyLines) {
      allReferences.push(...extractDivertReferences(sourceLine, scope.knotName));
      const externalMatch = EXTERNAL_REGEX.exec(sourceLine.codeText);
      if (externalMatch) externalDeclarations.push({ functionName: externalMatch[1], sourceLine });
      const declarationMatch = VARIABLE_DECLARATION_REGEX.exec(sourceLine.codeText);
      if (declarationMatch && declarationMatch[2].trim().startsWith("->")) {
        divertTargetVariableNames.add(declarationMatch[1]);
      }
    }
  }

  // INK001 — assignment used as a comparison.
  for (const sourceLine of storyLines) {
    if (sourceLine.codeText.startsWith("~")) continue;
    const assignmentMatch = ASSIGNMENT_IN_CONDITION_REGEX.exec(sourceLine.codeText);
    if (assignmentMatch) {
      findings.push({
        ruleId: "INK001",
        severity: "error",
        filePath: sourceLine.filePath,
        lineNumber: sourceLine.lineNumber,
        message: `"{${assignmentMatch[1]} = …:" uses "=" — ink comparisons need "==". Inline with "|" this silently prints as a sequence; other forms fail to compile with a confusing message.`,
      });
    }
  }

  // INK002 — loops that can run out of choices.
  for (const scope of scopes) {
    if (scope.kind === "function") continue;
    checkLoopExhaustion(scope, findings, resolveTarget);
  }

  /**
   * A tunnel can return if "->->" appears in the target or in anything it reaches by plain
   * diverts, threads or "->-> redirect" (not via nested tunnel calls, whose ->-> returns
   * from the nested call instead).
   */
  function tunnelCanReturn(startTarget: string): boolean {
    const targetsToVisit = [startTarget];
    const visitedTargets = new Set<string>();
    while (targetsToVisit.length > 0) {
      const currentTarget = targetsToVisit.pop()!;
      if (visitedTargets.has(currentTarget) || BUILT_IN_DIVERT_TARGETS.has(currentTarget)) continue;
      visitedTargets.add(currentTarget);
      const targetLines = linesForTarget(currentTarget, knotScopesByName);
      if (targetLines.some((sourceLine) => /->\s*->/.test(sourceLine.codeText))) return true;
      const owningKnotName = currentTarget.split(".")[0];
      for (const sourceLine of targetLines) {
        for (const reference of extractDivertReferences(sourceLine, owningKnotName)) {
          if (reference.kind === "tunnel-call") continue;
          const resolvedNext = resolveTarget(reference.targetName, owningKnotName);
          if (resolvedNext && !functionNames.has(resolvedNext)) targetsToVisit.push(resolvedNext);
        }
      }
    }
    return false;
  }

  // INK003 — tunnels that never return.
  const reportedTunnelTargets = new Set<string>();
  for (const reference of allReferences) {
    if (reference.kind !== "tunnel-call") continue;
    const resolvedTarget = resolveTarget(reference.targetName, reference.owningKnotName);
    if (!resolvedTarget || BUILT_IN_DIVERT_TARGETS.has(resolvedTarget) || functionNames.has(resolvedTarget)) continue;
    if (reportedTunnelTargets.has(resolvedTarget)) continue;
    if (!tunnelCanReturn(resolvedTarget)) {
      reportedTunnelTargets.add(resolvedTarget);
      findings.push({
        ruleId: "INK003",
        severity: "warning",
        filePath: reference.sourceLine.filePath,
        lineNumber: reference.sourceLine.lineNumber,
        message: `"-> ${reference.targetName} ->" calls a tunnel, but no "->->" is reachable from ${resolvedTarget} (checked through its diverts and threads) — the call never returns.`,
      });
    }
  }

  // INK004 — threads that end the story.
  const reportedThreadTargets = new Set<string>();
  for (const reference of allReferences) {
    if (reference.kind !== "thread") continue;
    const resolvedTarget = resolveTarget(reference.targetName, reference.owningKnotName);
    if (!resolvedTarget || reportedThreadTargets.has(resolvedTarget)) continue;
    const endingLine = findTopLevelEnd(linesForTarget(resolvedTarget, knotScopesByName));
    if (endingLine) {
      reportedThreadTargets.add(resolvedTarget);
      findings.push({
        ruleId: "INK004",
        severity: "warning",
        filePath: endingLine.filePath,
        lineNumber: endingLine.lineNumber,
        message: `${resolvedTarget} is used as a thread ("<- ${reference.targetName}" at line ${reference.sourceLine.lineNumber}) but its top-level flow reaches "-> END", which ends the whole story before the main thread's choices appear. Use "-> DONE".`,
      });
    }
  }

  // INK005 — EXTERNAL without fallback.
  for (const externalDeclaration of externalDeclarations) {
    if (!functionNames.has(externalDeclaration.functionName)) {
      findings.push({
        ruleId: "INK005",
        severity: "info",
        filePath: externalDeclaration.sourceLine.filePath,
        lineNumber: externalDeclaration.sourceLine.lineNumber,
        message: `EXTERNAL ${externalDeclaration.functionName} has no ink fallback "=== function ${externalDeclaration.functionName}(…) ===". Inky and test runs cannot play past it.`,
      });
    }
  }

  // INK006 — unreachable knots and stitches.
  const referencedTargets = new Set<string>();
  for (const reference of allReferences) {
    const resolvedTarget = resolveTarget(reference.targetName, reference.owningKnotName);
    if (resolvedTarget) referencedTargets.add(resolvedTarget);
  }
  for (const scope of scopes) {
    if (scope.kind === "knot" && !referencedTargets.has(scope.knotName)) {
      const knotIsReachedViaStitch = [...referencedTargets].some((target) => target.startsWith(`${scope.knotName}.`));
      if (!knotIsReachedViaStitch) {
        findings.push({
          ruleId: "INK006",
          severity: "info",
          filePath: scope.headerLine!.filePath,
          lineNumber: scope.headerLine!.lineNumber,
          message: `Knot ${scope.knotName} is never diverted, tunnelled or threaded to. Fine if the game enters it with ChoosePathString("${scope.knotName}").`,
        });
      }
    }
    if (scope.kind === "stitch") {
      const fullStitchPath = `${scope.knotName}.${scope.stitchName}`;
      const knotScopeList = knotScopesByName.get(scope.knotName) ?? [];
      const knotHeaderScope = knotScopeList[0];
      const isFirstStitch = knotScopeList.find((candidate) => candidate.kind === "stitch") === scope;
      const knotHasPreStitchContent = knotHeaderScope.bodyLines.some((sourceLine) => sourceLine.codeText !== "" && !sourceLine.codeText.startsWith("#"));
      const reachedAsDefaultStitch = isFirstStitch && !knotHasPreStitchContent && referencedTargets.has(scope.knotName);
      if (!referencedTargets.has(fullStitchPath) && !reachedAsDefaultStitch) {
        findings.push({
          ruleId: "INK006",
          severity: "info",
          filePath: scope.headerLine!.filePath,
          lineNumber: scope.headerLine!.lineNumber,
          message: `Stitch ${fullStitchPath} is never diverted to${isFirstStitch && knotHasPreStitchContent ? " (content before it in the knot does not fall into it)" : ""}.`,
        });
      }
    }
  }

  // INK007 — printing divert-target variables.
  for (const sourceLine of storyLines) {
    for (const variableName of divertTargetVariableNames) {
      if (new RegExp(String.raw`\{\s*${variableName}\s*\}`, "u").test(sourceLine.codeText)) {
        findings.push({
          ruleId: "INK007",
          severity: "warning",
          filePath: sourceLine.filePath,
          lineNumber: sourceLine.lineNumber,
          message: `{${variableName}} prints a divert-target value as "DivertTargetValue(…)", not readable text.`,
        });
      }
    }
  }

  return findings;
}

function linesForTarget(resolvedTarget: string, knotScopesByName: Map<string, Scope[]>): SourceLine[] {
  const [knotPart, stitchPart] = resolvedTarget.split(".");
  const knotScopeList = knotScopesByName.get(knotPart) ?? [];
  if (stitchPart) {
    return knotScopeList.find((scope) => scope.stitchName === stitchPart)?.bodyLines ?? [];
  }
  return knotScopeList.flatMap((scope) => scope.bodyLines);
}

/** First "-> END" that is not inside a choice body. */
function findTopLevelEnd(targetLines: SourceLine[]): SourceLine | null {
  let insideChoiceBody = false;
  for (const sourceLine of targetLines) {
    if (choiceDepthOf(sourceLine.codeText)) {
      insideChoiceBody = true;
      continue;
    }
    const gatherInfo = gatherDepthOf(sourceLine.codeText);
    if (gatherInfo && gatherInfo.depth === 1) insideChoiceBody = false;
    if (!insideChoiceBody && /->\s*END\b/.test(sourceLine.codeText)) return sourceLine;
  }
  return null;
}

type ResolveTargetFunction = (targetName: string, owningKnotName: string) => string | null;

function checkLoopExhaustion(scope: Scope, findings: Finding[], resolveTarget: ResolveTargetFunction): void {
  const scopeLines = scope.bodyLines.filter((sourceLine) => sourceLine.codeText !== "");
  const firstChoiceIndex = scopeLines.findIndex((sourceLine) => choiceDepthOf(sourceLine.codeText));
  if (firstChoiceIndex < 0) return;

  // Names that mean "back to before this choice point".
  const loopTargetNames = new Set<string>();
  if (scope.kind === "knot") loopTargetNames.add(scope.knotName);
  if (scope.kind === "stitch") loopTargetNames.add(`${scope.knotName}.${scope.stitchName}`);
  if (scope.kind === "root") return; // root loops are rare; skip
  for (let lineIndex = 0; lineIndex <= firstChoiceIndex; lineIndex++) {
    const codeText = scopeLines[lineIndex].codeText;
    const gatherInfo = gatherDepthOf(codeText);
    const choiceInfo = choiceDepthOf(codeText);
    const textAfterBullets = gatherInfo?.afterBullets ?? choiceInfo?.afterBullets;
    if (textAfterBullets === undefined) continue;
    const labelName = stripLeadingLabelAndConditions(textAfterBullets).labelName;
    if (labelName && !(choiceInfo && lineIndex === firstChoiceIndex)) loopTargetNames.add(`label:${labelName}`);
  }

  function classifyDiverts(linesToClassify: SourceLine[]): "loops" | "exits" | "none" {
    let sawLoop = false;
    let sawExit = false;
    for (const sourceLine of linesToClassify) {
      if (/->\s*->/.test(sourceLine.codeText)) sawExit = true; // tunnel return leaves the scope
      for (const reference of extractDivertReferences(sourceLine, scope.knotName)) {
        if (reference.kind === "value" || reference.kind === "thread" || reference.kind === "tunnel-call") continue;
        if (reference.kind === "tunnel-return-redirect") {
          sawExit = true;
          continue;
        }
        const resolvedTarget = resolveTarget(reference.targetName, scope.knotName);
        const isLoopBack =
          (resolvedTarget !== null && loopTargetNames.has(resolvedTarget)) ||
          (resolvedTarget === null && loopTargetNames.has(`label:${reference.targetName.split(".").pop()}`));
        if (isLoopBack) sawLoop = true;
        else sawExit = true;
      }
    }
    if (sawExit) return "exits";
    if (sawLoop) return "loops";
    return "none";
  }

  const topChoiceDepth = Math.min(
    ...scopeLines.map((sourceLine) => choiceDepthOf(sourceLine.codeText)?.depth ?? Infinity),
  );
  let hasStickyChoice = false;
  let hasFallbackChoice = false;
  let hasExitingChoice = false;
  let loopingChoiceCount = 0;
  let firstLoopingChoiceLine: SourceLine | null = null;

  for (let lineIndex = firstChoiceIndex; lineIndex < scopeLines.length; lineIndex++) {
    const choiceInfo = choiceDepthOf(scopeLines[lineIndex].codeText);
    if (!choiceInfo || choiceInfo.depth !== topChoiceDepth) continue;
    if (choiceInfo.isSticky) hasStickyChoice = true;
    const { remainingText } = stripLeadingLabelAndConditions(choiceInfo.afterBullets);
    if (remainingText === "" || remainingText.startsWith("->")) hasFallbackChoice = true;

    // Choice block: until the next choice/gather at depth <= this one.
    let blockEndIndex = lineIndex + 1;
    while (blockEndIndex < scopeLines.length) {
      const laterCodeText = scopeLines[blockEndIndex].codeText;
      const laterChoice = choiceDepthOf(laterCodeText);
      const laterGather = gatherDepthOf(laterCodeText);
      if ((laterChoice && laterChoice.depth <= choiceInfo.depth) || (laterGather && laterGather.depth <= choiceInfo.depth)) break;
      blockEndIndex++;
    }
    let outcome = classifyDiverts(scopeLines.slice(lineIndex, blockEndIndex));
    if (outcome === "none") {
      // Falls through to the next gather at this depth.
      let gatherIndex = blockEndIndex;
      while (gatherIndex < scopeLines.length) {
        const gatherInfo = gatherDepthOf(scopeLines[gatherIndex].codeText);
        if (gatherInfo && gatherInfo.depth <= choiceInfo.depth) break;
        gatherIndex++;
      }
      let tailEndIndex = gatherIndex + 1;
      while (tailEndIndex < scopeLines.length && !choiceDepthOf(scopeLines[tailEndIndex].codeText)) tailEndIndex++;
      outcome = gatherIndex < scopeLines.length ? classifyDiverts(scopeLines.slice(gatherIndex, tailEndIndex)) : "exits";
      if (outcome === "none") outcome = "exits";
    }
    if (outcome === "exits") hasExitingChoice = true;
    if (outcome === "loops") {
      loopingChoiceCount++;
      firstLoopingChoiceLine ??= scopeLines[lineIndex];
    }
  }

  if (loopingChoiceCount > 0 && !hasStickyChoice && !hasFallbackChoice && !hasExitingChoice) {
    const scopeLabel = scope.kind === "stitch" ? `${scope.knotName}.${scope.stitchName}` : scope.knotName;
    findings.push({
      ruleId: "INK002",
      severity: "warning",
      filePath: firstLoopingChoiceLine!.filePath,
      lineNumber: firstLoopingChoiceLine!.lineNumber,
      message: `${scopeLabel} loops back to its own choices, but every choice is once-only (*) and none leaves the loop. After ${loopingChoiceCount} pick(s) the story runs out of content. Make one sticky (+), add a fallback "* -> somewhere", or add an exit.`,
    });
  }
}


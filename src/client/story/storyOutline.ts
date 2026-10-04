/**
 * A lightweight structural read of the project — knots, stitches, labels and
 * the diverts between them — used for the map, "go to knot", and divert
 * autocompletion. It works on source text (not compiled JSON) so it still
 * produces a useful map while the story has compile errors.
 */

export interface OutlineLocation {
  filePath: string;
  lineNumber: number;
}

export interface OutlineKnot extends OutlineLocation {
  name: string;
  isFunction: boolean;
  stitchNames: string[];
  labelNames: string[];
}

export type OutlineDivertKind = "divert" | "tunnel" | "thread";

export interface OutlineDivert extends OutlineLocation {
  /** Knot that contains the divert, or ROOT_NODE_NAME for top-level content. */
  fromKnotName: string;
  rawTarget: string;
  kind: OutlineDivertKind;
}

export interface StoryOutline {
  knots: OutlineKnot[];
  diverts: OutlineDivert[];
  rootLocation: OutlineLocation | null;
}

export const ROOT_NODE_NAME = "(start)";
export const BUILT_IN_ENDINGS = new Set(["END", "DONE"]);

const IDENTIFIER = String.raw`[\p{L}\p{N}_]+`;
const KNOT_HEADER = new RegExp(String.raw`^={2,}\s*(function\s+)?(${IDENTIFIER})`, "u");
const STITCH_HEADER = new RegExp(String.raw`^=(?!=)\s*(${IDENTIFIER})`, "u");
const LABEL_IN_WEAVE = new RegExp(String.raw`^(?:[*+\-]\s*)+\(\s*(${IDENTIFIER})\s*\)`, "u");
const DIVERT_OCCURRENCE = new RegExp(String.raw`(->->|->|<-)\s*(${IDENTIFIER}(?:\.${IDENTIFIER})*)?(\s*->)?`, "gu");

function stripCommentsFromLines(fileText: string): string[] {
  let insideBlockComment = false;
  return fileText.split(/\r?\n/).map((rawLine) => {
    let keptText = "";
    let characterIndex = 0;
    while (characterIndex < rawLine.length) {
      if (insideBlockComment) {
        const blockEnd = rawLine.indexOf("*/", characterIndex);
        if (blockEnd === -1) return keptText;
        insideBlockComment = false;
        characterIndex = blockEnd + 2;
        continue;
      }
      if (rawLine.startsWith("//", characterIndex)) break;
      if (rawLine.startsWith("/*", characterIndex)) {
        insideBlockComment = true;
        characterIndex += 2;
        continue;
      }
      keptText += rawLine[characterIndex];
      characterIndex += 1;
    }
    return keptText;
  });
}

/** Files are walked main-first, then the rest alphabetically, mirroring INCLUDE order closely enough for a map. */
export function buildStoryOutline(fileTextByPath: Record<string, string>, mainFilePath: string): StoryOutline {
  const orderedFilePaths = [mainFilePath, ...Object.keys(fileTextByPath).filter((filePath) => filePath !== mainFilePath).sort()];
  const knots: OutlineKnot[] = [];
  const diverts: OutlineDivert[] = [];
  let rootLocation: OutlineLocation | null = null;

  for (const filePath of orderedFilePaths) {
    const fileText = fileTextByPath[filePath];
    if (fileText === undefined) continue;
    let currentKnot: OutlineKnot | null = null;

    stripCommentsFromLines(fileText).forEach((lineText, zeroBasedLineIndex) => {
      const trimmedLine = lineText.trim();
      const lineNumber = zeroBasedLineIndex + 1;
      if (!trimmedLine) return;

      const knotMatch = KNOT_HEADER.exec(trimmedLine);
      if (knotMatch) {
        currentKnot = { name: knotMatch[2], isFunction: Boolean(knotMatch[1]), stitchNames: [], labelNames: [], filePath, lineNumber };
        knots.push(currentKnot);
        return;
      }
      const stitchMatch = STITCH_HEADER.exec(trimmedLine);
      if (stitchMatch && currentKnot) {
        (currentKnot as OutlineKnot).stitchNames.push(stitchMatch[1]);
        return;
      }
      const labelMatch = LABEL_IN_WEAVE.exec(trimmedLine);
      if (labelMatch && currentKnot) (currentKnot as OutlineKnot).labelNames.push(labelMatch[1]);

      // Only the main file's top-level content is the story's real entry point.
      if (!currentKnot && filePath === mainFilePath && !/^(VAR|CONST|LIST|INCLUDE|EXTERNAL)\b/.test(trimmedLine)) {
        rootLocation ??= { filePath, lineNumber };
      }

      for (const divertMatch of trimmedLine.matchAll(DIVERT_OCCURRENCE)) {
        const [, arrow, targetName, trailingTunnelArrow] = divertMatch;
        if (!targetName) continue; // bare "->->" returns from a tunnel; nothing to draw
        const kind: OutlineDivertKind = arrow === "<-" ? "thread" : trailingTunnelArrow || arrow === "->->" ? "tunnel" : "divert";
        diverts.push({
          fromKnotName: (currentKnot as OutlineKnot | null)?.name ?? ROOT_NODE_NAME,
          rawTarget: targetName,
          kind,
          filePath,
          lineNumber,
        });
      }
    });
  }
  return { knots, diverts, rootLocation };
}

/**
 * Maps a divert target to the knot it lands in, following ink's lookup order
 * loosely: a stitch or label of the current knot, then a knot name, then
 * "knot.stitch". Returns null for variables and functions we can't place.
 */
export function resolveTargetKnotName(rawTarget: string, fromKnotName: string, knotsByName: Map<string, OutlineKnot>): string | null {
  if (BUILT_IN_ENDINGS.has(rawTarget)) return rawTarget;
  const [firstSegment] = rawTarget.split(".");
  const fromKnot = knotsByName.get(fromKnotName);
  if (fromKnot && !rawTarget.includes(".") && (fromKnot.stitchNames.includes(rawTarget) || fromKnot.labelNames.includes(rawTarget))) {
    return fromKnotName;
  }
  if (knotsByName.has(firstSegment)) return firstSegment;
  return null;
}

/**
 * Path rules shared by the server (which must never let a request escape the
 * data directory) and the client (which resolves INCLUDE paths the same way
 * the ink compiler does: relative to the main file's folder).
 *
 * Project-relative paths always use forward slashes, never start with "/",
 * and never contain "." or ".." segments once normalized.
 */

const ALLOWED_PROJECT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$/;
const ALLOWED_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.()-]{0,119}$/;

export const INK_FILE_EXTENSION = ".ink";
export const DEFAULT_MAIN_FILE_NAME = "main.ink";

export function isValidProjectName(candidateProjectName: string): boolean {
  return ALLOWED_PROJECT_NAME_PATTERN.test(candidateProjectName) && !candidateProjectName.endsWith(".");
}

/** Collapses "a/./b", "a//b" and "a/x/../b"; returns "" if the path climbs above the project root. */
export function normalizeProjectRelativePath(rawPath: string): string {
  const resolvedSegments: string[] = [];
  for (const segment of rawPath.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (resolvedSegments.length === 0) return "";
      resolvedSegments.pop();
      continue;
    }
    resolvedSegments.push(segment);
  }
  return resolvedSegments.join("/");
}

export function directoryOfProjectRelativePath(projectRelativePath: string): string {
  const lastSlashIndex = projectRelativePath.lastIndexOf("/");
  return lastSlashIndex === -1 ? "" : projectRelativePath.slice(0, lastSlashIndex);
}

export function joinProjectRelativePaths(baseDirectory: string, relativePath: string): string {
  return normalizeProjectRelativePath(baseDirectory ? `${baseDirectory}/${relativePath}` : relativePath);
}

/** True only for normalized paths whose every segment is safe and which end in .ink. */
export function isValidInkFilePath(candidatePath: string): boolean {
  if (candidatePath !== normalizeProjectRelativePath(candidatePath) || candidatePath === "") return false;
  if (!candidatePath.toLowerCase().endsWith(INK_FILE_EXTENSION)) return false;
  return candidatePath.split("/").every((segment) => ALLOWED_PATH_SEGMENT_PATTERN.test(segment));
}

import { mkdir, readdir, readFile, rename, rmdir, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  DEFAULT_MAIN_FILE_NAME,
  isValidInkFilePath,
  isValidProjectName,
} from "../shared/projectPaths";
import type { ProjectFileSummary, ProjectSummary } from "../shared/apiTypes";

/**
 * Projects are plain folders of .ink files under the data directory, so they can
 * be committed to git, opened in Inky, or synced into a game repo untouched.
 * The only non-ink file is an optional `.inkwell.json` holding the main-file
 * choice; deleting it just falls back to main.ink.
 *
 * Every write is "if the version you started from is still current": each file's
 * version is a hash of its bytes, so the desktop and the iPad can't silently
 * overwrite each other's edits.
 */

const PROJECT_SETTINGS_FILE_NAME = ".inkwell.json";

export class StorageError extends Error {
  constructor(
    readonly httpStatus: 400 | 404 | 409,
    message: string,
    readonly conflictDetails?: { currentContent: string; currentVersion: string },
  ) {
    super(message);
  }
}

interface ProjectSettings {
  mainFilePath: string;
}

export function versionOfContent(fileContent: string): string {
  return createHash("sha256").update(fileContent, "utf8").digest("hex").slice(0, 20);
}

export class ProjectStorage {
  constructor(
    private readonly projectsDataDirectory: string,
    private readonly trashDirectory: string,
  ) {}

  async ensureDirectoriesExist(): Promise<void> {
    await mkdir(this.projectsDataDirectory, { recursive: true });
    await mkdir(this.trashDirectory, { recursive: true });
  }

  // -- path guards ------------------------------------------------------------

  private projectDirectoryFor(projectName: string): string {
    if (!isValidProjectName(projectName)) throw new StorageError(400, `Invalid project name: ${projectName}`);
    return join(this.projectsDataDirectory, projectName);
  }

  /** Validates syntax, then double-checks containment after resolution (belt and braces). */
  private absolutePathForInkFile(projectName: string, projectRelativeFilePath: string): string {
    if (!isValidInkFilePath(projectRelativeFilePath)) {
      throw new StorageError(400, `Invalid ink file path: ${projectRelativeFilePath}`);
    }
    const projectDirectory = this.projectDirectoryFor(projectName);
    const absoluteFilePath = resolve(projectDirectory, projectRelativeFilePath);
    if (!absoluteFilePath.startsWith(projectDirectory + sep)) {
      throw new StorageError(400, `Path escapes project: ${projectRelativeFilePath}`);
    }
    return absoluteFilePath;
  }

  private async assertProjectExists(projectName: string): Promise<string> {
    const projectDirectory = this.projectDirectoryFor(projectName);
    const projectDirectoryStats = await stat(projectDirectory).catch(() => null);
    if (!projectDirectoryStats?.isDirectory()) throw new StorageError(404, `No such project: ${projectName}`);
    return projectDirectory;
  }

  // -- projects ---------------------------------------------------------------

  async listProjects(): Promise<ProjectSummary[]> {
    const directoryEntries = await readdir(this.projectsDataDirectory, { withFileTypes: true });
    const projectSummaries: ProjectSummary[] = [];
    for (const directoryEntry of directoryEntries) {
      if (!directoryEntry.isDirectory() || !isValidProjectName(directoryEntry.name)) continue;
      const projectDirectory = join(this.projectsDataDirectory, directoryEntry.name);
      const inkFilePaths = await this.collectInkFilePaths(projectDirectory);
      let lastModifiedMilliseconds = 0;
      for (const inkFilePath of inkFilePaths) {
        const fileStats = await stat(join(projectDirectory, inkFilePath));
        lastModifiedMilliseconds = Math.max(lastModifiedMilliseconds, fileStats.mtimeMs);
      }
      projectSummaries.push({
        name: directoryEntry.name,
        fileCount: inkFilePaths.length,
        lastModifiedIso: new Date(lastModifiedMilliseconds || Date.now()).toISOString(),
      });
    }
    return projectSummaries.sort((first, second) => second.lastModifiedIso.localeCompare(first.lastModifiedIso));
  }

  async createProject(projectName: string): Promise<void> {
    const projectDirectory = this.projectDirectoryFor(projectName);
    if (await stat(projectDirectory).catch(() => null)) throw new StorageError(409, `Project already exists: ${projectName}`);
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(join(projectDirectory, DEFAULT_MAIN_FILE_NAME), starterStoryFor(projectName), "utf8");
  }

  async renameProject(currentProjectName: string, newProjectName: string): Promise<void> {
    const currentDirectory = await this.assertProjectExists(currentProjectName);
    const newDirectory = this.projectDirectoryFor(newProjectName);
    if (await stat(newDirectory).catch(() => null)) throw new StorageError(409, `Project already exists: ${newProjectName}`);
    await rename(currentDirectory, newDirectory);
  }

  /** Never deletes outright: moves the folder to .trash so a mis-tap on an iPad is recoverable. */
  async moveProjectToTrash(projectName: string): Promise<void> {
    const projectDirectory = await this.assertProjectExists(projectName);
    await rename(projectDirectory, join(this.trashDirectory, `${projectName}--${trashTimestamp()}`));
  }

  async readProjectSettings(projectName: string): Promise<ProjectSettings> {
    const projectDirectory = await this.assertProjectExists(projectName);
    const settingsText = await readFile(join(projectDirectory, PROJECT_SETTINGS_FILE_NAME), "utf8").catch(() => "");
    let parsedSettings: Partial<ProjectSettings> = {};
    try {
      parsedSettings = settingsText ? (JSON.parse(settingsText) as Partial<ProjectSettings>) : {};
    } catch {
      parsedSettings = {};
    }
    const configuredMainFilePath = parsedSettings.mainFilePath;
    return {
      mainFilePath:
        configuredMainFilePath && isValidInkFilePath(configuredMainFilePath) ? configuredMainFilePath : DEFAULT_MAIN_FILE_NAME,
    };
  }

  async setMainFile(projectName: string, mainFilePath: string): Promise<void> {
    const absoluteMainFilePath = this.absolutePathForInkFile(projectName, mainFilePath);
    if (!(await stat(absoluteMainFilePath).catch(() => null))) throw new StorageError(404, `No such file: ${mainFilePath}`);
    const projectDirectory = this.projectDirectoryFor(projectName);
    const settings: ProjectSettings = { mainFilePath };
    await writeFileAtomically(join(projectDirectory, PROJECT_SETTINGS_FILE_NAME), `${JSON.stringify(settings, null, 2)}\n`);
  }

  // -- files ------------------------------------------------------------------

  private async collectInkFilePaths(projectDirectory: string): Promise<string[]> {
    const collectedPaths: string[] = [];
    const walk = async (currentDirectory: string): Promise<void> => {
      const directoryEntries = await readdir(currentDirectory, { withFileTypes: true });
      for (const directoryEntry of directoryEntries) {
        if (directoryEntry.name.startsWith(".")) continue;
        const absoluteEntryPath = join(currentDirectory, directoryEntry.name);
        if (directoryEntry.isDirectory()) {
          await walk(absoluteEntryPath);
        } else if (directoryEntry.isFile()) {
          const projectRelativePath = relative(projectDirectory, absoluteEntryPath).split(sep).join("/");
          if (isValidInkFilePath(projectRelativePath)) collectedPaths.push(projectRelativePath);
        }
      }
    };
    await walk(projectDirectory);
    return collectedPaths.sort();
  }

  async listFiles(projectName: string): Promise<ProjectFileSummary[]> {
    const projectDirectory = await this.assertProjectExists(projectName);
    const inkFilePaths = await this.collectInkFilePaths(projectDirectory);
    return Promise.all(
      inkFilePaths.map(async (inkFilePath) => {
        const fileContent = await readFile(join(projectDirectory, inkFilePath), "utf8");
        return { path: inkFilePath, version: versionOfContent(fileContent), sizeBytes: Buffer.byteLength(fileContent) };
      }),
    );
  }

  /** Reads every ink file at once; the client compiles the whole project locally. */
  async readAllFiles(projectName: string): Promise<Record<string, { content: string; version: string }>> {
    const projectDirectory = await this.assertProjectExists(projectName);
    const inkFilePaths = await this.collectInkFilePaths(projectDirectory);
    const filesByPath: Record<string, { content: string; version: string }> = {};
    for (const inkFilePath of inkFilePaths) {
      const fileContent = (await readFile(join(projectDirectory, inkFilePath), "utf8")).replace(/^﻿/, "");
      filesByPath[inkFilePath] = { content: fileContent, version: versionOfContent(fileContent) };
    }
    return filesByPath;
  }

  async readFileContent(projectName: string, projectRelativeFilePath: string): Promise<{ content: string; version: string }> {
    await this.assertProjectExists(projectName);
    const absoluteFilePath = this.absolutePathForInkFile(projectName, projectRelativeFilePath);
    const fileContent = await readFile(absoluteFilePath, "utf8").catch(() => null);
    if (fileContent === null) throw new StorageError(404, `No such file: ${projectRelativeFilePath}`);
    const contentWithoutByteOrderMark = fileContent.replace(/^﻿/, "");
    return { content: contentWithoutByteOrderMark, version: versionOfContent(contentWithoutByteOrderMark) };
  }

  /**
   * `expectedBaseVersion` null means "create; fail if it exists". A string means
   * "overwrite only if the file still has this version"; otherwise 409 with the
   * server's copy so the client can show both sides.
   */
  async writeFileContent(
    projectName: string,
    projectRelativeFilePath: string,
    newContent: string,
    expectedBaseVersion: string | null,
  ): Promise<{ version: string }> {
    await this.assertProjectExists(projectName);
    const absoluteFilePath = this.absolutePathForInkFile(projectName, projectRelativeFilePath);
    const existingContent = await readFile(absoluteFilePath, "utf8").catch(() => null);

    if (expectedBaseVersion === null && existingContent !== null) {
      throw new StorageError(409, `File already exists: ${projectRelativeFilePath}`);
    }
    if (expectedBaseVersion !== null) {
      if (existingContent === null) throw new StorageError(404, `No such file: ${projectRelativeFilePath}`);
      const currentVersion = versionOfContent(existingContent);
      if (currentVersion !== expectedBaseVersion) {
        throw new StorageError(409, "File changed on the server since you opened it", {
          currentContent: existingContent,
          currentVersion,
        });
      }
    }

    await mkdir(dirname(absoluteFilePath), { recursive: true });
    await writeFileAtomically(absoluteFilePath, newContent);
    return { version: versionOfContent(newContent) };
  }

  async renameFile(projectName: string, currentFilePath: string, newFilePath: string): Promise<void> {
    await this.assertProjectExists(projectName);
    const absoluteCurrentPath = this.absolutePathForInkFile(projectName, currentFilePath);
    const absoluteNewPath = this.absolutePathForInkFile(projectName, newFilePath);
    if (!(await stat(absoluteCurrentPath).catch(() => null))) throw new StorageError(404, `No such file: ${currentFilePath}`);
    if (await stat(absoluteNewPath).catch(() => null)) throw new StorageError(409, `File already exists: ${newFilePath}`);
    await mkdir(dirname(absoluteNewPath), { recursive: true });
    await rename(absoluteCurrentPath, absoluteNewPath);
    const projectSettings = await this.readProjectSettings(projectName);
    if (projectSettings.mainFilePath === currentFilePath) await this.setMainFile(projectName, newFilePath);
    await this.removeEmptyParentDirectories(projectName, absoluteCurrentPath);
  }

  async moveFileToTrash(projectName: string, projectRelativeFilePath: string): Promise<void> {
    await this.assertProjectExists(projectName);
    const absoluteFilePath = this.absolutePathForInkFile(projectName, projectRelativeFilePath);
    if (!(await stat(absoluteFilePath).catch(() => null))) throw new StorageError(404, `No such file: ${projectRelativeFilePath}`);
    const flattenedName = projectRelativeFilePath.replace(/\//g, "__");
    await rename(absoluteFilePath, join(this.trashDirectory, `${projectName}--${trashTimestamp()}--${flattenedName}`));
    await this.removeEmptyParentDirectories(projectName, absoluteFilePath);
  }

  private async removeEmptyParentDirectories(projectName: string, absoluteFormerFilePath: string): Promise<void> {
    const projectDirectory = this.projectDirectoryFor(projectName);
    let currentDirectory = dirname(absoluteFormerFilePath);
    while (currentDirectory.startsWith(projectDirectory + sep)) {
      const remainingEntries = await readdir(currentDirectory).catch(() => ["(unreadable)"]);
      if (remainingEntries.length > 0) return;
      await rmdir(currentDirectory).catch(() => undefined);
      currentDirectory = dirname(currentDirectory);
    }
  }
}

/** Write to a sibling temp file then rename, so a crash mid-save never leaves half a story. */
async function writeFileAtomically(absoluteFilePath: string, fileContent: string): Promise<void> {
  const temporaryFilePath = `${absoluteFilePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryFilePath, fileContent, "utf8");
  await rename(temporaryFilePath, absoluteFilePath);
}

function trashTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function starterStoryFor(projectName: string): string {
  return `// ${projectName}
//
// Tag vocabulary (document what your game parses here):
//   #speaker: name
//
// Split chapters into their own files and pull them in with:
// INCLUDE chapters/example.ink

VAR visits_to_the_door = 0

-> opening

=== opening ===
The lamp hums. Somewhere below, a door you have never opened is waiting.
- (hub)
* [Look around]
    Dust, brass, and a smell like rain on hot stone.
    -> hub
+ [Knock on the door]
    ~ visits_to_the_door += 1
    {visits_to_the_door > 2: Something knocks back.|Nothing answers.}
    -> hub
* [Leave] -> ending

=== ending ===
You step back into the evening.
-> END
`;
}

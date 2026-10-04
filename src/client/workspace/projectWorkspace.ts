import { api, SaveConflictError } from "../api";

/**
 * Owns every open file's text for one project, autosaves it, and keeps it in
 * step with the server. Framework-free on purpose: buffers change on every
 * keystroke, and pushing that through React state would re-render the map and
 * the play pane per character. React subscribes to the coarse-grained
 * snapshot (statuses, file list, a debounced content revision) instead.
 *
 * Saving model (mirrors the server's): every save says which version it was
 * based on. If another device saved in between, the server answers 409 and the
 * file goes into "conflict"; autosave for that file stops until the person
 * chooses whose text to keep. Nothing is ever merged silently.
 */

export type FileSaveStatus = "saved" | "unsaved" | "saving" | "conflict" | "error";

export interface FileBuffer {
  path: string;
  content: string;
  /** Text as last confirmed on the server; `content !== savedContent` means unsaved changes. */
  savedContent: string;
  savedVersion: string | null;
  status: FileSaveStatus;
  conflictServerContent?: string;
  conflictServerVersion?: string;
  errorMessage?: string;
}

export interface WorkspaceSnapshot {
  projectName: string;
  mainFilePath: string;
  filePaths: string[];
  statusesByPath: Record<string, FileSaveStatus>;
  /** Bumps (debounced) whenever any buffer's text changes; compile and outline key off this. */
  contentRevision: number;
  /** Bumps when the server's file list or main file changed underneath us. */
  structureRevision: number;
}

type ExternalReplacementListener = (filePath: string, replacementContent: string) => void;

const AUTOSAVE_DELAY_MILLISECONDS = 900;
const CONTENT_REVISION_DEBOUNCE_MILLISECONDS = 350;
const REMOTE_POLL_INTERVAL_MILLISECONDS = 15_000;

export class ProjectWorkspace {
  private readonly buffersByPath = new Map<string, FileBuffer>();
  private readonly autosaveTimersByPath = new Map<string, number>();
  private readonly saveInFlightByPath = new Map<string, Promise<void>>();
  private readonly snapshotListeners = new Set<() => void>();
  private readonly externalReplacementListeners = new Set<ExternalReplacementListener>();
  private contentRevisionTimer: number | undefined;
  private remotePollTimer: number | undefined;
  private currentSnapshot: WorkspaceSnapshot;
  private disposed = false;

  constructor(
    readonly projectName: string,
    private mainFilePath: string,
    initialFiles: Record<string, { content: string; version: string }>,
  ) {
    for (const [filePath, storedFile] of Object.entries(initialFiles)) {
      this.buffersByPath.set(filePath, {
        path: filePath,
        content: storedFile.content,
        savedContent: storedFile.content,
        savedVersion: storedFile.version,
        status: "saved",
      });
    }
    this.currentSnapshot = this.buildSnapshot(0, 0);
    this.startRemoteWatching();
  }

  static async open(projectName: string): Promise<ProjectWorkspace> {
    const projectSnapshot = await api.loadProject(projectName);
    return new ProjectWorkspace(projectName, projectSnapshot.mainFilePath, projectSnapshot.files);
  }

  // -- subscriptions -------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  };

  getSnapshot = (): WorkspaceSnapshot => this.currentSnapshot;

  onExternalReplacement(listener: ExternalReplacementListener): () => void {
    this.externalReplacementListeners.add(listener);
    return () => this.externalReplacementListeners.delete(listener);
  }

  private buildSnapshot(contentRevision: number, structureRevision: number): WorkspaceSnapshot {
    const filePaths = [...this.buffersByPath.keys()].sort();
    return {
      projectName: this.projectName,
      mainFilePath: this.mainFilePath,
      filePaths,
      statusesByPath: Object.fromEntries(filePaths.map((filePath) => [filePath, this.buffersByPath.get(filePath)!.status])),
      contentRevision,
      structureRevision,
    };
  }

  private publish(options: { contentChanged?: boolean; structureChanged?: boolean } = {}): void {
    if (this.disposed) return;
    this.currentSnapshot = this.buildSnapshot(
      this.currentSnapshot.contentRevision + (options.contentChanged ? 1 : 0),
      this.currentSnapshot.structureRevision + (options.structureChanged ? 1 : 0),
    );
    for (const listener of this.snapshotListeners) listener();
  }

  private scheduleContentRevision(): void {
    window.clearTimeout(this.contentRevisionTimer);
    this.contentRevisionTimer = window.setTimeout(() => this.publish({ contentChanged: true }), CONTENT_REVISION_DEBOUNCE_MILLISECONDS);
  }

  // -- reading -----------------------------------------------------------------

  getBuffer(filePath: string): FileBuffer | undefined {
    return this.buffersByPath.get(filePath);
  }

  /** Current text of every file, unsaved edits included: what the compiler and map should see. */
  currentFileTexts(): Record<string, string> {
    return Object.fromEntries([...this.buffersByPath].map(([filePath, fileBuffer]) => [filePath, fileBuffer.content]));
  }

  hasUnsavedChanges(): boolean {
    return [...this.buffersByPath.values()].some((fileBuffer) => fileBuffer.status !== "saved");
  }

  // -- editing -----------------------------------------------------------------

  /** Called by the editor on every change. */
  updateContent(filePath: string, newContent: string): void {
    const fileBuffer = this.buffersByPath.get(filePath);
    if (!fileBuffer || fileBuffer.content === newContent) return;
    fileBuffer.content = newContent;
    if (fileBuffer.status === "saved" || fileBuffer.status === "error") {
      fileBuffer.status = newContent === fileBuffer.savedContent ? "saved" : "unsaved";
      this.publish();
    }
    this.scheduleAutosave(filePath);
    this.scheduleContentRevision();
  }

  private scheduleAutosave(filePath: string): void {
    const fileBuffer = this.buffersByPath.get(filePath);
    if (!fileBuffer || fileBuffer.status === "conflict") return;
    window.clearTimeout(this.autosaveTimersByPath.get(filePath));
    this.autosaveTimersByPath.set(filePath, window.setTimeout(() => void this.saveFile(filePath), AUTOSAVE_DELAY_MILLISECONDS));
  }

  /** An edit made by the app rather than by typing (e.g. adding an INCLUDE); open editors are updated too. */
  applyProgrammaticEdit(filePath: string, newContent: string): void {
    const fileBuffer = this.buffersByPath.get(filePath);
    if (!fileBuffer || fileBuffer.content === newContent) return;
    this.updateContent(filePath, newContent);
    for (const listener of this.externalReplacementListeners) listener(filePath, newContent);
  }

  /** Saves one file now. Serialized per file so two saves never race each other's base version. */
  async saveFile(filePath: string): Promise<void> {
    window.clearTimeout(this.autosaveTimersByPath.get(filePath));
    const previousSave = this.saveInFlightByPath.get(filePath);
    if (previousSave) await previousSave;

    const fileBuffer = this.buffersByPath.get(filePath);
    if (!fileBuffer || fileBuffer.status === "conflict" || fileBuffer.content === fileBuffer.savedContent) {
      if (fileBuffer && fileBuffer.status !== "conflict" && fileBuffer.status !== "saved") {
        fileBuffer.status = "saved";
        this.publish();
      }
      return;
    }

    const contentBeingSaved = fileBuffer.content;
    fileBuffer.status = "saving";
    this.publish();

    const savePromise = (async () => {
      try {
        const saveResult = await api.saveFile(this.projectName, filePath, contentBeingSaved, fileBuffer.savedVersion);
        fileBuffer.savedContent = contentBeingSaved;
        fileBuffer.savedVersion = saveResult.version;
        fileBuffer.errorMessage = undefined;
        fileBuffer.status = fileBuffer.content === contentBeingSaved ? "saved" : "unsaved";
        if (fileBuffer.status === "unsaved") this.scheduleAutosave(filePath);
      } catch (saveFailure) {
        if (saveFailure instanceof SaveConflictError) {
          fileBuffer.status = "conflict";
          fileBuffer.conflictServerContent = saveFailure.conflict.currentContent;
          fileBuffer.conflictServerVersion = saveFailure.conflict.currentVersion;
        } else {
          fileBuffer.status = "error";
          fileBuffer.errorMessage = saveFailure instanceof Error ? saveFailure.message : String(saveFailure);
          // Retry later: on an iPad the usual cause is Wi-Fi dropping for a moment.
          window.setTimeout(() => this.scheduleAutosave(filePath), 5000);
        }
      } finally {
        this.saveInFlightByPath.delete(filePath);
        this.publish();
      }
    })();
    this.saveInFlightByPath.set(filePath, savePromise);
    await savePromise;
  }

  async saveAll(): Promise<void> {
    await Promise.all([...this.buffersByPath.keys()].map((filePath) => this.saveFile(filePath)));
  }

  /** Conflict resolution: overwrite the server with what's in this editor. */
  async resolveConflictKeepingMine(filePath: string): Promise<void> {
    const fileBuffer = this.buffersByPath.get(filePath);
    if (!fileBuffer || fileBuffer.status !== "conflict") return;
    fileBuffer.savedVersion = fileBuffer.conflictServerVersion ?? fileBuffer.savedVersion;
    fileBuffer.savedContent = fileBuffer.conflictServerContent ?? fileBuffer.savedContent;
    fileBuffer.status = "unsaved";
    fileBuffer.conflictServerContent = undefined;
    fileBuffer.conflictServerVersion = undefined;
    await this.saveFile(filePath);
  }

  /** Conflict resolution: discard local edits and take the server's text. */
  resolveConflictTakingTheirs(filePath: string): void {
    const fileBuffer = this.buffersByPath.get(filePath);
    if (!fileBuffer || fileBuffer.status !== "conflict" || fileBuffer.conflictServerContent === undefined) return;
    this.replaceFromServer(fileBuffer, fileBuffer.conflictServerContent, fileBuffer.conflictServerVersion ?? null);
  }

  private replaceFromServer(fileBuffer: FileBuffer, serverContent: string, serverVersion: string | null): void {
    fileBuffer.content = serverContent;
    fileBuffer.savedContent = serverContent;
    fileBuffer.savedVersion = serverVersion;
    fileBuffer.status = "saved";
    fileBuffer.conflictServerContent = undefined;
    fileBuffer.conflictServerVersion = undefined;
    for (const listener of this.externalReplacementListeners) listener(fileBuffer.path, serverContent);
    this.publish({ contentChanged: true });
  }

  // -- file operations --------------------------------------------------------

  async createFile(filePath: string, initialContent: string): Promise<void> {
    const saveResult = await api.saveFile(this.projectName, filePath, initialContent, null);
    this.buffersByPath.set(filePath, {
      path: filePath,
      content: initialContent,
      savedContent: initialContent,
      savedVersion: saveResult.version,
      status: "saved",
    });
    this.publish({ contentChanged: true, structureChanged: true });
  }

  async renameFile(fromPath: string, toPath: string): Promise<void> {
    await this.saveFile(fromPath);
    await api.renameFile(this.projectName, fromPath, toPath);
    const fileBuffer = this.buffersByPath.get(fromPath);
    if (fileBuffer) {
      this.buffersByPath.delete(fromPath);
      fileBuffer.path = toPath;
      this.buffersByPath.set(toPath, fileBuffer);
    }
    if (this.mainFilePath === fromPath) this.mainFilePath = toPath;
    this.publish({ contentChanged: true, structureChanged: true });
  }

  async trashFile(filePath: string): Promise<void> {
    window.clearTimeout(this.autosaveTimersByPath.get(filePath));
    await api.trashFile(this.projectName, filePath);
    this.buffersByPath.delete(filePath);
    this.publish({ contentChanged: true, structureChanged: true });
  }

  async setMainFile(filePath: string): Promise<void> {
    await api.setMainFile(this.projectName, filePath);
    this.mainFilePath = filePath;
    this.publish({ contentChanged: true, structureChanged: true });
  }

  // -- staying in step with other devices -----------------------------------------

  private startRemoteWatching(): void {
    const checkWhenVisible = () => {
      if (document.visibilityState === "visible") void this.pullRemoteChanges();
    };
    document.addEventListener("visibilitychange", checkWhenVisible);
    window.addEventListener("focus", checkWhenVisible);
    this.remotePollTimer = window.setInterval(checkWhenVisible, REMOTE_POLL_INTERVAL_MILLISECONDS);
    this.stopRemoteWatching = () => {
      document.removeEventListener("visibilitychange", checkWhenVisible);
      window.removeEventListener("focus", checkWhenVisible);
      window.clearInterval(this.remotePollTimer);
    };
  }

  private stopRemoteWatching: () => void = () => undefined;
  private pullInProgress = false;

  /**
   * Clean files silently follow the server. A file with unsaved local edits that
   * also changed remotely becomes a conflict right away, rather than waiting for
   * the next autosave to discover it.
   */
  async pullRemoteChanges(): Promise<void> {
    if (this.pullInProgress || this.disposed) return;
    this.pullInProgress = true;
    try {
      const { mainFilePath: serverMainFilePath, versions: serverVersionsByPath } = await api.fetchVersions(this.projectName);
      let structureChanged = serverMainFilePath !== this.mainFilePath;
      this.mainFilePath = serverMainFilePath;

      for (const [filePath, serverVersion] of Object.entries(serverVersionsByPath)) {
        const fileBuffer = this.buffersByPath.get(filePath);
        if (!fileBuffer) {
          const remoteFile = await api.readFile(this.projectName, filePath);
          this.buffersByPath.set(filePath, {
            path: filePath,
            content: remoteFile.content,
            savedContent: remoteFile.content,
            savedVersion: remoteFile.version,
            status: "saved",
          });
          structureChanged = true;
          continue;
        }
        if (fileBuffer.savedVersion === serverVersion || this.saveInFlightByPath.has(filePath) || fileBuffer.status === "conflict") continue;
        const remoteFile = await api.readFile(this.projectName, filePath);
        if (fileBuffer.content === fileBuffer.savedContent) {
          this.replaceFromServer(fileBuffer, remoteFile.content, remoteFile.version);
        } else {
          window.clearTimeout(this.autosaveTimersByPath.get(filePath));
          fileBuffer.status = "conflict";
          fileBuffer.conflictServerContent = remoteFile.content;
          fileBuffer.conflictServerVersion = remoteFile.version;
          this.publish();
        }
      }

      for (const [filePath, fileBuffer] of [...this.buffersByPath]) {
        if (filePath in serverVersionsByPath) continue;
        // Removed elsewhere: drop it only if nothing local would be lost.
        if (fileBuffer.content === fileBuffer.savedContent && !this.saveInFlightByPath.has(filePath)) {
          this.buffersByPath.delete(filePath);
          structureChanged = true;
        }
      }
      if (structureChanged) this.publish({ contentChanged: true, structureChanged: true });
    } catch {
      // Offline for a moment; the next poll will try again.
    } finally {
      this.pullInProgress = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopRemoteWatching();
    window.clearTimeout(this.contentRevisionTimer);
    for (const autosaveTimer of this.autosaveTimersByPath.values()) window.clearTimeout(autosaveTimer);
  }
}

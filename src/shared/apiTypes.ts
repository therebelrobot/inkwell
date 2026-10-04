/** Wire shapes shared by server routes and the client API wrapper. */

export interface ProjectSummary {
  name: string;
  fileCount: number;
  lastModifiedIso: string;
}

export interface ProjectFileSummary {
  path: string;
  version: string;
  sizeBytes: number;
}

export interface ProjectSnapshot {
  name: string;
  mainFilePath: string;
  files: Record<string, { content: string; version: string }>;
}

export interface SessionStatus {
  passwordRequired: boolean;
  signedIn: boolean;
}

export interface SaveConflictResponse {
  error: string;
  currentContent: string;
  currentVersion: string;
}

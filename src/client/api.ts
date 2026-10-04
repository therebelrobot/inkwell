import type { ProjectSnapshot, ProjectSummary, SaveConflictResponse, SessionStatus } from "../shared/apiTypes";

export class ApiError extends Error {
  constructor(
    readonly httpStatus: number,
    message: string,
    readonly responseBody: unknown,
  ) {
    super(message);
  }
}

export class SaveConflictError extends Error {
  constructor(readonly conflict: SaveConflictResponse) {
    super(conflict.error);
  }
}

/** Fired on any 401 so the app can drop back to the sign-in screen from anywhere. */
export const SIGNED_OUT_EVENT_NAME = "inkwell:signed-out";

async function requestJson<ResponseShape>(method: string, path: string, requestBody?: unknown): Promise<ResponseShape> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: requestBody === undefined ? undefined : { "Content-Type": "application/json" },
    body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
  });
  const responseBody = await response.json().catch(() => null);
  if (response.status === 401 && path !== "/api/session") window.dispatchEvent(new Event(SIGNED_OUT_EVENT_NAME));
  if (response.status === 409 && responseBody && typeof responseBody === "object" && "currentVersion" in responseBody) {
    throw new SaveConflictError(responseBody as SaveConflictResponse);
  }
  if (!response.ok) {
    const errorMessage = (responseBody as { error?: string } | null)?.error ?? `Request failed (${response.status})`;
    throw new ApiError(response.status, errorMessage, responseBody);
  }
  return responseBody as ResponseShape;
}

const projectPath = (projectName: string) => `/api/projects/${encodeURIComponent(projectName)}`;
const filePath = (projectName: string, projectRelativePath: string) =>
  `${projectPath(projectName)}/file?path=${encodeURIComponent(projectRelativePath)}`;

export const api = {
  getSession: () => requestJson<SessionStatus>("GET", "/api/session"),
  signIn: (password: string) => requestJson<{ ok: true }>("POST", "/api/session", { password }),
  signOut: () => requestJson<{ ok: true }>("DELETE", "/api/session"),

  listProjects: () => requestJson<ProjectSummary[]>("GET", "/api/projects"),
  createProject: (projectName: string) => requestJson<{ ok: true }>("POST", "/api/projects", { name: projectName }),
  renameProject: (projectName: string, newName: string) => requestJson<{ ok: true }>("PATCH", projectPath(projectName), { newName }),
  setMainFile: (projectName: string, mainFilePath: string) => requestJson<{ ok: true }>("PATCH", projectPath(projectName), { mainFilePath }),
  trashProject: (projectName: string) => requestJson<{ ok: true }>("DELETE", projectPath(projectName)),

  loadProject: (projectName: string) => requestJson<ProjectSnapshot>("GET", projectPath(projectName)),
  fetchVersions: (projectName: string) =>
    requestJson<{ mainFilePath: string; versions: Record<string, string> }>("GET", `${projectPath(projectName)}/versions`),
  readFile: (projectName: string, projectRelativePath: string) =>
    requestJson<{ content: string; version: string }>("GET", filePath(projectName, projectRelativePath)),
  saveFile: (projectName: string, projectRelativePath: string, content: string, baseVersion: string | null) =>
    requestJson<{ version: string }>("PUT", filePath(projectName, projectRelativePath), { content, baseVersion }),
  renameFile: (projectName: string, fromPath: string, toPath: string) =>
    requestJson<{ ok: true }>("POST", `${projectPath(projectName)}/file/rename`, { fromPath, toPath }),
  trashFile: (projectName: string, projectRelativePath: string) =>
    requestJson<{ ok: true }>("DELETE", filePath(projectName, projectRelativePath)),

  exportZipUrl: (projectName: string) => `${projectPath(projectName)}/export.zip`,
  exportJsonUrl: (projectName: string) => `${projectPath(projectName)}/export.json`,
};

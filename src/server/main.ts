import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { readServerConfigurationFromEnvironment } from "./configuration";
import { isSessionValid, requireSession, signOut, tryPasswordSignIn } from "./authentication";
import { ProjectStorage, StorageError } from "./projectStorage";
import { buildZipArchive } from "./zipArchive";
import { compileInkProject } from "../shared/inkProjectCompiler";
import type { ProjectSnapshot, SaveConflictResponse, SessionStatus } from "../shared/apiTypes";

const serverConfiguration = readServerConfigurationFromEnvironment();
const projectStorage = new ProjectStorage(serverConfiguration.projectsDataDirectory, serverConfiguration.trashDirectory);
await projectStorage.ensureDirectoriesExist();

const application = new Hono();
const MAXIMUM_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

application.onError((thrownError, context) => {
  if (thrownError instanceof StorageError) {
    if (thrownError.conflictDetails) {
      const conflictBody: SaveConflictResponse = { error: thrownError.message, ...thrownError.conflictDetails };
      return context.json(conflictBody, 409);
    }
    return context.json({ error: thrownError.message }, thrownError.httpStatus);
  }
  console.error(thrownError);
  return context.json({ error: "Internal server error" }, 500);
});

application.get("/healthz", (context) => context.text("ok"));

// -- session --------------------------------------------------------------------

application.get("/api/session", (context) => {
  const sessionStatus: SessionStatus = {
    passwordRequired: Boolean(serverConfiguration.editorPassword),
    signedIn: isSessionValid(context, serverConfiguration),
  };
  return context.json(sessionStatus);
});

application.post("/api/session", async (context) => {
  const requestBody = await context.req.json<{ password?: string }>().catch(() => ({ password: "" }));
  if (tryPasswordSignIn(context, serverConfiguration, requestBody.password ?? "")) return context.json({ ok: true });
  // A flat delay on failure makes guessing over the LAN slow without any state to manage.
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
  return context.json({ error: "Wrong password" }, 401);
});

application.delete("/api/session", (context) => {
  signOut(context);
  return context.json({ ok: true });
});

// -- projects (everything below needs a session) -----------------------------

const protectedApi = new Hono();
protectedApi.use("*", requireSession(serverConfiguration));
protectedApi.use("*", bodyLimit({ maxSize: MAXIMUM_REQUEST_BODY_BYTES, onError: (context) => context.json({ error: "Request too large" }, 413) }));

function requiredQueryParameter(context: Context, parameterName: string): string {
  const parameterValue = context.req.query(parameterName);
  if (!parameterValue) throw new StorageError(400, `Missing query parameter: ${parameterName}`);
  return parameterValue;
}

function attachmentFileName(projectName: string, extension: string): string {
  return `${projectName.replace(/[^A-Za-z0-9_.-]+/g, "-")}${extension}`;
}

protectedApi.get("/projects", async (context) => context.json(await projectStorage.listProjects()));

protectedApi.post("/projects", async (context) => {
  const { name: newProjectName } = await context.req.json<{ name: string }>();
  await projectStorage.createProject(String(newProjectName ?? "").trim());
  return context.json({ ok: true }, 201);
});

protectedApi.get("/projects/:projectName", async (context) => {
  const projectName = context.req.param("projectName");
  const projectSettings = await projectStorage.readProjectSettings(projectName);
  const projectSnapshot: ProjectSnapshot = {
    name: projectName,
    mainFilePath: projectSettings.mainFilePath,
    files: await projectStorage.readAllFiles(projectName),
  };
  return context.json(projectSnapshot);
});

protectedApi.patch("/projects/:projectName", async (context) => {
  const projectName = context.req.param("projectName");
  const changes = await context.req.json<{ newName?: string; mainFilePath?: string }>();
  if (changes.mainFilePath) await projectStorage.setMainFile(projectName, changes.mainFilePath);
  if (changes.newName && changes.newName !== projectName) await projectStorage.renameProject(projectName, changes.newName.trim());
  return context.json({ ok: true });
});

protectedApi.delete("/projects/:projectName", async (context) => {
  await projectStorage.moveProjectToTrash(context.req.param("projectName"));
  return context.json({ ok: true });
});

/** Cheap poll used when a tab regains focus, to notice edits made on another device. */
protectedApi.get("/projects/:projectName/versions", async (context) => {
  const projectName = context.req.param("projectName");
  const fileSummaries = await projectStorage.listFiles(projectName);
  const projectSettings = await projectStorage.readProjectSettings(projectName);
  return context.json({
    mainFilePath: projectSettings.mainFilePath,
    versions: Object.fromEntries(fileSummaries.map((fileSummary) => [fileSummary.path, fileSummary.version])),
  });
});

protectedApi.get("/projects/:projectName/file", async (context) => {
  const projectName = context.req.param("projectName");
  return context.json(await projectStorage.readFileContent(projectName, requiredQueryParameter(context, "path")));
});

protectedApi.put("/projects/:projectName/file", async (context) => {
  const projectName = context.req.param("projectName");
  const projectRelativeFilePath = requiredQueryParameter(context, "path");
  const { content: newContent, baseVersion } = await context.req.json<{ content: string; baseVersion: string | null }>();
  if (typeof newContent !== "string") throw new StorageError(400, "content must be a string");
  const saveResult = await projectStorage.writeFileContent(projectName, projectRelativeFilePath, newContent, baseVersion ?? null);
  return context.json(saveResult);
});

protectedApi.post("/projects/:projectName/file/rename", async (context) => {
  const projectName = context.req.param("projectName");
  const { fromPath, toPath } = await context.req.json<{ fromPath: string; toPath: string }>();
  await projectStorage.renameFile(projectName, fromPath, toPath);
  return context.json({ ok: true });
});

protectedApi.delete("/projects/:projectName/file", async (context) => {
  const projectName = context.req.param("projectName");
  await projectStorage.moveFileToTrash(projectName, requiredQueryParameter(context, "path"));
  return context.json({ ok: true });
});

async function compileStoredProject(projectName: string) {
  const projectSettings = await projectStorage.readProjectSettings(projectName);
  const storedFiles = await projectStorage.readAllFiles(projectName);
  const fileTextByPath = Object.fromEntries(Object.entries(storedFiles).map(([filePath, storedFile]) => [filePath, storedFile.content]));
  return { fileTextByPath, compilationResult: compileInkProject(fileTextByPath, projectSettings.mainFilePath) };
}

protectedApi.get("/projects/:projectName/export.json", async (context) => {
  const projectName = context.req.param("projectName");
  const { compilationResult } = await compileStoredProject(projectName);
  if (!compilationResult.compiledJson) return context.json({ error: "Story has compile errors", diagnostics: compilationResult.diagnostics }, 422);
  context.header("Content-Disposition", `attachment; filename="${attachmentFileName(projectName, ".json")}"`);
  return context.body(compilationResult.compiledJson, 200, { "Content-Type": "application/json; charset=utf-8" });
});

/** Zip of the .ink sources, plus the compiled story.json when the project compiles cleanly. */
protectedApi.get("/projects/:projectName/export.zip", async (context) => {
  const projectName = context.req.param("projectName");
  const { fileTextByPath, compilationResult } = await compileStoredProject(projectName);
  const topFolder = attachmentFileName(projectName, "");
  const zipEntries = Object.entries(fileTextByPath).map(([filePath, fileText]) => ({ pathInArchive: `${topFolder}/${filePath}`, content: fileText }));
  if (compilationResult.compiledJson) zipEntries.push({ pathInArchive: `${topFolder}/story.json`, content: compilationResult.compiledJson });
  const zipBytes = buildZipArchive(zipEntries);
  context.header("Content-Disposition", `attachment; filename="${attachmentFileName(projectName, ".zip")}"`);
  return context.body(new Uint8Array(zipBytes), 200, { "Content-Type": "application/zip" });
});

application.route("/api", protectedApi);
application.all("/api/*", (context) => context.json({ error: "Not found" }, 404));

// -- client -----------------------------------------------------------------------

application.use(
  "/assets/*",
  async (context, next) => {
    await next();
    // Vite fingerprints everything under /assets, so these can be cached forever.
    context.header("Cache-Control", "public, max-age=31536000, immutable");
  },
  serveStatic({ root: serverConfiguration.clientStaticDirectory }),
);
application.use("*", serveStatic({ root: serverConfiguration.clientStaticDirectory }));

let cachedIndexHtml: string | null = null;
application.get("*", async (context) => {
  cachedIndexHtml ??= await readFile(join(serverConfiguration.clientStaticDirectory, "index.html"), "utf8").catch(() => null);
  if (!cachedIndexHtml) return context.text("Client build not found. Run `npm run build`.", 500);
  context.header("Cache-Control", "no-cache");
  return context.html(cachedIndexHtml);
});

serve({ fetch: application.fetch, port: serverConfiguration.listenPort, hostname: serverConfiguration.listenHost }, (addressInfo) => {
  console.log(`inkwell listening on http://${serverConfiguration.listenHost}:${addressInfo.port}`);
  console.log(`projects: ${serverConfiguration.projectsDataDirectory}`);
  if (!serverConfiguration.editorPassword) console.log("INKWELL_PASSWORD is not set: the editor is open to anyone who can reach it.");
});

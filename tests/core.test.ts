import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { compileInkProject } from "../src/shared/inkProjectCompiler";
import { analyseStory } from "../src/shared/inkLinter";
import { isValidInkFilePath, isValidProjectName, joinProjectRelativePaths, normalizeProjectRelativePath } from "../src/shared/projectPaths";
import { buildStoryOutline } from "../src/client/story/storyOutline";
import { layoutStoryMap } from "../src/client/story/mapLayout";
import { StoryPlayer } from "../src/client/story/storyPlayer";
import { ProjectStorage, StorageError } from "../src/server/projectStorage";
import { buildZipArchive } from "../src/server/zipArchive";

const FIXTURE_DIRECTORY = join(process.cwd(), "tests/fixtures/weaver-guild");

async function readFixtureFiles(): Promise<Record<string, string>> {
  const fileTextByPath: Record<string, string> = {};
  for (const relativePath of ["main.ink", "chapters/workshop.ink", "chapters/archive.ink"]) {
    fileTextByPath[relativePath] = await readFile(join(FIXTURE_DIRECTORY, relativePath), "utf8");
  }
  return fileTextByPath;
}

test("project paths reject traversal and odd names", () => {
  assert.equal(normalizeProjectRelativePath("a/./b//c.ink"), "a/b/c.ink");
  assert.equal(normalizeProjectRelativePath("../x.ink"), "");
  assert.equal(joinProjectRelativePaths("chapters", "../main.ink"), "main.ink");
  assert.ok(isValidInkFilePath("chapters/one.ink"));
  assert.ok(!isValidInkFilePath("../one.ink"));
  assert.ok(!isValidInkFilePath("/etc/passwd.ink"));
  assert.ok(!isValidInkFilePath(".hidden.ink"));
  assert.ok(!isValidInkFilePath("notes.txt"));
  assert.ok(isValidProjectName("Weaver Guild"));
  assert.ok(!isValidProjectName("../etc"));
  assert.ok(!isValidProjectName(".trash"));
});

test("multi-file project compiles with INCLUDEs resolved from the main file's folder", async () => {
  const compilationResult = compileInkProject(await readFixtureFiles(), "main.ink");
  assert.deepEqual(compilationResult.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
  assert.ok(compilationResult.compiledJson?.includes('"inkVersion":21'));
});

test("compile errors carry the included file and line", async () => {
  const fileTextByPath = await readFixtureFiles();
  fileTextByPath["chapters/archive.ink"] += "* [Nowhere] -> missing_knot\n";
  const compilationResult = compileInkProject(fileTextByPath, "main.ink");
  const divertError = compilationResult.diagnostics.find((diagnostic) => diagnostic.message.includes("missing_knot"));
  assert.ok(divertError);
  assert.equal(divertError.filePath, "chapters/archive.ink");
  assert.equal(divertError.lineNumber, 10);
  assert.equal(compilationResult.compiledJson, null);
});

test("a missing INCLUDE is reported on the INCLUDE line instead of crashing", async () => {
  const fileTextByPath = await readFixtureFiles();
  delete fileTextByPath["chapters/archive.ink"];
  const compilationResult = compileInkProject(fileTextByPath, "main.ink");
  const includeError = compilationResult.diagnostics.find((diagnostic) => diagnostic.message.startsWith("INCLUDE target not found"));
  assert.ok(includeError);
  assert.equal(includeError.filePath, "main.ink");
  assert.equal(includeError.lineNumber, 4);
});

test("ported linter runs on in-memory files and flags the orphaned knot", async () => {
  const fileTextByPath = await readFixtureFiles();
  const findings = analyseStory("main.ink", (filePath) => fileTextByPath[filePath]);
  assert.ok(findings.some((finding) => finding.ruleId === "INK006" && finding.message.includes("forgotten_room")), JSON.stringify(findings));
  assert.ok(findings.some((finding) => finding.ruleId === "INK005" && finding.message.includes("camera_shake")), JSON.stringify(findings));
});

test("ported linter matches the skill's CLI on the skill's seeded-faults fixture", { skip: !process.env.INK_SKILL_DIR }, async () => {
  const skillDirectory = process.env.INK_SKILL_DIR!;
  const fixtureDirectory = join(skillDirectory, "tests");
  const fileTextByPath: Record<string, string> = {};
  for (const fileName of await readdir(fixtureDirectory)) {
    if (fileName.endsWith(".ink")) fileTextByPath[fileName] = await readFile(join(fixtureDirectory, fileName), "utf8");
  }
  const portedFindings = analyseStory("seeded-faults.ink", (filePath) => fileTextByPath[filePath]).map(
    (finding) => `${finding.filePath.split("/").pop()}:${finding.lineNumber}:${finding.ruleId}`,
  );
  let cliOutput: string;
  try {
    cliOutput = execFileSync("node", [join(skillDirectory, "scripts/check-ink.ts"), join(fixtureDirectory, "seeded-faults.ink"), "--json"], { encoding: "utf8" });
  } catch (cliExit) {
    cliOutput = (cliExit as { stdout: string }).stdout; // exits 1 because the fixture contains errors on purpose
  }
  const cliFindings = (JSON.parse(cliOutput) as { filePath: string; lineNumber: number; ruleId: string }[]).map(
    (finding) => `${finding.filePath.split("/").pop()}:${finding.lineNumber}:${finding.ruleId}`,
  );
  assert.deepEqual([...portedFindings].sort(), [...cliFindings].sort());
});

test("outline and map: knots in columns by distance, unreached knot last, functions excluded", async () => {
  const fileTextByPath = await readFixtureFiles();
  const outline = buildStoryOutline(fileTextByPath, "main.ink");
  assert.deepEqual(
    outline.knots.map((knot) => knot.name).sort(),
    ["archive", "epilogue", "forgotten_room", "play_note", "rest_tunnel", "workshop"].sort(),
  );
  const mapLayout = layoutStoryMap(outline);
  const nodeById = new Map(mapLayout.nodes.map((node) => [node.id, node]));
  assert.equal(nodeById.get("(start)")?.columnIndex, 0);
  assert.equal(nodeById.get("workshop")?.columnIndex, 1);
  assert.equal(nodeById.get("archive")?.columnIndex, 2);
  assert.equal(nodeById.get("forgotten_room")?.kind, "unreached");
  assert.equal(nodeById.has("play_note"), false);
  assert.ok(mapLayout.edges.some((edge) => edge.fromNodeId === "workshop" && edge.toNodeId === "rest_tunnel" && edge.kind === "tunnel"));
  assert.ok(mapLayout.edges.some((edge) => edge.fromNodeId === "archive" && edge.toNodeId === "workshop" && edge.isBackward));
});

test("story player: externals fall back or stub, rewind and replay after recompile", async () => {
  const fileTextByPath = await readFixtureFiles();
  const compiledJson = compileInkProject(fileTextByPath, "main.ink").compiledJson!;
  const storyPlayer = new StoryPlayer(compiledJson, ["camera_shake"], null);
  assert.equal(storyPlayer.transcript[0]?.kind, "line");
  assert.deepEqual(storyPlayer.choices.map((choice) => choice.text), ["Pluck the low string", "Search the drawers", "Rest", "Leave the workshop"]);

  storyPlayer.choose(0); // pluck: uses play_note's ink fallback
  assert.ok(storyPlayer.transcript.some((entry) => entry.kind === "line" && entry.text.startsWith("c hums")));
  assert.equal(storyPlayer.readVariables().find((reading) => reading.name === "harmonies_learned")?.displayValue, "1");

  storyPlayer.rewindOneChoice();
  assert.equal(storyPlayer.readVariables().find((reading) => reading.name === "harmonies_learned")?.displayValue, "0");
  assert.equal(storyPlayer.choices.length, 4);

  storyPlayer.choose(1); // search drawers -> key
  const unlockChoice = storyPlayer.choices.find((choice) => choice.text === "Unlock the archive");
  assert.ok(unlockChoice);
  storyPlayer.choose(unlockChoice.index);
  assert.ok(storyPlayer.transcript.some((entry) => entry.kind === "notice" && entry.text.includes("camera_shake")));

  // Recompile with an edited line; replaying the same choices should land in the same place.
  fileTextByPath["chapters/archive.ink"] = fileTextByPath["chapters/archive.ink"].replace("Dust falls.", "Dust drifts down.");
  const editedJson = compileInkProject(fileTextByPath, "main.ink").compiledJson!;
  const replayedPlayer = new StoryPlayer(editedJson, ["camera_shake"], null);
  assert.equal(replayedPlayer.replayChoices(storyPlayer.choiceHistory), storyPlayer.choiceHistory.length);
  assert.ok(replayedPlayer.transcript.some((entry) => entry.kind === "line" && entry.text === "Dust drifts down."));
});

test("story player can start from a knot", async () => {
  const compiledJson = compileInkProject(await readFixtureFiles(), "main.ink").compiledJson!;
  const storyPlayer = new StoryPlayer(compiledJson, ["camera_shake"], "epilogue");
  assert.ok(storyPlayer.transcript.some((entry) => entry.kind === "line" && entry.text.startsWith("The guild lamps")));
  assert.equal(storyPlayer.transcript.at(-1)?.kind, "end");
});

test("storage: create, conflict on stale version, path guards, trash", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "inkwell-test-"));
  const projectStorage = new ProjectStorage(join(dataDirectory, "projects"), join(dataDirectory, ".trash"));
  await projectStorage.ensureDirectoriesExist();
  await projectStorage.createProject("Guild");
  await cp(FIXTURE_DIRECTORY, join(dataDirectory, "projects", "Guild"), { recursive: true });

  const mainFile = await projectStorage.readFileContent("Guild", "main.ink");
  const firstSave = await projectStorage.writeFileContent("Guild", "main.ink", `${mainFile.content}\n// edit from desktop\n`, mainFile.version);
  await assert.rejects(
    projectStorage.writeFileContent("Guild", "main.ink", "edit from ipad", mainFile.version),
    (failure: unknown) => failure instanceof StorageError && failure.httpStatus === 409 && failure.conflictDetails?.currentVersion === firstSave.version,
  );
  await assert.rejects(projectStorage.writeFileContent("Guild", "../../evil.ink", "x", null), StorageError);
  await assert.rejects(projectStorage.readFileContent("../projects", "main.ink"), StorageError);

  await projectStorage.renameFile("Guild", "chapters/archive.ink", "chapters/old/archive.ink");
  assert.ok((await projectStorage.listFiles("Guild")).some((fileSummary) => fileSummary.path === "chapters/old/archive.ink"));
  await projectStorage.moveFileToTrash("Guild", "chapters/old/archive.ink");
  assert.equal((await readdir(join(dataDirectory, ".trash"))).length, 1);
  await assert.rejects(readdir(join(dataDirectory, "projects", "Guild", "chapters", "old"))); // emptied folder removed
});

test("zip archive is readable by unzip", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "inkwell-zip-"));
  const zipPath = join(outputDirectory, "out.zip");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(zipPath, buildZipArchive([{ pathInArchive: "story/main.ink", content: "Hello ✦ wörld\n" }, { pathInArchive: "story/chapters/a.ink", content: "A\n" }]));
  const listing = execFileSync("unzip", ["-l", zipPath], { encoding: "utf8" });
  assert.match(listing, /story\/chapters\/a\.ink/);
  assert.equal(execFileSync("unzip", ["-p", zipPath, "story/main.ink"], { encoding: "utf8" }), "Hello ✦ wörld\n");
});

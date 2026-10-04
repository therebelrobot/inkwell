import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ProjectWorkspace } from "../workspace/projectWorkspace";
import { InkEditor, type InkEditorHandle } from "../editor/InkEditor";
import { FileSidebar } from "./FileSidebar";
import { PlayPreview } from "./PlayPreview";
import { KnotMap } from "./KnotMap";
import { ProblemsList } from "./ProblemsList";
import { SymbolBar } from "./SymbolBar";
import { buildStoryOutline, type StoryOutline } from "../story/storyOutline";
import type { CompileRequest, CompileResponse } from "../story/compileWorker";
import type { InkDiagnostic } from "../../shared/inkProjectCompiler";
import { api } from "../api";
import { downloadExport } from "../exportDownload";

type SidePanelTab = "play" | "map" | "problems";
type NarrowTab = "files" | "write" | SidePanelTab;

const WIDE_LAYOUT_QUERY = "(min-width: 980px)";

function useMediaQuery(mediaQuery: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mediaQueryList = window.matchMedia(mediaQuery);
      mediaQueryList.addEventListener("change", onChange);
      return () => mediaQueryList.removeEventListener("change", onChange);
    },
    () => window.matchMedia(mediaQuery).matches,
  );
}

const SAVE_STATUS_TEXT = { saved: "Saved", unsaved: "Unsaved", saving: "Saving…", conflict: "Conflict", error: "Not saved" } as const;

/** INCLUDE paths are relative to the main file's folder. */
function includePathFromMain(mainFilePath: string, includedFilePath: string): string {
  const mainFolder = mainFilePath.includes("/") ? mainFilePath.slice(0, mainFilePath.lastIndexOf("/") + 1) : "";
  return mainFolder && includedFilePath.startsWith(mainFolder) ? includedFilePath.slice(mainFolder.length) : includedFilePath;
}

/** Inserts after the last existing INCLUDE, or after the leading comment block when there is none. */
function addIncludeLine(mainFileText: string, includePath: string): string {
  const lines = mainFileText.split("\n");
  if (lines.some((lineText) => lineText.trim() === `INCLUDE ${includePath}`)) return mainFileText;
  let lastIncludeIndex = -1;
  lines.forEach((lineText, lineIndex) => {
    if (/^\s*INCLUDE\s+/.test(lineText)) lastIncludeIndex = lineIndex;
  });
  let insertIndex = lastIncludeIndex + 1;
  if (lastIncludeIndex === -1) {
    insertIndex = 0;
    while (insertIndex < lines.length && /^\s*\/\//.test(lines[insertIndex])) insertIndex += 1;
  }
  lines.splice(insertIndex, 0, `INCLUDE ${includePath}`);
  return lines.join("\n");
}

export function EditorScreen({ workspace, onLeaveProject }: { workspace: ProjectWorkspace; onLeaveProject: () => void }) {
  const snapshot = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  const isWideLayout = useMediaQuery(WIDE_LAYOUT_QUERY);
  const [activeFilePath, setActiveFilePath] = useState(snapshot.mainFilePath);
  const [sidePanelTab, setSidePanelTab] = useState<SidePanelTab>("play");
  const [narrowTab, setNarrowTab] = useState<NarrowTab>("write");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [editorHasFocus, setEditorHasFocus] = useState(false);
  const [startKnotName, setStartKnotName] = useState<string | null>(null);
  const [showTheirVersion, setShowTheirVersion] = useState(false);
  const editorHandleRef = useRef<InkEditorHandle>(null);
  const pendingRevealLineRef = useRef<number | null>(null);

  // Keep the active file valid when files are renamed, trashed, or vanish remotely.
  useEffect(() => {
    if (!snapshot.filePaths.includes(activeFilePath)) setActiveFilePath(snapshot.filePaths.includes(snapshot.mainFilePath) ? snapshot.mainFilePath : snapshot.filePaths[0] ?? "");
  }, [snapshot.filePaths, snapshot.mainFilePath, activeFilePath]);

  // -- compile in the worker; newest request wins ---------------------------------

  const [compileResponse, setCompileResponse] = useState<CompileResponse | null>(null);
  const [lastGoodCompiledJson, setLastGoodCompiledJson] = useState<string | null>(null);
  const compileWorkerRef = useRef<Worker | null>(null);
  const latestRequestIdRef = useRef(0);

  useEffect(() => {
    const compileWorker = new Worker(new URL("../story/compileWorker.ts", import.meta.url), { type: "module" });
    compileWorker.onmessage = (messageEvent: MessageEvent<CompileResponse>) => {
      if (messageEvent.data.requestId !== latestRequestIdRef.current) return;
      setCompileResponse(messageEvent.data);
      if (messageEvent.data.compiledJson) setLastGoodCompiledJson(messageEvent.data.compiledJson);
    };
    compileWorkerRef.current = compileWorker;
    return () => compileWorker.terminate();
  }, []);

  useEffect(() => {
    latestRequestIdRef.current += 1;
    const compileRequest: CompileRequest = {
      requestId: latestRequestIdRef.current,
      fileTextByPath: workspace.currentFileTexts(),
      mainFilePath: snapshot.mainFilePath,
    };
    compileWorkerRef.current?.postMessage(compileRequest);
  }, [workspace, snapshot.contentRevision, snapshot.mainFilePath]);

  const outline: StoryOutline | null = useMemo(
    () => buildStoryOutline(workspace.currentFileTexts(), snapshot.mainFilePath),
    // contentRevision is the signal that the texts changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspace, snapshot.contentRevision, snapshot.mainFilePath],
  );
  const outlineRef = useRef(outline);
  outlineRef.current = outline;
  const getOutline = useCallback(() => outlineRef.current, []);

  const knotNames = useMemo(() => (outline?.knots ?? []).filter((knot) => !knot.isFunction).map((knot) => knot.name), [outline]);

  // EXTERNALs with an ink fallback play through the fallback (as in Inky); the rest get a logging stub.
  const externalFunctionsToStub = useMemo(() => {
    const functionKnotNames = new Set((outline?.knots ?? []).filter((knot) => knot.isFunction).map((knot) => knot.name));
    const declaredExternals = new Set<string>();
    for (const fileText of Object.values(workspace.currentFileTexts())) {
      for (const externalMatch of fileText.matchAll(/^\s*EXTERNAL\s+([\p{L}\p{N}_]+)/gmu)) declaredExternals.add(externalMatch[1]);
    }
    return [...declaredExternals].filter((externalName) => !functionKnotNames.has(externalName)).sort();
  }, [outline, workspace]);
  const stableExternalsKey = externalFunctionsToStub.join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableExternalFunctionsToStub = useMemo(() => externalFunctionsToStub, [stableExternalsKey]);

  const diagnostics: InkDiagnostic[] = compileResponse?.diagnostics ?? [];
  const diagnosticsForActiveFile = useMemo(() => diagnostics.filter((diagnostic) => diagnostic.filePath === activeFilePath), [diagnostics, activeFilePath]);
  const errorCount = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const warningCount = diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;

  // -- navigation -----------------------------------------------------------------

  const openLocation = useCallback(
    (filePath: string, lineNumber: number) => {
      if (!isWideLayout) setNarrowTab("write");
      if (filePath === activeFilePath && (isWideLayout || narrowTab === "write")) {
        editorHandleRef.current?.revealLine(lineNumber);
        return;
      }
      pendingRevealLineRef.current = lineNumber;
      setActiveFilePath(filePath);
    },
    [activeFilePath, isWideLayout, narrowTab],
  );

  useEffect(() => {
    if (pendingRevealLineRef.current === null) return;
    const lineToReveal = pendingRevealLineRef.current;
    pendingRevealLineRef.current = null;
    requestAnimationFrame(() => editorHandleRef.current?.revealLine(lineToReveal));
  }, [activeFilePath, narrowTab]);

  const playFromKnot = (knotName: string) => {
    setStartKnotName(knotName);
    if (isWideLayout) setSidePanelTab("play");
    else setNarrowTab("play");
  };

  // -- leaving and unsaved work ---------------------------------------------------------

  useEffect(() => {
    const warnAboutUnsavedWork = (beforeUnloadEvent: BeforeUnloadEvent) => {
      if (!workspace.hasUnsavedChanges()) return;
      void workspace.saveAll();
      beforeUnloadEvent.preventDefault();
    };
    // iPadOS rarely fires beforeunload; pagehide/hidden is the last reliable moment to save.
    const saveWhenHidden = () => {
      if (document.visibilityState === "hidden") void workspace.saveAll();
    };
    window.addEventListener("beforeunload", warnAboutUnsavedWork);
    document.addEventListener("visibilitychange", saveWhenHidden);
    return () => {
      window.removeEventListener("beforeunload", warnAboutUnsavedWork);
      document.removeEventListener("visibilitychange", saveWhenHidden);
    };
  }, [workspace]);

  const leaveProject = async () => {
    await workspace.saveAll();
    onLeaveProject();
  };

  const exportProject = async (exportFormat: "zip" | "json") => {
    await workspace.saveAll();
    const exportUrl = exportFormat === "zip" ? api.exportZipUrl(workspace.projectName) : api.exportJsonUrl(workspace.projectName);
    await downloadExport(exportUrl, `${workspace.projectName}.${exportFormat}`);
  };

  // -- pieces -------------------------------------------------------------------------

  const activeBuffer = workspace.getBuffer(activeFilePath);
  const activeStatus = snapshot.statusesByPath[activeFilePath] ?? "saved";

  const sidebar = (
    <FileSidebar
      projectName={workspace.projectName}
      filePaths={snapshot.filePaths}
      mainFilePath={snapshot.mainFilePath}
      activeFilePath={activeFilePath}
      statusesByPath={snapshot.statusesByPath}
      onOpenFile={(filePath) => {
        setActiveFilePath(filePath);
        if (!isWideLayout) setNarrowTab("write");
      }}
      onCreateFile={async (filePath) => {
        await workspace.createFile(filePath, `=== ${filePath.split("/").pop()!.replace(/\.ink$/i, "").replace(/[^\p{L}\p{N}_]/gu, "_")} ===\n\n-> DONE\n`);
        // Like Inky: a new file joins the story by getting an INCLUDE in the main file.
        const mainFileText = workspace.getBuffer(snapshot.mainFilePath)?.content;
        if (mainFileText !== undefined) {
          workspace.applyProgrammaticEdit(snapshot.mainFilePath, addIncludeLine(mainFileText, includePathFromMain(snapshot.mainFilePath, filePath)));
        }
        setActiveFilePath(filePath);
        if (!isWideLayout) setNarrowTab("write");
      }}
      onRenameFile={async (fromPath, toPath) => {
        await workspace.renameFile(fromPath, toPath);
        if (activeFilePath === fromPath) setActiveFilePath(toPath);
        // Keep the main file's INCLUDE pointing at the renamed file.
        const currentMainFilePath = workspace.getSnapshot().mainFilePath;
        const mainFileText = workspace.getBuffer(currentMainFilePath)?.content;
        if (mainFileText !== undefined && toPath !== currentMainFilePath) {
          const oldIncludePath = includePathFromMain(currentMainFilePath, fromPath);
          const newIncludePath = includePathFromMain(currentMainFilePath, toPath);
          const updatedMainText = mainFileText
            .split("\n")
            .map((lineText) => (lineText.trim() === `INCLUDE ${oldIncludePath}` ? lineText.replace(oldIncludePath, newIncludePath) : lineText))
            .join("\n");
          workspace.applyProgrammaticEdit(currentMainFilePath, updatedMainText);
        }
      }}
      onTrashFile={(filePath) => workspace.trashFile(filePath)}
      onSetMainFile={(filePath) => workspace.setMainFile(filePath)}
      onExport={exportProject}
      onLeaveProject={() => void leaveProject()}
    />
  );

  const editorColumn = (
    <section className="editor-column" aria-label="Editor">
      <header className="editor-column__header">
        {isWideLayout && (
          <button
            type="button"
            className="button--quiet"
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
            aria-label={sidebarCollapsed ? "Show files" : "Hide files"}
            aria-pressed={!sidebarCollapsed}
          >
            Files
          </button>
        )}
        <span className="editor-column__file-name">{activeFilePath}</span>
        <span className={`save-state save-state--${activeStatus}`} role="status">
          {SAVE_STATUS_TEXT[activeStatus]}
        </span>
      </header>

      {activeBuffer?.status === "conflict" && (
        <div className="conflict-banner" role="alert">
          <p>
            <strong>{activeFilePath}</strong> was changed on another device while you had unsaved edits here. Autosave is paused for this file.
          </p>
          <div className="conflict-banner__actions">
            <button type="button" onClick={() => setShowTheirVersion((shown) => !shown)}>
              {showTheirVersion ? "Hide" : "Show"} the other version
            </button>
            <button type="button" className="button--verdigris" onClick={() => void workspace.resolveConflictKeepingMine(activeFilePath)}>
              Keep mine
            </button>
            <button type="button" onClick={() => workspace.resolveConflictTakingTheirs(activeFilePath)}>
              Use the other version
            </button>
          </div>
          {showTheirVersion && <pre className="conflict-banner__theirs">{activeBuffer.conflictServerContent}</pre>}
        </div>
      )}
      {activeBuffer?.status === "error" && <p className="save-error-banner">Couldn't reach the server: {activeBuffer.errorMessage}. Your text is kept here and will save when the connection is back.</p>}

      {activeFilePath ? (
        <InkEditor
          ref={editorHandleRef}
          workspace={workspace}
          activeFilePath={activeFilePath}
          diagnosticsForActiveFile={diagnosticsForActiveFile}
          getOutline={getOutline}
          onFocusChange={setEditorHasFocus}
        />
      ) : (
        <div className="pane-empty">
          <p>This project has no .ink files. Create one from the file list.</p>
        </div>
      )}
    </section>
  );

  const problemsTabLabel = errorCount > 0 ? `Problems (${errorCount})` : warningCount > 0 ? `Problems (${warningCount})` : "Problems";
  const compileStateClass = errorCount > 0 ? "has-errors" : warningCount > 0 ? "has-warnings" : "is-clean";
  const tabLabel = (tab: NarrowTab) =>
    tab === "files" ? "Files" : tab === "write" ? "Write" : tab === "play" ? "Play" : tab === "map" ? "Map" : problemsTabLabel;

  // One tree for both layouts, so rotating an iPad across the breakpoint never
  // remounts the editor (undo history) or the play pane (your playthrough).
  // CSS arranges it as three columns when wide and one pane at a time when narrow.
  const visiblePanelTab: SidePanelTab = isWideLayout ? sidePanelTab : narrowTab === "files" || narrowTab === "write" ? sidePanelTab : narrowTab;
  const narrowShows = (pane: "files" | "write" | "panel") =>
    isWideLayout || (pane === "panel" ? narrowTab !== "files" && narrowTab !== "write" : narrowTab === pane);

  return (
    <div className={`editor-screen ${isWideLayout ? "editor-screen--wide" : "editor-screen--narrow"}${sidebarCollapsed && isWideLayout ? " sidebar-collapsed" : ""}`}>
      <div className="layout-slot layout-slot--files" hidden={!narrowShows("files") || (isWideLayout && sidebarCollapsed)}>
        {sidebar}
      </div>
      <div className="layout-slot layout-slot--write" hidden={!narrowShows("write")}>
        {editorColumn}
      </div>
      <aside className="layout-slot layout-slot--panel side-panel" aria-label="Story tools" hidden={!narrowShows("panel")}>
        {isWideLayout && (
          <div className="tab-strip" role="tablist">
            {(["play", "map", "problems"] as SidePanelTab[]).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={sidePanelTab === tab}
                className={tab === "problems" ? compileStateClass : undefined}
                onClick={() => setSidePanelTab(tab)}
              >
                {tabLabel(tab)}
              </button>
            ))}
          </div>
        )}
        <div className="side-panel__body">
          <div className="side-panel__view" hidden={visiblePanelTab !== "play"}>
            <PlayPreview
              compiledJson={lastGoodCompiledJson}
              playingStaleBuild={Boolean(compileResponse) && !compileResponse?.compiledJson && Boolean(lastGoodCompiledJson)}
              externalFunctionsToStub={stableExternalFunctionsToStub}
              knotNames={knotNames}
              startKnotName={startKnotName}
              onStartKnotChange={setStartKnotName}
            />
          </div>
          {visiblePanelTab === "map" && (
            <div className="side-panel__view">
              <KnotMap outline={outline} onOpenLocation={openLocation} onPlayFrom={playFromKnot} />
            </div>
          )}
          {visiblePanelTab === "problems" && (
            <div className="side-panel__view">
              <ProblemsList diagnostics={diagnostics} compileDurationMilliseconds={compileResponse?.compileDurationMilliseconds ?? null} onOpenLocation={openLocation} />
            </div>
          )}
        </div>
      </aside>
      {!isWideLayout && (
        <nav className="bottom-tabs" role="tablist" aria-label="Views">
          {(["files", "write", "play", "map", "problems"] as NarrowTab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={narrowTab === tab}
              className={tab === "problems" ? compileStateClass : undefined}
              onClick={() => setNarrowTab(tab)}
            >
              {tabLabel(tab)}
            </button>
          ))}
        </nav>
      )}
      <SymbolBar
        visible={editorHasFocus && (isWideLayout || narrowTab === "write")}
        onInsert={(text, cursorOffset) => editorHandleRef.current?.insertText(text, cursorOffset)}
      />
    </div>
  );
}

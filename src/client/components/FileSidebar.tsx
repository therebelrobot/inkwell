import { Fragment, useState } from "react";
import type { FileSaveStatus } from "../workspace/projectWorkspace";
import { isValidInkFilePath, normalizeProjectRelativePath } from "../../shared/projectPaths";

interface FileSidebarProps {
  projectName: string;
  filePaths: string[];
  mainFilePath: string;
  activeFilePath: string;
  statusesByPath: Record<string, FileSaveStatus>;
  onOpenFile: (filePath: string) => void;
  onCreateFile: (filePath: string) => Promise<void>;
  onRenameFile: (fromPath: string, toPath: string) => Promise<void>;
  onTrashFile: (filePath: string) => Promise<void>;
  onSetMainFile: (filePath: string) => Promise<void>;
  onExport: (format: "zip" | "json") => Promise<void>;
  onLeaveProject: () => void;
}

const STATUS_DESCRIPTION: Record<FileSaveStatus, string> = {
  saved: "Saved",
  unsaved: "Unsaved changes",
  saving: "Saving",
  conflict: "Changed on another device",
  error: "Couldn't save; retrying",
};

/** Accepts "chapter two", "chapters/two" or "chapters/two.ink" and returns a valid .ink path, or null. */
function toInkFilePath(typedName: string): string | null {
  const trimmedName = typedName.trim().replace(/\s+/g, "_");
  if (!trimmedName) return null;
  const withExtension = trimmedName.toLowerCase().endsWith(".ink") ? trimmedName : `${trimmedName}.ink`;
  const normalizedPath = normalizeProjectRelativePath(withExtension);
  return isValidInkFilePath(normalizedPath) ? normalizedPath : null;
}

/** Top-level files first, then each folder under a heading row (shown once, where the folder begins). */
function orderFilesForDisplay(filePaths: string[]): { filePath: string; folderHeading: string | null }[] {
  const folderOf = (filePath: string) => filePath.split("/").slice(0, -1).join("/");
  const sortedPaths = [...filePaths].sort((first, second) => {
    const firstFolder = folderOf(first);
    const secondFolder = folderOf(second);
    if ((firstFolder === "") !== (secondFolder === "")) return firstFolder === "" ? -1 : 1;
    return firstFolder.localeCompare(secondFolder) || first.localeCompare(second);
  });
  let previousFolder = "";
  return sortedPaths.map((filePath) => {
    const currentFolder = folderOf(filePath);
    const folderHeading = currentFolder !== "" && currentFolder !== previousFolder ? currentFolder : null;
    previousFolder = currentFolder;
    return { filePath, folderHeading };
  });
}

export function FileSidebar(props: FileSidebarProps) {
  const [openMenuFilePath, setOpenMenuFilePath] = useState<string | null>(null);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);

  const runAction = async (description: string, action: () => Promise<void>) => {
    setBusyMessage(description);
    try {
      await action();
    } catch (actionFailure) {
      window.alert(actionFailure instanceof Error ? actionFailure.message : String(actionFailure));
    } finally {
      setBusyMessage(null);
      setOpenMenuFilePath(null);
    }
  };

  const promptForNewFile = () => {
    const typedName = window.prompt("New file name (folders allowed, e.g. chapters/two)");
    if (typedName === null) return;
    const newFilePath = toInkFilePath(typedName);
    if (!newFilePath) {
      window.alert("Use letters, numbers, spaces, dashes or underscores, with / between folders.");
      return;
    }
    void runAction("Creating file", () => props.onCreateFile(newFilePath));
  };

  const promptForRename = (currentPath: string) => {
    const typedName = window.prompt("Rename to", currentPath);
    if (typedName === null || typedName === currentPath) return;
    const newFilePath = toInkFilePath(typedName);
    if (!newFilePath) {
      window.alert("Use letters, numbers, spaces, dashes or underscores, with / between folders.");
      return;
    }
    void runAction("Renaming", () => props.onRenameFile(currentPath, newFilePath));
  };

  const confirmTrash = (filePath: string) => {
    if (!window.confirm(`Move ${filePath} to the trash folder? It stays recoverable on the server under data/.trash.`)) return;
    void runAction("Moving to trash", () => props.onTrashFile(filePath));
  };

  return (
    <nav className="file-sidebar" aria-label="Project files">
      <div className="file-sidebar__header">
        <button type="button" className="button--quiet file-sidebar__back" onClick={props.onLeaveProject} aria-label="All projects">
          ‹ Projects
        </button>
        <h1 className="file-sidebar__project-name">{props.projectName}</h1>
      </div>

      <ul className="file-list">
        {orderFilesForDisplay(props.filePaths).map(({ filePath, folderHeading }) => {
          const folderDepth = filePath.split("/").length - 1;
          const fileStatus = props.statusesByPath[filePath] ?? "saved";
          return (
            <Fragment key={filePath}>
            {folderHeading !== null && (
              <li className="file-list__folder-heading" style={{ paddingLeft: `${12 + (folderHeading.split("/").length - 1) * 14}px` }}>
                {folderHeading.split("/").pop()}/
              </li>
            )}
            <li className={`file-list__item${filePath === props.activeFilePath ? " is-active" : ""}`}>
              <button
                type="button"
                className="file-list__open"
                style={{ paddingLeft: `${12 + folderDepth * 14}px` }}
                onClick={() => props.onOpenFile(filePath)}
                aria-current={filePath === props.activeFilePath ? "page" : undefined}
              >
                <span className={`status-dot status-dot--${fileStatus}`} title={STATUS_DESCRIPTION[fileStatus]} aria-label={STATUS_DESCRIPTION[fileStatus]} />
                <span className="file-list__name">{folderDepth > 0 ? filePath.split("/").slice(-1)[0] : filePath}</span>
                {filePath === props.mainFilePath && <span className="file-list__main">main</span>}
              </button>
              <button
                type="button"
                className="file-list__menu-toggle"
                aria-label={`Actions for ${filePath}`}
                aria-expanded={openMenuFilePath === filePath}
                onClick={() => setOpenMenuFilePath(openMenuFilePath === filePath ? null : filePath)}
              >
                ⋯
              </button>
              {openMenuFilePath === filePath && (
                <div className="file-list__menu">
                  <button type="button" onClick={() => promptForRename(filePath)}>
                    Rename
                  </button>
                  {filePath !== props.mainFilePath && (
                    <button type="button" onClick={() => void runAction("Setting main file", () => props.onSetMainFile(filePath))}>
                      Make this the main file
                    </button>
                  )}
                  {filePath !== props.mainFilePath && (
                    <button type="button" className="button--danger" onClick={() => confirmTrash(filePath)}>
                      Move to trash
                    </button>
                  )}
                </div>
              )}
            </li>
            </Fragment>
          );
        })}
      </ul>

      <div className="file-sidebar__actions">
        <button type="button" onClick={promptForNewFile}>
          New file
        </button>
        <button type="button" onClick={() => void runAction("Exporting", () => props.onExport("zip"))}>
          Export project (.zip)
        </button>
        <button type="button" onClick={() => void runAction("Exporting", () => props.onExport("json"))}>
          Export story.json
        </button>
        {busyMessage && <p className="file-sidebar__busy">{busyMessage}…</p>}
      </div>
    </nav>
  );
}

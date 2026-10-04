import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import type { ProjectSummary } from "../../shared/apiTypes";
import { isValidProjectName } from "../../shared/projectPaths";

interface ProjectPickerProps {
  onOpenProject: (projectName: string) => void;
  showSignOut: boolean;
  onSignOut: () => void;
}

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function describeWhen(isoTimestamp: string): string {
  const elapsedSeconds = (new Date(isoTimestamp).getTime() - Date.now()) / 1000;
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, secondsPerUnit] of steps) {
    if (Math.abs(elapsedSeconds) >= secondsPerUnit) return relativeTimeFormatter.format(Math.round(elapsedSeconds / secondsPerUnit), unit);
  }
  return "just now";
}

export function ProjectPicker({ onOpenProject, showSignOut, onSignOut }: ProjectPickerProps) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const refreshProjects = () =>
    api
      .listProjects()
      .then(setProjects)
      .catch((loadFailure: Error) => setErrorMessage(loadFailure.message));

  useEffect(() => {
    void refreshProjects();
  }, []);

  const createProject = async (formEvent: FormEvent) => {
    formEvent.preventDefault();
    const trimmedName = newProjectName.trim();
    if (!isValidProjectName(trimmedName)) {
      setErrorMessage("Project names start with a letter or number and use letters, numbers, spaces, dots, dashes or underscores.");
      return;
    }
    try {
      await api.createProject(trimmedName);
      onOpenProject(trimmedName);
    } catch (createFailure) {
      setErrorMessage(createFailure instanceof Error ? createFailure.message : String(createFailure));
    }
  };

  const renameProject = async (projectName: string) => {
    const typedName = window.prompt("Rename project", projectName)?.trim();
    if (!typedName || typedName === projectName) return;
    try {
      await api.renameProject(projectName, typedName);
      await refreshProjects();
    } catch (renameFailure) {
      setErrorMessage(renameFailure instanceof Error ? renameFailure.message : String(renameFailure));
    }
  };

  const trashProject = async (projectName: string) => {
    if (!window.confirm(`Move "${projectName}" to the trash folder? It stays recoverable on the server under data/.trash.`)) return;
    await api.trashProject(projectName).catch((trashFailure: Error) => setErrorMessage(trashFailure.message));
    await refreshProjects();
  };

  return (
    <main className="project-picker">
      <header className="project-picker__header">
        <p className="wordmark">inkwell</p>
        {showSignOut && (
          <button type="button" className="button--quiet" onClick={onSignOut}>
            Sign out
          </button>
        )}
      </header>

      <form className="project-picker__create" onSubmit={createProject}>
        <label htmlFor="new-project-name">Start a new story</label>
        <div className="project-picker__create-row">
          <input
            id="new-project-name"
            value={newProjectName}
            onChange={(changeEvent) => setNewProjectName(changeEvent.target.value)}
            placeholder="Story name"
            autoCapitalize="words"
            autoComplete="off"
          />
          <button type="submit" className="button--verdigris">
            Create
          </button>
        </div>
      </form>

      {errorMessage && (
        <p className="form-error" role="alert">
          {errorMessage}
        </p>
      )}

      {projects === null ? (
        <p className="project-picker__loading">Loading stories…</p>
      ) : projects.length === 0 ? (
        <p className="project-picker__empty">No stories yet. Name one above to begin; it starts with a small example you can write over.</p>
      ) : (
        <ul className="project-list">
          {projects.map((project) => (
            <li key={project.name} className="project-list__item">
              <button type="button" className="project-list__open" onClick={() => onOpenProject(project.name)}>
                <span className="project-list__name">{project.name}</span>
                <span className="project-list__meta">
                  {project.fileCount} file{project.fileCount === 1 ? "" : "s"}, edited {describeWhen(project.lastModifiedIso)}
                </span>
              </button>
              <button type="button" className="button--quiet" onClick={() => void renameProject(project.name)}>
                Rename
              </button>
              <button type="button" className="button--quiet button--danger" onClick={() => void trashProject(project.name)}>
                Trash
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

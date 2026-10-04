import { useEffect, useState } from "react";
import { api, SIGNED_OUT_EVENT_NAME } from "./api";
import type { SessionStatus } from "../shared/apiTypes";
import { SignIn } from "./components/SignIn";
import { ProjectPicker } from "./components/ProjectPicker";
import { EditorScreen } from "./components/EditorScreen";
import { ProjectWorkspace } from "./workspace/projectWorkspace";

/** The open project lives in the URL hash (#/project/Name) so a Home Screen launch or reload returns to it. */
function projectNameFromLocation(): string | null {
  const hashMatch = /^#\/project\/(.+)$/.exec(window.location.hash);
  return hashMatch ? decodeURIComponent(hashMatch[1]) : null;
}

export function App() {
  const [sessionStatus, setSessionStatus] = useState<SessionStatus | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [openProjectName, setOpenProjectName] = useState<string | null>(projectNameFromLocation);
  const [workspace, setWorkspace] = useState<ProjectWorkspace | null>(null);
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null);

  const refreshSession = () =>
    api
      .getSession()
      .then((status) => {
        setSessionStatus(status);
        setSessionError(null);
      })
      .catch((sessionFailure: Error) => setSessionError(sessionFailure.message));

  useEffect(() => {
    void refreshSession();
    const handleSignedOut = () => setSessionStatus((current) => (current ? { ...current, signedIn: false } : current));
    const handleHashChange = () => setOpenProjectName(projectNameFromLocation());
    window.addEventListener(SIGNED_OUT_EVENT_NAME, handleSignedOut);
    window.addEventListener("hashchange", handleHashChange);
    return () => {
      window.removeEventListener(SIGNED_OUT_EVENT_NAME, handleSignedOut);
      window.removeEventListener("hashchange", handleHashChange);
    };
  }, []);

  const signedIn = Boolean(sessionStatus?.signedIn);

  useEffect(() => {
    if (!signedIn || !openProjectName) {
      setWorkspace(null);
      return;
    }
    let cancelled = false;
    let openedWorkspace: ProjectWorkspace | null = null;
    setProjectLoadError(null);
    ProjectWorkspace.open(openProjectName)
      .then((loadedWorkspace) => {
        if (cancelled) {
          loadedWorkspace.dispose();
          return;
        }
        openedWorkspace = loadedWorkspace;
        setWorkspace(loadedWorkspace);
      })
      .catch((loadFailure: Error) => !cancelled && setProjectLoadError(loadFailure.message));
    return () => {
      cancelled = true;
      openedWorkspace?.dispose();
    };
  }, [signedIn, openProjectName]);

  const openProject = (projectName: string) => {
    window.location.hash = `#/project/${encodeURIComponent(projectName)}`;
  };
  const leaveProject = () => {
    window.location.hash = "";
  };

  if (sessionError) {
    return (
      <main className="centered-message">
        <p>Can't reach the inkwell server ({sessionError}). Check that the container is running, then reload.</p>
        <button type="button" onClick={() => void refreshSession()}>
          Try again
        </button>
      </main>
    );
  }
  if (!sessionStatus) return <main className="centered-message" aria-busy="true" />;
  if (!signedIn) return <SignIn onSignedIn={() => void refreshSession()} />;

  if (!openProjectName) {
    return (
      <ProjectPicker
        onOpenProject={openProject}
        showSignOut={sessionStatus.passwordRequired}
        onSignOut={() => void api.signOut().then(refreshSession)}
      />
    );
  }
  if (projectLoadError) {
    return (
      <main className="centered-message">
        <p>Couldn't open “{openProjectName}”: {projectLoadError}</p>
        <button type="button" onClick={leaveProject}>
          Back to all stories
        </button>
      </main>
    );
  }
  if (!workspace || workspace.projectName !== openProjectName) return <main className="centered-message" aria-busy="true" />;
  return <EditorScreen key={workspace.projectName} workspace={workspace} onLeaveProject={leaveProject} />;
}

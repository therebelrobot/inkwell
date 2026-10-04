import type { InkDiagnostic } from "../../shared/inkProjectCompiler";

interface ProblemsListProps {
  diagnostics: InkDiagnostic[];
  compileDurationMilliseconds: number | null;
  onOpenLocation: (filePath: string, lineNumber: number) => void;
}

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;
const SEVERITY_WORD = { error: "Error", warning: "Warning", info: "Note" } as const;

export function ProblemsList({ diagnostics, compileDurationMilliseconds, onOpenLocation }: ProblemsListProps) {
  const sortedDiagnostics = [...diagnostics].sort(
    (first, second) =>
      SEVERITY_ORDER[first.severity] - SEVERITY_ORDER[second.severity] ||
      first.filePath.localeCompare(second.filePath) ||
      first.lineNumber - second.lineNumber,
  );

  if (sortedDiagnostics.length === 0) {
    return (
      <div className="pane-empty">
        <p>
          No problems. The story compiles
          {compileDurationMilliseconds !== null ? ` (${compileDurationMilliseconds} ms)` : ""} and the linter found nothing to flag.
        </p>
      </div>
    );
  }

  return (
    <ul className="problems">
      {sortedDiagnostics.map((diagnostic, diagnosticIndex) => (
        <li key={diagnosticIndex}>
          <button
            type="button"
            className={`problem problem--${diagnostic.severity}`}
            onClick={() => onOpenLocation(diagnostic.filePath, Math.max(1, diagnostic.lineNumber))}
          >
            <span className="problem__severity">{SEVERITY_WORD[diagnostic.severity]}</span>
            <span className="problem__message">{diagnostic.message}</span>
            <span className="problem__where">
              {diagnostic.filePath}
              {diagnostic.lineNumber > 0 ? `:${diagnostic.lineNumber}` : ""}
              {diagnostic.ruleId ? `  ${diagnostic.ruleId}` : ""}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

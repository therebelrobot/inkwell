import { useEffect, useRef, useState } from "react";
import { StoryPlayer, type TranscriptEntry } from "../story/storyPlayer";

interface PlayPreviewProps {
  compiledJson: string | null;
  /** True when the current text has errors and we're playing the last build that compiled. */
  playingStaleBuild: boolean;
  externalFunctionsToStub: string[];
  knotNames: string[];
  startKnotName: string | null;
  onStartKnotChange: (knotName: string | null) => void;
}

function TranscriptLine({ entry }: { entry: TranscriptEntry }) {
  switch (entry.kind) {
    case "line":
      return (
        <p className="transcript__line">
          {entry.text}
          {entry.tags.map((tag) => (
            <span key={tag} className="transcript__tag">
              #{tag}
            </span>
          ))}
        </p>
      );
    case "picked":
      return <p className="transcript__picked">{entry.text}</p>;
    case "notice":
      return <p className="transcript__notice">{entry.text}</p>;
    case "error":
      return <p className="transcript__error">{entry.text}</p>;
    case "end":
      return <p className="transcript__end">End of this path</p>;
  }
}

export function PlayPreview({ compiledJson, playingStaleBuild, externalFunctionsToStub, knotNames, startKnotName, onStartKnotChange }: PlayPreviewProps) {
  const playerRef = useRef<StoryPlayer | null>(null);
  const [, setRenderTick] = useState(0);
  const [showVariables, setShowVariables] = useState(false);
  const [creationError, setCreationError] = useState<string | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const previousStartKnotRef = useRef(startKnotName);
  const rerender = () => setRenderTick((tick) => tick + 1);

  // Rebuild on every new compile, replaying earlier choices so you stay where you were.
  useEffect(() => {
    if (!compiledJson) {
      playerRef.current = null;
      rerender();
      return;
    }
    const startKnotChanged = previousStartKnotRef.current !== startKnotName;
    previousStartKnotRef.current = startKnotName;
    const previousChoices = startKnotChanged ? [] : playerRef.current?.choiceHistory ?? [];
    try {
      const freshPlayer = new StoryPlayer(compiledJson, externalFunctionsToStub, startKnotName);
      freshPlayer.replayChoices(previousChoices);
      playerRef.current = freshPlayer;
      setCreationError(null);
    } catch (creationFailure) {
      playerRef.current = null;
      setCreationError(creationFailure instanceof Error ? creationFailure.message : String(creationFailure));
    }
    rerender();
  }, [compiledJson, startKnotName, externalFunctionsToStub]);

  const player = playerRef.current;
  const transcriptLength = player?.transcript.length ?? 0;
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [transcriptLength]);

  const restart = () => {
    if (!compiledJson) return;
    playerRef.current = new StoryPlayer(compiledJson, externalFunctionsToStub, startKnotName);
    rerender();
  };

  if (!compiledJson) {
    return (
      <div className="pane-empty">
        <p>{creationError ?? "Fix the errors listed under Problems and the story will play here."}</p>
      </div>
    );
  }

  return (
    <div className="play-preview">
      <div className="pane-toolbar">
        <button type="button" onClick={restart}>
          Restart
        </button>
        <button type="button" onClick={() => { player?.rewindOneChoice(); rerender(); }} disabled={!player?.canRewind}>
          Back one choice
        </button>
        <label className="pane-toolbar__select">
          <span>Start at</span>
          <select value={startKnotName ?? ""} onChange={(changeEvent) => onStartKnotChange(changeEvent.target.value || null)}>
            <option value="">The beginning</option>
            {knotNames.map((knotName) => (
              <option key={knotName} value={knotName}>
                {knotName}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="button--quiet" aria-pressed={showVariables} onClick={() => setShowVariables((shown) => !shown)}>
          Variables
        </button>
      </div>

      {playingStaleBuild && <p className="play-preview__stale">Playing the last version that compiled. The current text has errors.</p>}

      {showVariables && player && (
        <dl className="variables">
          {player.readVariables().map((variableReading) => (
            <div key={variableReading.name} className="variables__row">
              <dt>{variableReading.name}</dt>
              <dd>{variableReading.displayValue}</dd>
            </div>
          ))}
          {player.readVariables().length === 0 && <p className="variables__empty">No global variables declared.</p>}
        </dl>
      )}

      <div className="transcript" aria-live="polite">
        {player?.transcript.map((entry, entryIndex) => <TranscriptLine key={entryIndex} entry={entry} />)}
        <div ref={transcriptEndRef} />
      </div>

      {player && player.choices.length > 0 && (
        <ol className="choices">
          {player.choices.map((choice) => (
            <li key={choice.index}>
              <button type="button" onClick={() => { player.choose(choice.index); rerender(); }}>
                {choice.text}
                {choice.tags.map((tag) => (
                  <span key={tag} className="transcript__tag">
                    #{tag}
                  </span>
                ))}
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

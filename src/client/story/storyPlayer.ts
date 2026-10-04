import { Story } from "inkjs";

/**
 * Plays a compiled story for the preview pane. Like Inky, it remembers the
 * choices made so far; when the story recompiles it replays them on the new
 * build, so editing a line deep in a branch doesn't throw you back to the top.
 * If the edit removed a choice the replay needed, playback stops at that point
 * and says so.
 */

export type TranscriptEntry =
  | { kind: "line"; text: string; tags: string[] }
  | { kind: "picked"; text: string }
  | { kind: "notice"; text: string }
  | { kind: "error"; text: string }
  | { kind: "end" };

export interface PresentedChoice {
  index: number;
  text: string;
  tags: string[];
}

export interface VariableReading {
  name: string;
  displayValue: string;
}

const MAXIMUM_LINES_PER_ADVANCE = 2000;

interface RewindPoint {
  stateJson: string;
  transcriptLength: number;
  choiceHistoryLength: number;
}

export class StoryPlayer {
  readonly story: Story;
  transcript: TranscriptEntry[] = [];
  choices: PresentedChoice[] = [];
  choiceHistory: number[] = [];
  private rewindPoints: RewindPoint[] = [];
  private readonly runtimeMessages: string[] = [];

  constructor(compiledJson: string, externalFunctionsToStub: string[], private readonly startKnotPath: string | null) {
    this.story = new Story(compiledJson);
    // Inky plays with ink fallbacks on; matching that keeps "works in the preview" meaningful.
    this.story.allowExternalFunctionFallbacks = true;
    this.story.onError = (message: string) => {
      this.runtimeMessages.push(message);
    };
    for (const externalFunctionName of externalFunctionsToStub) {
      this.story.BindExternalFunction(externalFunctionName, (...functionArguments: unknown[]) => {
        this.transcript.push({ kind: "notice", text: `EXTERNAL ${externalFunctionName}(${functionArguments.map((value) => JSON.stringify(value)).join(", ")}) called; stubbed, returned nothing` });
        return null;
      }, false);
    }
    this.begin();
  }

  private begin(): void {
    if (this.startKnotPath) {
      try {
        this.story.ChoosePathString(this.startKnotPath);
        this.transcript.push({ kind: "notice", text: `Started at ${this.startKnotPath}` });
      } catch (choosePathFailure) {
        this.transcript.push({ kind: "error", text: errorText(choosePathFailure) });
      }
    }
    this.advance();
  }

  private flushRuntimeMessages(): void {
    for (const runtimeMessage of this.runtimeMessages.splice(0)) {
      this.transcript.push({ kind: runtimeMessage.toUpperCase().includes("WARNING") ? "notice" : "error", text: runtimeMessage });
    }
  }

  private advance(): void {
    let linesThisAdvance = 0;
    try {
      while (this.story.canContinue) {
        const lineText = (this.story.Continue() ?? "").trim();
        const lineTags = this.story.currentTags ?? [];
        this.flushRuntimeMessages();
        if (lineText !== "" || lineTags.length > 0) this.transcript.push({ kind: "line", text: lineText, tags: lineTags });
        linesThisAdvance += 1;
        if (linesThisAdvance > MAXIMUM_LINES_PER_ADVANCE) {
          this.transcript.push({ kind: "error", text: `Stopped after ${MAXIMUM_LINES_PER_ADVANCE} lines without a choice: is something looping?` });
          this.choices = [];
          return;
        }
      }
    } catch (runtimeFailure) {
      this.flushRuntimeMessages();
      this.transcript.push({ kind: "error", text: errorText(runtimeFailure) });
      this.choices = [];
      return;
    }
    this.flushRuntimeMessages();
    this.choices = this.story.currentChoices.map((choice) => ({ index: choice.index, text: choice.text, tags: choice.tags ?? [] }));
    if (this.choices.length === 0) this.transcript.push({ kind: "end" });
  }

  choose(choiceIndex: number): void {
    const pickedChoice = this.choices.find((choice) => choice.index === choiceIndex);
    if (!pickedChoice) return;
    this.rewindPoints.push({
      stateJson: this.story.state.toJson(),
      transcriptLength: this.transcript.length,
      choiceHistoryLength: this.choiceHistory.length,
    });
    this.transcript.push({ kind: "picked", text: pickedChoice.text });
    this.choiceHistory.push(choiceIndex);
    try {
      this.story.ChooseChoiceIndex(choiceIndex);
    } catch (chooseFailure) {
      this.transcript.push({ kind: "error", text: errorText(chooseFailure) });
      this.choices = [];
      return;
    }
    this.advance();
  }

  get canRewind(): boolean {
    return this.rewindPoints.length > 0;
  }

  /** Steps back to just before the most recent choice. */
  rewindOneChoice(): void {
    const rewindPoint = this.rewindPoints.pop();
    if (!rewindPoint) return;
    this.story.state.LoadJson(rewindPoint.stateJson);
    this.transcript = this.transcript.slice(0, rewindPoint.transcriptLength);
    this.choiceHistory = this.choiceHistory.slice(0, rewindPoint.choiceHistoryLength);
    this.choices = this.story.currentChoices.map((choice) => ({ index: choice.index, text: choice.text, tags: choice.tags ?? [] }));
  }

  /** Re-applies a previous run's choices on this (new) build. Returns how many replayed cleanly. */
  replayChoices(previousChoiceHistory: number[]): number {
    let replayedCount = 0;
    for (const previousChoiceIndex of previousChoiceHistory) {
      if (!this.choices.some((choice) => choice.index === previousChoiceIndex)) {
        this.transcript.push({ kind: "notice", text: "The story changed here, so the replay of your earlier choices stopped." });
        break;
      }
      this.choose(previousChoiceIndex);
      replayedCount += 1;
    }
    return replayedCount;
  }

  readVariables(): VariableReading[] {
    // inkjs keeps globals in a private Map; reading it is the only way to list them without parsing source.
    const globalVariables = (this.story.variablesState as unknown as { _globalVariables?: Map<string, { valueObject?: unknown; toString(): string }> })
      ._globalVariables;
    if (!(globalVariables instanceof Map)) return [];
    return [...globalVariables.entries()].map(([variableName, inkValue]) => ({ name: variableName, displayValue: describeInkValue(inkValue) }));
  }
}

function describeInkValue(inkValue: { valueObject?: unknown; toString(): string }): string {
  const rawValue = inkValue?.valueObject;
  if (typeof rawValue === "string") return JSON.stringify(rawValue);
  // InkList extends Map; an empty list would otherwise print as nothing at all.
  if (rawValue instanceof Map) return rawValue.size === 0 ? "() empty list" : `(${String(rawValue)})`;
  return rawValue === undefined || rawValue === null ? String(inkValue) : String(rawValue);
}

function errorText(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

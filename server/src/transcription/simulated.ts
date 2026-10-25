/**
 * Scripted transcript generator for testing without speech credentials.
 * It ignores audio entirely and every event it produces is flagged `simulated: true`
 * so the UI can label it — it must never be presented as live transcription.
 *
 * Timing follows the event order of Deepgram live streaming with interim results: one interim
 * result per word (the last one usually containing the complete text), then the finalized result
 * after the endpointing silence. The delays are modelling assumptions, not provider measurements.
 */
import type { SttCallbacks, SttProvider, SttStartOptions, SttStream } from './types.js';

export interface ScriptLine {
  /** Text emitted as one finalized segment. */
  text: string;
  /** Whether the speaker pauses after this segment (end of utterance). */
  speechFinal: boolean;
  /** Pause before this line starts, ms (at speed 1). */
  gapMs?: number;
  /** Re-emit this final, as some STT providers occasionally do. */
  duplicate?: boolean;
  /** Emit an interim result containing the complete text before the final (default true). */
  interimFull?: boolean;
  /** Delay between the last word and the final result, ms at speed 1 (models endpointing; default 300). */
  finalDelayMs?: number;
  /** For speechFinal=false lines: emit UtteranceEnd this long after the last word (models utterance_end_ms). */
  utteranceEndDelayMs?: number;
  /** Final text when it differs from the interim text (the provider revised its hypothesis). */
  finalText?: string;
}

/** Demonstrates filler, split, indirect, follow-up, personal and duplicate questions. */
export const DEFAULT_SCRIPT: ScriptLine[] = [
  { text: 'Hi, thanks for joining today. Can you hear me okay?', speechFinal: true, gapMs: 800 },
  { text: "Great. Let's start with something technical.", speechFinal: true },
  { text: 'Can you explain the difference between', speechFinal: false },
  { text: 'a process and a thread?', speechFinal: true, gapMs: 300 },
  { text: 'Okay, that makes sense.', speechFinal: true, gapMs: 6_000 },
  { text: 'Walk me through how you would design a rate limiter for a public API.', speechFinal: true, gapMs: 2_000 },
  { text: 'And how would it behave across multiple servers?', speechFinal: true, gapMs: 5_000 },
  { text: 'Tell me about a project where you handled a large transaction volume.', speechFinal: true, gapMs: 6_000, duplicate: true },
  { text: 'What did you study at university?', speechFinal: true, gapMs: 6_000 },
  { text: "Alright, that's all from my side, right?", speechFinal: true, gapMs: 6_000 },
];

const WORD_MS = 220;
const DEFAULT_FINAL_DELAY_MS = 300;
const DEFAULT_GAP_MS = 1_500;

class SimulatedStream implements SttStream {
  private timers = new Set<NodeJS.Timeout>();
  private closed = false;

  constructor(
    private readonly script: ScriptLine[],
    private readonly speed: number,
    private readonly cb: SttCallbacks,
  ) {
    this.cb.onStatus('transcriber_connected', 'Simulated transcript (test mode, not real audio)');
    void this.run();
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.timers.delete(t);
        resolve();
      }, ms / this.speed);
      this.timers.add(t);
    });
  }

  private async run(): Promise<void> {
    let clockMs = 0;
    for (const line of this.script) {
      const gap = line.gapMs ?? DEFAULT_GAP_MS;
      await this.wait(gap);
      if (this.closed) return;
      clockMs += gap;
      const startMs = clockMs;
      const words = line.text.split(' ');
      // One interim result per spoken word; the last one carries the complete text unless disabled.
      const interimWords = line.interimFull === false ? words.length - 1 : words.length;
      for (let i = 1; i <= words.length; i++) {
        await this.wait(WORD_MS);
        if (this.closed) return;
        clockMs += WORD_MS;
        if (i <= interimWords) this.cb.onPartial({ text: words.slice(0, i).join(' '), startMs, endMs: clockMs });
      }
      // The final arrives after the endpointing silence.
      const finalDelay = line.finalDelayMs ?? DEFAULT_FINAL_DELAY_MS;
      await this.wait(finalDelay);
      if (this.closed) return;
      const segment = { text: line.finalText ?? line.text, startMs, endMs: clockMs, speechFinal: line.speechFinal };
      this.cb.onFinal(segment);
      if (line.duplicate) this.cb.onFinal({ ...segment });
      if (line.speechFinal) this.cb.onUtteranceEnd();
      else if (line.utteranceEndDelayMs !== undefined) {
        const t = setTimeout(
          () => {
            this.timers.delete(t);
            if (!this.closed) this.cb.onUtteranceEnd();
          },
          Math.max(0, line.utteranceEndDelayMs - finalDelay) / this.speed,
        );
        this.timers.add(t);
      }
      clockMs += finalDelay;
    }
    if (!this.closed) this.cb.onStatus('transcriber_closed', 'Simulated script finished');
  }

  sendAudio(): void {
    // Audio is intentionally ignored in simulation mode.
  }

  async finish(): Promise<void> {
    this.close();
  }

  close(): void {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}

export class SimulatedSttProvider implements SttProvider {
  readonly name = 'simulated';
  readonly simulated = true;

  constructor(
    private readonly speed = 1,
    private readonly script: ScriptLine[] = DEFAULT_SCRIPT,
  ) {}

  isConfigured(): boolean {
    return true;
  }

  start(_options: SttStartOptions, callbacks: SttCallbacks): SttStream {
    return new SimulatedStream(this.script, this.speed, callbacks);
  }
}

/**
 * Tracks, within the current utterance, when each transcript state (partial or final) was received,
 * so the server can tell when a detected question's complete text first became available.
 * That moment is the reference point for all latency milestones.
 */
import { normalizeText } from '@meeting-copilot/shared';

interface Observation {
  text: string;
  at: number;
}

export class TextAvailability {
  private observations: Observation[] = [];

  constructor(private readonly maxObservations = 64) {}

  /** Record the full utterance text known at time `at` (pending finals + current partial). */
  observe(utteranceText: string, at: number): void {
    const text = normalizeText(utteranceText);
    if (!text) return;
    const last = this.observations.at(-1);
    if (last?.text === text) return;
    this.observations.push({ text, at });
    if (this.observations.length > this.maxObservations) this.observations.shift();
  }

  /** Earliest observation that already contained `question` in full; `fallback` if none did. */
  availableAt(question: string, fallback: number): number {
    const q = normalizeText(question);
    if (!q) return fallback;
    for (const o of this.observations) if (o.text.includes(q)) return Math.min(o.at, fallback);
    return fallback;
  }

  reset(): void {
    this.observations = [];
  }
}

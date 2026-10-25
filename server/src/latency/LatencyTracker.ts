/**
 * Lightweight latency instrumentation for the question -> answer path.
 * Records timestamps only (never question or answer text) in a bounded ring buffer.
 *
 * Milestones, all relative to `textAvailableAt` (the moment the transcript first contained the
 * complete question text, from a partial or a final result):
 *   detect     detectedAt   - textAvailableAt   question accepted
 *   dispatch   dispatchedAt - textAvailableAt   request sent to the LLM provider
 *   ttft       firstTokenAt - dispatchedAt      provider time to first token
 *   firstText  firstTokenAt - textAvailableAt   first answer text leaves the server
 *   displayed  displayedAt  - textAvailableAt   first answer text rendered in the UI (reported by the client)
 *   complete   completedAt  - textAvailableAt   answer finished
 */

export type TraceKind = 'auto' | 'speculative' | 'manual' | 'retry';
export type TraceOutcome = 'completed' | 'failed' | 'cancelled' | 'rejected';

export interface LatencyTrace {
  requestId: string;
  questionId: string;
  kind: TraceKind;
  provider: string;
  simulated: boolean;
  textAvailableAt: number;
  detectedAt: number;
  dispatchedAt?: number;
  firstTokenAt?: number;
  completedAt?: number;
  displayedAt?: number;
  outcome?: TraceOutcome;
}

export const MILESTONES = ['detect', 'dispatch', 'ttft', 'firstText', 'displayed', 'complete'] as const;
export type Milestone = (typeof MILESTONES)[number];

export interface Percentiles {
  n: number;
  p50: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
}

/** Nearest-rank percentile (no interpolation), suitable for small samples. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? null;
}

export function summarize(values: number[]): Percentiles {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), min: sorted[0] ?? null, max: sorted.at(-1) ?? null };
}

export function milestoneValue(t: LatencyTrace, m: Milestone): number | null {
  const d = (a: number | undefined, b: number | undefined) => (a === undefined || b === undefined ? null : Math.max(0, a - b));
  switch (m) {
    case 'detect':
      return d(t.detectedAt, t.textAvailableAt);
    case 'dispatch':
      return d(t.dispatchedAt, t.textAvailableAt);
    case 'ttft':
      return d(t.firstTokenAt, t.dispatchedAt);
    case 'firstText':
      return d(t.firstTokenAt, t.textAvailableAt);
    case 'displayed':
      return d(t.displayedAt, t.textAvailableAt);
    case 'complete':
      return t.outcome === 'completed' ? d(t.completedAt, t.textAvailableAt) : null;
  }
}

export class LatencyTracker {
  private readonly traces = new Map<string, LatencyTrace>();

  constructor(private readonly capacity = 500) {}

  start(trace: LatencyTrace): void {
    this.traces.set(trace.requestId, trace);
    while (this.traces.size > this.capacity) {
      const oldest = this.traces.keys().next().value;
      if (oldest === undefined) break;
      this.traces.delete(oldest);
    }
  }

  update(requestId: string, patch: Partial<LatencyTrace>): LatencyTrace | undefined {
    const t = this.traces.get(requestId);
    if (!t) return undefined;
    Object.assign(t, patch);
    return t;
  }

  get(requestId: string): LatencyTrace | undefined {
    return this.traces.get(requestId);
  }

  all(filter?: (t: LatencyTrace) => boolean): LatencyTrace[] {
    return [...this.traces.values()].filter((t) => (filter ? filter(t) : true));
  }

  summary(filter?: (t: LatencyTrace) => boolean): Record<Milestone, Percentiles> {
    const traces = this.all(filter);
    const out = {} as Record<Milestone, Percentiles>;
    for (const m of MILESTONES) {
      out[m] = summarize(traces.map((t) => milestoneValue(t, m)).filter((v): v is number => v !== null));
    }
    return out;
  }

  clear(): void {
    this.traces.clear();
  }
}

/** Process-wide tracker (exposed read-only via GET /api/metrics/latency). */
export const latencyTracker = new LatencyTracker();

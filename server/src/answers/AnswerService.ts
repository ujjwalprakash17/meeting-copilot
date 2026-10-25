/**
 * Streams suggested answers from the LLM provider to the client.
 *  - One generation at a time per session: a newer question supersedes (aborts) the active one.
 *  - At most one request per question unless the user explicitly retries.
 *  - Timeouts: a first-token deadline plus an overall deadline.
 */
import type { AnswerContextInfo, AnswerGrounding, ServerEvent } from '@meeting-copilot/shared';
import { latencyTracker, type LatencyTracker, type TraceKind } from '../latency/LatencyTracker.js';
import type { Logger } from '@meeting-copilot/shared';
import { log as rootLog } from '../logger.js';
import { LlmError, type LlmMessage, type LlmProvider } from '../llm/types.js';
import { elapsedMs, monotonicNow } from '@meeting-copilot/shared';

export interface AnswerJob {
  requestId: string;
  questionId: string;
  messages: LlmMessage[];
  context: AnswerContextInfo;
  grounding: AnswerGrounding;
  /** Retry bypasses per-question dedupe. */
  force?: boolean;
  /** When set, this fixed text is streamed instead of calling the LLM (e.g. insufficient resume evidence). */
  fixedText?: string;
  /** Output token cap for this answer (defaults to the service-wide cap). */
  maxTokens?: number;
  /** Latency reference points for instrumentation. */
  trace?: { kind: TraceKind; textAvailableAt: number; detectedAt: number };
}

interface ActiveJob {
  requestId: string;
  questionId: string;
  controller: AbortController;
  cancelReason: 'superseded' | 'user' | 'session_ended' | 'speculation_rejected' | null;
}

export interface AnswerServiceOptions {
  timeoutMs: number;
  firstTokenTimeoutMs?: number;
  maxTokens: number;
  tracker?: LatencyTracker;
  /** Logger carrying the session correlation id (sid). */
  log?: Logger;
}

export class AnswerService {
  private active: ActiveJob | null = null;
  private readonly answered = new Set<string>();
  private readonly lastAnswer = new Map<string, string>();

  constructor(
    private readonly llm: LlmProvider,
    private readonly send: (event: ServerEvent) => void,
    private readonly opts: AnswerServiceOptions,
  ) {}

  private logger: Logger | undefined;

  /** Attach the session's logger (adds the session correlation id once it is known). */
  setLogger(logger: Logger): void {
    this.logger = logger;
  }

  hasAnswered(questionId: string): boolean {
    return this.answered.has(questionId);
  }

  answerFor(questionId: string): string | undefined {
    return this.lastAnswer.get(questionId);
  }

  /** Request currently streaming, if any. */
  activeRequest(): { requestId: string; questionId: string } | null {
    return this.active ? { requestId: this.active.requestId, questionId: this.active.questionId } : null;
  }

  /** Forget that a question was answered (used when a tentative question is retracted). */
  forget(questionId: string): void {
    this.answered.delete(questionId);
    this.lastAnswer.delete(questionId);
  }

  isGenerating(questionId?: string): boolean {
    return this.active !== null && (questionId === undefined || this.active.questionId === questionId);
  }

  cancel(requestId: string, reason: 'user' | 'superseded' | 'session_ended' | 'speculation_rejected' = 'user'): void {
    if (this.active?.requestId !== requestId) return;
    // The first reason wins (e.g. a rejected speculation must not be reported as "superseded").
    this.active.cancelReason ??= reason;
    this.active.controller.abort();
  }

  cancelAll(reason: 'superseded' | 'session_ended'): void {
    if (this.active) this.cancel(this.active.requestId, reason);
  }

  /** Returns false when skipped as a duplicate. */
  async generate(job: AnswerJob): Promise<boolean> {
    if (!job.force && (this.answered.has(job.questionId) || this.active?.questionId === job.questionId)) return false;
    if (this.active) this.cancel(this.active.requestId, 'superseded');
    this.answered.add(job.questionId);

    const controller = new AbortController();
    const current: ActiveJob = { requestId: job.requestId, questionId: job.questionId, controller, cancelReason: null };
    this.active = current;
    const startedAt = Date.now();
    const t0 = monotonicNow();
    const tracker = this.opts.tracker ?? latencyTracker;
    const provider = job.fixedText ? 'resume-check' : this.llm.name;
    const llmLog = (this.logger ?? this.opts.log ?? rootLog).child(provider, { rid: job.requestId, qid: job.questionId });
    llmLog.debug('request_started', { model: job.fixedText ? 'none' : this.llm.model, kind: job.trace?.kind, prompt_chars: job.context.promptChars, max_tokens: job.maxTokens });
    tracker.start({
      requestId: job.requestId,
      questionId: job.questionId,
      kind: job.trace?.kind ?? (job.force ? 'retry' : 'auto'),
      provider: job.fixedText ? 'none' : this.llm.name,
      simulated: job.fixedText ? false : this.llm.simulated,
      textAvailableAt: job.trace?.textAvailableAt ?? startedAt,
      detectedAt: job.trace?.detectedAt ?? startedAt,
      dispatchedAt: startedAt,
    });
    let firstTokenAt: number | null = null;
    let text = '';
    let timedOut = false;
    const overall = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.opts.timeoutMs);
    const firstToken = setTimeout(() => {
      if (firstTokenAt === null) {
        timedOut = true;
        controller.abort();
      }
    }, this.opts.firstTokenTimeoutMs ?? Math.min(15_000, this.opts.timeoutMs));

    this.send({
      type: 'answer.start',
      requestId: job.requestId,
      questionId: job.questionId,
      model: job.fixedText ? 'resume-check (no LLM call)' : this.llm.model,
      simulated: job.fixedText ? false : this.llm.simulated,
      context: job.context,
      grounding: job.grounding,
      ts: Date.now(),
    });

    try {
      const deltas: AsyncIterable<string> = job.fixedText
        ? (async function* (t: string) {
            yield t;
          })(job.fixedText)
        : this.llm.stream({ messages: job.messages, maxTokens: Math.min(job.maxTokens ?? this.opts.maxTokens, this.opts.maxTokens), signal: controller.signal });
      for await (const delta of deltas) {
        if (controller.signal.aborted) break;
        if (firstTokenAt === null) {
          firstTokenAt = Date.now();
          tracker.update(job.requestId, { firstTokenAt });
          llmLog.debug('first_token', { ttft_ms: elapsedMs(t0) });
        }
        text += delta;
        this.send({ type: 'answer.delta', requestId: job.requestId, delta, ts: Date.now() });
      }
      if (controller.signal.aborted) throw new LlmError('timeout', 'aborted', true);
      this.lastAnswer.set(job.questionId, text);
      const trace = tracker.update(job.requestId, { completedAt: Date.now(), outcome: 'completed' });
      this.send({
        type: 'answer.completed',
        requestId: job.requestId,
        firstTokenMs: firstTokenAt === null ? null : firstTokenAt - startedAt,
        durationMs: Date.now() - startedAt,
        ts: Date.now(),
      });
      // Timings only; never answer or question text.
      llmLog.info('generation_completed', {
        kind: trace?.kind,
        since_text_ms: trace ? startedAt - trace.textAvailableAt : null,
        ttft_ms: firstTokenAt === null ? null : firstTokenAt - startedAt,
        duration_ms: elapsedMs(t0),
        answer_chars: text.length,
      });
    } catch (err) {
      tracker.update(job.requestId, {
        completedAt: Date.now(),
        outcome: current.cancelReason === 'speculation_rejected' ? 'rejected' : current.cancelReason ? 'cancelled' : 'failed',
      });
      if (current.cancelReason) {
        llmLog.debug('generation_cancelled', { reason: current.cancelReason, duration_ms: elapsedMs(t0) });
        this.send({ type: 'answer.cancelled', requestId: job.requestId, questionId: job.questionId, reason: current.cancelReason, ts: Date.now() });
      } else {
        const e =
          timedOut
            ? new LlmError('timeout', `No complete answer within ${Math.round(this.opts.timeoutMs / 1000)} s. Try again.`, true)
            : err instanceof LlmError
              ? err
              : new LlmError('internal', err instanceof Error ? err.message : 'Unknown error', true);
        // Allow a later automatic attempt for retryable errors.
        if (e.retryable) this.answered.delete(job.questionId);
        // Configuration problems are errors; transient provider/network problems are warnings.
        (e.retryable ? llmLog.warn : llmLog.error)('generation_failed', {
          code: e.code,
          status: e.status,
          provider_request_id: e.providerRequestId,
          retryable: e.retryable,
          retry_after_ms: e.retryAfterMs,
          duration_ms: elapsedMs(t0),
          err: e.message,
          recovery: e.retryable ? 'user_can_retry' : 'fix_configuration',
        });
        this.send({
          type: 'answer.error',
          requestId: job.requestId,
          questionId: job.questionId,
          code: e.code,
          message: e.message,
          retryable: e.retryable,
          ts: Date.now(),
        });
      }
    } finally {
      clearTimeout(overall);
      clearTimeout(firstToken);
      if (this.active === current) this.active = null;
    }
    return true;
  }
}

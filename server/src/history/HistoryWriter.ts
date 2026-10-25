/**
 * Asynchronous, batched writer in front of a HistoryRepository.
 *
 * Latency: callers only push to an in-memory queue (no I/O). Writes happen later, debounced and
 * batched into one transaction, so persistence never delays transcript or answer streaming.
 *
 * Consistency:
 *  - Within a batch only the newest version of each card is written; the repository also refuses to
 *    overwrite a newer card with an older one.
 *  - Deleting a conversation (or everything) first drops queued writes for it and tombstones its ID,
 *    so a write that was already queued cannot resurrect deleted data.
 *  - Flushes are serialized; deletes wait for an in-flight flush before running.
 *  - A failed batch is retried once, then dropped and reported via `onError`.
 */
import { log } from '../logger.js';

const dbLog = log.child('history-db');
import type { CardRecord, HistoryOp, HistoryRepository } from './types.js';

export interface HistoryWriterOptions {
  debounceMs?: number;
  /** Upper bound on how long a write can wait in the queue. */
  maxDelayMs?: number;
  retryDelayMs?: number;
}

export type HistoryErrorListener = (error: Error, info: { dropped: number; willRetry: boolean }) => void;

export class HistoryWriter {
  private queue: HistoryOp[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstQueuedAt: number | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private readonly tombstones = new Set<string>();
  private readonly listeners = new Set<HistoryErrorListener>();
  private closed = false;
  /** Recent flush durations in ms (for the metrics endpoint). */
  readonly flushDurations: number[] = [];

  constructor(
    readonly repository: HistoryRepository,
    private readonly opts: HistoryWriterOptions = {},
  ) {}

  onError(listener: HistoryErrorListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private conversationOf(op: HistoryOp): string {
    return op.kind === 'conversation' ? op.value.id : op.value.conversationId;
  }

  enqueue(op: HistoryOp): void {
    if (this.closed || this.tombstones.has(this.conversationOf(op))) return;
    this.queue.push(op);
    this.firstQueuedAt ??= Date.now();
    this.schedule(this.opts.debounceMs ?? 400);
  }

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    const waited = this.firstQueuedAt === null ? 0 : Date.now() - this.firstQueuedAt;
    const wait = Math.max(0, Math.min(delay, (this.opts.maxDelayMs ?? 2_000) - waited));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, wait);
    this.timer.unref?.();
  }

  /** Collapses the queue: newest version per card, latest timestamp per conversation, conversations first. */
  private static compact(ops: HistoryOp[]): HistoryOp[] {
    const conversations = new Map<string, HistoryOp & { kind: 'conversation' }>();
    const cards = new Map<string, CardRecord>();
    for (const op of ops) {
      if (op.kind === 'conversation') {
        const prev = conversations.get(op.value.id);
        if (!prev || op.value.at > prev.value.at) conversations.set(op.value.id, op);
      } else {
        const prev = cards.get(op.value.id);
        if (!prev || op.value.updatedAt >= prev.updatedAt) cards.set(op.value.id, op.value);
      }
    }
    return [...conversations.values(), ...[...cards.values()].map((value) => ({ kind: 'card' as const, value }))];
  }

  /** Writes everything queued so far. Safe to call at any time; flushes run one after another. */
  flush(): Promise<void> {
    this.flushing = this.flushing.then(() => this.flushOnce(0));
    return this.flushing;
  }

  private async flushOnce(attempt: number, retryOps?: HistoryOp[]): Promise<void> {
    const ops = retryOps ?? this.queue.splice(0);
    if (!retryOps) this.firstQueuedAt = null;
    const batch = HistoryWriter.compact(ops).filter((op) => !this.tombstones.has(this.conversationOf(op)));
    if (batch.length === 0) return;
    const started = performance.now();
    try {
      await this.repository.applyBatch(batch);
      this.flushDurations.push(performance.now() - started);
      if (this.flushDurations.length > 200) this.flushDurations.shift();
      dbLog.debug('flushed', { ops: batch.length, duration_ms: Math.round(performance.now() - started), retry: attempt > 0 });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const willRetry = attempt === 0 && !this.closed;
      (willRetry ? dbLog.warn : dbLog.error)('write_failed', {
        ops: batch.length,
        attempt: attempt + 1,
        err: error,
        duration_ms: Math.round(performance.now() - started),
        recovery: willRetry ? 'retry_once' : 'batch_dropped_ui_notified',
      });
      for (const l of this.listeners) l(error, { dropped: willRetry ? 0 : batch.length, willRetry });
      if (willRetry) {
        await new Promise((r) => setTimeout(r, this.opts.retryDelayMs ?? 1_000));
        // Merge with anything queued meanwhile; newer versions win in compact().
        await this.flushOnce(1, [...batch, ...this.queue.splice(0)]);
      }
    }
  }

  async deleteConversation(id: string): Promise<boolean> {
    this.tombstones.add(id);
    this.queue = this.queue.filter((op) => this.conversationOf(op) !== id);
    await this.flushing;
    return this.repository.deleteConversation(id);
  }

  async deleteAll(): Promise<number> {
    for (const op of this.queue) this.tombstones.add(this.conversationOf(op));
    this.queue = [];
    await this.flushing;
    const ids = await this.repository.deleteAll();
    for (const id of ids) this.tombstones.add(id);
    return ids.length;
  }

  isDeleted(id: string): boolean {
    return this.tombstones.has(id);
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    await this.flush();
    this.closed = true;
    this.repository.close();
  }
}

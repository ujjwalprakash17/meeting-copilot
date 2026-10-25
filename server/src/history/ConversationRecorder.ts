/**
 * Derives history records from a session's outgoing event stream (after the events were sent to the
 * client), and hands them to the HistoryWriter queue.
 *
 *  - Tentative (speculative) questions are not saved unless confirmed; retracted ones never are.
 *  - Answer text accumulates in memory while streaming; the card is written once per state change
 *    (question accepted, then completed/failed/cancelled), never once per token.
 *  - Only question text, answer text and small metadata are recorded.
 */
import type { ServerEvent } from '@meeting-copilot/shared';
import type { HistoryWriter } from './HistoryWriter.js';
import type { CardRecord, CardStatus } from './types.js';

interface QuestionState {
  id: string;
  conversationId: string;
  text: string;
  source: 'auto' | 'manual';
  createdAt: number;
  speculative: boolean;
  latestRequestId: string | null;
}

interface RequestState {
  questionId: string;
  text: string;
  model: string;
  simulated: boolean;
  groundingKind: string;
  groundingEvidence: string;
  groundingSections: string[];
  /** Terminal state, once reached. */
  done: CardStatus | null;
  firstTokenMs: number | null;
  durationMs: number | null;
  errorCode: string | null;
}

const MAX_TRACKED = 100;

export class ConversationRecorder {
  private readonly questions = new Map<string, QuestionState>();
  private readonly requests = new Map<string, RequestState>();

  constructor(
    private readonly writer: HistoryWriter,
    private conversationId: string | undefined,
    private readonly simulated: () => boolean,
  ) {}

  setConversation(id: string | undefined): void {
    this.conversationId = id;
  }

  private write(q: QuestionState, status: CardStatus): void {
    const now = Date.now();
    this.writer.enqueue({ kind: 'conversation', value: { id: q.conversationId, at: now, simulated: this.simulated() } });
    const req = q.latestRequestId ? this.requests.get(q.latestRequestId) : undefined;
    this.writer.enqueue({
      kind: 'card',
      value: {
        id: q.id,
        conversationId: q.conversationId,
        createdAt: q.createdAt,
        updatedAt: now,
        question: q.text,
        source: q.source,
        status,
        answer: req?.text || null,
        model: req?.model ?? null,
        simulated: req?.simulated ?? this.simulated(),
        groundingKind: req?.groundingKind ?? null,
        groundingEvidence: req?.groundingEvidence ?? null,
        groundingSections: req?.groundingSections ?? [],
        firstTokenMs: req?.firstTokenMs ?? null,
        durationMs: req?.durationMs ?? null,
        errorCode: req?.errorCode ?? null,
      } satisfies CardRecord,
    });
  }

  private prune(): void {
    while (this.questions.size > MAX_TRACKED) {
      const oldest = this.questions.keys().next().value;
      if (oldest === undefined) break;
      this.questions.delete(oldest);
    }
  }

  observe(event: ServerEvent): void {
    switch (event.type) {
      case 'question.detected': {
        if (!this.conversationId) return;
        const q: QuestionState = {
          id: event.question.id,
          conversationId: this.conversationId,
          text: event.question.text,
          source: event.question.source,
          createdAt: event.question.detectedAt,
          speculative: event.question.speculative,
          latestRequestId: null,
        };
        this.questions.set(q.id, q);
        this.prune();
        if (!q.speculative) this.write(q, 'pending');
        return;
      }
      case 'question.updated': {
        const q = this.questions.get(event.questionId);
        if (!q) return;
        if (event.status === 'retracted') {
          this.questions.delete(q.id);
          if (q.latestRequestId) this.requests.delete(q.latestRequestId);
          return;
        }
        q.speculative = false;
        if (event.text) q.text = event.text;
        const req = q.latestRequestId ? this.requests.get(q.latestRequestId) : undefined;
        // If the tentative answer already finished, the confirmation is what makes it saveable.
        this.write(q, req?.done ?? 'pending');
        return;
      }
      case 'answer.start': {
        const q = this.questions.get(event.questionId);
        if (!q) return;
        q.latestRequestId = event.requestId;
        this.requests.set(event.requestId, {
          questionId: q.id,
          text: '',
          model: event.model,
          simulated: event.simulated,
          groundingKind: event.grounding.kind,
          groundingEvidence: event.grounding.evidence,
          groundingSections: event.grounding.sections,
          done: null,
          firstTokenMs: null,
          durationMs: null,
          errorCode: null,
        });
        return;
      }
      case 'answer.delta': {
        const r = this.requests.get(event.requestId);
        if (r) r.text += event.delta;
        return;
      }
      case 'answer.completed':
      case 'answer.error':
      case 'answer.cancelled': {
        const r = this.requests.get(event.requestId);
        const q = r ? this.questions.get(r.questionId) : undefined;
        if (!r || !q || q.latestRequestId !== event.requestId) return;
        if (event.type === 'answer.cancelled' && event.reason === 'speculation_rejected') return;
        const status: CardStatus = event.type === 'answer.completed' ? 'completed' : event.type === 'answer.error' ? 'failed' : 'cancelled';
        r.done = status;
        if (event.type === 'answer.completed') {
          r.firstTokenMs = event.firstTokenMs;
          r.durationMs = event.durationMs;
        }
        if (event.type === 'answer.error') r.errorCode = event.code;
        // Tentative answers are saved only once the question is confirmed (see question.updated).
        if (q.speculative) return;
        this.write(q, status);
        return;
      }
      default:
        return;
    }
  }
}

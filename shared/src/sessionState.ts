/**
 * Pure reducer that turns the server event stream into UI state.
 * Used by the offscreen document (authoritative copy while a session runs)
 * and by the assistant window (rendering copy), so both stay consistent.
 */
import { LIMITS } from './config.js';
import type { AnswerContextInfo, AnswerGrounding, DetectedQuestion, ErrorCode, ServerEvent, TranscriptSegment } from './events.js';

export type AnswerStatus = 'generating' | 'completed' | 'failed' | 'cancelled';

export interface AnswerAttempt {
  requestId: string;
  status: AnswerStatus;
  text: string;
  model?: string;
  simulated?: boolean;
  context?: AnswerContextInfo;
  grounding?: AnswerGrounding;
  errorCode?: ErrorCode;
  errorMessage?: string;
  retryable?: boolean;
  firstTokenMs?: number | null;
  durationMs?: number;
  startedAt: number;
}

export interface QuestionCard {
  question: DetectedQuestion;
  attempts: AnswerAttempt[];
}

export interface SessionNotice {
  code: string;
  message: string;
  fatal: boolean;
  ts: number;
}

export interface CopilotState {
  sessionId: string | null;
  sttProvider: string | null;
  llmProvider: string | null;
  llmModel: string | null;
  /** True when the transcript comes from the scripted simulator, not real audio. */
  sttSimulated: boolean;
  llmSimulated: boolean;
  segments: TranscriptSegment[];
  partial: { text: string; startMs: number } | null;
  cards: QuestionCard[];
  lastNotice: SessionNotice | null;
  transcriberState: 'transcriber_connected' | 'transcriber_reconnecting' | 'transcriber_closed' | null;
  ended: boolean;
}

export const initialCopilotState = (): CopilotState => ({
  sessionId: null,
  sttProvider: null,
  llmProvider: null,
  llmModel: null,
  sttSimulated: false,
  llmSimulated: false,
  segments: [],
  partial: null,
  cards: [],
  lastNotice: null,
  transcriberState: null,
  ended: false,
});

function updateAttempt(
  state: CopilotState,
  requestId: string,
  update: (a: AnswerAttempt) => AnswerAttempt,
): CopilotState {
  let changed = false;
  const cards = state.cards.map((card) => {
    if (!card.attempts.some((a) => a.requestId === requestId)) return card;
    changed = true;
    return { ...card, attempts: card.attempts.map((a) => (a.requestId === requestId ? update(a) : a)) };
  });
  return changed ? { ...state, cards } : state;
}

export function reduceServerEvent(state: CopilotState, event: ServerEvent): CopilotState {
  switch (event.type) {
    case 'session.ready':
      return {
        ...state,
        sessionId: event.sessionId,
        sttProvider: event.stt.provider,
        sttSimulated: event.stt.simulated,
        llmProvider: event.llm.provider,
        llmModel: event.llm.model,
        llmSimulated: event.llm.simulated,
        ended: false,
      };
    case 'session.status':
      return { ...state, transcriberState: event.state };
    case 'session.error':
      return { ...state, lastNotice: { code: event.code, message: event.message, fatal: event.fatal, ts: event.ts } };
    case 'session.ended':
      return { ...state, partial: null, ended: true };
    case 'transcript.partial':
      return { ...state, partial: event.text ? { text: event.text, startMs: event.startMs } : null };
    case 'transcript.final': {
      if (state.segments.some((s) => s.id === event.segment.id)) return { ...state, partial: null };
      // Keep the transcript in time order even if a segment arrives late (e.g. split speaker runs).
      const segments = [...state.segments];
      let at = segments.length;
      while (at > 0 && (segments[at - 1]?.startMs ?? 0) > event.segment.startMs) at--;
      segments.splice(at, 0, event.segment);
      if (segments.length > LIMITS.maxTranscriptSegments) segments.splice(0, segments.length - LIMITS.maxTranscriptSegments);
      return { ...state, segments, partial: null };
    }
    case 'question.detected': {
      if (state.cards.some((c) => c.question.id === event.question.id)) return state;
      const cards = [...state.cards, { question: event.question, attempts: [] }];
      if (cards.length > LIMITS.maxQuestionCards) cards.splice(0, cards.length - LIMITS.maxQuestionCards);
      return { ...state, cards };
    }
    case 'question.updated': {
      if (event.status === 'retracted') {
        // A tentative (interim-transcript) question turned out to be wrong: discard it and its draft.
        const cards = state.cards.filter((c) => c.question.id !== event.questionId);
        return cards.length === state.cards.length ? state : { ...state, cards };
      }
      return {
        ...state,
        cards: state.cards.map((c) =>
          c.question.id === event.questionId ? { ...c, question: { ...c.question, speculative: false, text: event.text ?? c.question.text } } : c,
        ),
      };
    }
    case 'answer.start': {
      const attempt: AnswerAttempt = {
        requestId: event.requestId,
        status: 'generating',
        text: '',
        model: event.model,
        simulated: event.simulated,
        context: event.context,
        grounding: event.grounding,
        startedAt: event.ts,
      };
      let found = false;
      const cards = state.cards.map((card) => {
        if (card.question.id !== event.questionId) return card;
        found = true;
        if (card.attempts.some((a) => a.requestId === event.requestId)) return card;
        return { ...card, attempts: [...card.attempts, attempt] };
      });
      return found ? { ...state, cards } : state;
    }
    case 'answer.delta':
      // Late output from a cancelled/superseded/finished request must never change what is shown.
      return updateAttempt(state, event.requestId, (a) => (a.status === 'generating' ? { ...a, text: a.text + event.delta } : a));
    case 'answer.completed':
      return updateAttempt(state, event.requestId, (a) => ({
        ...a,
        status: 'completed',
        firstTokenMs: event.firstTokenMs,
        durationMs: event.durationMs,
      }));
    case 'answer.error':
      return updateAttempt(state, event.requestId, (a) => ({
        ...a,
        status: 'failed',
        errorCode: event.code,
        errorMessage: event.message,
        retryable: event.retryable,
      }));
    case 'answer.cancelled':
      return updateAttempt(state, event.requestId, (a) => ({
        ...a,
        status: 'cancelled',
        errorMessage:
          event.reason === 'superseded'
            ? 'Superseded by a newer question'
            : event.reason === 'user'
              ? 'Cancelled'
              : event.reason === 'speculation_rejected'
                ? 'Discarded: the final transcript differed'
                : 'Session ended',
      }));
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

/** Marks any still-generating answers as cancelled (e.g. when the socket drops). */
export function settleGenerating(state: CopilotState): CopilotState {
  return {
    ...state,
    partial: null,
    cards: state.cards.map((card) => ({
      ...card,
      attempts: card.attempts.map((a) =>
        a.status === 'generating' ? { ...a, status: 'cancelled' as const, errorMessage: 'Connection to server lost' } : a,
      ),
    })),
  };
}

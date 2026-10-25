import { describe, expect, it } from 'vitest';
import { initialCopilotState, reduceServerEvent, settleGenerating, type CopilotState } from './sessionState.js';
import type { ServerEvent } from './events.js';
import { LIMITS } from './config.js';

const apply = (events: ServerEvent[], s: CopilotState = initialCopilotState()) => events.reduce(reduceServerEvent, s);
const question = (id: string): ServerEvent => ({
  type: 'question.detected',
  ts: 1,
  question: { id, text: 'What is a closure?', segmentIds: [], source: 'auto', confidence: 0.9, isFollowUp: false, detectedAt: 1, textAvailableAt: 1, speculative: false },
});
const context = { transcriptSegments: 3, includesBackground: false, includesNotes: false, includesPreviousQa: false, promptChars: 100 };
const grounding = { kind: 'general' as const, evidence: 'not_needed' as const, excerptCount: 0, sections: [] };

describe('reduceServerEvent', () => {
  it('replaces partials and appends finals without duplicates', () => {
    const final: ServerEvent = {
      type: 'transcript.final',
      ts: 2,
      simulated: false,
      segment: { id: 's1', text: 'Hello there.', startMs: 0, endMs: 900, speechFinal: true },
    };
    const s = apply([
      { type: 'transcript.partial', ts: 1, text: 'Hel', startMs: 0, endMs: 300, simulated: false },
      { type: 'transcript.partial', ts: 1, text: 'Hello the', startMs: 0, endMs: 600, simulated: false },
      final,
      final,
    ]);
    expect(s.segments).toHaveLength(1);
    expect(s.partial).toBeNull();
  });

  it('streams answer deltas into the right attempt and completes it', () => {
    const s = apply([
      question('q1'),
      { type: 'answer.start', ts: 2, requestId: 'r1', questionId: 'q1', model: 'm', simulated: false, context, grounding },
      { type: 'answer.delta', ts: 3, requestId: 'r1', delta: 'A closure ' },
      { type: 'answer.delta', ts: 3, requestId: 'r1', delta: 'captures scope.' },
      { type: 'answer.completed', ts: 4, requestId: 'r1', firstTokenMs: 300, durationMs: 900 },
    ]);
    const attempt = s.cards[0]?.attempts[0];
    expect(attempt?.text).toBe('A closure captures scope.');
    expect(attempt?.status).toBe('completed');
    expect(attempt?.firstTokenMs).toBe(300);
  });

  it('records failures and retries as separate attempts', () => {
    const s = apply([
      question('q1'),
      { type: 'answer.start', ts: 2, requestId: 'r1', questionId: 'q1', model: 'm', simulated: false, context, grounding },
      { type: 'answer.error', ts: 3, requestId: 'r1', questionId: 'q1', code: 'rate_limited', message: 'slow down', retryable: true },
      { type: 'answer.start', ts: 4, requestId: 'r2', questionId: 'q1', model: 'm', simulated: false, context, grounding },
    ]);
    expect(s.cards[0]?.attempts.map((a) => a.status)).toEqual(['failed', 'generating']);
    expect(settleGenerating(s).cards[0]?.attempts[1]?.status).toBe('cancelled');
  });

  it('keeps segments in time order and preserves provider speaker labels exactly', () => {
    const seg = (id: string, startMs: number, speaker?: number): ServerEvent => ({
      type: 'transcript.final',
      ts: 1,
      simulated: false,
      segment: { id, text: id, startMs, endMs: startMs + 100, speechFinal: false, ...(speaker !== undefined ? { speaker } : {}) },
    });
    const s = apply([seg('a', 0, 0), seg('c', 2000, 1), seg('b', 1000, 0), seg('d', 3000)]);
    expect(s.segments.map((x) => [x.id, x.speaker])).toEqual([
      ['a', 0],
      ['b', 0],
      ['c', 1],
      ['d', undefined],
    ]);
  });

  it('bounds transcript and card history', () => {
    const events: ServerEvent[] = [];
    for (let i = 0; i < LIMITS.maxTranscriptSegments + 10; i++) {
      events.push({ type: 'transcript.final', ts: i, simulated: false, segment: { id: `s${i}`, text: 'x', startMs: i, endMs: i, speechFinal: false } });
    }
    for (let i = 0; i < LIMITS.maxQuestionCards + 5; i++) events.push(question(`q${i}`));
    const s = apply(events);
    expect(s.segments).toHaveLength(LIMITS.maxTranscriptSegments);
    expect(s.segments[0]?.id).toBe('s10');
    expect(s.cards).toHaveLength(LIMITS.maxQuestionCards);
  });
});

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { initialCopilotState, reduceServerEvent, type CopilotState, type ServerEvent } from '@meeting-copilot/shared';
import { AnswerCard } from './AnswerCard.js';

const context = { transcriptSegments: 2, includesBackground: false, includesNotes: false, includesPreviousQa: false, promptChars: 500 };
const grounding = { kind: 'general' as const, evidence: 'not_needed' as const, excerptCount: 0, sections: [] };
const apply = (events: ServerEvent[], s: CopilotState = initialCopilotState()) => events.reduce(reduceServerEvent, s);
const detected = (speculative: boolean): ServerEvent => ({
  type: 'question.detected',
  ts: 1,
  question: { id: 'q1', text: 'What is a closure?', segmentIds: [], source: 'auto', confidence: 0.9, isFollowUp: false, detectedAt: 1, textAvailableAt: 1, speculative },
});
const render = (s: CopilotState, shownMs?: number) => {
  const card = s.cards[0];
  if (!card) throw new Error('no card');
  return renderToStaticMarkup(<AnswerCard card={card} onRetry={() => undefined} onCancel={() => undefined} canAct shownMs={shownMs} />);
};

describe('AnswerCard progressive rendering', () => {
  it('shows a generating state immediately, then partial text before completion', () => {
    const started = apply([detected(false), { type: 'answer.start', ts: 2, requestId: 'r1', questionId: 'q1', model: 'm', simulated: false, context, grounding }]);
    expect(render(started)).toContain('Generating suggestion');
    expect(render(started)).toContain('Cancel');

    const partial = apply([{ type: 'answer.delta', ts: 3, requestId: 'r1', delta: 'A closure captures' }], started);
    const html = render(partial, 320);
    expect(html).toContain('A closure captures');
    expect(html).toContain('answer generating');
    expect(html).toContain('on screen 320 ms after the question');
    expect(html).not.toContain('Retry');

    const done = apply([{ type: 'answer.completed', ts: 4, requestId: 'r1', firstTokenMs: 250, durationMs: 900 }], partial);
    expect(render(done)).toContain('Retry');
    expect(render(done)).toContain('first token 250 ms after dispatch');
  });

  it('labels tentative answers until confirmed, and removes them when retracted', () => {
    const start: ServerEvent = { type: 'answer.start', ts: 2, requestId: 'r1', questionId: 'q1', model: 'm', simulated: false, context, grounding };
    const tentative = apply([detected(true), start, { type: 'answer.delta', ts: 3, requestId: 'r1', delta: 'Draft' }]);
    expect(render(tentative)).toContain('Tentative');

    const confirmed = apply([{ type: 'question.updated', ts: 4, questionId: 'q1', status: 'confirmed', text: 'What is a closure?' }], tentative);
    expect(render(confirmed)).not.toContain('Tentative');

    const retracted = apply([{ type: 'question.updated', ts: 4, questionId: 'q1', status: 'retracted' }], tentative);
    expect(retracted.cards).toHaveLength(0);
  });

  it('ignores late tokens from a cancelled request', () => {
    const s = apply([
      detected(false),
      { type: 'answer.start', ts: 2, requestId: 'r1', questionId: 'q1', model: 'm', simulated: false, context, grounding },
      { type: 'answer.delta', ts: 3, requestId: 'r1', delta: 'Old ' },
      { type: 'answer.cancelled', ts: 4, requestId: 'r1', questionId: 'q1', reason: 'superseded' },
      { type: 'answer.delta', ts: 5, requestId: 'r1', delta: 'late text' },
    ]);
    expect(s.cards[0]?.attempts[0]?.text).toBe('Old ');
    expect(render(s)).toContain('Superseded by a newer question');
  });
});

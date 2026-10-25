import { describe, expect, it } from 'vitest';
import type { ServerEvent } from '@meeting-copilot/shared';
import { AnswerService, type AnswerJob } from '../src/answers/AnswerService.js';
import { LlmError, type LlmProvider, type LlmRequest } from '../src/llm/types.js';

/** Controllable fake LLM: yields `chunks` with `delayMs` between them, or throws `fail`. */
function fakeLlm(opts: { chunks?: string[]; delayMs?: number; fail?: LlmError; firstDelayMs?: number } = {}): LlmProvider & { calls: number } {
  const provider = {
    name: 'fake',
    model: 'fake-model',
    simulated: false,
    calls: 0,
    isConfigured: () => true,
    status: () => ({ provider: 'fake', model: 'fake-model', configured: true, simulated: false, verified: true, message: '' }),
    async *stream(req: LlmRequest) {
      provider.calls++;
      if (opts.fail) throw opts.fail;
      const wait = (ms: number) =>
        new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, ms);
          req.signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new LlmError('timeout', 'aborted', true));
          });
        });
      if (opts.firstDelayMs) await wait(opts.firstDelayMs);
      for (const c of opts.chunks ?? ['Hello', ' world']) {
        await wait(opts.delayMs ?? 1);
        yield c;
      }
    },
  };
  return provider;
}

const job = (questionId: string, requestId: string, extra: Partial<AnswerJob> = {}): AnswerJob => ({
  requestId,
  questionId,
  messages: [{ role: 'user', content: 'q' }],
  context: { transcriptSegments: 0, includesBackground: false, includesNotes: false, includesPreviousQa: false, promptChars: 1 },
  grounding: { kind: 'general', evidence: 'not_needed', excerptCount: 0, sections: [] },
  ...extra,
});

const types = (events: ServerEvent[]) => events.map((e) => e.type);

describe('AnswerService', () => {
  it('streams deltas and completes with timings', async () => {
    const events: ServerEvent[] = [];
    const svc = new AnswerService(fakeLlm(), (e) => events.push(e), { timeoutMs: 5000, maxTokens: 100 });
    await svc.generate(job('q1', 'r1'));
    expect(types(events)).toEqual(['answer.start', 'answer.delta', 'answer.delta', 'answer.completed']);
    expect(svc.answerFor('q1')).toBe('Hello world');
  });

  it('does not request the same question twice unless forced', async () => {
    const llm = fakeLlm();
    const svc = new AnswerService(llm, () => undefined, { timeoutMs: 5000, maxTokens: 100 });
    expect(await svc.generate(job('q1', 'r1'))).toBe(true);
    expect(await svc.generate(job('q1', 'r2'))).toBe(false);
    expect(await svc.generate(job('q1', 'r3', { force: true }))).toBe(true);
    expect(llm.calls).toBe(2);
  });

  it('supersedes an in-flight answer when a newer question arrives', async () => {
    const events: ServerEvent[] = [];
    const svc = new AnswerService(fakeLlm({ chunks: ['a', 'b', 'c'], delayMs: 50 }), (e) => events.push(e), { timeoutMs: 5000, maxTokens: 100 });
    const first = svc.generate(job('q1', 'r1'));
    await new Promise((r) => setTimeout(r, 20));
    await Promise.all([first, svc.generate(job('q2', 'r2'))]);
    const cancelled = events.find((e) => e.type === 'answer.cancelled');
    expect(cancelled).toMatchObject({ requestId: 'r1', reason: 'superseded' });
    expect(events.some((e) => e.type === 'answer.completed' && e.requestId === 'r2')).toBe(true);
  });

  it('reports provider errors with retryability', async () => {
    const events: ServerEvent[] = [];
    const svc = new AnswerService(fakeLlm({ fail: new LlmError('invalid_credentials', 'bad key', false) }), (e) => events.push(e), {
      timeoutMs: 5000,
      maxTokens: 100,
    });
    await svc.generate(job('q1', 'r1'));
    expect(events.at(-1)).toMatchObject({ type: 'answer.error', code: 'invalid_credentials', retryable: false });
  });

  it('times out when no first token arrives', async () => {
    const events: ServerEvent[] = [];
    const svc = new AnswerService(fakeLlm({ firstDelayMs: 500 }), (e) => events.push(e), { timeoutMs: 5000, firstTokenTimeoutMs: 50, maxTokens: 100 });
    await svc.generate(job('q1', 'r1'));
    expect(events.at(-1)).toMatchObject({ type: 'answer.error', code: 'timeout', retryable: true });
  });

  it('supports user cancellation', async () => {
    const events: ServerEvent[] = [];
    const svc = new AnswerService(fakeLlm({ chunks: ['a', 'b'], delayMs: 50 }), (e) => events.push(e), { timeoutMs: 5000, maxTokens: 100 });
    const p = svc.generate(job('q1', 'r1'));
    await new Promise((r) => setTimeout(r, 10));
    svc.cancel('r1');
    await p;
    expect(events.at(-1)).toMatchObject({ type: 'answer.cancelled', reason: 'user' });
  });

  it('streams fixed text without calling the LLM', async () => {
    const llm = fakeLlm();
    const events: ServerEvent[] = [];
    const svc = new AnswerService(llm, (e) => events.push(e), { timeoutMs: 5000, maxTokens: 100 });
    await svc.generate(job('q1', 'r1', { fixedText: 'Not in your resume.' }));
    expect(llm.calls).toBe(0);
    expect(events[0]).toMatchObject({ type: 'answer.start', model: 'resume-check (no LLM call)' });
  });
});

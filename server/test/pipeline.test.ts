/**
 * Session pipeline behaviour that matters for latency and correctness: speculative answers from
 * interim transcripts (confirm / reject), superseding, late-output suppression, asynchronous history
 * persistence (slow and failing), privacy of what is persisted, and a latency regression bound.
 * Everything runs locally with the simulated transcriber and the mock LLM.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerEvent } from '@meeting-copilot/shared';
import { HistoryWriter } from '../src/history/HistoryWriter.js';
import { SqliteHistoryRepository } from '../src/history/SqliteHistoryRepository.js';
import type { HistoryOp, HistoryRepository } from '../src/history/types.js';
import { milestoneValue } from '../src/latency/LatencyTracker.js';
import { MockLlmProvider } from '../src/llm/mock.js';
import type { ScriptLine } from '../src/transcription/simulated.js';
import { SAMPLE_RESUME } from './fixtures.js';
import { allSpeculationResolved, connect, ofType, startApp, type TestApp } from './helpers.js';

const apps: TestApp[] = [];
const dirs: string[] = [];
const writers: HistoryWriter[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const w of writers.splice(0)) await w.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const launch = async (...args: Parameters<typeof startApp>) => {
  const app = await startApp(...args);
  apps.push(app);
  return app;
};

const Q1 = 'What is the difference between TCP and UDP?';
const ENDPOINTED: ScriptLine[] = [{ text: Q1, speechFinal: true, gapMs: 50, finalDelayMs: 300 }];

describe('speculative answers', () => {
  it('streams a tentative answer before the final transcript, then confirms it without a second request', async () => {
    const app = await launch({ script: ENDPOINTED });
    const c = await connect(app.baseUrl);
    c.start();
    await c.waitFor((e) => ofType(e, 'question.updated').length > 0 && ofType(e, 'answer.completed').length > 0);
    const events = c.events();
    const detected = ofType(events, 'question.detected');
    expect(detected).toHaveLength(1);
    expect(detected[0]?.question.speculative).toBe(true);
    expect(ofType(events, 'answer.start')).toHaveLength(1);
    expect(ofType(events, 'question.updated')[0]).toMatchObject({ status: 'confirmed', questionId: detected[0]?.question.id });

    // The first answer text reached the client before the finalized transcript did.
    const firstDelta = c.received.findIndex((r) => r.event.type === 'answer.delta');
    const final = c.received.findIndex((r) => r.event.type === 'transcript.final');
    expect(firstDelta).toBeGreaterThan(-1);
    expect(firstDelta).toBeLessThan(final);
  });

  it('retracts the tentative answer when the final transcript differs and answers the final question', async () => {
    const revised = `${Q1.slice(0, -1)} on mobile networks?`;
    const app = await launch({ script: [{ text: Q1, finalText: revised, speechFinal: true, gapMs: 50, finalDelayMs: 300 }], llm: new MockLlmProvider(20) });
    const c = await connect(app.baseUrl);
    c.start();
    await c.waitFor((e) => ofType(e, 'answer.completed').length > 0);
    const events = c.events();
    const [spec, real] = ofType(events, 'question.detected');
    expect(spec?.question).toMatchObject({ speculative: true, text: Q1 });
    expect(real?.question).toMatchObject({ speculative: false, text: revised });
    expect(ofType(events, 'question.updated')[0]).toMatchObject({ status: 'retracted', questionId: spec?.question.id });

    const specRequest = ofType(events, 'answer.start').find((s) => s.questionId === spec?.question.id)?.requestId;
    expect(ofType(events, 'answer.cancelled').find((x) => x.requestId === specRequest)?.reason).toBe('speculation_rejected');
    // No output for the rejected request after it was retracted.
    const retractedAt = events.findIndex((e) => e.type === 'question.updated');
    expect(events.slice(retractedAt).some((e) => e.type === 'answer.delta' && e.requestId === specRequest)).toBe(false);
    expect(ofType(events, 'answer.completed').map((x) => x.requestId)).not.toContain(specRequest);
  });

  it('does not speculate in manual mode or on fillers', async () => {
    const app = await launch({ script: [{ text: 'Can you hear me okay?', speechFinal: true, gapMs: 20 }, ...ENDPOINTED] });
    const c = await connect(app.baseUrl);
    c.start({ answerMode: 'manual' });
    await c.waitFor((e) => ofType(e, 'question.detected').length > 0);
    await new Promise((r) => setTimeout(r, 200));
    expect(ofType(c.events(), 'question.detected').every((d) => !d.question.speculative)).toBe(true);
    expect(ofType(c.events(), 'answer.start')).toHaveLength(0);
  });
});

describe('superseding and late output', () => {
  it('cancels an older answer when a newer question arrives and never shows its late tokens', async () => {
    const script: ScriptLine[] = [
      { text: Q1, speechFinal: true, gapMs: 20, finalDelayMs: 50 },
      { text: 'How does garbage collection work in Java?', speechFinal: true, gapMs: 300, finalDelayMs: 50 },
    ];
    // Slow mock (150 ms per word, ~5 s per answer) so the first answer is clearly still streaming when the
    // second question's final transcript arrives (~1.9 s later). Speculation is suppressed while a confirmed
    // answer streams, so the newer question supersedes at its final; a faster mock made this a timing race.
    const app = await launch({ script, llm: new MockLlmProvider(150) });
    const c = await connect(app.baseUrl);
    c.start();
    await c.waitFor((e) => ofType(e, 'answer.completed').length > 0, 15_000);
    const events = c.events();
    const firstRequest = ofType(events, 'answer.start')[0]?.requestId;
    const cancelIdx = events.findIndex((e) => e.type === 'answer.cancelled' && e.requestId === firstRequest);
    expect(cancelIdx).toBeGreaterThan(-1);
    expect((events[cancelIdx] as Extract<ServerEvent, { type: 'answer.cancelled' }>).reason).toBe('superseded');
    expect(events.slice(cancelIdx).some((e) => e.type === 'answer.delta' && e.requestId === firstRequest)).toBe(false);
  });
});

describe('latency instrumentation (mock regression bound)', () => {
  it('dispatches tentative answers within a few ms of the complete question text and records display time', async () => {
    const questions = [
      'Why would you use a message queue between services?',
      'How does a hash map handle collisions?',
      'What is the difference between a process and a thread?',
      'How would you design a rate limiter for an API?',
      'Why do databases use write ahead logs?',
      'What happens when you type a URL into a browser?',
    ];
    const script: ScriptLine[] = questions.map((text) => ({ text, speechFinal: true, gapMs: 150 }));
    const app = await launch({ script, speed: 2 });
    const c = await connect(app.baseUrl);
    c.start();
    await c.waitFor((e) => ofType(e, 'answer.completed').length >= 6, 15_000);
    const first = ofType(c.events(), 'answer.start')[0];
    if (first) c.ws.send(JSON.stringify({ type: 'answer.displayed', requestId: first.requestId, displayedAt: Date.now(), ts: Date.now() }));
    await new Promise((r) => setTimeout(r, 50));

    const traces = app.tracker.all((t) => t.kind === 'speculative' && t.outcome === 'completed');
    expect(traces).toHaveLength(6);
    const dispatch = traces.map((t) => milestoneValue(t, 'dispatch') ?? Infinity).sort((a, b) => a - b);
    // Generous bound for CI noise; measured locally at 1-3 ms (see docs/latency).
    expect(dispatch[dispatch.length - 1]).toBeLessThan(100);
    expect(first && app.tracker.get(first.requestId)?.displayedAt).toBeTypeOf('number');
  });
});

describe('history persistence from a session', () => {
  const dbFile = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mc-pipeline-'));
    dirs.push(dir);
    return { dir, file: path.join(dir, 'history.sqlite') };
  };

  it('saves confirmed cards (not retracted tentative ones) under the conversation id', async () => {
    const { file } = dbFile();
    const repo = new SqliteHistoryRepository(file);
    const writer = new HistoryWriter(repo, { debounceMs: 20 });
    writers.push(writer);
    const app = await launch({
      script: [...ENDPOINTED, { text: 'Why would you pick Kafka?', finalText: 'Why would you pick Kafka over RabbitMQ?', speechFinal: true, gapMs: 400 }],
      history: writer,
    });
    const conversationId = randomUUID();
    const c = await connect(app.baseUrl);
    c.start({ conversationId });
    // Wait for the answer to the *final* (revised) Kafka question, not the retracted tentative one.
    await c.waitFor((e) => {
      const finalQ = ofType(e, 'question.detected').find((d) => d.question.text.includes('RabbitMQ'));
      const req = finalQ && ofType(e, 'answer.start').find((a) => a.questionId === finalQ.question.id);
      return Boolean(req && ofType(e, 'answer.completed').some((x) => x.requestId === req.requestId));
    });
    await writer.flush();
    const saved = await repo.getConversation(conversationId);
    expect(saved?.conversation.simulated).toBe(true);
    expect(saved?.cards.map((k) => [k.question, k.status])).toEqual([
      [Q1, 'completed'],
      ['Why would you pick Kafka over RabbitMQ?', 'completed'],
    ]);
    expect(saved?.cards.every((k) => k.answer?.startsWith('[TEST MODE'))).toBe(true);
  });

  it('streams answers on time while a history write is slow, and reports failed writes without affecting answers', async () => {
    let releaseWrites = () => {};
    const gate = new Promise<void>((r) => (releaseWrites = r));
    let calls = 0;
    const slowRepo: HistoryRepository = {
      async applyBatch(_ops: HistoryOp[]) {
        calls++;
        if (calls === 1) await gate; // first write hangs until released
        else throw new Error('disk full');
      },
      listConversations: async () => [],
      getConversation: async () => null,
      renameConversation: async () => false,
      deleteConversation: async () => false,
      deleteAll: async () => [],
      close: () => undefined,
    };
    const writer = new HistoryWriter(slowRepo, { debounceMs: 0, retryDelayMs: 10 });
    const app = await launch({
      script: [...ENDPOINTED, { text: 'How does garbage collection work in Java?', speechFinal: true, gapMs: 600 }],
      history: writer,
    });
    const c = await connect(app.baseUrl);
    c.start({ conversationId: randomUUID() });
    // Both answers complete although the first history write never finished.
    await c.waitFor((e) => ofType(e, 'answer.completed').length >= 2, 10_000);
    expect(calls).toBeGreaterThanOrEqual(1);
    releaseWrites();
    await c.waitFor((e) => ofType(e, 'session.error').some((x) => x.code === 'history_write_failed'), 5_000);
    expect(ofType(c.events(), 'session.error').find((x) => x.code === 'history_write_failed')?.fatal).toBe(false);
  });

  it('never persists resume text or audio', async () => {
    const { dir, file } = dbFile();
    const repo = new SqliteHistoryRepository(file);
    const writer = new HistoryWriter(repo, { debounceMs: 10 });
    writers.push(writer);
    const app = await launch({
      script: [{ text: 'Tell me about a project where you handled a large transaction volume.', speechFinal: true, gapMs: 50 }],
      history: writer,
    });
    const c = await connect(app.baseUrl);
    c.start({ conversationId: randomUUID(), resume: { fileName: 'resume.txt', text: SAMPLE_RESUME } });
    // Binary "audio" with a distinctive pattern (ignored by the simulator, but must never be stored anywhere).
    const marker = Buffer.from('AUDIOMARKER-'.repeat(50));
    c.ws.send(marker.subarray(0, marker.length - (marker.length % 2)));
    // The tentative answer can complete before the final transcript confirms the question; the card is
    // saved on confirmation, so wait for that too before closing the writer.
    await c.waitFor((e) => ofType(e, 'answer.completed').length >= 1 && allSpeculationResolved(e));
    await writer.close();
    const bytes = readdirSync(dir)
      .map((f) => readFileSync(path.join(dir, f)))
      .reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0))
      .toString('latin1');
    expect(bytes).toContain('large transaction volume'); // the question is saved...
    for (const secret of ['AUDIOMARKER', 'Ledger Reconciliation Tool', 'alex.rivera@example.com', 'Northwind Payments', 'resume.txt']) {
      expect(bytes).not.toContain(secret); // ...resume contents, file name and audio are not
    }
  });
});

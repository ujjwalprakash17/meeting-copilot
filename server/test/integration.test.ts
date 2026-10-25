/**
 * End-to-end over a real WebSocket: simulated transcript -> detection -> retrieval -> mock LLM stream.
 * No external services are called.
 */
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { AUDIO_FORMAT, DEFAULT_SESSION_CONFIG, parseServerEvent, type ServerEvent, type SessionConfig } from '@meeting-copilot/shared';
import { createApp } from '../src/app.js';
import type { ServerConfig } from '../src/config.js';
import { MockLlmProvider } from '../src/llm/mock.js';
import { configureLogger } from '../src/logger.js';
import { DeepgramProvider } from '../src/transcription/deepgram.js';
import { SimulatedSttProvider } from '../src/transcription/simulated.js';
import { makePdf, SAMPLE_RESUME } from './fixtures.js';

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

const config: ServerConfig = {
  host: '127.0.0.1',
  port: 0,
  allowedExtensionIds: [],
  allowNoOrigin: false,
  logLevel: 'error',
  logTranscripts: false,
  stt: { provider: 'deepgram', deepgramApiKey: null, deepgramModel: 'nova-3', endpointingMs: 300, utteranceEndMs: 1000 },
  llm: { provider: 'mock', groqApiKey: null, groqModel: 'x', groqDetectionModel: null, timeoutMs: 5000, maxAnswerTokens: 200 },
  detection: { debounceMs: 100, dedupeWindowMs: 120_000 },
  simulationSpeed: 10,
};

let baseUrl = '';
let close: () => Promise<void>;

beforeAll(async () => {
  configureLogger('error', false);
  const { server, wss } = createApp({
    config,
    liveStt: new DeepgramProvider({ apiKey: null, model: 'nova-3', endpointingMs: 300, utteranceEndMs: 1000 }),
    simulatedStt: new SimulatedSttProvider(config.simulationSpeed),
    llm: new MockLlmProvider(1),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () =>
    new Promise((r) => {
      for (const c of wss.clients) c.terminate();
      server.close(() => r());
    });
});
afterAll(async () => close());

function connect(origin = ORIGIN): Promise<{ ws: WebSocket; events: ServerEvent[]; waitFor: (pred: (e: ServerEvent[]) => boolean, ms?: number) => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${baseUrl}/ws`, { origin });
    const events: ServerEvent[] = [];
    ws.on('message', (data) => {
      const parsed = parseServerEvent(data.toString());
      if (!parsed.ok) throw new Error(`Server sent an invalid event: ${parsed.error}`);
      events.push(parsed.value);
    });
    const waitFor = (pred: (e: ServerEvent[]) => boolean, ms = 8000) =>
      new Promise<void>((res, rej) => {
        const started = Date.now();
        const tick = () => (pred(events) ? res() : Date.now() - started > ms ? rej(new Error(`timeout; got ${events.map((e) => e.type).join(',')}`)) : setTimeout(tick, 10));
        tick();
      });
    ws.on('open', () => resolve({ ws, events, waitFor }));
    ws.on('error', reject);
  });
}

const start = (ws: WebSocket, mode: 'live' | 'simulation', config: Partial<SessionConfig> = {}) =>
  ws.send(
    JSON.stringify({ type: 'audio.start', sessionId: 'sess-1', mode, audio: AUDIO_FORMAT, config: { ...DEFAULT_SESSION_CONFIG, ...config }, ts: Date.now() }),
  );

describe('WebSocket session (simulation + mock LLM)', () => {
  it('runs the full transcript -> question -> streamed answer pipeline', async () => {
    const { ws, events, waitFor } = await connect();
    start(ws, 'simulation', { resume: { fileName: 'resume.txt', text: SAMPLE_RESUME } });
    await waitFor((e) => e.some((x) => x.type === 'transcript.final' && x.segment.text.startsWith("Alright")), 15_000);
    await waitFor((e) => e.filter((x) => x.type === 'answer.completed').length >= 5, 5000);

    expect(events[0]).toMatchObject({ type: 'session.ready', stt: { simulated: true }, llm: { simulated: true } });
    expect(events.some((e) => e.type === 'transcript.partial' && e.simulated)).toBe(true);

    const questions = events.flatMap((e) => (e.type === 'question.detected' ? [e.question.text] : []));
    expect(questions).toEqual([
      'Can you explain the difference between a process and a thread?',
      'Walk me through how you would design a rate limiter for a public API.',
      'And how would it behave across multiple servers?',
      'Tell me about a project where you handled a large transaction volume.',
      'What did you study at university?',
    ]);

    // The duplicated final in the script appears once in the transcript.
    const finals = events.filter((e) => e.type === 'transcript.final' && e.segment.text.startsWith('Tell me about a project'));
    expect(finals).toHaveLength(1);

    const starts = events.filter((e): e is Extract<ServerEvent, { type: 'answer.start' }> => e.type === 'answer.start');
    expect(starts.map((s) => s.grounding.kind)).toEqual(['general', 'general', 'general', 'personal', 'personal']);
    expect(starts[3]?.grounding.evidence).toBe('strong');
    expect(starts[3]?.grounding.sections).toContain('Experience');
    // The follow-up includes the previous Q&A as context.
    expect(starts[2]?.context.includesPreviousQa).toBe(true);
    // Education is absent from the resume: deterministic message, no LLM call.
    expect(starts[4]?.grounding.evidence).toBe('none');
    expect(starts[4]?.model).toContain('no LLM call');
    const educationText = events
      .filter((e) => e.type === 'answer.delta' && e.requestId === starts[4]?.requestId)
      .map((e) => (e.type === 'answer.delta' ? e.delta : ''))
      .join('');
    expect(educationText).toContain("couldn't find enough information");

    ws.send(JSON.stringify({ type: 'audio.stop', sessionId: 'sess-1', ts: Date.now() }));
    await waitFor((e) => e.some((x) => x.type === 'session.ended'));
    ws.close();
  });

  it('supports manual answers, retry and cancel in manual mode', async () => {
    const { ws, events, waitFor } = await connect();
    start(ws, 'simulation', { answerMode: 'manual' });
    await waitFor((e) => e.some((x) => x.type === 'question.detected'), 10_000);
    await new Promise((r) => setTimeout(r, 100));
    expect(events.some((e) => e.type === 'answer.start')).toBe(false);

    ws.send(JSON.stringify({ type: 'answer.request', requestId: 'manual-1', questionText: 'What is idempotency?', ts: Date.now() }));
    await waitFor((e) => e.some((x) => x.type === 'answer.completed' && x.requestId === 'manual-1'));
    const q = events.find((e) => e.type === 'question.detected' && e.question.source === 'manual');
    expect(q).toBeDefined();
    if (q?.type !== 'question.detected') throw new Error('unreachable');
    ws.send(JSON.stringify({ type: 'answer.retry', questionId: q.question.id, requestId: 'retry-1', ts: Date.now() }));
    await waitFor((e) => e.some((x) => x.type === 'answer.start' && x.requestId === 'retry-1'));
    ws.send(JSON.stringify({ type: 'answer.cancel', requestId: 'retry-1', ts: Date.now() }));
    await waitFor((e) => e.some((x) => (x.type === 'answer.cancelled' || x.type === 'answer.completed') && x.requestId === 'retry-1'));
    ws.close();
  });

  it('reports missing speech credentials for live mode', async () => {
    const { ws, events, waitFor } = await connect();
    start(ws, 'live');
    await waitFor((e) => e.length > 0);
    expect(events[0]).toMatchObject({ type: 'session.error', code: 'stt_not_configured', fatal: true });
    ws.close();
  });

  it('validates messages and audio frames', async () => {
    const { ws, events, waitFor } = await connect();
    ws.send('{"type":"audio.start"}');
    ws.send('not json');
    await waitFor((e) => e.filter((x) => x.type === 'session.error').length >= 2);
    expect(events.every((e) => e.type === 'session.error' && e.code === 'bad_message')).toBe(true);
    ws.close();
  });

  it('rejects web page origins and oversized frames', async () => {
    await expect(connect('https://meet.google.com')).rejects.toThrow(/403|Unexpected server response/);
    const { ws } = await connect();
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    ws.send(Buffer.alloc(300 * 1024));
    expect(await closed).toBe(1009);
  });
});

describe('HTTP API', () => {
  it('extracts an uploaded resume for the extension origin only', async () => {
    const pdf = makePdf(['EXPERIENCE', 'Senior Engineer at Northwind Payments 2021 - Present', 'Payment service handling 2M transactions per day']);
    const ok = await fetch(`http://${baseUrl}/api/resume/extract`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'X-File-Name': encodeURIComponent('my resume.pdf') },
      body: pdf,
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const body = (await ok.json()) as { fileName: string; kind: string; sections: string[] };
    expect(body).toMatchObject({ fileName: 'my resume.pdf', kind: 'pdf' });
    expect(body.sections).toContain('Experience');

    const forbidden = await fetch(`http://${baseUrl}/api/resume/extract`, { method: 'POST', headers: { Origin: 'https://evil.example' }, body: pdf });
    expect(forbidden.status).toBe(403);

    const tooBig = await fetch(`http://${baseUrl}/api/resume/extract`, { method: 'POST', headers: { Origin: ORIGIN }, body: Buffer.alloc(6 * 1024 * 1024) });
    expect(tooBig.status).toBe(413);
  });

  it('generates insights and reports provider status without secrets', async () => {
    const res = await fetch(`http://${baseUrl}/api/insights`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'summary', transcript: 'We agreed to ship on Friday.' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { simulated: boolean }).simulated).toBe(true);

    const status = await (await fetch(`http://${baseUrl}/api/status`, { headers: { Origin: ORIGIN } })).json();
    expect(status).toMatchObject({ stt: { configured: false }, llm: { provider: 'mock' } });
    expect(JSON.stringify(status)).not.toMatch(/key/i);
  });
});

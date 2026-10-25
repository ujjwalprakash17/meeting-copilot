/**
 * Speaker attribution and transcript reliability: provider labels -> session labels, reconnects,
 * continuation after an extension reconnect, turn boundaries in question detection, and a replay of
 * real recorded Deepgram responses (bench/sample-dialogue.json, synthetic two-voice audio).
 */
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import type { TranscriptSegment } from '@meeting-copilot/shared';
import { QuestionDetector, type QuestionCandidate } from '../src/detection/QuestionDetector.js';
import { DeepgramProvider } from '../src/transcription/deepgram.js';
import { SpeakerRegistry } from '../src/transcription/SpeakerRegistry.js';
import type { SttCallbacks, SttFinal, SttProvider, SttStream } from '../src/transcription/types.js';
import { connect, ofType, startApp, type TestApp } from './helpers.js';
import { ReplaySttProvider, type RecordedMessage } from './replay.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

describe('SpeakerRegistry', () => {
  it('numbers speakers by first appearance, never merges connections, and supports an offset', () => {
    const r = new SpeakerRegistry();
    const restarts: number[] = [];
    const onNew = () => restarts.push(1);
    expect(r.resolve(3, 1, onNew)).toBe(0); // provider label 3 seen first -> Speaker 1
    expect(r.resolve(0, 1, onNew)).toBe(1);
    expect(r.resolve(3, 1, onNew)).toBe(0); // stable within the connection
    expect(r.resolve(undefined, 1, onNew)).toBeUndefined(); // no label is never turned into one
    expect(r.resolve(0, 2, onNew)).toBe(2); // same provider number on a new connection = new label
    expect(r.resolve(0, 2, onNew)).toBe(2);
    expect(restarts).toHaveLength(1);
    expect(new SpeakerRegistry(4).resolve(0)).toBe(4);
  });
});

describe('question detection at speaker turns', () => {
  const seg = (id: string, text: string, speaker?: number, speechFinal = false): TranscriptSegment => ({
    id,
    text,
    startMs: Number(id.slice(1)) * 1000,
    endMs: Number(id.slice(1)) * 1000 + 900,
    speechFinal,
    ...(speaker !== undefined ? { speaker } : {}),
  });
  const detector = () => {
    const found: QuestionCandidate[] = [];
    const d = new QuestionDetector({ debounceMs: 60_000, dedupeWindowMs: 60_000 }, (c) => found.push(c));
    return { d, found };
  };

  it('does not merge one speaker’s statement into another speaker’s question', () => {
    const { d, found } = detector();
    d.addFinal(seg('s1', 'We moved everything to Kafka last year.', 0));
    d.addFinal(seg('s2', 'Walk me through how you would partition the topics', 1));
    d.utteranceEnd();
    expect(found).toHaveLength(1);
    expect(found[0]?.text).toBe('Walk me through how you would partition the topics');
    expect(found[0]?.context).toBeUndefined();
    expect(found[0]?.segmentIds).toEqual(['s2']);
  });

  it('keeps a question together when a label flips mid-sentence (diarizer flicker)', () => {
    const { d, found } = detector();
    d.addFinal(seg('s1', 'Can you explain the difference between', 0));
    d.addFinal(seg('s2', 'a process and a thread?', 1, true));
    expect(found[0]?.text).toBe('Can you explain the difference between a process and a thread?');
  });

  it('behaves as before when there are no speaker labels', () => {
    const { d, found } = detector();
    d.addFinal(seg('s1', 'We moved everything to Kafka last year.'));
    d.addFinal(seg('s2', 'Walk me through how you would partition the topics'));
    d.utteranceEnd();
    expect(found[0]?.context).toBe('We moved everything to Kafka last year.');
  });
});

describe('Deepgram reconnect (fake streaming endpoint)', () => {
  it('keeps timestamps increasing and tags results from each connection separately', async () => {
    const wss = new WebSocketServer({ port: 0 });
    cleanup.push(() => new Promise<void>((r) => wss.close(() => r())));
    let connections = 0;
    wss.on('connection', (ws) => {
      connections++;
      const n = connections;
      const result = (text: string) =>
        JSON.stringify({
          type: 'Results',
          start: 0.2,
          duration: 0.8,
          is_final: true,
          speech_final: true,
          channel: { alternatives: [{ transcript: text, words: [{ word: 'x', punctuated_word: text, start: 0.2, end: 1.0, speaker: 0 }] }] },
        });
      if (n === 1) {
        ws.send(result('From the first connection.'));
        setTimeout(() => ws.close(1011, 'server restart'), 400); // unexpected close after audio was sent
      } else {
        ws.send(result('From the second connection.'));
      }
    });
    await new Promise((r) => wss.once('listening', r));
    const port = (wss.address() as AddressInfo).port;

    const provider = new DeepgramProvider({ apiKey: 'test', model: 'nova-3', endpointingMs: 300, utteranceEndMs: 1000, url: `ws://127.0.0.1:${port}/v1/listen` });
    const finals: SttFinal[] = [];
    const statuses: string[] = [];
    const stream = provider.start(
      { language: 'en', keywords: [], diarize: true },
      {
        onPartial: () => undefined,
        onFinal: (f) => finals.push(f),
        onUtteranceEnd: () => undefined,
        onStatus: (s) => statuses.push(s),
        onError: () => undefined,
      },
    );
    cleanup.push(() => stream.close());
    // 2 s of audio on the first connection, then keep streaming while it reconnects.
    for (let i = 0; i < 50; i++) stream.sendAudio(Buffer.alloc(1280));
    await new Promise((r) => setTimeout(r, 1_500));
    expect(statuses).toContain('transcriber_reconnecting');
    expect(finals.map((f) => [f.text, f.speaker, f.speakerScope])).toEqual([
      ['From the first connection.', 0, 1],
      ['From the second connection.', 0, 2],
    ]);
    // The second connection's timestamps are offset by the audio already sent (2 s), so time never goes backwards.
    expect(finals[1]?.startMs).toBeGreaterThanOrEqual(2_000);
    expect(finals[1]?.startMs ?? 0).toBeGreaterThan(finals[0]?.endMs ?? 0);
  });
});

/** Emits the given finals (with scopes) after the session starts. */
class ScriptedFinals implements SttProvider {
  readonly name = 'scripted';
  readonly simulated = false;
  constructor(private readonly finals: SttFinal[]) {}
  isConfigured() {
    return true;
  }
  start(_o: unknown, cb: SttCallbacks): SttStream {
    const t = setTimeout(() => {
      for (const f of this.finals) cb.onFinal(f);
      cb.onUtteranceEnd();
    }, 20);
    return { sendAudio: () => undefined, finish: async () => clearTimeout(t), close: () => clearTimeout(t) };
  }
}

async function liveSession(provider: SttProvider, extra: Record<string, unknown> = {}) {
  const app: TestApp = await startApp({ script: [], liveStt: provider });
  cleanup.push(() => app.close());
  const c = await connect(app.baseUrl);
  c.ws.send(
    JSON.stringify({
      type: 'audio.start',
      sessionId: 's',
      mode: 'live',
      audio: { encoding: 'linear16', sampleRate: 16000, channels: 1 },
      config: { answerMode: 'manual', answerStyle: 'concise', answerLength: 'short', background: '', notes: '', keywords: [], language: 'en', diarize: true, contextSegments: 8, resume: null },
      ts: Date.now(),
      ...extra,
    }),
  );
  return c;
}

describe('session speaker labels', () => {
  const f = (text: string, startMs: number, speaker: number | undefined, speakerScope: number): SttFinal => ({
    text,
    startMs,
    endMs: startMs + 500,
    speechFinal: false,
    ...(speaker !== undefined ? { speaker } : {}),
    speakerScope,
  });

  it('maps provider labels to stable session labels and starts new labels after a transcriber reconnect', async () => {
    const c = await liveSession(
      new ScriptedFinals([f('Alpha one.', 0, 1, 1), f('Bravo one.', 1000, 0, 1), f('Alpha two.', 2000, 1, 1), f('After reconnect.', 3000, 1, 2), f('No label.', 4000, undefined, 2)]),
    );
    await c.waitFor((e) => ofType(e, 'transcript.final').length === 5);
    expect(ofType(c.events(), 'transcript.final').map((e) => [e.segment.text, e.segment.speaker])).toEqual([
      ['Alpha one.', 0],
      ['Bravo one.', 1],
      ['Alpha two.', 0],
      ['After reconnect.', 2],
      ['No label.', undefined],
    ]);
    const notices = ofType(c.events(), 'session.status').filter((s) => s.message.includes('speaker labels'));
    expect(notices).toHaveLength(1);
  });

  it('continues the timeline and speaker numbering after an extension reconnect', async () => {
    const c = await liveSession(new ScriptedFinals([f('Hello again.', 500, 0, 1)]), { continuation: { timelineOffsetMs: 60_000, speakerOffset: 2 } });
    await c.waitFor((e) => ofType(e, 'transcript.final').length === 1);
    const seg = ofType(c.events(), 'transcript.final')[0]?.segment;
    expect(seg?.startMs).toBe(60_500);
    expect(seg?.speaker).toBe(2);
    expect(ofType(c.events(), 'session.status').some((s) => s.message.includes('speaker labels'))).toBe(true);
  });

  it('rejects invalid continuation values', async () => {
    const c = await liveSession(new ScriptedFinals([]), { continuation: { timelineOffsetMs: -5, speakerOffset: 1 } });
    await c.waitFor((e) => ofType(e, 'session.error').length > 0);
    expect(ofType(c.events(), 'session.error')[0]?.code).toBe('bad_message');
  });
});

describe('replay of real Deepgram responses (two synthetic voices)', () => {
  const fixture = JSON.parse(readFileSync(path.join(here, 'fixtures', 'deepgram-two-speakers.json'), 'utf8')) as { messages: RecordedMessage[] };

  it('produces ordered segments whose labels match the provider metadata, and answers each question once', async () => {
    const app = await startApp({ script: [], liveStt: new ReplaySttProvider(fixture.messages, 8) });
    cleanup.push(() => app.close());
    const c = await connect(app.baseUrl);
    c.start({ diarize: true }, 'live');
    await c.waitFor((e) => ofType(e, 'session.status').some((s) => s.state === 'transcriber_connected'));
    const lastAt = Math.max(...fixture.messages.map((m) => m.at));
    await new Promise((r) => setTimeout(r, lastAt / 8 + 1_500));
    const events = c.events();

    // Expected labels straight from the provider: each final's words, numbered by first appearance.
    const raw = fixture.messages
      .map((m) => m.raw as { type?: string; is_final?: boolean; channel?: { alternatives?: Array<{ transcript?: string; words?: Array<{ speaker?: number }> }> } })
      .filter((m) => m.type === 'Results' && m.is_final && m.channel?.alternatives?.[0]?.transcript);
    const order: number[] = [];
    const expected = raw.map((m) => {
      const sp = m.channel?.alternatives?.[0]?.words?.[0]?.speaker as number;
      if (!order.includes(sp)) order.push(sp);
      return [m.channel?.alternatives?.[0]?.transcript, order.indexOf(sp)];
    });
    const finals = ofType(events, 'transcript.final').map((e) => e.segment);
    expect(finals.map((s) => [s.text, s.speaker])).toEqual(expected);
    for (let i = 1; i < finals.length; i++) expect(finals[i]?.startMs ?? 0).toBeGreaterThanOrEqual(finals[i - 1]?.startMs ?? 0);

    // Each real question detected once, the audio check ignored, one answer per question.
    const retracted = new Set(ofType(events, 'question.updated').filter((u) => u.status === 'retracted').map((u) => u.questionId));
    const questions = ofType(events, 'question.detected').filter((d) => !retracted.has(d.question.id));
    expect(questions.map((q) => q.question.text)).toEqual([
      'What is the difference between a process and a thread?',
      'And how would you design a rate limiter for a public API?',
      'Should I go into more detail about the trade offs?',
      'Tell me about a project where you handled a large transaction volume.',
    ]);
    for (const q of questions) expect(ofType(events, 'answer.start').filter((a) => a.questionId === q.question.id)).toHaveLength(1);
  }, 30_000);
});

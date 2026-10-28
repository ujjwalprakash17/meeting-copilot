/**
 * Context memory through the real session pipeline (WebSocket, detector, answer service; mock LLM that records
 * each prompt; scripted transcriber per connection): continuity, reconnect vs new session, the switch-off and
 * failure paths, resume follow-ups, design extensions, duplicates.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { AUDIO_FORMAT, DEFAULT_SESSION_CONFIG, parseServerEvent, type ServerEvent, type SessionConfig } from '@meeting-copilot/shared';
import { ConversationMemory } from '../src/context/ConversationMemory.js';
import { MockLlmProvider } from '../src/llm/mock.js';
import type { LlmRequest } from '../src/llm/types.js';
import type { SttCallbacks, SttFinal, SttProvider, SttStream } from '../src/transcription/types.js';
import { SAMPLE_RESUME } from './fixtures.js';
import { ORIGIN, ofType, startApp } from './helpers.js';

/** Mock answers; records the user prompt of every answer request. */
class RecordingLlm extends MockLlmProvider {
  readonly prompts: string[] = [];
  constructor(private readonly classify: (utterance: string) => unknown = () => ({ is_question: false })) {
    super(0);
  }
  override async *stream(request: LlmRequest): AsyncIterable<string> {
    this.prompts.push(request.messages.at(-1)?.content ?? '');
    yield* super.stream(request);
  }
  async classifyJson(request: LlmRequest): Promise<unknown> {
    return this.classify((JSON.parse(request.messages[1]?.content ?? '{}') as { utterance: string }).utterance);
  }
}

/** One script per session start, in order: each line is a finalized utterance (speech_final) at a fixed gap. */
class QueueStt implements SttProvider {
  readonly name = 'scripted';
  readonly simulated = false;
  constructor(private readonly scripts: string[][], private readonly gapMs = 700) {}
  isConfigured() {
    return true;
  }
  start(_o: unknown, cb: SttCallbacks): SttStream {
    const lines = this.scripts.shift() ?? [];
    const timers = lines.map((text, i) =>
      setTimeout(() => {
        const final: SttFinal = { text, startMs: i * 2000, endMs: i * 2000 + 1500, speechFinal: true };
        cb.onFinal(final);
      }, 50 + i * this.gapMs),
    );
    return { sendAudio: () => undefined, finish: async () => timers.forEach(clearTimeout), close: () => timers.forEach(clearTimeout) };
  }
}

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
});

async function app(scripts: string[][], llm: RecordingLlm, opts: { memoryOff?: boolean } = {}) {
  const a = await startApp({ script: [], llm, liveStt: new QueueStt(scripts), ...(opts.memoryOff ? { config: { contextMemory: false } } : {}) });
  cleanup.push(() => a.close());
  return a;
}

async function session(baseUrl: string, sessionId: string, opts: { continuation?: boolean; config?: Partial<SessionConfig> } = {}) {
  const ws = new WebSocket(`ws://${baseUrl}/ws`, { origin: ORIGIN });
  const events: ServerEvent[] = [];
  ws.on('message', (d, isBinary) => {
    if (isBinary) return;
    const parsed = parseServerEvent(d.toString());
    if (parsed.ok) events.push(parsed.value);
  });
  await new Promise((r) => ws.once('open', r));
  ws.send(
    JSON.stringify({
      type: 'audio.start',
      sessionId,
      mode: 'live',
      audio: AUDIO_FORMAT,
      config: { ...DEFAULT_SESSION_CONFIG, ...opts.config },
      ...(opts.continuation ? { continuation: { timelineOffsetMs: 60_000, speakerOffset: 0 } } : {}),
      ts: Date.now(),
    }),
  );
  const waitFor = (pred: (e: ServerEvent[]) => boolean, ms = 8_000) =>
    new Promise<void>((res, rej) => {
      const t0 = Date.now();
      const tick = () => (pred(events) ? res() : Date.now() - t0 > ms ? rej(new Error(`timeout: ${events.map((e) => e.type).join(',')}`)) : setTimeout(tick, 10));
      tick();
    });
  const completed = (n: number) => waitFor((e) => ofType(e, 'answer.completed').length >= n);
  const stop = () => ws.send(JSON.stringify({ type: 'audio.stop', sessionId, ts: Date.now() }));
  cleanup.push(() => ws.close());
  return { ws, events, waitFor, completed, stop };
}

const settle = () => new Promise((r) => setTimeout(r, 300));
const hasContext = (prompt: string | undefined) => (prompt ?? '').includes('<conversation_context>');

describe('context in answer prompts', () => {
  const DESIGN = ['Design a URL shortener.', 'We need to support 10 million requests per day.', 'How would you scale it?', 'What if the cache fails?'];

  it('carries the design and its requirements into follow-up answers, and adds nothing to the first', async () => {
    const llm = new RecordingLlm();
    const a = await app([DESIGN], llm);
    const s = await session(a.baseUrl, 'sess-design');
    await s.completed(3);
    expect(ofType(s.events, 'question.detected').map((q) => q.question.text)).toEqual(['Design a URL shortener.', 'How would you scale it?', 'What if the cache fails?']);
    expect(hasContext(llm.prompts[0])).toBe(false);
    for (const prompt of llm.prompts.slice(1)) {
      expect(prompt).toContain('Current topic: URL shortener (system design)');
      expect(prompt).toContain('We need to support 10 million requests per day.');
      expect(prompt.indexOf('<conversation_context>')).toBeGreaterThan(prompt.indexOf('</transcript>'));
      expect(prompt.indexOf('<conversation_context>')).toBeLessThan(prompt.indexOf('<question>'));
    }
  });

  it('sends exactly the old prompts when CONTEXT_MEMORY is off, and the same first prompt when on', async () => {
    const off = new RecordingLlm();
    const on = new RecordingLlm();
    const aOff = await app([DESIGN], off, { memoryOff: true });
    const aOn = await app([DESIGN], on);
    const sOff = await session(aOff.baseUrl, 'sess-off');
    const sOn = await session(aOn.baseUrl, 'sess-on');
    await Promise.all([sOff.completed(3), sOn.completed(3)]);
    expect(off.prompts.some(hasContext)).toBe(false);
    expect(on.prompts[0]).toBe(off.prompts[0]);
    // With context removed, the follow-up prompts are identical too: the feature only adds the block.
    const strip = (p: string) => p.replace(/<conversation_context>[\s\S]*?<\/conversation_context>\n\n/, '');
    expect(on.prompts.map(strip)).toEqual(off.prompts);
  });
});

describe('session boundaries', () => {
  it('keeps the context across an extension reconnect and starts clean for a new session or after Stop', async () => {
    const llm = new RecordingLlm();
    const a = await app(
      [
        ['Design a URL shortener.', 'We need to support 10 million requests per day.'],
        ['What would you use for caching?'],
        ['What would you use for caching?'],
        ['How would you scale it?'],
      ],
      llm,
    );
    const first = await session(a.baseUrl, 'sess-r');
    await first.completed(1);
    await first.waitFor((e) => ofType(e, 'transcript.final').length === 2);
    await settle();
    first.ws.close(); // dropped connection, no Stop
    await settle();

    const reconnected = await session(a.baseUrl, 'sess-r', { continuation: true });
    await reconnected.completed(1);
    expect(llm.prompts[1]).toContain('Current topic: URL shortener');
    expect(llm.prompts[1]).toContain('10 million requests per day');

    const other = await session(a.baseUrl, 'sess-other');
    await other.completed(1);
    expect(hasContext(llm.prompts[2])).toBe(false); // no contamination from another meeting

    reconnected.stop();
    await reconnected.waitFor((e) => ofType(e, 'session.ended').length > 0);
    const afterStop = await session(a.baseUrl, 'sess-r', { continuation: true });
    await afterStop.completed(1);
    expect(hasContext(llm.prompts[3])).toBe(false); // Stop ends the meeting's memory
  });

  it('does not duplicate facts or answers when the transcriber replays finals', async () => {
    const llm = new RecordingLlm();
    const a = await app(
      [['Design a URL shortener.', 'We need to support 10 million requests per day.', 'We need to support 10 million requests per day.', 'How would you scale it?', 'How would you scale it?', 'What about caching?']],
      llm,
    );
    const s = await session(a.baseUrl, 'sess-dup');
    await s.completed(3);
    await settle();
    expect(ofType(s.events, 'question.detected').map((q) => q.question.text)).toEqual(['Design a URL shortener.', 'How would you scale it?', 'What about caching?']);
    const block = /<conversation_context>([\s\S]*?)<\/conversation_context>/.exec(llm.prompts.at(-1) ?? '')?.[1] ?? '';
    expect(block.match(/10 million requests per day/g)).toHaveLength(1);
    expect(block.match(/Q: Design a URL shortener\./g)).toHaveLength(1);
  });
});

describe('design extensions and resume context', () => {
  it('answers "Now add authentication." while a design is discussed, but not otherwise', async () => {
    const llm = new RecordingLlm();
    const a = await app([['Design a URL shortener.', 'Now add authentication.'], ['Now add authentication.']], llm);
    const design = await session(a.baseUrl, 'sess-ext');
    await design.completed(2);
    expect(ofType(design.events, 'question.detected').map((q) => q.question.text)).toEqual(['Design a URL shortener.', 'Now add authentication.']);
    expect(llm.prompts[1]).toContain('Current topic: URL shortener');
    expect(llm.prompts[1]).toContain('Feature: Now add authentication.');

    const plain = await session(a.baseUrl, 'sess-plain');
    await plain.waitFor((e) => ofType(e, 'transcript.final').length === 1);
    await settle();
    expect(ofType(plain.events, 'question.detected')).toHaveLength(0);
  });

  it('answers a design task set as a statement, and not one announced for later', async () => {
    const llm = new RecordingLlm();
    const a = await app([["Okay so today let's design a ride-sharing service like Uber.", 'Only support a single city for now.', 'How would you store the driver locations?'], ["Later we'll design a cache together."]], llm);
    const s = await session(a.baseUrl, 'sess-task');
    await s.completed(2);
    expect(ofType(s.events, 'question.detected').map((q) => q.question.text)).toEqual([
      "Okay so today let's design a ride-sharing service like Uber.",
      'How would you store the driver locations?',
    ]);
    expect(llm.prompts[1]).toContain('Current topic: ride-sharing');
    expect(llm.prompts[1]).toContain('single city for now');

    const later = await session(a.baseUrl, 'sess-later');
    await later.waitFor((e) => ofType(e, 'transcript.final').length === 1);
    await settle();
    expect(ofType(later.events, 'question.detected')).toHaveLength(0);
  });

  it('grounds a vague follow-up about a project in the resume, and not a design question after it', async () => {
    const llm = new RecordingLlm();
    const a = await app(
      [['Tell me about a project where you handled a large transaction volume.', 'What exactly was your contribution?', 'Design a chat application.']],
      llm,
      {},
    );
    const s = await session(a.baseUrl, 'sess-resume', { config: { resume: { fileName: 'resume.txt', text: SAMPLE_RESUME } } });
    await s.completed(3);
    const starts = ofType(s.events, 'answer.start');
    expect(starts.map((x) => x.grounding.kind)).toEqual(['personal', 'personal', 'general']);
    expect(starts[1]?.grounding.evidence).not.toBe('none'); // the follow-up found the project in the resume
    expect(starts[1]?.grounding.sections).toContain('Experience');
    const designPrompt = llm.prompts.find((p) => p.includes('Design a chat application.')) ?? '';
    expect(designPrompt).not.toContain('<resume_excerpts>');
    expect(designPrompt).not.toContain('<conversation_context>');
  });

  it('answers a general follow-up in a background topic as before when there is no resume to ground it', async () => {
    const llm = new RecordingLlm();
    const a = await app([['Tell me about a project where you handled a large transaction volume.', 'How big was the team?']], llm);
    const s = await session(a.baseUrl, 'sess-no-resume');
    await s.completed(2);
    const starts = ofType(s.events, 'answer.start');
    expect(starts[1]?.grounding.kind).toBe('general'); // not upgraded to personal, so no "add your resume" reply
    expect(llm.prompts.at(-1)).toContain('<conversation_context>');
  });
});

describe('failures fall back to the existing answer path', () => {
  it('answers normally when the context memory throws', async () => {
    vi.spyOn(ConversationMemory.prototype, 'contextFor').mockImplementation(() => {
      throw new Error('boom');
    });
    vi.spyOn(ConversationMemory.prototype, 'commit').mockImplementation(() => {
      throw new Error('boom');
    });
    vi.spyOn(ConversationMemory.prototype, 'observeStatements').mockImplementation(() => {
      throw new Error('boom');
    });
    const llm = new RecordingLlm();
    const a = await app([['Design a URL shortener.', 'We need to support 10 million requests per day.', 'How would you scale it?']], llm);
    const s = await session(a.baseUrl, 'sess-fail');
    await s.completed(2);
    expect(llm.prompts).toHaveLength(2);
    expect(llm.prompts.some(hasContext)).toBe(false);
  });

  it('keeps context and answers when the classifier fails or returns malformed output', async () => {
    let calls = 0;
    const llm = new RecordingLlm(() => {
      calls++;
      if (calls === 1) throw new Error('classifier down');
      return 'not json';
    });
    const a = await app([['Design a URL shortener.', 'We need to support 10 million requests per day.', 'Your biggest weakness', 'Your favourite database', 'How would you scale it?']], llm);
    const s = await session(a.baseUrl, 'sess-cls');
    await s.completed(2);
    await settle();
    expect(calls).toBe(2);
    expect(ofType(s.events, 'question.detected').map((q) => q.question.text)).toEqual(['Design a URL shortener.', 'How would you scale it?']);
    // The rejected fragments left the design context untouched (they only appear in the raw transcript, as before).
    const block = /<conversation_context>([\s\S]*?)<\/conversation_context>/.exec(llm.prompts[1] ?? '')?.[1] ?? '';
    expect(block).toContain('Current topic: URL shortener');
    expect(block).toContain('10 million requests per day');
    expect(block).not.toContain('weakness');
  });

  it('records quickly consecutive questions in order', async () => {
    const llm = new RecordingLlm();
    const a = await startApp({ script: [], llm, liveStt: new QueueStt([['Design a URL shortener.', 'How would you scale it?', 'What about caching?', 'What about security?']], 20) });
    cleanup.push(() => a.close());
    const s = await session(a.baseUrl, 'sess-fast');
    await s.waitFor((e) => ofType(e, 'question.detected').length === 4);
    await s.waitFor((e) => ofType(e, 'answer.completed').length >= 1);
    await settle();
    expect(ofType(s.events, 'session.error')).toHaveLength(0);
    const last = llm.prompts.at(-1) ?? '';
    expect(last).toContain('Current topic: URL shortener');
  });
});

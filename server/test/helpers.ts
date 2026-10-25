import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { AUDIO_FORMAT, DEFAULT_SESSION_CONFIG, parseServerEvent, type ServerEvent, type SessionConfig } from '@meeting-copilot/shared';
import { createApp } from '../src/app.js';
import type { ServerConfig } from '../src/config.js';
import type { HistoryWriter } from '../src/history/HistoryWriter.js';
import { LatencyTracker } from '../src/latency/LatencyTracker.js';
import type { LlmProvider } from '../src/llm/types.js';
import { MockLlmProvider } from '../src/llm/mock.js';
import { configureLogger } from '../src/logger.js';
import { DeepgramProvider } from '../src/transcription/deepgram.js';
import { SimulatedSttProvider, type ScriptLine } from '../src/transcription/simulated.js';
import type { SttProvider } from '../src/transcription/types.js';

export const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

export function testConfig(over: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    allowedExtensionIds: [],
    allowNoOrigin: false,
    logLevel: 'error',
    logTranscripts: false,
    stt: { provider: 'deepgram', deepgramApiKey: null, deepgramModel: 'nova-3', endpointingMs: 300, utteranceEndMs: 1000 },
    llm: { provider: 'mock', groqApiKey: null, groqModel: 'x', groqDetectionModel: null, timeoutMs: 5000, maxAnswerTokens: 300 },
    detection: { debounceMs: 300, dedupeWindowMs: 120_000 },
    simulationSpeed: 1,
    ...over,
  };
}

export interface TestApp {
  baseUrl: string;
  tracker: LatencyTracker;
  close(): Promise<void>;
}

export async function startApp(opts: {
  script: ScriptLine[];
  speed?: number;
  llm?: LlmProvider;
  history?: HistoryWriter | null;
  config?: Partial<ServerConfig>;
  /** Replaces the live transcriber (e.g. a replay of recorded Deepgram responses). */
  liveStt?: SttProvider;
}): Promise<TestApp> {
  configureLogger('error', false);
  const tracker = new LatencyTracker();
  const { server, wss } = createApp({
    config: testConfig(opts.config),
    liveStt: opts.liveStt ?? new DeepgramProvider({ apiKey: null, model: 'nova-3', endpointingMs: 300, utteranceEndMs: 1000 }),
    simulatedStt: new SimulatedSttProvider(opts.speed ?? 1, opts.script),
    llm: opts.llm ?? new MockLlmProvider(2),
    history: opts.history ?? null,
    tracker,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    baseUrl: `127.0.0.1:${(server.address() as AddressInfo).port}`,
    tracker,
    close: () =>
      new Promise((r) => {
        for (const c of wss.clients) c.terminate();
        server.close(() => r());
      }),
  };
}

export interface Received {
  event: ServerEvent;
  at: number;
}

export async function connect(baseUrl: string) {
  const ws = new WebSocket(`ws://${baseUrl}/ws`, { origin: ORIGIN });
  const received: Received[] = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const parsed = parseServerEvent(data.toString());
    if (!parsed.ok) throw new Error(`Server sent an invalid event: ${parsed.error}`);
    received.push({ event: parsed.value, at: Date.now() });
  });
  await new Promise((r, j) => {
    ws.once('open', r);
    ws.once('error', j);
  });
  const events = () => received.map((r) => r.event);
  const waitFor = (pred: (e: ServerEvent[]) => boolean, ms = 10_000) =>
    new Promise<void>((res, rej) => {
      const started = Date.now();
      const tick = () =>
        pred(events()) ? res() : Date.now() - started > ms ? rej(new Error(`timeout; got ${events().map((e) => e.type).join(',')}`)) : setTimeout(tick, 5);
      tick();
    });
  const start = (config: Partial<SessionConfig> = {}, mode: 'live' | 'simulation' = 'simulation') =>
    ws.send(JSON.stringify({ type: 'audio.start', sessionId: 'test', mode, audio: AUDIO_FORMAT, config: { ...DEFAULT_SESSION_CONFIG, ...config }, ts: Date.now() }));
  return { ws, received, events, waitFor, start };
}

export const ofType = <T extends ServerEvent['type']>(events: ServerEvent[], type: T) =>
  events.filter((e): e is Extract<ServerEvent, { type: T }> => e.type === type);

/** True when every tentative (speculative) question seen so far has been confirmed or retracted. */
export const allSpeculationResolved = (events: ServerEvent[]): boolean => {
  const resolved = new Set(ofType(events, 'question.updated').map((u) => u.questionId));
  return ofType(events, 'question.detected').every((d) => !d.question.speculative || resolved.has(d.question.id));
};

/**
 * Repeatable latency benchmark using the simulated transcriber and the mock LLM (no external services).
 *
 *   npm run bench:latency -w server -- --label after --reps 10 --ttft 0
 *
 * What it measures: this project's own pipeline (detection, dispatch, transport) plus the *modelled*
 * STT timing of the simulator (interim results per word, final 300 ms after the last word,
 * UtteranceEnd 1000 ms after the last word). Provider latency (Deepgram processing, Groq TTFT) is NOT
 * included: the mock LLM's time to first token is whatever --ttft sets. Use bench:groq for real Groq numbers.
 *
 * Reference point for every milestone: question.textAvailableAt = the server time at which the
 * transcript first contained the complete question text (interim or final).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { AUDIO_FORMAT, DEFAULT_SESSION_CONFIG } from '@meeting-copilot/shared';
import { createApp } from '../src/app.js';
import type { ServerConfig } from '../src/config.js';
import { percentile } from '../src/latency/LatencyTracker.js';
import { MockLlmProvider } from '../src/llm/mock.js';
import { configureLogger } from '../src/logger.js';
import { DeepgramProvider } from '../src/transcription/deepgram.js';
import { SimulatedSttProvider, type ScriptLine } from '../src/transcription/simulated.js';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(String(process.argv[i]).replace(/^--/, ''), String(process.argv[i + 1]));
const label = args.get('label') ?? 'run';
const reps = Number(args.get('reps') ?? 10);
const ttftMs = Number(args.get('ttft') ?? 0);
const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../../docs/latency');

const TOPICS = [
  ['TCP', 'UDP'], ['a process', 'a thread'], ['SQL', 'NoSQL databases'], ['REST', 'gRPC'], ['a stack', 'a queue'],
  ['optimistic', 'pessimistic locking'], ['horizontal', 'vertical scaling'], ['unit', 'integration tests'], ['caching', 'memoization'],
  ['a mutex', 'a semaphore'], ['latency', 'throughput'], ['monoliths', 'microservices'], ['HTTP/1.1', 'HTTP/2'], ['arrays', 'linked lists'],
  ['Docker', 'virtual machines'], ['sharding', 'replication'],
] as const;
const IMPERATIVES = [
  'Walk me through how you would design a URL shortener.', 'Explain how a load balancer distributes traffic.', 'Describe how garbage collection works in Java.',
  'Walk me through how you would debug a memory leak.', 'Explain how database indexes speed up queries.', 'Describe the CAP theorem in simple terms.',
  'Walk me through how DNS resolution works.', 'Explain how you would rate limit a public API.', 'Describe how OAuth authorization codes work.',
  'Explain how consistent hashing works.', 'Walk me through how a CDN caches content.', 'Describe how you would design a chat system.',
];

let topic = 0;
const nextTopic = () => TOPICS[topic++ % TOPICS.length] ?? TOPICS[0];
let imperative = 0;
const filler: ScriptLine = { text: 'Okay, that makes sense.', speechFinal: true, gapMs: 600 };

/** Each scenario yields one script per repetition; every question text is unique so dedupe never hides one. */
const SCENARIOS: Record<string, { describe: string; line: (i: number) => ScriptLine[] }> = {
  endpointed: {
    describe: 'interim with full text, final with speech_final 300 ms after the last word',
    line: (i) => {
      const [a, b] = nextTopic();
      return [{ text: `What is the difference between ${a} and ${b} in case ${i + 1}?`, speechFinal: true, gapMs: 1500 }];
    },
  },
  'no-speech-final': {
    describe: 'final without speech_final at +300 ms; only UtteranceEnd at +1000 ms marks the end',
    line: () => [{ text: IMPERATIVES[imperative++ % IMPERATIVES.length] ?? '', speechFinal: false, utteranceEndDelayMs: 1000, gapMs: 1500 }],
  },
  'final-only': {
    describe: 'no interim result with the complete text; the final (speech_final) is the first complete text',
    line: (i) => {
      const [a, b] = nextTopic();
      return [{ text: `How would you compare ${a} with ${b} for project ${i + 1}?`, speechFinal: true, interimFull: false, gapMs: 1500 }];
    },
  },
  split: {
    describe: 'question split across two finals (first without speech_final)',
    line: (i) => {
      const [a, b] = nextTopic();
      return [
        { text: 'Can you explain the difference between', speechFinal: false, gapMs: 1500 },
        { text: `${a} and ${b} for team ${i + 1}?`, speechFinal: true, gapMs: 150 },
      ];
    },
  },
  revised: {
    describe: 'interim shows a complete question, but the final adds words (hypothesis revised)',
    line: (i) => {
      const [a, b] = nextTopic();
      return [
        {
          text: `Why would you choose ${a} over ${b}?`,
          finalText: `Why would you choose ${a} over ${b} for service ${i + 1} at scale?`,
          speechFinal: true,
          gapMs: 1500,
        },
      ];
    },
  },
};

interface QuestionRecord {
  id: string;
  text: string;
  textAvailableAt: number;
  detectedAt: number;
  retracted?: boolean;
  confirmedAt?: number;
  dispatchAt?: number;
  firstTextAt?: number;
  completedAt?: number;
  ttft?: number | null;
  requests: number;
}

async function runScenario(baseUrl: string, name: string, expected: number) {
  const ws = new WebSocket(`ws://${baseUrl}/ws`, { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' });
  const questions = new Map<string, QuestionRecord>();
  const requestToQuestion = new Map<string, string>();
  let ended = false;
  await new Promise((r) => ws.once('open', r));
  ws.on('message', (data) => {
    const now = Date.now();
    const e = JSON.parse(data.toString());
    switch (e.type) {
      case 'question.detected':
        questions.set(e.question.id, {
          id: e.question.id,
          text: e.question.text,
          textAvailableAt: e.question.textAvailableAt,
          detectedAt: e.question.detectedAt,
          requests: 0,
          ...(e.question.speculative ? {} : { confirmedAt: now }),
        });
        break;
      case 'question.updated': {
        const q = questions.get(e.questionId);
        if (!q) break;
        if (e.status === 'retracted') q.retracted = true;
        if (e.status === 'confirmed') {
          q.confirmedAt = now;
          // Confirmation can adjust the reference text (final transcript wording).
          if (typeof e.textAvailableAt === 'number') q.textAvailableAt = e.textAvailableAt;
        }
        break;
      }
      case 'answer.start': {
        requestToQuestion.set(e.requestId, e.questionId);
        const q = questions.get(e.questionId);
        if (q) {
          q.requests++;
          q.dispatchAt ??= e.ts;
        }
        break;
      }
      case 'answer.delta': {
        const q = questions.get(requestToQuestion.get(e.requestId) ?? '');
        if (q && q.firstTextAt === undefined) q.firstTextAt = now;
        break;
      }
      case 'answer.completed': {
        const q = questions.get(requestToQuestion.get(e.requestId) ?? '');
        if (q) {
          q.completedAt = now;
          q.ttft = e.firstTokenMs;
        }
        break;
      }
      case 'session.status':
        if (e.state === 'transcriber_closed') ended = true;
        break;
    }
  });
  ws.send(
    JSON.stringify({ type: 'audio.start', sessionId: `bench-${name}`, mode: 'simulation', audio: AUDIO_FORMAT, config: DEFAULT_SESSION_CONFIG, ts: Date.now() }),
  );
  const started = Date.now();
  while (!ended && Date.now() - started < 300_000) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 1500)); // let the last answer finish
  ws.close();
  const accepted = [...questions.values()].filter((q) => !q.retracted);
  return { expected, accepted, all: [...questions.values()] };
}

const stats = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, p50: percentile(s, 50), p95: percentile(s, 95), max: s.at(-1) ?? null };
};

async function main() {
  configureLogger('error', false);
  const scripts = Object.entries(SCENARIOS).map(([name, sc]) => {
    const lines: ScriptLine[] = [];
    for (let i = 0; i < reps; i++) lines.push(...sc.line(i), filler);
    return { name, describe: sc.describe, lines };
  });
  // Each new connection gets the next scenario's script.
  let connection = 0;
  const simulated = {
    name: 'simulated',
    simulated: true,
    isConfigured: () => true,
    start: (options: Parameters<SimulatedSttProvider['start']>[0], cb: Parameters<SimulatedSttProvider['start']>[1]) =>
      new SimulatedSttProvider(1, scripts[connection++ % scripts.length]?.lines ?? []).start(options, cb),
  };
  const config: ServerConfig = {
    host: '127.0.0.1',
    port: 0,
    allowedExtensionIds: [],
    allowNoOrigin: false,
    logLevel: 'error',
    logTranscripts: false,
    stt: { provider: 'deepgram', deepgramApiKey: null, deepgramModel: 'nova-3', endpointingMs: 300, utteranceEndMs: 1000 },
    llm: { provider: 'mock', groqApiKey: null, groqModel: 'mock', groqDetectionModel: null, timeoutMs: 10_000, maxAnswerTokens: 300 },
    detection: { debounceMs: 1200, dedupeWindowMs: 120_000 },
    simulationSpeed: 1,
  };
  const { server } = createApp({
    config,
    liveStt: new DeepgramProvider({ apiKey: null, model: 'nova-3', endpointingMs: 300, utteranceEndMs: 1000 }),
    simulatedStt: simulated,
    llm: new MockLlmProvider(5, ttftMs),
  } as Parameters<typeof createApp>[0]);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Scenarios run concurrently on separate connections (scripts are assigned in connection order).
  const runs = [];
  for (const s of scripts) {
    runs.push(runScenario(baseUrl, s.name, reps));
    // Stagger so connections start (and receive their script) in order.
    await new Promise((r) => setTimeout(r, 150));
  }
  const results = await Promise.all(runs);
  server.close();

  const report: Record<string, unknown> = {};
  const all: QuestionRecord[] = [];
  results.forEach((r, i) => {
    const name = scripts[i]?.name ?? String(i);
    const accepted = r.accepted;
    all.push(...accepted);
    const rel = (f: (q: QuestionRecord) => number | undefined) =>
      stats(accepted.map((q) => f(q)).filter((v): v is number => typeof v === 'number').map((v) => Math.max(0, v)));
    report[name] = {
      describe: scripts[i]?.describe,
      expectedQuestions: r.expected,
      acceptedQuestions: accepted.length,
      retractedSpeculations: r.all.filter((q) => q.retracted).length,
      llmRequests: r.all.reduce((n, q) => n + q.requests, 0),
      dispatchMs: rel((q) => (q.dispatchAt ?? NaN) - q.textAvailableAt),
      firstTextMs: rel((q) => (q.firstTextAt ?? NaN) - q.textAvailableAt),
      confirmedMs: rel((q) => (q.confirmedAt ?? NaN) - q.textAvailableAt),
      completeMs: rel((q) => (q.completedAt ?? NaN) - q.textAvailableAt),
      mockTtftMs: rel((q) => q.ttft ?? undefined),
    };
  });
  const overall = {
    firstTextMs: stats(all.map((q) => (q.firstTextAt ?? NaN) - q.textAvailableAt).filter(Number.isFinite)),
    dispatchMs: stats(all.map((q) => (q.dispatchAt ?? NaN) - q.textAvailableAt).filter(Number.isFinite)),
  };
  const out = {
    label,
    generatedAt: new Date().toISOString(),
    node: process.version,
    note: 'Mock LLM + simulated STT timing model. Excludes real Deepgram processing and real Groq latency.',
    params: { reps, mockTtftMs: ttftMs, mockTokenDelayMs: 5, modelledEndpointingMs: 300, modelledUtteranceEndMs: 1000, wordMs: 220 },
    scenarios: report,
    overall,
  };
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${label}-mock.json`);
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);

  console.log(`\nLatency benchmark "${label}" (mock LLM ttft=${ttftMs} ms, simulated STT timing model) -> ${path.relative(process.cwd(), file)}\n`);
  console.log('| scenario | accepted/expected | dispatch p50/p95 | first text p50/p95 | confirmed p50/p95 | LLM requests | retracted |');
  console.log('|---|---|---|---|---|---|---|');
  type S = { p50: number | null; p95: number | null };
  type Row = { acceptedQuestions: number; expectedQuestions: number; dispatchMs: S; firstTextMs: S; confirmedMs: S; llmRequests: number; retractedSpeculations: number };
  for (const [name, r] of Object.entries(report as Record<string, Row>)) {
    const f = (s: S) => `${s.p50 ?? '–'} / ${s.p95 ?? '–'} ms`;
    console.log(`| ${name} | ${r.acceptedQuestions}/${r.expectedQuestions} | ${f(r.dispatchMs)} | ${f(r.firstTextMs)} | ${f(r.confirmedMs)} | ${r.llmRequests} | ${r.retractedSpeculations} |`);
  }
  console.log(`\nOverall first text: p50 ${overall.firstTextMs.p50} ms, p95 ${overall.firstTextMs.p95} ms (n=${overall.firstTextMs.n})`);
}

void main();

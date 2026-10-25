/**
 * OPT-IN end-to-end benchmark with REAL providers (needs DEEPGRAM_API_KEY and GROQ_API_KEY).
 * Runs the server pipeline in-process and plays the synthetic two-speaker dialogue into it over a
 * WebSocket exactly like the extension does (audio.start live + 40 ms PCM16 frames in real time).
 * Reports, per detected question: text available -> first answer text received by the client,
 * dispatch and provider time to first token, confirmation of tentative answers, plus the transcript
 * with the speaker labels the UI would show.
 *
 *   npm run bench:e2e -w server -- --label after [--no-diarize]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { AUDIO_CHUNK_SAMPLES, AUDIO_FORMAT, DEFAULT_SESSION_CONFIG, type ServerEvent } from '@meeting-copilot/shared';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { LatencyTracker, summarize } from '../src/latency/LatencyTracker.js';
import { GroqProvider } from '../src/llm/groq.js';
import { configureLogger } from '../src/logger.js';
import { DeepgramProvider } from '../src/transcription/deepgram.js';
import { SimulatedSttProvider } from '../src/transcription/simulated.js';
import { SAMPLE_RESUME } from '../test/fixtures.js';
import { loadDialogue } from './sampleAudio.js';

const args = process.argv.slice(2);
const label = args[args.indexOf('--label') + 1] ?? 'run';
const diarize = !args.includes('--no-diarize');
const here = path.dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
if (!config.stt.deepgramApiKey || !config.llm.groqApiKey) {
  console.error('DEEPGRAM_API_KEY and GROQ_API_KEY are required. This benchmark calls both real APIs and is opt-in.');
  process.exit(1);
}

async function main() {
  configureLogger('error', false);
  const tracker = new LatencyTracker();
  const llm = new GroqProvider({
    apiKey: config.llm.groqApiKey,
    model: config.llm.groqModel,
    detectionModel: config.llm.groqDetectionModel,
    timeoutMs: config.llm.timeoutMs,
    reasoningEffort: config.llm.reasoningEffort ?? null,
  });
  const { server } = createApp({
    config: { ...config, allowNoOrigin: false },
    liveStt: new DeepgramProvider({
      apiKey: config.stt.deepgramApiKey,
      model: config.stt.deepgramModel,
      endpointingMs: config.stt.endpointingMs,
      utteranceEndMs: config.stt.utteranceEndMs,
    }),
    simulatedStt: new SimulatedSttProvider(1),
    llm,
    history: null,
    tracker,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' });
  const received: Array<{ at: number; e: ServerEvent }> = [];
  ws.on('message', (d, isBinary) => {
    if (!isBinary) received.push({ at: Date.now(), e: JSON.parse(d.toString()) as ServerEvent });
  });
  await new Promise((r) => ws.once('open', r));
  ws.send(
    JSON.stringify({
      type: 'audio.start',
      sessionId: `bench-${label}`,
      mode: 'live',
      audio: AUDIO_FORMAT,
      config: { ...DEFAULT_SESSION_CONFIG, diarize, resume: { fileName: 'sample.txt', text: SAMPLE_RESUME } },
      ts: Date.now(),
    }),
  );
  const waitFor = async (pred: () => boolean, ms: number) => {
    const t = Date.now();
    while (!pred() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 20));
  };
  await waitFor(() => received.some((r) => r.e.type === 'session.status' && r.e.state === 'transcriber_connected'), 15_000);

  const { pcm, durationMs } = loadDialogue();
  console.log(`Playing ${Math.round(durationMs / 1000)} s of audio through the live pipeline (Deepgram ${config.stt.deepgramModel}, diarization ${diarize ? 'on' : 'off'}, Groq ${config.llm.groqModel})...`);
  const frameMs = (AUDIO_CHUNK_SAMPLES / 16_000) * 1000;
  const t0 = Date.now();
  for (let i = 0, off = 0; off < pcm.length; i++, off += AUDIO_CHUNK_SAMPLES) {
    const wait = t0 + i * frameMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const frame = pcm.subarray(off, off + AUDIO_CHUNK_SAMPLES);
    ws.send(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
  }
  await new Promise((r) => setTimeout(r, 6_000)); // let the last answers finish
  ws.send(JSON.stringify({ type: 'audio.stop', sessionId: `bench-${label}`, ts: Date.now() }));
  await waitFor(() => received.some((r) => r.e.type === 'session.ended'), 5_000);
  ws.close();
  server.close();

  const events = received.map((r) => r.e);
  const detected = events.filter((e): e is Extract<ServerEvent, { type: 'question.detected' }> => e.type === 'question.detected');
  const updates = events.filter((e): e is Extract<ServerEvent, { type: 'question.updated' }> => e.type === 'question.updated');
  const starts = events.filter((e): e is Extract<ServerEvent, { type: 'answer.start' }> => e.type === 'answer.start');
  const retracted = new Set(updates.filter((u) => u.status === 'retracted').map((u) => u.questionId));
  const questions = detected
    .filter((d) => !retracted.has(d.question.id))
    .map((d) => {
      const req = starts.find((s) => s.questionId === d.question.id);
      const firstDelta = req ? received.find((r) => r.e.type === 'answer.delta' && r.e.requestId === req.requestId) : undefined;
      const done = req ? events.find((e): e is Extract<ServerEvent, { type: 'answer.completed' }> => e.type === 'answer.completed' && e.requestId === req.requestId) : undefined;
      const confirmedAt = d.question.speculative ? received.find((r) => r.e.type === 'question.updated' && r.e.questionId === d.question.id)?.at : undefined;
      return {
        text: d.question.text,
        speculative: d.question.speculative,
        firstTextMs: firstDelta ? firstDelta.at - d.question.textAvailableAt : null,
        dispatchMs: req ? req.ts - d.question.textAvailableAt : null,
        providerTtftMs: done?.firstTokenMs ?? null,
        confirmedMs: confirmedAt ? confirmedAt - d.question.textAvailableAt : null,
        error: events.find((e) => e.type === 'answer.error' && req && e.requestId === req.requestId) ?? null,
      };
    });
  const finals = events.filter((e): e is Extract<ServerEvent, { type: 'transcript.final' }> => e.type === 'transcript.final');
  const num = (xs: Array<number | null>) => xs.filter((x): x is number => typeof x === 'number');
  const out = {
    label,
    generatedAt: new Date().toISOString(),
    providers: { stt: `deepgram ${config.stt.deepgramModel} (real)`, llm: `groq ${config.llm.groqModel} (real)`, diarize },
    questions,
    summary: {
      firstTextMs: summarize(num(questions.map((q) => q.firstTextMs))),
      dispatchMs: summarize(num(questions.map((q) => q.dispatchMs))),
      providerTtftMs: summarize(num(questions.map((q) => q.providerTtftMs))),
      retractedTentative: retracted.size,
      llmRequests: starts.length,
    },
    transcript: finals.map((f) => `${f.segment.speaker === undefined ? '' : `[Speaker ${f.segment.speaker + 1}] `}${f.segment.text}`),
    errors: events.filter((e) => e.type === 'session.error'),
  };
  const docs = path.resolve(here, '../../docs/latency');
  mkdirSync(docs, { recursive: true });
  writeFileSync(path.join(docs, `e2e-real-${label}.json`), `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify({ ...out, transcript: undefined }, null, 2));
  console.log('\nTranscript:');
  for (const l of out.transcript) console.log(`  ${l}`);
  process.exit(0); // the Groq keep-alive pool would otherwise keep the process alive
}

void main();

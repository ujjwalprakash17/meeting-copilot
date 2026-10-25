/**
 * OPT-IN real-provider benchmark for transcription and speaker attribution (needs DEEPGRAM_API_KEY).
 * Streams the synthetic two-speaker dialogue to Deepgram in real time (40 ms frames, like the extension),
 * using the server's own URL builder and response parser, and reports:
 *   - word error rate of the finalized transcript,
 *   - speaker attribution accuracy of the segments the parser produces (and of Deepgram's raw word labels),
 *   - how often one transcript segment mixes two reference speakers,
 *   - lag from the end of each spoken line to the first transcript containing it (interim) and to its final.
 *
 *   npm run bench:stt -w server -- --label after [--no-diarize] [--save-fixture]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { AUDIO_CHUNK_SAMPLES, normalizeText } from '@meeting-copilot/shared';
import { loadConfig } from '../src/config.js';
import { buildDeepgramUrl } from '../src/transcription/deepgram.js';
import { parseDeepgramMessage } from '../src/transcription/deepgramParser.js';
import { summarize } from '../src/latency/LatencyTracker.js';
import { loadDialogue, referenceSpeakerAt, wordErrorRate, type ReferenceLine } from './sampleAudio.js';

const args = process.argv.slice(2);
const label = args[args.indexOf('--label') + 1] ?? 'run';
const diarize = !args.includes('--no-diarize');
const here = path.dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
if (!config.stt.deepgramApiKey) {
  console.error('DEEPGRAM_API_KEY is not set. This benchmark calls the real Deepgram API and is opt-in.');
  process.exit(1);
}

interface Recorded {
  at: number;
  raw: string;
}
interface RawWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  speaker?: number;
}

async function record(pcm: Int16Array): Promise<{ messages: Recorded[]; url: string }> {
  const url = buildDeepgramUrl(
    'wss://api.deepgram.com/v1/listen',
    { apiKey: config.stt.deepgramApiKey, model: config.stt.deepgramModel, endpointingMs: config.stt.endpointingMs, utteranceEndMs: config.stt.utteranceEndMs },
    { language: 'en', keywords: [], diarize },
  );
  const ws = new WebSocket(url, { headers: { Authorization: `Token ${config.stt.deepgramApiKey}` } });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('unexpected-response', (_q, r) => reject(new Error(`Deepgram HTTP ${r.statusCode}`)));
    ws.once('error', reject);
  });
  const messages: Recorded[] = [];
  const t0 = Date.now();
  ws.on('message', (data) => messages.push({ at: Date.now() - t0, raw: data.toString() }));
  // Real-time pacing on an absolute schedule (no drift): frame i leaves at i * 40 ms.
  const frameMs = (AUDIO_CHUNK_SAMPLES / 16_000) * 1000;
  for (let i = 0, off = 0; off < pcm.length; i++, off += AUDIO_CHUNK_SAMPLES) {
    const wait = t0 + i * frameMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const frame = pcm.subarray(off, off + AUDIO_CHUNK_SAMPLES);
    ws.send(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
  }
  ws.send(JSON.stringify({ type: 'CloseStream' }));
  await new Promise((r) => ws.once('close', r));
  return { messages, url: url.replace(/keyterm=[^&]*/g, 'keyterm=…') };
}

function evaluate(messages: Recorded[], reference: ReferenceLine[]) {
  // What the server's parser emits (segments, with or without speaker labels).
  const segments = messages.flatMap((m) => {
    const p = parseDeepgramMessage(m.raw);
    if (p.kind === 'finals') return p.segments.map((s) => ({ ...s, at: m.at }));
    return [];
  });
  // Deepgram's raw word-level output for the finalized results.
  const words: Array<RawWord & { at: number }> = messages.flatMap((m) => {
    const msg = JSON.parse(m.raw) as { type?: string; is_final?: boolean; channel?: { alternatives?: Array<{ words?: RawWord[] }> } };
    return msg.type === 'Results' && msg.is_final ? (msg.channel?.alternatives?.[0]?.words ?? []).map((w) => ({ ...w, at: m.at })) : [];
  });

  const hypothesis = segments.map((s) => s.text).join(' ');
  const wer = wordErrorRate(reference.map((r) => r.text).join(' '), hypothesis);

  // Speaker attribution, scored per word against the reference timeline (overlaps excluded).
  const score = (predict: (w: RawWord) => number | undefined) => {
    const pairs = words
      .map((w) => ({ truth: referenceSpeakerAt(reference, ((w.start + w.end) / 2) * 1000), pred: predict(w) }))
      .filter((p): p is { truth: string; pred: number | undefined } => p.truth !== null);
    const labelled = pairs.filter((p): p is { truth: string; pred: number } => p.pred !== undefined);
    // Map each predicted label to the reference speaker it overlaps most (labels are arbitrary numbers).
    const mapping = new Map<number, string>();
    for (const pred of new Set(labelled.map((p) => p.pred))) {
      const counts = new Map<string, number>();
      for (const p of labelled) if (p.pred === pred) counts.set(p.truth, (counts.get(p.truth) ?? 0) + 1);
      mapping.set(pred, [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '?');
    }
    const correct = labelled.filter((p) => mapping.get(p.pred) === p.truth).length;
    return {
      wordsScored: pairs.length,
      wordsLabelled: labelled.length,
      accuracy: labelled.length ? Number((correct / labelled.length).toFixed(3)) : null,
      distinctLabels: mapping.size,
    };
  };
  const segmentAt = (w: RawWord) => segments.find((s) => w.start * 1000 >= s.startMs - 1 && w.end * 1000 <= s.endMs + 1);
  const parserAttribution = score((w) => segmentAt(w)?.speaker);
  const rawAttribution = score((w) => w.speaker);
  const mixedSegments = segments.filter((s) => {
    const truths = new Set(
      words.filter((w) => w.start * 1000 >= s.startMs - 1 && w.end * 1000 <= s.endMs + 1).map((w) => referenceSpeakerAt(reference, ((w.start + w.end) / 2) * 1000)).filter(Boolean),
    );
    return truths.size > 1;
  }).length;

  // Lag from the end of each spoken line to the first interim / final transcript containing its last words.
  const parsed = messages.map((m) => ({ at: m.at, p: parseDeepgramMessage(m.raw) }));
  const textOf = (p: ReturnType<typeof parseDeepgramMessage>) =>
    p.kind === 'partial' ? p.partial.text : p.kind === 'finals' ? p.segments.map((s) => s.text).join(' ') : '';
  const interimLag: number[] = [];
  const finalLag: number[] = [];
  for (const line of reference) {
    const tail = normalizeText(line.text).split(' ').slice(-2).join(' ');
    const first = parsed.find((x) => x.at >= line.startMs && normalizeText(textOf(x.p)).includes(tail));
    const final = parsed.find((x) => x.at >= line.startMs && x.p.kind === 'finals' && normalizeText(textOf(x.p)).includes(tail));
    if (first) interimLag.push(Math.max(0, first.at - line.endMs));
    if (final) finalLag.push(Math.max(0, final.at - line.endMs));
  }
  return {
    wer: { ...wer, wer: Number(wer.wer.toFixed(3)) },
    segments: segments.length,
    segmentsMixingTwoReferenceSpeakers: mixedSegments,
    parserAttribution,
    deepgramWordAttribution: rawAttribution,
    lagAfterLineEndMs: { firstTranscript: summarize(interimLag), final: summarize(finalLag) },
    transcript: segments.map((s) => `${s.speaker === undefined ? '' : `[S${s.speaker + 1}] `}${s.text}`),
  };
}

async function main() {
  const { pcm, reference, durationMs } = loadDialogue();
  console.log(`Streaming ${Math.round(durationMs / 1000)} s of synthetic two-speaker audio to Deepgram (${config.stt.deepgramModel}, diarization ${diarize ? 'on' : 'off'})...`);
  const { messages, url } = await record(pcm);
  const result = evaluate(messages, reference);
  const out = { label, generatedAt: new Date().toISOString(), provider: 'deepgram (real API)', model: config.stt.deepgramModel, diarize, url, audioSeconds: Math.round(durationMs / 1000), ...result };
  const docs = path.resolve(here, '../../docs/latency');
  mkdirSync(docs, { recursive: true });
  writeFileSync(path.join(docs, `stt-real-${label}.json`), `${JSON.stringify(out, null, 2)}\n`);
  mkdirSync(path.join(here, 'samples'), { recursive: true });
  writeFileSync(path.join(here, 'samples', `deepgram-${label}.json`), JSON.stringify({ reference, messages }, null, 1));
  if (args.includes('--save-fixture')) {
    // Real provider responses (synthetic audio, no secrets) for offline regression tests.
    writeFileSync(path.resolve(here, '../test/fixtures/deepgram-two-speakers.json'), `${JSON.stringify({ note: 'Recorded from the real Deepgram streaming API for bench/sample-dialogue.json (synthetic TTS audio).', reference, messages: messages.map((m) => ({ at: m.at, raw: JSON.parse(m.raw) })) }, null, 1)}\n`);
  }
  console.log(JSON.stringify({ ...out, transcript: undefined }, null, 2));
  console.log('\nTranscript as the server would show it:');
  for (const line of result.transcript) console.log(`  ${line}`);
}

void main();

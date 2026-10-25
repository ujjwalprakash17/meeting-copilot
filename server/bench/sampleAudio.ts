/**
 * Assembles the synthetic dialogue (bench/sample-dialogue.json + samples/line-NN.wav from
 * make-sample-audio.ps1) into one 16 kHz mono PCM16 stream plus a ground-truth timeline
 * (who speaks when, and what). Overlapping lines are mixed (summed with clipping).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeText } from '@meeting-copilot/shared';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SAMPLE_RATE = 16_000;

export interface ReferenceLine {
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
}

/** Minimal RIFF/WAVE reader for 16-bit PCM mono (walks chunks, so extra chunks are tolerated). */
function readWav(file: string): Int16Array {
  const buf = readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${file} is not a WAV file`);
  let offset = 12;
  let rate = 0;
  let bits = 0;
  let channels = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2);
      rate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      if (rate !== SAMPLE_RATE || bits !== 16 || channels !== 1) throw new Error(`${file}: expected 16 kHz 16-bit mono, got ${rate} Hz ${bits}-bit ${channels} ch`);
      const pcm = new Int16Array(size / 2);
      for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(body + i * 2);
      return pcm;
    }
    offset = body + size + (size % 2);
  }
  throw new Error(`${file}: no data chunk`);
}

export function loadDialogue(): { pcm: Int16Array; reference: ReferenceLine[]; durationMs: number } {
  const dialogue = JSON.parse(readFileSync(path.join(here, 'sample-dialogue.json'), 'utf8')) as {
    lines: Array<{ speaker: string; gapMs: number; text: string }>;
  };
  const clips = dialogue.lines.map((line, i) => {
    const file = path.join(here, 'samples', `line-${String(i).padStart(2, '0')}.wav`);
    if (!existsSync(file)) throw new Error(`Missing ${file}. Generate the audio first: powershell -File server/bench/make-sample-audio.ps1`);
    return { ...line, pcm: readWav(file) };
  });
  const ms = (samples: number) => (samples / SAMPLE_RATE) * 1000;
  const toSamples = (millis: number) => Math.round((millis / 1000) * SAMPLE_RATE);
  // Lay out the timeline.
  let cursor = 0; // samples
  const placed = clips.map((c) => {
    const start = Math.max(0, cursor + toSamples(c.gapMs));
    cursor = start + c.pcm.length;
    return { ...c, start };
  });
  const total = Math.max(...placed.map((p) => p.start + p.pcm.length)) + toSamples(2_000); // trailing silence
  const mix = new Int32Array(total);
  for (const p of placed) for (let i = 0; i < p.pcm.length; i++) mix[p.start + i] = (mix[p.start + i] ?? 0) + (p.pcm[i] ?? 0);
  const pcm = Int16Array.from(mix, (v) => Math.max(-32768, Math.min(32767, v)));
  const reference = placed.map((p) => ({ speaker: p.speaker, text: p.text, startMs: ms(p.start), endMs: ms(p.start + p.pcm.length) }));
  return { pcm, reference, durationMs: ms(total) };
}

/** Word error rate (Levenshtein over normalized words). */
export function wordErrorRate(reference: string, hypothesis: string): { wer: number; errors: number; words: number } {
  const r = normalizeText(reference).split(' ').filter(Boolean);
  const h = normalizeText(hypothesis).split(' ').filter(Boolean);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...new Array<number>(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) (d[0] as number[])[j] = j;
  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) {
      const row = d[i] as number[];
      const prev = d[i - 1] as number[];
      row[j] = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + (r[i - 1] === h[j - 1] ? 0 : 1));
    }
  }
  const errors = (d[r.length] as number[])[h.length] ?? 0;
  return { wer: r.length ? errors / r.length : 0, errors, words: r.length };
}

/** Reference speaker at a time, or null inside overlaps/silence. */
export function referenceSpeakerAt(reference: ReferenceLine[], ms: number): string | null {
  const active = reference.filter((l) => ms >= l.startMs && ms <= l.endMs);
  return active.length === 1 ? (active[0]?.speaker ?? null) : null;
}

/**
 * Pure parser for Deepgram live (`/v1/listen`) server messages.
 * Reference: https://developers.deepgram.com/reference/speech-to-text/listen-streaming
 * Diarization: https://developers.deepgram.com/docs/diarization — for live streaming only a per-word
 * `speaker` number is returned (no confidence), and the numbers are only meaningful within one connection.
 */
import type { SttFinal, SttPartial } from './types.js';

export type DeepgramParsed =
  | { kind: 'partial'; partial: SttPartial }
  /** A finalized result, split into one segment per contiguous speaker run (usually exactly one). */
  | { kind: 'finals'; segments: SttFinal[]; speechFinal: boolean }
  | { kind: 'utterance_end' }
  | { kind: 'error'; message: string }
  | { kind: 'ignore' };

interface DeepgramWord {
  word?: string;
  punctuated_word?: string;
  start?: number;
  end?: number;
  speaker?: number;
}

interface DeepgramMessage {
  type?: string;
  description?: string;
  message?: string;
  start?: number;
  duration?: number;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: Array<{ transcript?: string; words?: DeepgramWord[] }> };
}

const isSpeaker = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/**
 * Splits a finalized result into speaker runs using the provider's word-level labels.
 * Previously the whole result got its majority speaker, which mislabels the minority words whenever a
 * result spans a speaker change. Words without a label form their own unlabelled run (never guessed).
 */
export function splitBySpeaker(
  transcript: string,
  words: DeepgramWord[] | undefined,
  resultStartMs: number,
  resultEndMs: number,
  speechFinal: boolean,
  offsetMs: number,
): SttFinal[] {
  const runs: Array<{ speaker: number | undefined; words: DeepgramWord[] }> = [];
  for (const w of words ?? []) {
    const speaker = isSpeaker(w.speaker) ? w.speaker : undefined;
    const last = runs.at(-1);
    if (last && last.speaker === speaker) last.words.push(w);
    else runs.push({ speaker, words: [w] });
  }
  // One run (the common case) or no word timings: keep Deepgram's own transcript text and result bounds.
  if (runs.length <= 1) {
    const speaker = runs[0]?.speaker;
    return [{ text: transcript, startMs: resultStartMs, endMs: resultEndMs, speechFinal, ...(speaker !== undefined ? { speaker } : {}) }];
  }
  return runs.map((run, i) => {
    const first = run.words[0] as DeepgramWord;
    const last = run.words.at(-1) as DeepgramWord;
    return {
      text: run.words.map((w) => w.punctuated_word ?? w.word ?? '').join(' ').trim(),
      // Word timings when present, otherwise the result's bounds.
      startMs: typeof first.start === 'number' ? Math.max(0, first.start * 1000 + offsetMs) : resultStartMs,
      endMs: typeof last.end === 'number' ? Math.max(0, last.end * 1000 + offsetMs) : resultEndMs,
      // Only the last run ends the utterance; earlier runs end at a speaker change.
      speechFinal: speechFinal && i === runs.length - 1,
      ...(run.speaker !== undefined ? { speaker: run.speaker } : {}),
    };
  });
}

/** @param offsetMs added to provider timestamps (used after reconnecting, when Deepgram restarts at 0). */
export function parseDeepgramMessage(raw: string, offsetMs = 0): DeepgramParsed {
  let msg: DeepgramMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { kind: 'ignore' };
  }
  switch (msg.type) {
    case 'Results': {
      const alt = msg.channel?.alternatives?.[0];
      const text = (alt?.transcript ?? '').trim();
      const startMs = Math.max(0, (msg.start ?? 0) * 1000 + offsetMs);
      const endMs = startMs + Math.max(0, (msg.duration ?? 0) * 1000);
      if (msg.is_final) {
        // A final with empty text can still carry speech_final (end of utterance after silence).
        if (!text) return msg.speech_final ? { kind: 'utterance_end' } : { kind: 'ignore' };
        const speechFinal = Boolean(msg.speech_final);
        return { kind: 'finals', segments: splitBySpeaker(text, alt?.words, startMs, endMs, speechFinal, offsetMs), speechFinal };
      }
      return text ? { kind: 'partial', partial: { text, startMs, endMs } } : { kind: 'ignore' };
    }
    case 'UtteranceEnd':
      return { kind: 'utterance_end' };
    case 'Error':
      return { kind: 'error', message: msg.description ?? msg.message ?? 'Deepgram reported an error' };
    default:
      return { kind: 'ignore' };
  }
}

import { describe, expect, it } from 'vitest';
import { parseClientEvent } from './events.js';
import { DEFAULT_SESSION_CONFIG, LIMITS } from './config.js';

const start = {
  type: 'audio.start',
  sessionId: 'abc',
  mode: 'live',
  audio: { encoding: 'linear16', sampleRate: 16000, channels: 1 },
  config: DEFAULT_SESSION_CONFIG,
  ts: 1,
};

describe('parseClientEvent', () => {
  it('accepts a valid audio.start', () => {
    expect(parseClientEvent(JSON.stringify(start)).ok).toBe(true);
  });

  it('rejects malformed JSON, unknown types and wrong audio formats', () => {
    expect(parseClientEvent('{nope').ok).toBe(false);
    expect(parseClientEvent(JSON.stringify({ type: 'transcript.final', ts: 1 })).ok).toBe(false);
    expect(parseClientEvent(JSON.stringify({ ...start, audio: { ...start.audio, sampleRate: 44100 } })).ok).toBe(false);
  });

  it('rejects oversized fields and payloads', () => {
    const big = { ...start, config: { ...DEFAULT_SESSION_CONFIG, notes: 'x'.repeat(LIMITS.maxNotesChars + 1) } };
    expect(parseClientEvent(JSON.stringify(big)).ok).toBe(false);
    expect(parseClientEvent('x'.repeat(LIMITS.maxMessageBytes + 1)).ok).toBe(false);
  });
});

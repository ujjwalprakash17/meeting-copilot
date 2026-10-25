import { describe, expect, it } from 'vitest';
import { QuestionDetector, type QuestionCandidate } from '../src/detection/QuestionDetector.js';
import { confirmsSpeculation, DEFAULT_SPECULATION, shouldSpeculate } from '../src/detection/speculation.js';

const detector = () => new QuestionDetector({ debounceMs: 1000, dedupeWindowMs: 60_000 }, () => undefined);

describe('speculation policy', () => {
  it('speculates on complete, unambiguous interim questions only', () => {
    const d = detector();
    const yes = (t: string) => shouldSpeculate(d.evaluatePartial(t), t, DEFAULT_SPECULATION);
    expect(yes('What is the difference between TCP and UDP?')).toBe(true);
    expect(yes('Walk me through how you would design a URL shortener.')).toBe(true);
    // Incomplete (no terminal punctuation yet), filler, too short, ambiguous, or followed by more speech.
    expect(yes('What is the difference between TCP and')).toBe(false);
    expect(yes('Can you hear me okay?')).toBe(false);
    expect(yes('Why?')).toBe(false);
    expect(yes('How we handled caching was interesting.')).toBe(false);
    expect(yes('What is a closure? So the next topic is')).toBe(false);
  });

  it('combines pending finals with the interim text (split questions)', () => {
    const d = detector();
    d.addFinal({ id: 's1', text: 'Can you explain the difference between', startMs: 0, endMs: 1000, speechFinal: false });
    const c = d.evaluatePartial('a process and a thread?');
    expect(c?.text).toBe('Can you explain the difference between a process and a thread?');
    expect(shouldSpeculate(c, `${d.pendingText()} a process and a thread?`, DEFAULT_SPECULATION)).toBe(true);
    d.dispose();
  });

  it('confirms only when the final wording matches', () => {
    expect(confirmsSpeculation('What is the difference between TCP and UDP?', 'what is the difference between TCP and UDP')).toBe(true);
    expect(confirmsSpeculation('Why would you choose Kafka over RabbitMQ?', 'Why would you choose Kafka over RabbitMQ at scale?')).toBe(false);
    expect(confirmsSpeculation('Is Redis single threaded?', 'Is Redis multi threaded?')).toBe(false);
  });
});

describe('fast-path flush', () => {
  it('evaluates a strong "?" question immediately even without speech_final', () => {
    const found: QuestionCandidate[] = [];
    const d = new QuestionDetector({ debounceMs: 60_000, dedupeWindowMs: 60_000 }, (c) => found.push(c));
    d.addFinal({ id: 's1', text: 'What is the difference between TCP and UDP?', startMs: 0, endMs: 1000, speechFinal: false });
    expect(found).toHaveLength(1);
    // Statements and unfinished questions still wait for the end-of-speech signal.
    d.addFinal({ id: 's2', text: 'Can you explain the difference between', startMs: 2000, endMs: 3000, speechFinal: false });
    expect(found).toHaveLength(1);
    d.dispose();
  });
});

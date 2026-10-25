import { describe, expect, it } from 'vitest';
import type { TranscriptSegment } from '@meeting-copilot/shared';
import { QuestionDetector, type QuestionCandidate } from '../src/detection/QuestionDetector.js';
import { scoreSentence } from '../src/detection/scoring.js';

/** Detector with a manual clock and manual timers so debounce behaviour is deterministic. */
function setup(debounceMs = 1000) {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;
  const candidates: QuestionCandidate[] = [];
  const detector = new QuestionDetector(
    {
      debounceMs,
      dedupeWindowMs: 120_000,
      now: () => now,
      setTimer: (fn, ms) => {
        const id = nextId++;
        timers.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimer: (h) => timers.delete(h as number),
    },
    (c) => candidates.push(c),
  );
  const advance = (ms: number) => {
    now += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= now) {
        timers.delete(id);
        t.fn();
      }
    }
  };
  let seq = 0;
  const final = (text: string, speechFinal = true, startMs = now): TranscriptSegment => ({
    id: `s${++seq}`,
    text,
    startMs,
    endMs: startMs + 500,
    speechFinal,
  });
  return { detector, candidates, advance, final };
}

describe('scoreSentence', () => {
  it.each([
    ['What is the difference between TCP and UDP?', true],
    ['How would you design a URL shortener?', true],
    ['Walk me through your approach to debugging a memory leak.', true],
    ["I'd love to hear how you handle code reviews.", true],
    ['Explain how garbage collection works in Java.', true],
    ['Describe the CAP theorem.', true],
    ['Can you hear me okay?', false],
    ["That's the plan for the sprint, right?", false],
    ['Does that make sense?', false],
    ['We migrated the service last year.', false],
    ['Okay.', false],
  ])('%s -> question=%s', (sentence, expected) => {
    expect(scoreSentence(sentence).score >= 2).toBe(expected);
  });

  it('marks follow-ups', () => {
    expect(scoreSentence('And how would it behave across multiple servers?').isFollowUp).toBe(true);
    expect(scoreSentence('Why?').isFollowUp).toBe(true);
    expect(scoreSentence('What is a monad?').isFollowUp).toBe(false);
  });
});

describe('QuestionDetector', () => {
  it('detects a direct question on end of utterance', () => {
    const { detector, candidates, final } = setup();
    detector.addFinal(final('What is a closure in JavaScript?'));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.text).toBe('What is a closure in JavaScript?');
    expect(candidates[0]?.ambiguous).toBe(false);
  });

  it('joins a question split across multiple final segments', () => {
    const { detector, candidates, final, advance } = setup();
    detector.addFinal(final('Can you explain the difference between', false));
    advance(400);
    expect(candidates).toHaveLength(0);
    detector.addFinal(final('a process and a thread?', true));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.text).toBe('Can you explain the difference between a process and a thread?');
    expect(candidates[0]?.segmentIds).toEqual(['s1', 's2']);
  });

  it('without an end-of-speech signal, evaluates a complete request after a short settle and anything else after the debounce', () => {
    const { detector, candidates, final, advance } = setup(1000);
    detector.addFinal(final('So tell me how you would scale', false));
    advance(600);
    expect(candidates).toHaveLength(0); // incomplete: still waiting
    detector.addFinal(final('a websocket service to a million users.', false));
    advance(350);
    expect(candidates).toHaveLength(0);
    advance(100); // 400 ms settle: the joined text is a complete, punctuated request
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.text).toBe('So tell me how you would scale a websocket service to a million users.');

    // Unpunctuated: the speaker may go on, so the full debounce applies.
    detector.addFinal(final('describe how you would shard the database', false));
    advance(900);
    expect(candidates).toHaveLength(1);
    advance(200);
    expect(candidates).toHaveLength(2);
  });

  it('postpones evaluation while partial results show the speaker is still talking', () => {
    const { detector, candidates, final, advance } = setup(1000);
    detector.addFinal(final('How do you approach', false));
    advance(800);
    detector.noteActivity();
    advance(800);
    expect(candidates).toHaveLength(0);
    advance(300);
    expect(candidates).toHaveLength(1);
  });

  it('ignores duplicate finals re-emitted by the provider', () => {
    const { detector, candidates, final } = setup();
    const seg = final('Tell me about a project where you handled a large transaction volume.', true, 5_000);
    expect(detector.addFinal(seg)).toBe(true);
    expect(detector.addFinal({ ...seg, id: 'other-id' })).toBe(false);
    expect(candidates).toHaveLength(1);
  });

  it('suppresses a repeated question within the dedupe window', () => {
    const { detector, candidates, final, advance } = setup();
    detector.addFinal(final('How does React reconciliation work?'));
    advance(30_000);
    detector.addFinal(final('How does React reconciliation work?'));
    detector.addFinal(final('So, how does reconciliation in React work?'));
    expect(candidates).toHaveLength(1);
  });

  it('ignores fillers and statements', () => {
    const { detector, candidates, final } = setup();
    detector.addFinal(final('Hi everyone, can you hear me?'));
    detector.addFinal(final('We shipped the new billing flow last week.'));
    detector.addFinal(final("Let's get started, okay?"));
    expect(candidates).toHaveLength(0);
  });

  it('keeps preceding statements as context and detects indirect questions', () => {
    const { detector, candidates, final } = setup();
    detector.addFinal(final("Our checkout service has latency spikes at peak. I'm curious how you would investigate that."));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.text).toBe("I'm curious how you would investigate that.");
    expect(candidates[0]?.context).toBe('Our checkout service has latency spikes at peak.');
  });

  it('flags ambiguous candidates instead of treating them as questions', () => {
    const { detector, candidates, final } = setup();
    detector.addFinal(final('How we handled caching was interesting'));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.ambiguous).toBe(true);
  });

  it('exposes the latest utterance for manual answering', () => {
    const { detector, final } = setup();
    detector.addFinal(final('Something about sharding strategies', false));
    expect(detector.latestUtterance()?.text).toBe('Something about sharding strategies');
  });
});

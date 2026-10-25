/**
 * Question/request detection beyond "?" and question words: instructions, polite requests, fragments,
 * scenarios and follow-ups, without answering statements. Table-driven over test/fixtures/questionCorpus.ts,
 * plus transcript-boundary behaviour (interim -> final, speaker changes, duplicates, split segments) and the
 * session pipeline (one answer per request, classifier only for ambiguous utterances, with context).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { TranscriptSegment } from '@meeting-copilot/shared';
import { classifierMessages, CLASSIFIER_PROMPT, parseClassifierVerdict } from '../src/detection/classifier.js';
import { classifyQuestionIntent } from '../src/detection/intent.js';
import { QuestionDetector, type QuestionCandidate } from '../src/detection/QuestionDetector.js';
import { DEFAULT_SPECULATION, shouldSpeculate } from '../src/detection/speculation.js';
import { MockLlmProvider } from '../src/llm/mock.js';
import type { LlmRequest } from '../src/llm/types.js';
import { captureLogs } from '../src/logger.js';
import type { ScriptLine } from '../src/transcription/simulated.js';
import { CORPUS, type Expectation } from './fixtures/questionCorpus.js';
import { connect, ofType, startApp } from './helpers.js';
import INDEPENDENT_JSON from './fixtures/independentUtterances.json' with { type: 'json' };
import MATRIX_JSON from './fixtures/meetingMatrix.json' with { type: 'json' };

const INDEPENDENT = INDEPENDENT_JSON as Array<{ text: string; label: 'yes' | 'no' | 'either'; category: string; source: string }>;
const MATRIX = MATRIX_JSON as Array<{ text: string; label: 'request' | 'statement' | 'other_addressee' | 'logistics'; note?: string }>;

const outcome = (c: QuestionCandidate | null): Expectation => (!c ? 'ignore' : c.ambiguous ? 'classifier' : 'answer');
const evaluate = (text: string) => new QuestionDetector({ debounceMs: 1000, dedupeWindowMs: 0 }, () => undefined).evaluate(text, []);

describe('detection corpus', () => {
  it.each(CORPUS.map((u) => [`${u.set}/${u.category}: ${u.text}`, u] as const))('%s', (_name, u) => {
    const c = evaluate(u.text);
    expect(outcome(c), `reasons: ${c?.reasons.join(', ') ?? 'none'}`).toBe(u.expect);
    if (u.intent) expect(c?.intentType).toBe(u.intent);
    if (u.requiresContext !== undefined) expect(c?.requiresContext).toBe(u.requiresContext);
  });

  it('has no false positives or false negatives on the labelled set', () => {
    const results = CORPUS.map((u) => ({ u, got: outcome(evaluate(u.text)) }));
    const falsePositives = results.filter((r) => r.u.expect === 'ignore' && r.got === 'answer').map((r) => r.u.text);
    const falseNegatives = results.filter((r) => r.u.expect !== 'ignore' && r.got === 'ignore').map((r) => r.u.text);
    expect({ falsePositives, falseNegatives }).toEqual({ falsePositives: [], falseNegatives: [] });
  });

  it('stays within the known errors on 560 independently written utterances', () => {
    // Written by separate agents that never saw this code (see bench/detection.ts --set). "either" items are not scored.
    const results = INDEPENDENT.map((u) => ({ u, got: outcome(evaluate(u.text)) }));
    const falseNegatives = results.filter((r) => r.u.label === 'yes' && r.got === 'ignore').map((r) => r.u.text);
    const falsePositives = results.filter((r) => r.u.label === 'no' && r.got === 'answer').map((r) => r.u.text);
    expect(falseNegatives).toEqual([]);
    expect(falsePositives).toEqual([
      // Addressed by name to another participant: the detector cannot know whether the user is Rahul.
      'Rahul, do you want to add anything before we move on?',
      // Rhetorical, unpunctuated run-on answered by the speaker in the same breath.
      'so what did we learn from that incident basically that nobody actually owned the alerts',
      // Real questions about scheduling, small talk and audio that the labeller did not want drafted answers for.
      'Could we push the follow-up to Thursday at two instead?',
      "How's the weather over there, still snowing?",
      'Is it just me or is there a really bad echo?',
    ]);
  });
});

describe('meeting test matrix (test/fixtures/meetingMatrix.json)', () => {
  const byLabel = (label: string) => MATRIX.filter((m) => m.label === label).map((m) => [m.text] as const);

  it.each(byLabel('request'))('answers the request: %s', (text) => {
    expect(outcome(evaluate(text))).toBe('answer');
  });

  it.each(byLabel('statement'))('does not answer the statement: %s', (text) => {
    // A bare scenario may still go to the classifier (it decides with context); it is never answered directly.
    expect(outcome(evaluate(text))).not.toBe('answer');
  });

  it.each(byLabel('logistics'))('ignores meeting logistics: %s', (text) => {
    expect(outcome(evaluate(text))).toBe('ignore');
  });

  // Known limitation, documented in the README: without knowing the user's name or the participants, the
  // detector cannot tell that a question is addressed to someone else. Expected to fail until that changes.
  it.fails.each(byLabel('other_addressee'))('ignores a question addressed to another participant: %s', (text) => {
    expect(outcome(evaluate(text))).toBe('ignore');
  });
});

describe('regression: "Give the name of your dog."', () => {
  it('is an instruction to answer, with or without punctuation', () => {
    for (const text of ['Give the name of your dog.', 'give the name of your dog', 'Okay, so give the name of your dog.', 'Please give the name of your dog']) {
      const c = evaluate(text);
      expect(c?.ambiguous, text).toBe(false);
      expect(c?.intentType, text).toBe('imperative_request');
    }
  });

  it('is not confused with statements about the same thing', () => {
    for (const text of ['I gave the name of my dog yesterday.', 'I will give you the name of the dog later.', "My dog's name is Bruno."]) {
      expect(evaluate(text), text).toBeNull();
    }
  });

  it('is complete enough to answer from the interim transcript, once', () => {
    const d = new QuestionDetector({ debounceMs: 1000, dedupeWindowMs: 60_000 }, () => undefined);
    expect(shouldSpeculate(d.evaluatePartial('Give the name of your'), 'Give the name of your', DEFAULT_SPECULATION)).toBe(false);
    expect(shouldSpeculate(d.evaluatePartial('Give the name of your dog.'), 'Give the name of your dog.', DEFAULT_SPECULATION)).toBe(true);
    d.dispose();
  });
});

describe('scenarios and follow-ups keep their context', () => {
  it('keeps the scenario in the question text', () => {
    const c = evaluate('Our system stores orders. Suppose the database goes down. What would you do?');
    expect(c?.text).toBe('Suppose the database goes down. What would you do?');
    expect(c?.context).toBe('Our system stores orders.');
    expect(c?.intentType).toBe('hypothetical');
  });

  it('marks follow-ups so the previous answer is included in the prompt', () => {
    for (const text of ['Can you elaborate?', 'Give me another example.', 'Explain that decision in more detail.', 'And your role in that project?']) {
      expect(evaluate(text)?.isFollowUp, text).toBe(true);
    }
    expect(evaluate('Tell me about yourself.')?.isFollowUp).toBe(false);
  });

  it('routes personal imperatives to resume grounding', () => {
    expect(classifyQuestionIntent('Name three technologies you use regularly.')).toMatchObject({ kind: 'personal' });
    expect(classifyQuestionIntent('Summarize your previous work experience.').kind).toBe('personal');
    expect(classifyQuestionIntent('Compare SQL and NoSQL.').kind).toBe('general');
  });
});

/** Detector with a manual clock and timers, as in questionDetector.test.ts. */
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
  const seg = (text: string, o: { speechFinal?: boolean; startMs?: number; endMs?: number; speaker?: number } = {}): TranscriptSegment => {
    const startMs = o.startMs ?? now;
    return { id: `s${++seq}`, text, startMs, endMs: o.endMs ?? startMs + 1000, speechFinal: o.speechFinal ?? true, ...(o.speaker !== undefined ? { speaker: o.speaker } : {}) };
  };
  return { detector, candidates, advance, seg };
}

describe('transcript boundaries', () => {
  it('joins a request split across final segments', () => {
    const { detector, candidates, seg } = setup();
    detector.addFinal(seg('List the steps you would take', { speechFinal: false }));
    expect(candidates).toHaveLength(0);
    detector.addFinal(seg('to debug this issue.'));
    expect(candidates.map((c) => c.text)).toEqual(['List the steps you would take to debug this issue.']);
  });

  it('joins a scenario and the question that follows it in the next segment', () => {
    const { detector, candidates, seg } = setup();
    detector.addFinal(seg('Suppose the database goes down.', { speechFinal: false }));
    detector.addFinal(seg('What would you do?'));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ text: 'Suppose the database goes down. What would you do?', intentType: 'hypothetical', ambiguous: false });
  });

  it('waits for the question when the recogniser ends the utterance right after a scenario', () => {
    // Seen with real Deepgram output: speech_final and UtteranceEnd right after "Suppose we have a million records."
    const { detector, candidates, seg, advance } = setup();
    detector.addFinal(seg('Suppose we have a million records.', { speechFinal: true }));
    detector.utteranceEnd();
    advance(1_000);
    // Interim results of the question keep it waiting, even past the normal debounce, until their final arrives.
    detector.noteActivity();
    advance(1_400);
    expect(candidates).toHaveLength(0);
    detector.addFinal(seg('How would you handle them?', { speechFinal: true }));
    expect(candidates.map((c) => [c.text, c.intentType, c.ambiguous])).toEqual([['Suppose we have a million records. How would you handle them?', 'hypothetical', false]]);
  });

  it('still evaluates a scenario that stands alone when the grace period ends', () => {
    const { detector, candidates, seg, advance } = setup();
    detector.addFinal(seg('Imagine traffic increases tenfold.', { speechFinal: true }));
    detector.utteranceEnd();
    advance(1_900);
    expect(candidates).toHaveLength(0);
    advance(100);
    expect(candidates.map((c) => [c.intentType, c.ambiguous])).toEqual([['hypothetical', true]]);
  });

  it('does not wait for UtteranceEnd when a final without speech_final already ends a complete request', () => {
    // Real Deepgram run: "Briefly introduce yourself." arrived without speech_final; UtteranceEnd came ~0.9 s later.
    const { detector, candidates, seg, advance } = setup(1200);
    detector.addFinal(seg('Briefly introduce yourself.', { speechFinal: false }));
    advance(399);
    expect(candidates).toHaveLength(0);
    advance(1);
    expect(candidates.map((c) => c.text)).toEqual(['Briefly introduce yourself.']);
  });

  it('keeps waiting when the speaker goes on after a complete request', () => {
    const { detector, candidates, seg, advance } = setup(1200);
    detector.addFinal(seg('Explain how you designed that system.', { speechFinal: false }));
    advance(250);
    detector.noteActivity(); // interim results: more speech
    advance(400);
    expect(candidates).toHaveLength(0);
    detector.addFinal(seg('Especially the caching layer.', { speechFinal: true }));
    expect(candidates.map((c) => c.text)).toEqual(['Explain how you designed that system. Especially the caching layer.']);
  });

  it('does not answer an incomplete fragment flushed by the debounce', () => {
    const { detector, candidates, seg, advance } = setup(1000);
    detector.addFinal(seg('Explain the', { speechFinal: false }));
    advance(1100);
    expect(candidates).toHaveLength(0);
  });

  it('ends the turn after an unpunctuated request when another speaker starts after a pause', () => {
    const { detector, candidates, seg } = setup();
    detector.addFinal(seg('give the name of your dog', { speechFinal: false, startMs: 0, endMs: 1500, speaker: 0 }));
    detector.addFinal(seg('my dog is called Max', { startMs: 2100, endMs: 3000, speaker: 1 }));
    expect(candidates.map((c) => [c.text, c.intentType])).toEqual([['give the name of your dog', 'imperative_request']]);
  });

  it('does not split a request when the speaker label flickers inside continuous speech', () => {
    const { detector, candidates, seg } = setup();
    detector.addFinal(seg('Walk me through your system', { speechFinal: false, startMs: 0, endMs: 1200, speaker: 0 }));
    detector.addFinal(seg('design and its trade-offs.', { startMs: 1240, endMs: 2500, speaker: 1 }));
    expect(candidates.map((c) => c.text)).toEqual(['Walk me through your system design and its trade-offs.']);
  });

  it('does not split an unfinished request on a speaker change, even after a pause', () => {
    const { detector, candidates, seg } = setup();
    detector.addFinal(seg('Can you explain the', { speechFinal: false, startMs: 0, endMs: 1000, speaker: 0 }));
    detector.addFinal(seg('difference between a process and a thread?', { startMs: 1600, endMs: 3000, speaker: 1 }));
    expect(candidates.map((c) => c.text)).toEqual(['Can you explain the difference between a process and a thread?']);
  });

  it('answers a request once when the provider re-emits the final, or after a reconnect', () => {
    const { detector, candidates, seg, advance } = setup();
    const first = seg('Describe your most challenging project.', { startMs: 5_000 });
    detector.addFinal(first);
    expect(detector.addFinal({ ...first, id: 'again' })).toBe(false); // re-emitted final
    advance(20_000);
    detector.addFinal(seg('Describe your most challenging project.', { startMs: 40_000 })); // replayed after reconnect
    detector.addFinal(seg('So, describe your most challenging project.', { startMs: 45_000 }));
    expect(candidates).toHaveLength(1);
  });
});

describe('classifier input and output', () => {
  it('describes request forms and statements, and passes capped recent context', () => {
    expect(CLASSIFIER_PROMPT).toMatch(/instructions or requests even without "\?"/);
    expect(CLASSIFIER_PROMPT).toMatch(/offering to explain something themselves/);
    const long = 'x'.repeat(590);
    const [, user] = classifierMessages({ utterance: 'Your biggest weakness', recent: [long, 'Tell me about your last project.', 'I led the billing rewrite.'], lastQuestion: 'Tell me about your last project.' });
    const body = JSON.parse(user?.content ?? '{}') as { recent: string[]; last_question: string; utterance: string };
    expect(body.recent).toEqual(['Tell me about your last project.', 'I led the billing rewrite.']); // oldest line dropped by the cap
    expect(body).toMatchObject({ last_question: 'Tell me about your last project.', utterance: 'Your biggest weakness' });
  });

  it('accepts only well-formed verdicts', () => {
    expect(parseClassifierVerdict({ is_question: true, intent: 'elliptical', needs_context: true })).toEqual({ isQuestion: true, intent: 'elliptical', needsContext: true });
    expect(parseClassifierVerdict({ is_question: true, intent: 'made_up' })).toEqual({ isQuestion: true, intent: null, needsContext: false });
    expect(parseClassifierVerdict({ is_question: 'yes' })).toBeNull();
    expect(parseClassifierVerdict(null)).toBeNull();
  });
});

/** Mock answers plus a scripted classifier; records every answer request and classifier input. */
class RecordingLlm extends MockLlmProvider {
  readonly answered: string[] = [];
  readonly classified: Array<{ utterance: string; recent: string[]; last_question: string }> = [];
  constructor(private readonly verdict: (utterance: string) => unknown) {
    super(1);
  }
  override async *stream(request: LlmRequest): AsyncIterable<string> {
    this.answered.push(request.messages.at(-1)?.content ?? '');
    yield* super.stream(request);
  }
  async classifyJson(request: LlmRequest): Promise<unknown> {
    const body = JSON.parse(request.messages[1]?.content ?? '{}') as RecordingLlm['classified'][number];
    this.classified.push(body);
    return this.verdict(body.utterance);
  }
}

describe('session pipeline', () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0)) await fn();
  });
  async function run(
    script: ScriptLine[],
    llm: RecordingLlm,
    until: (e: ReturnType<Awaited<ReturnType<typeof connect>>['events']>) => boolean,
    onStarted?: () => void,
  ) {
    const app = await startApp({ script, speed: 4, llm });
    cleanup.push(() => app.close());
    onStarted?.(); // startApp configures the logger, so log capture starts here
    const conn = await connect(app.baseUrl);
    conn.start();
    await conn.waitFor(until, 10_000);
    await new Promise((r) => setTimeout(r, 300)); // let any late (duplicate) work surface
    return conn.events();
  }

  it('answers "Give the name of your dog." once: tentative from the interim, confirmed by the final', async () => {
    const llm = new RecordingLlm(() => ({ is_question: false }));
    const events = await run([{ text: 'Give the name of your dog.', speechFinal: true, gapMs: 100 }], llm, (e) => ofType(e, 'answer.completed').length > 0 && ofType(e, 'question.updated').length > 0);
    expect(ofType(events, 'question.detected')).toHaveLength(1);
    expect(ofType(events, 'question.updated').map((u) => u.status)).toEqual(['confirmed']);
    expect(llm.answered).toHaveLength(1);
    expect(llm.classified).toHaveLength(0); // clear requests never cost a classifier call
  });

  it('does not answer or classify statements that mention requests', async () => {
    const llm = new RecordingLlm(() => ({ is_question: true }));
    const events = await run(
      [
        { text: 'I gave the name of my dog yesterday.', speechFinal: true, gapMs: 100 },
        { text: 'Let me explain what happened.', speechFinal: true, gapMs: 200 },
        { text: 'We discussed the architecture in the last meeting.', speechFinal: true, gapMs: 200 },
      ],
      llm,
      (e) => ofType(e, 'transcript.final').length === 3,
    );
    expect(ofType(events, 'question.detected')).toHaveLength(0);
    expect(llm.answered).toHaveLength(0);
    expect(llm.classified).toHaveLength(0);
  });

  it('asks the classifier about an elliptical fragment, with the recent conversation, and answers it as a follow-up', async () => {
    const llm = new RecordingLlm((u) => (u.startsWith('Your biggest') ? { is_question: true, intent: 'elliptical', needs_context: false } : { is_question: false }));
    const events = await run(
      [
        { text: 'Tell me about your last project.', speechFinal: true, gapMs: 100 },
        { text: 'Your biggest weakness', speechFinal: true, gapMs: 2_000 },
      ],
      llm,
      (e) => ofType(e, 'answer.completed').length >= 2,
    );
    expect(ofType(events, 'question.detected').map((q) => q.question.text)).toEqual(['Tell me about your last project.', 'Your biggest weakness']);
    expect(llm.classified).toHaveLength(1);
    expect(llm.classified[0]).toMatchObject({ utterance: 'Your biggest weakness', last_question: 'Tell me about your last project.' });
    expect(llm.classified[0]?.recent).toContain('Tell me about your last project.');
    // Both are about the user; without a resume the pipeline answers with its fixed "add your resume" text.
    expect(ofType(events, 'answer.start')).toHaveLength(2);
  });

  it('logs each detection decision with intent, timing and correlation ids, without transcript text', async () => {
    const llm = new RecordingLlm((u) => ({ is_question: u.startsWith('Your biggest'), intent: 'elliptical', needs_context: false }));
    let logs: ReturnType<typeof captureLogs> | undefined;
    cleanup.push(async () => logs?.restore());
    await run(
      [
        { text: 'Give the name of your dog.', speechFinal: true, gapMs: 100 },
        { text: 'I gave the name of my dog yesterday.', speechFinal: true, gapMs: 1_500 },
        { text: 'Your biggest weakness', speechFinal: true, gapMs: 1_500 },
      ],
      llm,
      () => llm.classified.length === 1,
      () => (logs = captureLogs('debug')),
    );
    await new Promise((r) => setTimeout(r, 300));
    const all = logs?.lines.join('\n') ?? '';
    expect(all).toMatch(/\[DEBUG\] \[session\] speculation_started .*qid=q-\S+ rid=r-\S+ source=interim intent=imperative_request/);
    expect(all).toMatch(/\[DEBUG\] \[session\] speculation_confirmed .*recovery=final_deduplicated/);
    expect(all).toMatch(/\[DEBUG\] \[session\] utterance_evaluated .*source=final decision=rejected segments=1 words=8 detect_ms=[\d.]+/);
    expect(all).toMatch(/\[DEBUG\] \[session\] utterance_evaluated .*decision=ambiguous .*intent=elliptical .*recovery=sent_to_classifier/);
    expect(all).toMatch(/\[DEBUG\] \[session\] classifier_decision .*is_question=true intent=elliptical .*duration_ms=\d+/);
    expect(all).toMatch(/\[DEBUG\] \[session\] question_detected .*source=classifier intent=elliptical .*answer_triggered=true rid=r-/);
    for (const text of ['name of your dog', 'my dog yesterday', 'biggest weakness']) expect(all).not.toContain(text);
  });

  it('drops an ambiguous utterance the classifier rejects', async () => {
    const llm = new RecordingLlm(() => ({ is_question: false, intent: 'none' }));
    const events = await run([{ text: 'Imagine traffic increases tenfold.', speechFinal: true, gapMs: 100 }], llm, () => llm.classified.length === 1);
    expect(ofType(events, 'question.detected')).toHaveLength(0);
    expect(llm.answered).toHaveLength(0);
  });
});

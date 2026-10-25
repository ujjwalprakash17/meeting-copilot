/**
 * Turns finalized transcript segments into question candidates.
 *
 * Strategy:
 *  1. Only finalized segments are considered (never partials), so no LLM work per partial update.
 *  2. Segments accumulate into an "utterance" until the provider signals end of speech
 *     (speech_final / UtteranceEnd) or no new final arrives for `debounceMs`. This joins questions
 *     split across segments ("Can you explain the difference between" + "a process and a thread?").
 *     Partial activity postpones the debounce so we don't evaluate while someone is still talking.
 *     Fast path: a strong question that ends in "?" is evaluated as soon as its final segment arrives,
 *     without waiting for the end-of-speech signal (UtteranceEnd can lag the final by ~700 ms).
 *  2b. `evaluatePartial` scores pending finals + the current interim text without side effects, so the
 *     session can start a tentative (speculative) answer before the final transcript arrives.
 *  3. Each sentence is scored heuristically (see scoring.ts). Ambiguous candidates are flagged so
 *     the session can optionally confirm them with a small LLM classifier.
 *  4. Duplicate segments (re-emitted finals) and repeated questions are suppressed.
 *  5. A different speaker after a complete sentence or a complete (even unpunctuated) request ends the
 *     turn; a speaker label that flickers mid-sentence does not.
 */
import { isTokenSubset, normalizeText, tokenSimilarity, type TranscriptSegment } from '@meeting-copilot/shared';
import { AMBIGUOUS_THRESHOLD, endsIncomplete, isClarification, QUESTION_THRESHOLD, scoreSentence, SELF_ANSWER, splitSentences, type RequestIntent } from './scoring.js';

export interface QuestionCandidate {
  text: string;
  context?: string;
  segmentIds: string[];
  score: number;
  /** 0..1, derived from the heuristic score. */
  confidence: number;
  ambiguous: boolean;
  isFollowUp: boolean;
  /** Form of the request (direct question, instruction, polite request, fragment, scenario, follow-up). */
  intentType: RequestIntent;
  /** Needs earlier conversation to be understood ("that decision", "What about…"). */
  requiresContext: boolean;
  reasons: string[];
}

/** Outcome of evaluating one finished utterance (for diagnostics; contains no transcript text). */
export interface UtteranceEvaluation {
  decision: 'accepted' | 'ambiguous' | 'rejected' | 'duplicate';
  segments: number;
  words: number;
  /** Time spent scoring the utterance, ms. */
  durationMs: number;
  candidate: QuestionCandidate | null;
}

/** Minimum pause before a new speaker's words for an unpunctuated request to count as a finished turn. */
const TURN_GAP_MS = 250;

export interface DetectorOptions {
  debounceMs: number;
  dedupeWindowMs: number;
  maxPendingSegments?: number;
  maxPendingWords?: number;
  /** Minimum score for the "?" fast path (0 disables). */
  fastFlushScore?: number;
  /** How long a bare scenario ("Suppose the database goes down.") waits for its question, ms (default 2000). */
  scenarioGraceMs?: number;
  /**
   * How long a final that already ends with a complete, unambiguous request waits for more speech when the
   * recognizer did not mark the end of speech, ms (default 400). Interim results in the meantime postpone it.
   */
  completeRequestSettleMs?: number;
  /** Called after an utterance has been evaluated (whether or not it contained a question). */
  onUtteranceFlushed?: () => void;
  /** Diagnostics for every evaluated utterance. */
  onEvaluated?: (evaluation: UtteranceEvaluation) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface RecentQuestion {
  text: string;
  at: number;
}

export class QuestionDetector {
  private pending: TranscriptSegment[] = [];
  private timer: unknown = null;
  private recentQuestions: RecentQuestion[] = [];
  private recentSegments: Array<{ norm: string; startMs: number }> = [];
  private lastUtterance: { text: string; segmentIds: string[] } | null = null;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    private readonly opts: DetectorOptions,
    private readonly onCandidate: (candidate: QuestionCandidate) => void,
  ) {
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  /** Returns false when the segment was ignored as a duplicate. */
  addFinal(segment: TranscriptSegment): boolean {
    const norm = normalizeText(segment.text);
    if (!norm) return false;
    const dup = this.recentSegments.some((s) => s.norm === norm && Math.abs(s.startMs - segment.startMs) < 2_000);
    if (dup || this.pending.some((s) => s.id === segment.id)) return false;
    this.recentSegments.push({ norm, startMs: segment.startMs });
    if (this.recentSegments.length > 20) this.recentSegments.shift();

    // A different (diarized) speaker after a completed sentence is a turn boundary: evaluate the previous
    // speaker's words on their own instead of merging two people's speech into one "question".
    // Only when the earlier text ends a sentence, so a mid-sentence label flicker cannot split a question.
    // Without punctuation, a complete request followed by a pause also ends the turn ("give the name of
    // your dog" + another voice), but a label change inside continuous speech does not.
    const last = this.pending.at(-1);
    if (last && last.speaker !== undefined && segment.speaker !== undefined && last.speaker !== segment.speaker) {
      const sentenceEnded = /[.?!]["')\]]*\s*$/.test(last.text);
      if (sentenceEnded || (segment.startMs - last.endMs >= TURN_GAP_MS && this.isCompleteRequest(this.pendingText()))) this.flush();
    }

    this.pending.push(segment);
    const words = this.pending.reduce((n, s) => n + s.text.split(/\s+/).length, 0);
    // Speakers often pause after setting up a scenario ("Suppose we have a million records." … "How would you
    // handle them?"), and the recogniser may end the utterance there (Deepgram sent speech_final and
    // UtteranceEnd together in testing). Give the question a short grace period instead of evaluating the
    // scenario alone; a scenario that stands alone is still evaluated when the grace period ends.
    const awaitingQuestion = segment.speechFinal && this.endsWithBareScenario();
    if (
      (segment.speechFinal && !awaitingQuestion) ||
      this.pending.length >= (this.opts.maxPendingSegments ?? 8) ||
      words >= (this.opts.maxPendingWords ?? 120) ||
      this.isStrongCompleteQuestion(this.pendingText())
    ) {
      this.flush();
    } else if (awaitingQuestion) {
      this.armTimer(this.scenarioGraceMs);
    } else if (/[.?!]["')\]]*\s*$/.test(segment.text) && this.isCompleteRequest(this.pendingText())) {
      // Deepgram often finalizes without speech_final (more so with background noise) and sends UtteranceEnd
      // about a second later. A complete request only needs a short pause to rule out more speech.
      this.armTimer(Math.min(this.opts.debounceMs, this.opts.completeRequestSettleMs ?? 400));
    } else {
      this.armTimer();
    }
    return true;
  }

  private get scenarioGraceMs(): number {
    return Math.max(this.opts.debounceMs, this.opts.scenarioGraceMs ?? 2_000);
  }

  /** Interim (partial) results show the speaker is still talking: postpone evaluation. */
  noteActivity(): void {
    // After a bare scenario, the words being spoken are most likely its question: wait for their final
    // (Deepgram's final can trail the last interim by over a second).
    if (this.pending.length > 0) this.armTimer(this.endsWithBareScenario() ? this.scenarioGraceMs : this.opts.debounceMs);
  }

  utteranceEnd(): void {
    // A bare scenario keeps waiting for its question (see addFinal); anything else is evaluated now.
    if (this.endsWithBareScenario() && this.timer !== null) return;
    this.flush();
  }

  /** Evaluate whatever is pending now. */
  flush(): void {
    this.cancelTimer();
    if (this.pending.length === 0) return;
    const segments = this.pending;
    this.pending = [];
    const text = segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
    this.lastUtterance = { text, segmentIds: segments.map((s) => s.id) };
    const started = performance.now();
    const candidate = this.evaluate(text, segments.map((s) => s.id));
    const durationMs = performance.now() - started;
    const duplicate = candidate !== null && this.isDuplicate(candidate.text);
    this.opts.onEvaluated?.({
      decision: !candidate ? 'rejected' : duplicate ? 'duplicate' : candidate.ambiguous ? 'ambiguous' : 'accepted',
      segments: segments.length,
      words: text.split(/\s+/).length,
      durationMs,
      candidate,
    });
    if (candidate && !duplicate) {
      if (!candidate.ambiguous) this.remember(candidate.text);
      this.onCandidate(candidate);
    }
    this.opts.onUtteranceFlushed?.();
  }

  /** The pending utterance ends with a scenario set-up that has no question yet. */
  private endsWithBareScenario(): boolean {
    const last = splitSentences(this.pendingText()).at(-1);
    if (!last) return false;
    const s = scoreSentence(last);
    return s.isScenario && s.score < QUESTION_THRESHOLD;
  }

  /** True when the text is, on its own, a complete question or request (punctuated or not). */
  private isCompleteRequest(text: string): boolean {
    if (endsIncomplete(text)) return false;
    const c = this.evaluate(text, []);
    return Boolean(c && !c.ambiguous && text.trim().endsWith(c.text.trim()));
  }

  /** True when the text ends in a clear, complete question ("?" and a high score). */
  private isStrongCompleteQuestion(text: string): boolean {
    const min = this.opts.fastFlushScore ?? 3;
    if (min <= 0 || !/\?\s*$/.test(text)) return false;
    const c = this.evaluate(text, []);
    // The question must be what ends the utterance (not an earlier sentence followed by more speech).
    return Boolean(c && !c.ambiguous && c.score >= min && text.trim().endsWith(c.text.trim()));
  }

  /**
   * Scores the utterance as it stands with the given interim text appended. No side effects:
   * nothing is remembered, flushed or deduplicated. Returns null when no question is present.
   */
  evaluatePartial(partialText: string): QuestionCandidate | null {
    const text = `${this.pendingText()} ${partialText}`.replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return this.evaluate(text, this.pending.map((s) => s.id));
  }

  /** Text of finalized segments in the current (not yet evaluated) utterance. */
  pendingText(): string {
    return this.pending.map((s) => s.text).join(' ');
  }

  /** Most recent utterance (pending first), used for manual "answer now". */
  latestUtterance(): { text: string; segmentIds: string[] } | null {
    if (this.pending.length > 0) {
      return { text: this.pending.map((s) => s.text).join(' '), segmentIds: this.pending.map((s) => s.id) };
    }
    return this.lastUtterance;
  }

  isDuplicate(text: string): boolean {
    const cutoff = this.now() - this.opts.dedupeWindowMs;
    this.recentQuestions = this.recentQuestions.filter((q) => q.at >= cutoff);
    return this.recentQuestions.some((q) => tokenSimilarity(q.text, text) >= 0.75 || isTokenSubset(q.text, text, 5));
  }

  /** Record a question as handled (also used for manual/confirmed questions). */
  remember(text: string): void {
    this.recentQuestions.push({ text, at: this.now() });
    if (this.recentQuestions.length > 30) this.recentQuestions.shift();
  }

  evaluate(text: string, segmentIds: string[]): QuestionCandidate | null {
    const sentences = splitSentences(text);
    const scored = sentences.map((s, i) => {
      const result = { s, ...scoreSentence(s) };
      // Rhetorical: the speaker answers it straight away ("So what does that tell us? It tells us…").
      const next = sentences[i + 1];
      if (next && SELF_ANSWER.test(next)) result.score = Math.min(result.score, 0);
      return result;
    });
    let firstIdx = scored.findIndex((x) => x.score >= QUESTION_THRESHOLD);
    let ambiguous = false;
    if (firstIdx === -1) {
      firstIdx = scored.findIndex((x) => x.score >= AMBIGUOUS_THRESHOLD);
      if (firstIdx === -1) return null;
      ambiguous = true;
    }
    const threshold = ambiguous ? AMBIGUOUS_THRESHOLD : QUESTION_THRESHOLD;
    // A scenario just before the question is part of it ("Suppose the database goes down. What would you do?").
    const scenarioIdx = scored.slice(Math.max(0, firstIdx - 3), firstIdx).findIndex((x) => x.isScenario);
    const startIdx = scenarioIdx === -1 ? firstIdx : Math.max(0, firstIdx - 3) + scenarioIdx;
    let questionParts = scored.filter((x, i) => (i >= startIdx && i < firstIdx) || (i >= firstIdx && x.score >= threshold));
    if (!ambiguous) {
      // Short clarifications right after the last request belong to it ("…that system. Especially the caching layer.").
      let next = scored.findLastIndex((x) => x.score >= threshold) + 1;
      while (next < scored.length && isClarification(scored[next]?.s ?? '')) next++;
      const clarifications = scored.slice(scored.findLastIndex((x) => x.score >= threshold) + 1, next);
      questionParts = [...questionParts, ...clarifications];
    }
    const asked = questionParts.filter((x) => x.score >= threshold);
    const best = asked.reduce((a, b) => (b.score > a.score ? b : a));
    const first = questionParts[0] ?? best;
    const context = scored
      .slice(Math.max(0, startIdx - 2), startIdx)
      .map((x) => x.s)
      .join(' ');
    return {
      text: questionParts.map((x) => x.s).join(' '),
      ...(context ? { context } : {}),
      segmentIds,
      score: best.score,
      confidence: Math.max(0.05, Math.min(0.99, best.score / 4)),
      ambiguous,
      isFollowUp: first.isFollowUp,
      // Pronouns in a question that follows a scenario refer to the scenario, not to earlier conversation.
      intentType: first.isScenario ? 'hypothetical' : (first.intent ?? 'direct_question'),
      requiresContext: first.requiresContext,
      reasons: best.reasons,
    };
  }

  dispose(): void {
    this.cancelTimer();
    this.pending = [];
  }

  private armTimer(ms = this.opts.debounceMs): void {
    this.cancelTimer();
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.flush();
    }, ms);
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }
}

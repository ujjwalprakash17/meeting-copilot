/**
 * One copilot session per WebSocket connection:
 *   binary audio -> STT stream -> transcript buffer -> question detector -> retrieval -> answer service
 * Each stage lives in its own module; this class only wires them together.
 *
 * Latency path (see README "Latency"):
 *  - Interim transcripts are scored as they arrive. A clear, complete question starts a *tentative*
 *    answer immediately (marked speculative in the UI); the final transcript confirms it or retracts it.
 *  - Final segments that end in a strong "?" question are evaluated without waiting for UtteranceEnd.
 *  - The LLM connection is pre-warmed at session start and when an utterance starts like a question.
 *  - History persistence only enqueues in memory after events are sent; it never blocks streaming.
 */
import { randomUUID } from 'node:crypto';
import {
  AUDIO_FORMAT,
  elapsedMs,
  LIMITS,
  monotonicNow,
  tokenize,
  type AnswerGrounding,
  type ClientEvent,
  type DetectedQuestion,
  type ServerEvent,
  type SessionConfig,
  type TranscriptSegment,
  type Logger,
} from '@meeting-copilot/shared';
import { AnswerService } from '../answers/AnswerService.js';
import { buildAnswerMessages, insufficientEvidenceMessage, MAX_TOKENS_BY_LENGTH } from '../answers/promptBuilder.js';
import { DEFAULT_LATENCY, type ServerConfig } from '../config.js';
import { classifierMessages, parseClassifierVerdict, type ClassifierVerdict } from '../detection/classifier.js';
import { classifyQuestionIntent } from '../detection/intent.js';
import { QuestionDetector, type QuestionCandidate, type UtteranceEvaluation } from '../detection/QuestionDetector.js';
import { startsLikeQuestion } from '../detection/scoring.js';
import { confirmsSpeculation, DEFAULT_SPECULATION, shouldSpeculate } from '../detection/speculation.js';
import { ConversationRecorder } from '../history/ConversationRecorder.js';
import type { HistoryWriter } from '../history/HistoryWriter.js';
import { latencyTracker, type LatencyTracker, type TraceKind } from '../latency/LatencyTracker.js';
import { TextAvailability } from '../latency/TextAvailability.js';
import type { LlmProvider } from '../llm/types.js';
import { log as rootLog, logTranscript } from '../logger.js';
import { KeywordRetriever } from '../resume/retrieval.js';
import { parseResume } from '../resume/sections.js';
import { TranscriptBuffer } from '../transcript/TranscriptBuffer.js';
import { SpeakerRegistry } from '../transcription/SpeakerRegistry.js';
import type { SttFinal, SttProvider, SttStream } from '../transcription/types.js';

export interface SessionDeps {
  config: ServerConfig;
  liveStt: SttProvider;
  simulatedStt: SttProvider;
  llm: LlmProvider;
  /** Conversation history writer; omitted/null = history disabled. */
  history?: HistoryWriter | null;
  tracker?: LatencyTracker;
}

/** Real-time audio is 32 KB/s; allow bursts (reconnect flushes) but reject floods. */
const AUDIO_BYTES_PER_SEC = AUDIO_FORMAT.sampleRate * 2;
const AUDIO_BUCKET_MAX = AUDIO_BYTES_PER_SEC * 5;
/** Transcript context sent with each answer is capped in characters as well as segments. */
const CONTEXT_MAX_CHARS = 2_500;
const HISTORY_ERROR_NOTICE_INTERVAL_MS = 30_000;

interface Speculation {
  question: DetectedQuestion;
  requestId: string;
  text: string;
}

export class Session {
  private sessionId: string | null = null;
  private mode: 'live' | 'simulation' = 'live';
  private stt: SttStream | null = null;
  private sttProvider: SttProvider | null = null;
  private sessionConfig: SessionConfig | null = null;
  private readonly prefix = randomUUID().slice(0, 8);
  private segCounter = 0;
  private qCounter = 0;
  private readonly buffer = new TranscriptBuffer(LIMITS.maxTranscriptSegments);
  private readonly detector: QuestionDetector;
  private readonly answers: AnswerService;
  private readonly questions = new Map<string, DetectedQuestion>();
  private resumeRetriever = new KeywordRetriever([]);
  private notesRetriever = new KeywordRetriever([]);
  private hasPersonalKnowledge = false;
  private knowledgeKey = '';
  private lastCompleted: { question: string; questionId: string } | null = null;
  private lastAuto: { question: DetectedQuestion; at: number } | null = null;
  private classifying = false;
  private audioBucket = AUDIO_BUCKET_MAX;
  private audioBucketAt = Date.now();
  private audioWarned = false;
  private closed = false;
  /** When each transcript state of the current utterance was received (latency reference). */
  private readonly textAvailability = new TextAvailability();
  /** Added to provider timestamps when continuing a session after an extension reconnect. */
  private timelineOffsetMs = 0;
  private speakers = new SpeakerRegistry();
  private speakerNumberingRestarted = false;
  private spec: Speculation | null = null;
  private specCountThisUtterance = 0;
  private candidateThisFlush = false;
  private readonly recorder: ConversationRecorder | null;
  private readonly unsubscribeHistoryErrors: (() => void) | null;
  private lastHistoryNoticeAt = 0;
  private readonly tracker: LatencyTracker;
  private readonly send: (event: ServerEvent) => void;
  private log: Logger;
  /** Audio counters, summarized periodically (never per frame). */
  private audio = { frames: 0, bytes: 0, dropped: 0, invalid: 0, startedAt: 0 };
  private audioSummaryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly deps: SessionDeps,
    sendToClient: (event: ServerEvent) => void,
    logger: Logger = rootLog.child('session'),
  ) {
    this.log = logger;
    this.tracker = deps.tracker ?? latencyTracker;
    const history = deps.history ?? null;
    this.recorder = history ? new ConversationRecorder(history, undefined, () => this.mode === 'simulation' || deps.llm.simulated) : null;
    // Events go to the client first; history only observes them afterwards (in-memory enqueue).
    this.send = (event) => {
      sendToClient(event);
      this.recorder?.observe(event);
    };
    this.unsubscribeHistoryErrors = history
      ? history.onError((err, info) => {
          if (Date.now() - this.lastHistoryNoticeAt < HISTORY_ERROR_NOTICE_INTERVAL_MS) return;
          this.lastHistoryNoticeAt = Date.now();
          this.error(
            'history_write_failed',
            info.willRetry
              ? 'Saving conversation history failed; retrying. Live answers are unaffected.'
              : `Conversation history could not be saved (${err.message}). Live answers are unaffected.`,
          );
        })
      : null;

    this.detector = new QuestionDetector(
      {
        debounceMs: deps.config.detection.debounceMs,
        dedupeWindowMs: deps.config.detection.dedupeWindowMs,
        onUtteranceFlushed: () => this.onUtteranceFlushed(),
        onEvaluated: (e) => this.logEvaluation(e),
      },
      (c) => {
        // Resolve the latency reference now (observations are reset right after this callback);
        // handling is deferred so the triggering segment is sent (transcript.final) before question.detected.
        this.candidateThisFlush = true;
        const textAvailableAt = this.textAvailability.availableAt(c.text, Date.now());
        queueMicrotask(() => void this.onCandidate(c, textAvailableAt));
      },
    );
    this.answers = new AnswerService(deps.llm, this.send, {
      timeoutMs: deps.config.llm.timeoutMs,
      maxTokens: deps.config.llm.maxAnswerTokens,
      tracker: this.tracker,
    });
  }

  private get latency() {
    return this.deps.config.latency ?? DEFAULT_LATENCY;
  }

  private error(code: Extract<ServerEvent, { type: 'session.error' }>['code'], message: string, fatal = false): void {
    this.send({ type: 'session.error', code, message, fatal, ts: Date.now() });
  }

  handleEvent(event: ClientEvent): void {
    if (this.closed) return;
    switch (event.type) {
      case 'audio.start':
        return this.start(event.sessionId, event.mode, event.config, event.continuation);
      case 'audio.stop':
        return void this.stop();
      case 'config.update':
        return this.applyConfig(event.config);
      case 'answer.request':
        return this.manualRequest(event.requestId, event.questionText);
      case 'answer.retry': {
        const q = this.questions.get(event.questionId);
        if (!q) return this.error('bad_message', 'That question is no longer available to retry.');
        return void this.answer(q, event.requestId, true, 'retry');
      }
      case 'answer.cancel':
        return this.answers.cancel(event.requestId, 'user');
      case 'answer.displayed': {
        // Client-side render time, for the latency report. Ignore implausible clocks.
        const trace = this.tracker.get(event.requestId);
        if (trace && trace.displayedAt === undefined && Math.abs(event.displayedAt - Date.now()) < 60_000) {
          this.tracker.update(event.requestId, { displayedAt: event.displayedAt });
        }
        return;
      }
    }
  }

  handleAudio(chunk: Buffer): void {
    if (this.closed || !this.stt) return;
    if (chunk.length > LIMITS.maxAudioFrameBytes || chunk.length % 2 !== 0) {
      if (this.audio.invalid++ === 0) this.log.warn('audio_frame_invalid', { bytes: chunk.length, recovery: 'frame_dropped' });
      return this.error('bad_message', 'Invalid audio frame (expected PCM16 mono 16 kHz).');
    }
    const now = Date.now();
    this.audioBucket = Math.min(AUDIO_BUCKET_MAX, this.audioBucket + ((now - this.audioBucketAt) / 1000) * AUDIO_BYTES_PER_SEC * 1.5);
    this.audioBucketAt = now;
    if (chunk.length > this.audioBucket) {
      this.audio.dropped++;
      if (!this.audioWarned) {
        this.log.warn('audio_rate_exceeded', { recovery: 'excess_frames_dropped' });
        this.error('audio_rate_exceeded', 'Audio is arriving faster than real time; dropping excess audio.');
      }
      this.audioWarned = true;
      return;
    }
    this.audioBucket -= chunk.length;
    this.audio.frames++;
    this.audio.bytes += chunk.length;
    this.stt.sendAudio(chunk);
  }

  private start(
    sessionId: string,
    mode: 'live' | 'simulation',
    config: SessionConfig,
    continuation?: { timelineOffsetMs: number; speakerOffset: number },
  ): void {
    if (this.stt) return this.error('already_started', 'A session is already running on this connection.');
    // After an extension reconnect, keep timestamps increasing and never reuse earlier speaker numbers.
    this.timelineOffsetMs = continuation?.timelineOffsetMs ?? 0;
    this.speakers = new SpeakerRegistry(continuation?.speakerOffset ?? 0);
    if (continuation && continuation.speakerOffset > 0) this.speakerNumberingRestarted = true;
    const provider = mode === 'simulation' ? this.deps.simulatedStt : this.deps.liveStt;
    if (!provider.isConfigured()) {
      return this.error(
        'stt_not_configured',
        `Speech-to-text is not configured: set DEEPGRAM_API_KEY in the server .env file (or use Simulation mode to test without credentials).`,
        true,
      );
    }
    this.sessionId = sessionId;
    // Correlate with the extension's logs: it logs the same sid.
    this.log = this.log.with({ sid: sessionId });
    this.answers.setLogger(this.log);
    this.audio = { frames: 0, bytes: 0, dropped: 0, invalid: 0, startedAt: monotonicNow() };
    this.audioSummaryTimer = setInterval(() => this.logAudioSummary('debug'), 60_000);
    this.audioSummaryTimer.unref?.();
    this.mode = mode;
    this.applyConfig(config);
    this.sttProvider = provider;
    const llm = this.deps.llm;
    // Open the provider connection now so the first answer does not pay connection setup.
    llm.warmup?.();
    this.send({
      type: 'session.ready',
      sessionId,
      stt: { provider: provider.name, simulated: provider.simulated },
      llm: { provider: llm.name, model: llm.model, simulated: llm.simulated },
      ts: Date.now(),
    });
    this.stt = provider.start(
      { language: config.language, keywords: config.keywords, diarize: config.diarize, log: this.log },
      {
        onPartial: (p) => this.onPartial(p, provider.simulated),
        onFinal: (f) => this.onFinal(f, provider.simulated),
        onUtteranceEnd: () => this.detector.utteranceEnd(),
        onStatus: (state, message) => this.send({ type: 'session.status', state, message, ts: Date.now() }),
        onError: (e) => {
          this.error(e.code, e.message, e.fatal);
          if (e.fatal) {
            this.stt?.close();
            this.stt = null;
          }
        },
      },
    );
    if (!llm.isConfigured()) {
      this.error('llm_not_configured', 'GROQ_API_KEY is not set on the server; transcription works but answers cannot be generated.');
    }
    this.log.info('started', {
      mode,
      stt: provider.name,
      llm: `${llm.name}/${llm.model}`,
      diarize: config.diarize,
      answer_mode: config.answerMode,
      speculative: this.latency.speculative,
      continuation: continuation ? 'yes' : undefined,
      has_resume: Boolean(config.resume),
      history: config.conversationId ? 'on' : 'off',
    });
  }

  private applyConfig(config: SessionConfig): void {
    this.sessionConfig = config;
    this.recorder?.setConversation(config.conversationId);
    const key = `${config.resume?.text ?? ''}\u0000${config.background}\u0000${config.notes}`;
    if (key === this.knowledgeKey) return;
    this.knowledgeKey = key;
    const personal = [...(config.resume ? parseResume(config.resume.text, 'resume') : []), ...parseResume(config.background, 'background')];
    this.resumeRetriever = new KeywordRetriever(personal);
    this.notesRetriever = new KeywordRetriever(parseResume(config.notes, 'notes'));
    this.hasPersonalKnowledge = personal.length > 0;
    this.log.debug('knowledge_updated', { personal_chunks: personal.length, note_chunks: this.notesRetriever.size, has_resume: Boolean(config.resume) });
  }

  // ---------------------------------------------------------------------------
  // Transcript handling
  // ---------------------------------------------------------------------------

  private onPartial(raw: { text: string; startMs: number; endMs: number }, simulated: boolean): void {
    const now = Date.now();
    const p = { ...raw, startMs: raw.startMs + this.timelineOffsetMs, endMs: raw.endMs + this.timelineOffsetMs };
    const utterance = `${this.detector.pendingText()} ${p.text}`.trim();
    this.textAvailability.observe(utterance, now);
    this.detector.noteActivity();
    this.send({ type: 'transcript.partial', ...p, simulated, ts: now });
    if (this.detector.pendingText() === '' && startsLikeQuestion(p.text)) this.deps.llm.warmup?.();
    this.updateSpeculation(p.text, utterance);
  }

  private onFinal(final: SttFinal, simulated: boolean): void {
    const { speakerScope, speaker: providerSpeaker, ...rest } = final;
    // Provider labels -> session labels (only when the provider actually returned one).
    const speaker = this.speakers.resolve(providerSpeaker, speakerScope ?? 1, () => this.noteSpeakerRestart());
    if (speaker !== undefined && this.speakerNumberingRestarted) {
      // Continuing after an extension reconnect: the first new label starts a new numbering.
      this.speakerNumberingRestarted = false;
      this.noteSpeakerRestart();
    }
    const segment: TranscriptSegment = {
      ...rest,
      startMs: rest.startMs + this.timelineOffsetMs,
      endMs: rest.endMs + this.timelineOffsetMs,
      ...(speaker !== undefined ? { speaker } : {}),
      id: `${this.prefix}-${++this.segCounter}`,
    };
    this.textAvailability.observe(`${this.detector.pendingText()} ${segment.text}`, Date.now());
    // The detector rejects re-emitted duplicate finals; drop those from the transcript too.
    if (!this.detector.addFinal(segment)) return;
    // A speaker-turn boundary may have flushed the earlier text: re-record this utterance's state.
    this.textAvailability.observe(this.detector.pendingText(), Date.now());
    this.buffer.add(segment);
    logTranscript(this.log, 'final_segment', segment.text);
    this.send({ type: 'transcript.final', segment, simulated, ts: Date.now() });
  }

  /** Tell the user once per restart that speaker numbers after this point are new labels. */
  private noteSpeakerRestart(): void {
    this.send({
      type: 'session.status',
      state: 'transcriber_connected',
      message: 'The transcription connection was re-established: speaker labels after this point are numbered anew and may refer to people labelled earlier.',
      ts: Date.now(),
    });
  }

  /** One DEBUG line per finished utterance (never per interim result); no transcript text unless LOG_TRANSCRIPTS. */
  private logEvaluation(e: UtteranceEvaluation): void {
    if (!this.log.enabled('debug')) return;
    const c = e.candidate;
    this.log.debug('utterance_evaluated', {
      source: 'final',
      decision: e.decision,
      segments: e.segments,
      words: e.words,
      intent: c?.intentType,
      requires_context: c?.requiresContext,
      score: c?.score,
      reasons: c?.reasons.join(','),
      detect_ms: Math.round(e.durationMs * 100) / 100,
      recovery: e.decision === 'duplicate' ? 'suppressed_already_answered' : e.decision === 'ambiguous' ? 'sent_to_classifier' : undefined,
    });
    if (c) logTranscript(this.log, 'candidate_text', c.text);
  }

  private onUtteranceFlushed(): void {
    this.textAvailability.reset();
    this.specCountThisUtterance = 0;
    const hadCandidate = this.candidateThisFlush;
    this.candidateThisFlush = false;
    // The final transcript contained no (new) question: a tentative one must be withdrawn.
    // Queued after the candidate handler, so a matching candidate resolves the speculation first.
    if (!hadCandidate) queueMicrotask(() => this.spec && this.retractSpeculation('final transcript has no question'));
  }

  // ---------------------------------------------------------------------------
  // Speculative (tentative) answers from interim transcripts
  // ---------------------------------------------------------------------------

  private speculationAllowed(): boolean {
    return (
      this.latency.speculative &&
      this.sessionConfig?.answerMode === 'auto' &&
      this.deps.llm.isConfigured() &&
      // Never cancel a confirmed answer that is still streaming on a guess.
      (this.answers.activeRequest() === null || this.answers.activeRequest()?.requestId === this.spec?.requestId)
    );
  }

  private updateSpeculation(partialText: string, utterance: string): void {
    if (this.spec) {
      const candidate = this.detector.evaluatePartial(partialText);
      if (candidate && confirmsSpeculation(this.spec.text, candidate.text)) return;
      this.retractSpeculation('interim transcript changed');
    }
    if (!this.speculationAllowed() || this.specCountThisUtterance >= DEFAULT_SPECULATION.maxPerUtterance) return;
    const candidate = this.detector.evaluatePartial(partialText);
    const opts = { ...DEFAULT_SPECULATION, minScore: this.latency.speculationMinScore };
    if (!shouldSpeculate(candidate, utterance, opts) || this.detector.isDuplicate(candidate.text)) return;

    const now = Date.now();
    const question: DetectedQuestion = {
      id: `q-${this.prefix}-${++this.qCounter}`,
      text: candidate.text,
      ...(candidate.context ? { context: candidate.context } : {}),
      segmentIds: candidate.segmentIds,
      source: 'auto',
      confidence: candidate.confidence,
      isFollowUp: candidate.isFollowUp,
      detectedAt: now,
      textAvailableAt: this.textAvailability.availableAt(candidate.text, now),
      speculative: true,
    };
    const requestId = `r-${randomUUID()}`;
    this.spec = { question, requestId, text: candidate.text };
    this.specCountThisUtterance++;
    this.trackQuestion(question);
    this.log.debug('speculation_started', { qid: question.id, rid: requestId, source: 'interim', intent: candidate.intentType, score: candidate.score });
    this.send({ type: 'question.detected', question, ts: now });
    void this.answer(question, requestId, false, 'speculative');
  }

  private retractSpeculation(reason: string): void {
    const s = this.spec;
    if (!s) return;
    this.spec = null;
    this.answers.cancel(s.requestId, 'speculation_rejected');
    this.answers.forget(s.question.id);
    this.questions.delete(s.question.id);
    if (this.lastCompleted?.questionId === s.question.id) this.lastCompleted = null;
    this.log.debug('tentative_retracted', { qid: s.question.id, reason });
    this.send({ type: 'question.updated', questionId: s.question.id, status: 'retracted', ts: Date.now() });
  }

  /** Returns true when the final candidate confirmed the running speculation (nothing else to do). */
  private resolveSpeculation(candidate: QuestionCandidate): boolean {
    const s = this.spec;
    if (!s) return false;
    if (!candidate.ambiguous && confirmsSpeculation(s.text, candidate.text)) {
      this.spec = null;
      s.question.speculative = false;
      s.question.text = candidate.text;
      this.lastAuto = { question: s.question, at: Date.now() };
      // The final transcript is the same request: keep the running answer instead of generating another one.
      this.log.debug('speculation_confirmed', { qid: s.question.id, rid: s.requestId, intent: candidate.intentType, recovery: 'final_deduplicated' });
      this.send({ type: 'question.updated', questionId: s.question.id, status: 'confirmed', text: candidate.text, ts: Date.now() });
      return true;
    }
    this.retractSpeculation('final transcript differs');
    return false;
  }

  // ---------------------------------------------------------------------------
  // Confirmed questions
  // ---------------------------------------------------------------------------

  private async onCandidate(candidate: QuestionCandidate, textAvailableAt: number): Promise<void> {
    if (this.closed) return;
    if (this.resolveSpeculation(candidate)) return;
    let source: 'heuristics' | 'classifier' = 'heuristics';
    if (candidate.ambiguous) {
      const verdict = await this.confirmAmbiguous(candidate);
      if (!verdict?.isQuestion) return;
      if (this.detector.isDuplicate(candidate.text)) {
        this.log.debug('duplicate_suppressed', { stage: 'after_classifier', intent: candidate.intentType });
        return;
      }
      this.detector.remember(candidate.text);
      source = 'classifier';
      // The classifier saw the recent conversation: prefer its reading of the form and of the context need.
      candidate = {
        ...candidate,
        ambiguous: false,
        intentType: verdict.intent ?? candidate.intentType,
        requiresContext: verdict.needsContext || candidate.requiresContext,
        isFollowUp: candidate.isFollowUp || verdict.needsContext || verdict.intent === 'follow_up',
      };
    }

    // A short fragment right after a question that is still being answered continues that question
    // ("What is a closure?" ... "In JavaScript?"): answer the combined question instead.
    let text = candidate.text;
    const prev = this.lastAuto;
    if (
      prev &&
      !candidate.ambiguous &&
      Date.now() - prev.at < this.latency.continuationWindowMs &&
      this.answers.isGenerating(prev.question.id) &&
      (candidate.isFollowUp || tokenize(candidate.text).length < 6)
    ) {
      text = `${prev.question.text} ${candidate.text}`;
      textAvailableAt = Math.min(textAvailableAt, Date.now());
    }

    const question: DetectedQuestion = {
      id: `q-${this.prefix}-${++this.qCounter}`,
      text,
      ...(candidate.context ? { context: candidate.context } : {}),
      segmentIds: candidate.segmentIds,
      source: 'auto',
      confidence: candidate.confidence,
      isFollowUp: text === candidate.text ? candidate.isFollowUp : false,
      detectedAt: Date.now(),
      textAvailableAt,
      speculative: false,
    };
    this.trackQuestion(question);
    this.lastAuto = { question, at: Date.now() };
    const auto = this.sessionConfig?.answerMode === 'auto';
    const requestId = `r-${randomUUID()}`;
    this.log.debug('question_detected', {
      qid: question.id,
      source,
      intent: candidate.intentType,
      requires_context: candidate.requiresContext,
      follow_up: question.isFollowUp,
      score: candidate.score,
      reasons: candidate.reasons.join(','),
      answer_triggered: auto,
      rid: auto ? requestId : undefined,
    });
    this.send({ type: 'question.detected', question, ts: Date.now() });
    if (auto) await this.answer(question, requestId, false, 'auto');
  }

  /**
   * Uses the small Groq detection model, if configured, to confirm ambiguous candidates (only those).
   * It sees a few recent transcript lines and the previous question so it can resolve "that" or "what about…".
   */
  private async confirmAmbiguous(candidate: QuestionCandidate): Promise<ClassifierVerdict | null> {
    const llm = this.deps.llm;
    if (!llm.classifyJson || !llm.isConfigured() || this.classifying) {
      this.log.debug('classifier_skipped', { reason: this.classifying ? 'busy' : 'not_configured', intent: candidate.intentType, recovery: 'treated_as_not_a_question' });
      return null;
    }
    this.classifying = true;
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.latency.classifierTimeoutMs);
    try {
      const recent = this.buffer
        .recent(4, 600)
        .filter((s) => !candidate.segmentIds.includes(s.id))
        .map((s) => (s.speaker !== undefined ? `S${s.speaker + 1}: ${s.text}` : s.text));
      const result = await llm.classifyJson({
        messages: classifierMessages({
          utterance: candidate.text,
          ...(candidate.context ? { preceding: candidate.context } : {}),
          recent,
          ...(this.lastAuto ? { lastQuestion: this.lastAuto.question.text } : {}),
        }),
        maxTokens: 60,
        signal: controller.signal,
      });
      const verdict = parseClassifierVerdict(result);
      this.log.debug('classifier_decision', {
        is_question: verdict?.isQuestion ?? false,
        intent: verdict?.intent ?? 'none',
        needs_context: verdict?.needsContext,
        heuristic_intent: candidate.intentType,
        duration_ms: Math.round(performance.now() - started),
        recovery: verdict ? undefined : 'unparseable_reply_treated_as_not_a_question',
      });
      return verdict;
    } catch (err) {
      this.log.debug('classifier_failed', { err, duration_ms: Math.round(performance.now() - started), recovery: 'treated_as_not_a_question' });
      return null;
    } finally {
      clearTimeout(timer);
      this.classifying = false;
    }
  }

  private trackQuestion(q: DetectedQuestion): void {
    this.questions.set(q.id, q);
    if (this.questions.size > LIMITS.maxQuestionCards) {
      const oldest = this.questions.keys().next().value;
      if (oldest !== undefined) this.questions.delete(oldest);
    }
  }

  private manualRequest(requestId: string, questionText?: string): void {
    const text = questionText?.trim() || this.detector.latestUtterance()?.text;
    if (!text) return this.error('bad_message', 'Nothing has been transcribed yet, so there is no question to answer.');
    if (this.spec) this.retractSpeculation('manual request');
    const question: DetectedQuestion = {
      id: `q-${this.prefix}-${++this.qCounter}`,
      text,
      segmentIds: questionText ? [] : (this.detector.latestUtterance()?.segmentIds ?? []),
      source: 'manual',
      confidence: 1,
      isFollowUp: false,
      detectedAt: Date.now(),
      textAvailableAt: Date.now(),
      speculative: false,
    };
    this.detector.remember(text);
    this.trackQuestion(question);
    this.send({ type: 'question.detected', question, ts: Date.now() });
    void this.answer(question, requestId, true, 'manual');
  }

  private async answer(question: DetectedQuestion, requestId: string, force: boolean, kind: TraceKind): Promise<void> {
    const config = this.sessionConfig;
    if (!config) return;
    // Everything below is in-memory and synchronous (sub-millisecond): no I/O before dispatch.
    const intent = classifyQuestionIntent(question.text);
    const retrieval =
      intent.kind === 'general'
        ? { chunks: [], evidence: 'none' as const }
        : this.resumeRetriever.retrieve(`${question.text}`, { sectionHints: intent.sectionHints, limit: 3 });
    const evidence: AnswerGrounding['evidence'] =
      intent.kind === 'general' ? 'not_needed' : !this.hasPersonalKnowledge ? 'no_resume' : retrieval.evidence;
    const noteExcerpts = this.notesRetriever.size
      ? this.notesRetriever.retrieve(`${question.context ?? ''} ${question.text}`, { sectionHints: [], limit: 2 }).chunks
      : [];
    const previous = question.isFollowUp && this.lastCompleted ? this.lastCompleted : null;
    const previousAnswer = previous ? this.answers.answerFor(previous.questionId) : undefined;
    // The question itself is sent separately, so its own segments are not repeated as context.
    const transcript = this.buffer.recent(config.contextSegments, CONTEXT_MAX_CHARS).filter((s) => !question.segmentIds.includes(s.id));

    const { messages, promptChars } = buildAnswerMessages({
      question: question.text,
      ...(question.context ? { questionContext: question.context } : {}),
      kind: intent.kind,
      evidence,
      style: config.answerStyle,
      length: config.answerLength,
      transcript,
      resumeExcerpts: retrieval.chunks,
      noteExcerpts,
      ...(previous && previousAnswer ? { previousQa: { question: previous.question, answer: previousAnswer } } : {}),
    });
    const grounding: AnswerGrounding = {
      kind: intent.kind,
      evidence,
      excerptCount: retrieval.chunks.length,
      sections: [...new Set(retrieval.chunks.map((c) => c.section))],
    };
    const noEvidence = intent.kind === 'personal' && (evidence === 'none' || evidence === 'no_resume');
    const now = Date.now();

    const ran = await this.answers.generate({
      requestId,
      questionId: question.id,
      messages,
      force,
      grounding,
      maxTokens: MAX_TOKENS_BY_LENGTH[config.answerLength],
      trace: {
        kind,
        textAvailableAt: kind === 'retry' ? now : question.textAvailableAt,
        detectedAt: kind === 'retry' ? now : question.detectedAt,
      },
      context: {
        transcriptSegments: transcript.length,
        includesBackground: retrieval.chunks.some((c) => c.source === 'background'),
        includesNotes: noteExcerpts.length > 0,
        includesPreviousQa: Boolean(previous && previousAnswer),
        promptChars: noEvidence ? 0 : promptChars,
      },
      ...(noEvidence ? { fixedText: insufficientEvidenceMessage(evidence === 'no_resume' ? 'no_resume' : 'none') } : {}),
    });
    if (ran && this.answers.answerFor(question.id) !== undefined && this.questions.has(question.id)) {
      this.lastCompleted = { question: question.text, questionId: question.id };
    }
  }

  async stop(): Promise<void> {
    if (this.audioSummaryTimer) clearInterval(this.audioSummaryTimer);
    if (!this.stt && !this.sessionId) return;
    this.detector.dispose();
    if (this.spec) this.retractSpeculation('session stopped');
    this.answers.cancelAll('session_ended');
    const stt = this.stt;
    this.stt = null;
    await stt?.finish();
    if (this.sessionId) this.send({ type: 'session.ended', sessionId: this.sessionId, ts: Date.now() });
    this.logAudioSummary('info', 'stopped');
    this.sessionId = null;
  }

  private logAudioSummary(level: 'debug' | 'info', event = 'audio_summary'): void {
    const seconds = this.audio.bytes / (AUDIO_FORMAT.sampleRate * 2);
    this.log[level](event, {
      audio_frames: this.audio.frames,
      audio_s: Math.round(seconds),
      dropped_frames: this.audio.dropped,
      invalid_frames: this.audio.invalid,
      final_segments: this.segCounter,
      uptime_s: this.audio.startedAt ? Math.round(elapsedMs(this.audio.startedAt) / 1000) : 0,
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.audioSummaryTimer) clearInterval(this.audioSummaryTimer);
    if (this.sessionId) this.log.info('closed', { reason: 'socket_closed' });
    this.detector.dispose();
    this.answers.cancelAll('session_ended');
    this.stt?.close();
    this.stt = null;
    this.buffer.clear();
    this.questions.clear();
    this.unsubscribeHistoryErrors?.();
  }
}

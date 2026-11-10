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
import { namesOwnSubject, utteranceSentences, type AnswerContext, type ConversationMemory, type MemoryStore, type QuestionInfo } from '../context/ConversationMemory.js';
import { DESIGN_INSTRUCTION, designRequestTitle } from '../context/extract.js';
import { classifierMessages, parseClassifierVerdict, type ClassifierVerdict } from '../detection/classifier.js';
import { classifyQuestionIntent } from '../detection/intent.js';
import { QuestionDetector, type QuestionCandidate, type UtteranceEvaluation } from '../detection/QuestionDetector.js';
import { QUESTION_THRESHOLD, splitSentences, startsLikeQuestion } from '../detection/scoring.js';
import { confirmsSpeculation, DEFAULT_SPECULATION, shouldSpeculate } from '../detection/speculation.js';
import { ConversationRecorder } from '../history/ConversationRecorder.js';
import type { HistoryWriter } from '../history/HistoryWriter.js';
import { latencyTracker, type LatencyTracker, type TraceKind } from '../latency/LatencyTracker.js';
import { TextAvailability } from '../latency/TextAvailability.js';
import type { LlmProvider } from '../llm/types.js';
import { log as rootLog, logTranscript } from '../logger.js';
import { KeywordRetriever, type RetrievalResult } from '../resume/retrieval.js';
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
  /** Conversation memory shared across connections (reconnects); omitted/null = context memory off. */
  memory?: MemoryStore | null;
}

/** Real-time audio is 32 KB/s; allow bursts (reconnect flushes) but reject floods. */
const AUDIO_BYTES_PER_SEC = AUDIO_FORMAT.sampleRate * 2;
const AUDIO_BUCKET_MAX = AUDIO_BYTES_PER_SEC * 5;
/** Transcript context sent with each answer is capped in characters as well as segments. */
const CONTEXT_MAX_CHARS = 2_500;
const HISTORY_ERROR_NOTICE_INTERVAL_MS = 30_000;
/** A design instruction heard while an answer was streaming is answered after it, unless it is older than this. */
const DEFERRED_REQUEST_MAX_MS = 20_000;

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
  /** Context memory of this extension session (resumed after a reconnect); null when off. */
  private memory: ConversationMemory | null = null;
  /** With memory: a design instruction heard while an answer was streaming, answered when it finishes (never cancels it). */
  private deferredRequest: { candidate: QuestionCandidate; textAvailableAt: number; at: number } | null = null;
  /** With memory: the requirements each tentative answer was drafted with, checked when the final transcript confirms it. */
  private readonly tentativeRequirements = new Map<string, string>();
  private specCountThisUtterance = 0;
  private candidateThisFlush = false;
  private recorder: ConversationRecorder | null = null;
  private unsubscribeHistoryErrors: (() => void) | null = null;
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
    // Events go to the client first; history only observes them afterwards (in-memory enqueue).
    this.send = (event) => {
      sendToClient(event);
      this.recorder?.observe(event);
    };
    if (deps.history) this.attachHistory(deps.history);

    this.detector = new QuestionDetector(
      {
        debounceMs: deps.config.detection.debounceMs,
        dedupeWindowMs: deps.config.detection.dedupeWindowMs,
        onUtteranceFlushed: () => this.onUtteranceFlushed(),
        onEvaluated: (e) => {
          this.observeForContext(e);
          this.logEvaluation(e);
        },
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

  /**
   * Starts recording this session's cards with `history` (hosted servers call this once the user's access
   * token is verified, which may be after the session started).
   */
  attachHistory(history: HistoryWriter): void {
    if (this.closed || this.recorder) return;
    this.recorder = new ConversationRecorder(history, this.sessionConfig?.conversationId, () => this.mode === 'simulation' || this.deps.llm.simulated);
    this.unsubscribeHistoryErrors = history.onError((err, info) => {
      if (Date.now() - this.lastHistoryNoticeAt < HISTORY_ERROR_NOTICE_INTERVAL_MS) return;
      this.lastHistoryNoticeAt = Date.now();
      this.error(
        'history_write_failed',
        info.willRetry
          ? 'Saving conversation history failed; retrying. Live answers are unaffected.'
          : `Conversation history could not be saved (${err.message}). Live answers are unaffected.`,
      );
    });
  }

  private error(code: Extract<ServerEvent, { type: 'session.error' }>['code'], message: string, fatal = false): void {
    this.send({ type: 'session.error', code, message, fatal, ts: Date.now() });
  }

  handleEvent(event: ClientEvent): void {
    if (this.closed) return;
    switch (event.type) {
      case 'auth.update':
        return; // handled by the connection (app.ts)
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
    if (this.deps.memory) {
      try {
        // Same extension session after a reconnect (continuation): keep the context. Otherwise start empty.
        const { memory, resumed } = this.deps.memory.acquire(sessionId, Boolean(continuation));
        this.memory = memory;
        this.log.debug('context_ready', { resumed, topics: memory.topicCount });
      } catch (err) {
        this.memory = null;
        this.log.warn('context_update_failed', { stage: 'acquire', err, recovery: 'answers_without_context' });
      }
    }
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

  /**
   * Feeds a finished utterance (final transcript only, after duplicate filtering) to the context memory:
   * statements become facts on the active topic before this utterance's question is answered. Two kinds of
   * statement are also answered as requests: a design task ("Today let's design a ride-sharing service.") and,
   * while a design is being discussed, an instruction for its next step ("Now add authentication."). Neither
   * cancels an answer that is still streaming: it waits until that answer has finished.
   */
  private observeForContext(e: UtteranceEvaluation): void {
    const memory = this.memory;
    if (!memory || this.closed) return;
    try {
      const text = this.detector.latestUtterance()?.text ?? '';
      const changed = memory.observeUtterance(utteranceSentences(text));
      if (this.sessionId) this.deps.memory?.touch(this.sessionId);
      if (changed > 0) this.log.debug('context_updated', { source: 'statement', facts_changed: changed, topic: memory.activeTopic?.kind });
      const request =
        e.decision !== 'rejected' || this.detector.isDuplicate(text)
          ? null
          : designRequestTitle(text)
            ? 'design_task'
            : memory.activeTopic?.kind === 'system_design' && splitSentences(text).length === 1 && DESIGN_INSTRUCTION.test(text.trim())
              ? 'design_extension'
              : null;
      if (!request) return;
      const candidate: QuestionCandidate = {
        text: text.trim(),
        segmentIds: this.detector.latestUtterance()?.segmentIds ?? [],
        score: QUESTION_THRESHOLD,
        confidence: 0.5,
        ambiguous: false,
        isFollowUp: request === 'design_extension',
        intentType: 'imperative_request',
        requiresContext: request === 'design_extension',
        reasons: [request === 'design_task' ? 'sets a design task' : 'extends the design under discussion'],
      };
      this.detector.remember(candidate.text);
      const textAvailableAt = this.textAvailability.availableAt(candidate.text, Date.now());
      if (this.answers.activeRequest() !== null) {
        this.deferredRequest = { candidate, textAvailableAt, at: Date.now() };
        this.log.debug('context_promoted_request', { kind: request, words: candidate.text.split(/\s+/).length, recovery: 'deferred_until_answer_finishes' });
        return;
      }
      this.candidateThisFlush = true;
      this.log.debug('context_promoted_request', { kind: request, words: candidate.text.split(/\s+/).length });
      queueMicrotask(() => void this.onCandidate(candidate, textAvailableAt));
    } catch (err) {
      this.log.warn('context_update_failed', { stage: 'observe', err, recovery: 'answers_without_context' });
    }
  }

  /** Answers a deferred design instruction once nothing is streaming (dropped when stale or superseded). */
  private flushDeferredRequest(): void {
    const d = this.deferredRequest;
    if (!d || this.closed || this.answers.activeRequest() !== null) return;
    this.deferredRequest = null;
    if (Date.now() - d.at > DEFERRED_REQUEST_MAX_MS) {
      this.log.debug('context_promoted_request_dropped', { reason: 'stale' });
      return;
    }
    queueMicrotask(() => void this.onCandidate(d.candidate, d.textAvailableAt));
  }

  /**
   * Records an accepted question in the context memory (never a tentative one). `memory` is the memory the
   * question was heard with: nothing is recorded once the connection is closed or the meeting has changed.
   */
  private commitToMemory(question: DetectedQuestion, memory: ConversationMemory | null = this.memory, replaces?: string): void {
    if (!memory || memory !== this.memory || this.closed) return;
    try {
      const decision = memory.commit({ ...this.questionInfo(question), ...(replaces ? { replaces } : {}) });
      if (this.sessionId) this.deps.memory?.touch(this.sessionId);
      this.log.debug('context_updated', { source: 'question', qid: question.id, route: decision.action, reason: decision.reason, topic: memory.activeTopic?.kind, topics: memory.topicCount });
    } catch (err) {
      this.log.warn('context_update_failed', { stage: 'commit', qid: question.id, err, recovery: 'answers_without_context' });
    }
  }

  private questionInfo(question: Pick<DetectedQuestion, 'id' | 'text' | 'context' | 'isFollowUp'>): QuestionInfo {
    const intent = classifyQuestionIntent(question.text);
    return {
      id: question.id,
      text: question.text,
      ...(question.context ? { context: question.context } : {}),
      isFollowUp: question.isFollowUp,
      intentKind: intent.kind,
      ownSubject: namesOwnSubject(intent.sectionHints),
    };
  }

  /**
   * A tentative answer was drafted with the requirements known from the interim transcript. If the final
   * transcript of the same question states different ones ("50 million" heard as "15 million"), the draft is
   * redone with them; otherwise it is kept.
   */
  private finalChangedRequirements(s: Speculation, candidate: QuestionCandidate): boolean {
    const used = this.tentativeRequirements.get(s.question.id);
    this.tentativeRequirements.delete(s.question.id);
    if (used === undefined || !this.memory) return false;
    try {
      const final = this.memory.contextFor(this.questionInfo({ id: s.question.id, text: candidate.text, ...(candidate.context ? { context: candidate.context } : {}), isFollowUp: candidate.isFollowUp }));
      return final.requirements !== used;
    } catch {
      return false;
    }
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
    this.deferredRequest = null; // a newer question is being asked
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
    this.tentativeRequirements.delete(s.question.id);
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
      if (this.finalChangedRequirements(s, candidate)) {
        this.retractSpeculation('final transcript changed a requirement');
        return false;
      }
      this.spec = null;
      s.question.speculative = false;
      s.question.text = candidate.text;
      this.lastAuto = { question: s.question, at: Date.now() };
      this.commitToMemory(s.question);
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
    // The meeting this was heard in: after a classifier wait it is only recorded there (see commitToMemory).
    const memory = this.memory;
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
    this.deferredRequest = null; // a newer question was asked
    this.commitToMemory(question, memory, text === candidate.text ? undefined : prev?.question.id);
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
    this.commitToMemory(question);
    this.send({ type: 'question.detected', question, ts: Date.now() });
    void this.answer(question, requestId, true, 'manual');
  }

  private async answer(question: DetectedQuestion, requestId: string, force: boolean, kind: TraceKind): Promise<void> {
    const config = this.sessionConfig;
    if (!config) return;
    // Everything below is in-memory and synchronous (sub-millisecond): no I/O before dispatch.
    const previous = question.isFollowUp && this.lastCompleted ? this.lastCompleted : null;
    const previousAnswer = previous ? this.answers.answerFor(previous.questionId) : undefined;
    const conversation = this.conversationContext(question, previous && previousAnswer ? previous.questionId : undefined);
    let intent = classifyQuestionIntent(question.text);
    const retrievalQuery = conversation?.personalFollowUp ? `${conversation.personalFollowUp.query} ${question.text}` : question.text;
    let retrieval: RetrievalResult =
      intent.kind === 'general' ? { chunks: [], evidence: 'none' } : this.resumeRetriever.retrieve(retrievalQuery, { sectionHints: intent.sectionHints, limit: 3 });
    // "How big was the team?" after a project question: answered from the resume, retrieved with that question,
    // when the resume has something on it. Otherwise it is answered as before (not with the "not in your resume" reply).
    if (conversation?.personalFollowUp && intent.kind === 'general' && this.hasPersonalKnowledge) {
      const found = this.resumeRetriever.retrieve(retrievalQuery, { sectionHints: [], limit: 3 });
      if (found.evidence !== 'none') {
        intent = { kind: 'personal', sectionHints: [] };
        retrieval = found;
      }
    }
    const evidence: AnswerGrounding['evidence'] =
      intent.kind === 'general' ? 'not_needed' : !this.hasPersonalKnowledge ? 'no_resume' : retrieval.evidence;
    const noteExcerpts = this.notesRetriever.size
      ? this.notesRetriever.retrieve(`${question.context ?? ''} ${question.text}`, { sectionHints: [], limit: 2 }).chunks
      : [];
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
      ...(conversation?.block ? { conversationContext: conversation.block } : {}),
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
    const answerText = this.answers.answerFor(question.id);
    if (ran && answerText !== undefined && this.questions.has(question.id)) {
      this.lastCompleted = { question: question.text, questionId: question.id };
      // A drafted answer becomes part of the topic summary (not the fixed "add your resume" message).
      if (!noEvidence && this.memory && !this.closed) {
        try {
          this.memory.recordAnswer(question.id, answerText);
        } catch (err) {
          this.log.warn('context_update_failed', { stage: 'answer', qid: question.id, err, recovery: 'answers_without_context' });
        }
      }
    }
    this.flushDeferredRequest();
  }

  /**
   * Bounded topic summary for an answer prompt; null when memory is off, empty for this topic, or fails. A tentative
   * question sees its interim utterance as the final one will be read ("Actually, make it 50 million… How would you
   * scale it?"), so the final only redrafts it when a requirement really differs.
   */
  private conversationContext(question: DetectedQuestion, previousQaId?: string): AnswerContext | null {
    if (!this.memory || this.closed) return null;
    try {
      const preview = question.speculative ? utteranceSentences(`${question.context ?? ''} ${question.text}`.trim()) : [];
      const ctx = this.memory.contextFor(this.questionInfo(question), { skipQuestionIds: previousQaId ? [previousQaId] : [], preview });
      if (question.speculative) {
        this.tentativeRequirements.set(question.id, ctx.requirements);
        if (this.tentativeRequirements.size > 20) this.tentativeRequirements.delete(this.tentativeRequirements.keys().next().value as string);
      }
      this.log.debug('context_attached', {
        qid: question.id,
        route: ctx.route,
        topic: ctx.topicKind,
        context_chars: ctx.block?.length ?? 0,
        personal_follow_up: ctx.personalFollowUp ? true : undefined,
      });
      return ctx;
    } catch (err) {
      this.log.warn('context_update_failed', { stage: 'context', qid: question.id, err, recovery: 'answers_without_context' });
      return null;
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
    // The user stopped listening: the next Start is a new meeting with an empty context. (A dropped
    // connection does not get here, so a reconnect still finds this session's memory.)
    if (this.sessionId) this.deps.memory?.release(this.sessionId);
    this.memory = null;
    this.deferredRequest = null;
    this.tentativeRequirements.clear();
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

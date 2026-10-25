/**
 * Owns one copilot session inside the offscreen document: server connection, tab audio capture,
 * and the authoritative UI state (shared reducer). The UI pages only render and send commands.
 */
import {
  AUDIO_FORMAT,
  elapsedMs,
  initialCopilotState,
  monotonicNow,
  reduceServerEvent,
  settleGenerating,
  type CopilotState,
  type ServerEvent,
  type SessionConfig,
  type Logger,
} from '@meeting-copilot/shared';
import { AudioCapture } from '../audio/AudioCapture.js';
import { extensionLog } from '../lib/log.js';
import { newId, send, type UiCommand } from '../lib/messages.js';
import { wsUrl, type SessionStatus } from '../lib/settings.js';
import { ServerConnection } from './ServerConnection.js';

export interface StartOptions {
  mode: 'live' | 'simulation';
  streamId: string | null;
  serverUrl: string;
  config: SessionConfig;
  tabId: number | null;
  tabTitle: string | null;
}

const READY_TIMEOUT_MS = 10_000;
/** Traffic summary interval (DEBUG): counts only, never content. */
const SUMMARY_INTERVAL_MS = 30_000;

export class SessionController {
  private state: CopilotState;
  private connection: ServerConnection | null = null;
  private capture: AudioCapture | null = null;
  private readonly sessionId = newId('sess');
  private config: SessionConfig;
  private status: SessionStatus;
  private historyTimer: ReturnType<typeof setTimeout> | null = null;
  private readyWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private stopping = false;
  private stopped = false;
  private endedWaiter: (() => void) | null = null;
  private readonly log: Logger;
  private readonly startedAt = monotonicNow();
  private readonly eventCounts = new Map<string, number>();
  private summaryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly opts: StartOptions,
    previous: CopilotState | null,
  ) {
    this.config = opts.config;
    // Continue the visible history from an earlier session in this browser session.
    this.state = previous ? { ...settleGenerating(previous), ended: false, lastNotice: null } : initialCopilotState();
    this.status = { phase: 'starting', mode: opts.mode, tabId: opts.tabId, tabTitle: opts.tabTitle, startedAt: Date.now(), message: null };
    // sid correlates extension and server logs (the server logs the same id from audio.start).
    this.log = extensionLog.child('session', { sid: this.sessionId });
  }

  snapshot(): CopilotState {
    return this.state;
  }

  private setStatus(patch: Partial<SessionStatus>): void {
    this.status = { ...this.status, ...patch };
    void send({ type: 'copilot.status', status: this.status });
  }

  private apply(event: ServerEvent): void {
    this.eventCounts.set(event.type, (this.eventCounts.get(event.type) ?? 0) + 1);
    this.logEvent(event);
    this.state = reduceServerEvent(this.state, event);
    void send({ type: 'copilot.event', event });
    this.scheduleHistorySave();
  }

  /** Lifecycle events only; deltas and transcript text are never logged. */
  private logEvent(event: ServerEvent): void {
    switch (event.type) {
      case 'session.error':
        (event.fatal ? this.log.error : this.log.warn)('server_error', { code: event.code, fatal: event.fatal, err: event.message });
        break;
      case 'session.status':
        this.log.info('transcriber_status', { state: event.state });
        break;
      case 'question.detected':
        this.log.debug('question_detected', { qid: event.question.id, speculative: event.question.speculative, source: event.question.source });
        break;
      case 'question.updated':
        this.log.debug('question_updated', { qid: event.questionId, status: event.status });
        break;
      case 'answer.start':
        this.log.debug('answer_started', { rid: event.requestId, qid: event.questionId, model: event.model });
        break;
      case 'answer.completed':
        this.log.info('answer_completed', { rid: event.requestId, first_token_ms: event.firstTokenMs, duration_ms: event.durationMs });
        break;
      case 'answer.error':
        this.log.warn('answer_failed', { rid: event.requestId, code: event.code, retryable: event.retryable, err: event.message });
        break;
      case 'answer.cancelled':
        this.log.debug('answer_cancelled', { rid: event.requestId, reason: event.reason });
        break;
      default:
        break;
    }
  }

  private scheduleHistorySave(): void {
    if (this.historyTimer) return;
    this.historyTimer = setTimeout(() => {
      this.historyTimer = null;
      void send({ type: 'copilot.history', state: this.state });
    }, 1_000);
  }

  /** Set when the server first accepted this session; used to continue the timeline after a reconnect. */
  private timelineStartedAt: number | null = null;

  private sendStart(isReconnect = false): void {
    // On reconnect the server starts a fresh session: tell it where the transcript timeline is and which
    // speaker numbers are already in use, so timestamps keep increasing and labels are never reused.
    const shown = this.state.segments.map((s) => s.speaker).filter((n): n is number => n !== undefined);
    const continuation =
      isReconnect && this.timelineStartedAt !== null
        ? { timelineOffsetMs: Math.max(0, Date.now() - this.timelineStartedAt), speakerOffset: shown.length ? Math.max(...shown) + 1 : 0 }
        : undefined;
    this.connection?.sendEvent({
      type: 'audio.start',
      sessionId: this.sessionId,
      mode: this.opts.mode,
      audio: { encoding: AUDIO_FORMAT.encoding, sampleRate: AUDIO_FORMAT.sampleRate, channels: AUDIO_FORMAT.channels },
      config: this.config,
      ...(continuation ? { continuation } : {}),
      ts: Date.now(),
    });
  }

  async start(): Promise<void> {
    this.log.info('start', { mode: this.opts.mode, server: new URL(this.opts.serverUrl).host });
    if (this.opts.mode === 'live' && !this.opts.streamId) throw new Error('No tab capture stream was provided.');
    const ready = new Promise<void>((resolve, reject) => {
      this.readyWaiter = { resolve, reject };
      setTimeout(() => reject(new Error('The server did not start the session in time.')), READY_TIMEOUT_MS);
    });

    this.connection = new ServerConnection(wsUrl(this.opts.serverUrl), this.log.child('ws', { sid: this.sessionId }), {
      onOpen: (isReconnect) => {
        this.sendStart(isReconnect);
        if (isReconnect) this.setStatus({ phase: 'live', message: 'Reconnected to the server (server-side context was reset).' });
      },
      onEvent: (event) => this.onServerEvent(event),
      onReconnecting: (attempt) => {
        this.state = settleGenerating(this.state);
        this.setStatus({ phase: 'reconnecting', message: `Connection to the server lost; reconnecting (attempt ${attempt})…` });
      },
      onClosed: (reason) => {
        this.readyWaiter?.reject(new Error(reason));
        void this.stop(reason);
      },
    });
    this.connection.connect();

    let stage = 'server_ready';
    try {
      await ready;
      this.log.info('ready', { duration_ms: elapsedMs(this.startedAt), stt: this.state.sttProvider, llm: this.state.llmModel });
      if (this.opts.mode === 'live' && this.opts.streamId) {
        stage = 'audio_capture';
        this.capture = new AudioCapture(this.log.child('audio-capture', { sid: this.sessionId }));
        await this.capture.start(this.opts.streamId, {
          onFrame: (frame) => this.connection?.sendAudio(frame),
          onEnded: (reason) => void this.stop(reason),
        });
      }
      this.setStatus({ phase: 'live', message: null });
      this.summaryTimer = setInterval(() => this.logSummary('traffic'), SUMMARY_INTERVAL_MS);
    } catch (err) {
      this.log.error('start_failed', { stage, err, duration_ms: elapsedMs(this.startedAt), recovery: 'session_stopped' });
      await this.stop((err as Error).message);
      throw err;
    }
  }

  private logSummary(event: string, level: 'debug' | 'info' = 'debug'): void {
    this.log[level](event, {
      uptime_s: Math.round(elapsedMs(this.startedAt) / 1000),
      audio_frames_sent: this.connection?.framesSent ?? 0,
      audio_frames_dropped: this.connection?.droppedFrames ?? 0,
      events: [...this.eventCounts.entries()].map(([k, v]) => `${k}:${v}`).join(','),
    });
  }

  private onServerEvent(event: ServerEvent): void {
    this.apply(event);
    if (event.type === 'session.ready') {
      this.timelineStartedAt ??= Date.now();
      this.readyWaiter?.resolve();
      this.readyWaiter = null;
    } else if (event.type === 'session.error' && event.fatal) {
      this.readyWaiter?.reject(new Error(event.message));
      this.readyWaiter = null;
      void this.stop(event.message);
    } else if (event.type === 'session.ended') {
      this.endedWaiter?.();
    }
  }

  command(command: UiCommand): boolean {
    if (command.type === 'config.update') this.config = command.config;
    const sent = this.connection?.sendEvent(command) ?? false;
    if (command.type !== 'answer.displayed') this.log.debug('command', { type: command.type, sent });
    if (!sent) this.log.warn('command_not_sent', { type: command.type, reason: 'not_connected' });
    return sent;
  }

  clearHistory(): void {
    this.state = { ...initialCopilotState(), sessionId: this.state.sessionId, sttProvider: this.state.sttProvider, sttSimulated: this.state.sttSimulated, llmProvider: this.state.llmProvider, llmModel: this.state.llmModel, llmSimulated: this.state.llmSimulated };
    void send({ type: 'copilot.history', state: this.state });
  }

  /** Stops capture and the server session and releases every resource. Safe to call repeatedly. */
  async stop(reason?: string): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.summaryTimer) clearInterval(this.summaryTimer);
    (reason ? this.log.warn : this.log.info)('stopping', { reason: reason ?? 'user' });
    this.setStatus({ phase: 'stopping', message: null });

    // 1. Stop audio first so nothing more is captured or sent.
    await this.capture?.stop();
    this.capture = null;

    // 2. Ask the server to finish (flushes the transcriber), waiting briefly for session.ended.
    if (this.connection?.isOpen) {
      const ended = new Promise<void>((resolve) => {
        this.endedWaiter = resolve;
        setTimeout(resolve, 1_500);
      });
      this.connection.sendEvent({ type: 'audio.stop', sessionId: this.sessionId, ts: Date.now() });
      await ended;
    }
    this.logSummary('stopped', 'info');
    this.connection?.close();
    this.connection = null;

    if (this.historyTimer) clearTimeout(this.historyTimer);
    this.historyTimer = null;
    this.state = { ...settleGenerating(this.state), ended: true };
    await send({ type: 'copilot.history', state: this.state });

    const isError = Boolean(reason);
    this.status = { ...this.status, phase: isError ? 'error' : 'idle', message: reason ?? null };
    await send({ type: 'copilot.status', status: this.status });
    this.stopped = true;
    await send({ type: 'copilot.ended' });
  }

  get isStopped(): boolean {
    return this.stopped;
  }
}

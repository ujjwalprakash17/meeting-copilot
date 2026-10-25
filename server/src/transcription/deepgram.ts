import WebSocket from 'ws';
import { AUDIO_FORMAT, elapsedMs, monotonicNow, type Logger } from '@meeting-copilot/shared';
import { log as rootLog } from '../logger.js';
import { parseDeepgramMessage } from './deepgramParser.js';
import type { SttCallbacks, SttProvider, SttStartOptions, SttStream } from './types.js';

const DEEPGRAM_URL = 'wss://api.deepgram.com/v1/listen';
const BYTES_PER_MS = (AUDIO_FORMAT.sampleRate * 2) / 1000;
const KEEPALIVE_INTERVAL_MS = 5_000;
const MAX_RECONNECTS = 5;
/** Audio queued while (re)connecting; older audio is dropped beyond this (~3 s). */
const MAX_PENDING_BYTES = 3_000 * BYTES_PER_MS;

export interface DeepgramOptions {
  apiKey: string | null;
  model: string;
  endpointingMs: number;
  utteranceEndMs: number;
  /** Override for tests. */
  url?: string;
}

export function buildDeepgramUrl(base: string, opts: DeepgramOptions, start: SttStartOptions): string {
  const params = new URLSearchParams({
    model: opts.model,
    language: start.language,
    encoding: AUDIO_FORMAT.encoding,
    sample_rate: String(AUDIO_FORMAT.sampleRate),
    channels: String(AUDIO_FORMAT.channels),
    interim_results: 'true',
    punctuate: 'true',
    smart_format: 'true',
    endpointing: String(opts.endpointingMs),
    utterance_end_ms: String(opts.utteranceEndMs),
    vad_events: 'true',
  });
  // Streaming diarization (v1 diarizer). `diarize=true` is deprecated; `diarize_model=latest` is the documented form.
  if (start.diarize) params.set('diarize_model', 'latest');
  // Keyterm prompting is supported by Nova-3 models only.
  if (opts.model.startsWith('nova-3')) for (const k of start.keywords.slice(0, 20)) params.append('keyterm', k);
  return `${base}?${params.toString()}`;
}

class DeepgramStream implements SttStream {
  private ws: WebSocket | null = null;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private reconnects = 0;
  private closed = false;
  private finishing = false;
  private keepAlive: NodeJS.Timeout | null = null;
  private lastAudioAt = 0;
  /** Audio already sent on previous connections, so timestamps stay monotonic across reconnects. */
  private sentBytesTotal = 0;
  private connectionOffsetMs = 0;
  /** Number of connections opened so far (1 = first); diarization speaker IDs restart with each one. */
  private connectionCount = 0;
  private readonly log: Logger;

  constructor(
    private readonly opts: DeepgramOptions & { apiKey: string },
    private readonly start: SttStartOptions,
    private readonly cb: SttCallbacks,
  ) {
    this.log = (start.log ?? rootLog).child('deepgram');
    this.connect();
    this.keepAlive = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN && Date.now() - this.lastAudioAt > KEEPALIVE_INTERVAL_MS) {
        this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  private connect(): void {
    this.connectionOffsetMs = this.sentBytesTotal / BYTES_PER_MS;
    this.connectionCount++;
    const t0 = monotonicNow();
    let openedAt = 0;
    const connection = this.connectionCount;
    this.log.info('connecting', { connection, model: this.opts.model, diarize: this.start.diarize, language: this.start.language });
    const ws = new WebSocket(buildDeepgramUrl(this.opts.url ?? DEEPGRAM_URL, this.opts, this.start), {
      headers: { Authorization: `Token ${this.opts.apiKey}` },
    });
    this.ws = ws;
    /** Set for client errors (bad key, bad parameters) that retrying cannot fix. */
    let authFailed = false;

    ws.on('unexpected-response', (_req, res) => {
      const status = res.statusCode ?? 0;
      const isAuth = status === 401 || status === 403;
      authFailed = status >= 400 && status < 500;
      this.log.error('http_error', {
        connection,
        status,
        auth: isAuth,
        provider_request_id: res.headers['dg-request-id'],
        duration_ms: elapsedMs(t0),
        recovery: authFailed ? 'no_retry_fix_configuration' : 'reconnect',
      });
      this.cb.onError({
        code: isAuth ? 'stt_auth_failed' : 'stt_error',
        message: isAuth
          ? 'Deepgram rejected the API key (check DEEPGRAM_API_KEY on the server).'
          : `Deepgram connection failed with HTTP ${status}.`,
        fatal: authFailed,
      });
      ws.terminate();
    });

    ws.on('upgrade', (res) => {
      this.log.debug('upgrade', { connection, provider_request_id: res.headers['dg-request-id'] });
    });

    ws.on('open', () => {
      openedAt = monotonicNow();
      this.log.info('connected', { connection, duration_ms: elapsedMs(t0), buffered_frames: this.pending.length });
      this.reconnects = 0;
      this.cb.onStatus('transcriber_connected', 'Connected to Deepgram');
      for (const chunk of this.pending) this.sendNow(chunk);
      this.pending = [];
      this.pendingBytes = 0;
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const parsed = parseDeepgramMessage(data.toString(), this.connectionOffsetMs);
      switch (parsed.kind) {
        case 'partial':
          this.cb.onPartial(parsed.partial);
          break;
        case 'finals':
          // Speaker numbers are per connection: tag them so the session never merges two connections' labels.
          for (const segment of parsed.segments) this.cb.onFinal({ ...segment, speakerScope: this.connectionCount });
          if (parsed.speechFinal) this.cb.onUtteranceEnd();
          break;
        case 'utterance_end':
          this.cb.onUtteranceEnd();
          break;
        case 'error':
          this.log.warn('provider_error', { connection, err: parsed.message, recovery: 'stream_continues' });
          this.cb.onError({ code: 'stt_error', message: `Deepgram: ${parsed.message}`, fatal: false });
          break;
        case 'ignore':
          break;
      }
    });

    ws.on('error', (err) => {
      this.log.warn('socket_error', { connection, err });
    });

    ws.on('close', (code, reasonBuf) => {
      if (this.ws !== ws) return;
      this.ws = null;
      const fields = { connection, code, reason: reasonBuf?.toString() || undefined, open_ms: openedAt ? elapsedMs(openedAt) : 0, audio_s: Math.round(this.sentBytesTotal / BYTES_PER_MS / 1000) };
      if (this.closed || this.finishing || authFailed) {
        this.log.info('closed', fields);
        this.cb.onStatus('transcriber_closed', 'Transcriber closed');
        return;
      }
      if (this.reconnects >= MAX_RECONNECTS) {
        this.log.error('reconnect_gave_up', { ...fields, attempts: this.reconnects, recovery: 'session_error_fatal' });
        this.cb.onError({ code: 'stt_error', message: `Lost connection to Deepgram (code ${code}); giving up after ${MAX_RECONNECTS} retries.`, fatal: true });
        this.cb.onStatus('transcriber_closed', 'Transcriber closed');
        return;
      }
      this.reconnects++;
      const delay = Math.min(8_000, 500 * 2 ** (this.reconnects - 1));
      this.log.warn('websocket_reconnecting', { ...fields, attempt: this.reconnects, delay_ms: delay, buffered_ms: Math.round(this.pendingBytes / BYTES_PER_MS) });
      this.cb.onStatus('transcriber_reconnecting', `Reconnecting to Deepgram (attempt ${this.reconnects})`);
      setTimeout(() => {
        if (!this.closed) this.connect();
      }, delay);
    });
  }

  private sendNow(chunk: Buffer): void {
    this.ws?.send(chunk);
    this.sentBytesTotal += chunk.length;
    this.lastAudioAt = Date.now();
  }

  sendAudio(pcm: Buffer): void {
    if (this.closed || this.finishing) return;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendNow(pcm);
      return;
    }
    this.pending.push(pcm);
    this.pendingBytes += pcm.length;
    while (this.pendingBytes > MAX_PENDING_BYTES && this.pending.length > 1) {
      const dropped = this.pending.shift();
      this.pendingBytes -= dropped?.length ?? 0;
      // Dropped audio still advances the timeline so later timestamps stay aligned.
      this.sentBytesTotal += dropped?.length ?? 0;
    }
  }

  async finish(): Promise<void> {
    if (this.closed || this.finishing) return;
    this.finishing = true;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.close();
      return;
    }
    ws.send(JSON.stringify({ type: 'CloseStream' }));
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3_000);
      ws.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.pending = [];
    const ws = this.ws;
    this.ws = null;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.terminate();
  }
}

export class DeepgramProvider implements SttProvider {
  readonly name = 'deepgram';
  readonly simulated = false;

  constructor(private readonly opts: DeepgramOptions) {}

  isConfigured(): boolean {
    return Boolean(this.opts.apiKey);
  }

  start(options: SttStartOptions, callbacks: SttCallbacks): SttStream {
    if (!this.opts.apiKey) throw new Error('DEEPGRAM_API_KEY is not configured');
    return new DeepgramStream({ ...this.opts, apiKey: this.opts.apiKey }, options, callbacks);
  }
}

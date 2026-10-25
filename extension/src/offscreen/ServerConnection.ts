/** WebSocket client for the local server with bounded reconnection. */
import { elapsedMs, monotonicNow, parseServerEvent, type ClientEvent, type Logger, type ServerEvent } from '@meeting-copilot/shared';

export interface ConnectionCallbacks {
  onOpen(isReconnect: boolean): void;
  onEvent(event: ServerEvent): void;
  onReconnecting(attempt: number): void;
  /** Gave up (or the server refused the connection). */
  onClosed(reason: string): void;
}

const MAX_RECONNECTS = 5;
/** Drop audio rather than queue it if the socket is backed up (~2 s of audio). */
const MAX_BUFFERED_BYTES = 64 * 1024;

export class ServerConnection {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private closedByUser = false;
  private everOpened = false;
  private openedAt = 0;
  framesSent = 0;
  droppedFrames = 0;

  constructor(
    private readonly url: string,
    private readonly log: Logger,
    private readonly cb: ConnectionCallbacks,
  ) {}

  connect(): void {
    const t0 = monotonicNow();
    const host = new URL(this.url).host;
    this.log.debug('connecting', { host, attempt: this.attempts });
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      const isReconnect = this.everOpened;
      this.everOpened = true;
      this.attempts = 0;
      this.openedAt = monotonicNow();
      this.log.info('connected', { host, duration_ms: elapsedMs(t0), reconnect: isReconnect });
      this.cb.onOpen(isReconnect);
    };
    ws.onmessage = (e: MessageEvent) => {
      if (typeof e.data !== 'string') return;
      const parsed = parseServerEvent(e.data);
      if (parsed.ok) this.cb.onEvent(parsed.value);
      else this.log.warn('invalid_server_event', { err: parsed.error, recovery: 'ignored' });
    };
    // Browsers expose no details on WebSocket error events; the close event that follows has the code.
    ws.onerror = () => this.log.debug('socket_error', { host, opened });
    ws.onclose = (e: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      const fields = { host, code: e.code, reason: e.reason || undefined, clean: e.wasClean, open_ms: opened ? elapsedMs(this.openedAt) : 0 };
      if (this.closedByUser) {
        this.log.info('closed', fields);
        return;
      }
      if (!this.everOpened && !opened) {
        this.log.error('connect_failed', { ...fields, duration_ms: elapsedMs(t0), recovery: 'session_stopped' });
        return this.cb.onClosed(`Cannot connect to the Meeting Copilot server at ${this.url}. Start it with "npm run dev:server" and check the server URL in Settings.`);
      }
      if (e.code === 1008 || e.code === 1009) {
        this.log.error('closed_by_server', { ...fields, recovery: 'session_stopped' });
        return this.cb.onClosed(`The server closed the connection (${e.reason || `code ${e.code}`}).`);
      }
      if (this.attempts >= MAX_RECONNECTS) {
        this.log.error('reconnect_gave_up', { ...fields, attempts: this.attempts, recovery: 'session_stopped' });
        return this.cb.onClosed('Lost connection to the Meeting Copilot server.');
      }
      this.attempts++;
      const delay = Math.min(8_000, 500 * 2 ** (this.attempts - 1));
      this.log.warn('reconnecting', { ...fields, attempt: this.attempts, delay_ms: delay });
      this.cb.onReconnecting(this.attempts);
      setTimeout(() => !this.closedByUser && this.connect(), delay);
    };
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  sendEvent(event: ClientEvent): boolean {
    if (!this.isOpen) return false;
    this.ws?.send(JSON.stringify(event));
    return true;
  }

  sendAudio(frame: ArrayBuffer): void {
    if (!this.ws || !this.isOpen || this.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      // Logged as a running count in the session summary, not per frame.
      if (this.droppedFrames++ === 0) this.log.warn('audio_frames_dropping', { reason: this.isOpen ? 'socket_backlog' : 'not_connected' });
      return;
    }
    this.ws.send(frame);
    this.framesSent++;
  }

  close(): void {
    this.closedByUser = true;
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, 'Session stopped');
    this.log.info('closed', { code: 1000, reason: 'session_stopped', frames_sent: this.framesSent, frames_dropped: this.droppedFrames });
  }
}

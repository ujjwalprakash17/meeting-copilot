/**
 * Connection failures, reconnection, server-initiated closes and malformed server events: each must
 * reach the UI through the callbacks and leave a searchable log line.
 */
import { createLogger } from '@meeting-copilot/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerConnection, type ConnectionCallbacks } from './ServerConnection';

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  binaryType = 'blob';
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  drop(code = 1006, reason = '') {
    this.readyState = 3;
    this.onerror?.();
    this.onclose?.({ code, reason, wasClean: false });
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
}

const latest = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1] as FakeWebSocket;

function setup() {
  const lines: string[] = [];
  const log = createLogger('ws', { level: () => 'debug', sink: (_l, line) => lines.push(line) }, { sid: 's-1' });
  const calls: string[] = [];
  const cb: ConnectionCallbacks = {
    onOpen: (re) => calls.push(`open:${re}`),
    onEvent: (e) => calls.push(`event:${e.type}`),
    onReconnecting: (n) => calls.push(`reconnecting:${n}`),
    onClosed: (reason) => calls.push(`closed:${reason}`),
  };
  const conn = new ServerConnection('ws://localhost:8790/ws?token=abc123secret', log, cb);
  return { conn, lines, calls };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ServerConnection', () => {
  it('reports a server that is not running to the UI with a fix, and logs connect_failed', () => {
    const { conn, lines, calls } = setup();
    conn.connect();
    latest().drop(1006);
    expect(calls).toEqual([expect.stringMatching(/^closed:Cannot connect to the Meeting Copilot server at .*npm run dev:server/)]);
    const line = lines.find((l) => l.includes('connect_failed')) ?? '';
    expect(line).toMatch(/\[ERROR\] \[ws\] connect_failed sid=s-1 host=localhost:8790 code=1006 .*recovery=session_stopped/);
    expect(lines.join('\n')).not.toContain('abc123secret'); // only the host is logged, never the query string
  });

  it('reconnects with backoff after an unexpected drop and logs each attempt', () => {
    const { conn, lines, calls } = setup();
    conn.connect();
    latest().open();
    latest().drop(1006);
    expect(calls).toEqual(['open:false', 'reconnecting:1']);
    expect(lines.some((l) => /\[WARN\] \[ws\] reconnecting .*code=1006 .*attempt=1 delay_ms=500/.test(l))).toBe(true);
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    latest().open();
    expect(calls).toEqual(['open:false', 'reconnecting:1', 'open:true']);
    expect(lines.some((l) => /\[INFO\] \[ws\] connected .*reconnect=true/.test(l))).toBe(true);
  });

  it('gives up after the bounded number of reconnects and tells the UI', () => {
    const { conn, lines, calls } = setup();
    conn.connect();
    latest().open();
    for (let i = 0; i < 6; i++) {
      latest().drop(1006);
      vi.advanceTimersByTime(10_000);
    }
    expect(calls.at(-1)).toBe('closed:Lost connection to the Meeting Copilot server.');
    expect(lines.filter((l) => l.includes('reconnecting'))).toHaveLength(5);
    expect(lines.some((l) => /\[ERROR\] \[ws\] reconnect_gave_up .*attempts=5 recovery=session_stopped/.test(l))).toBe(true);
  });

  it('does not reconnect when the server rejects the client (policy violation)', () => {
    const { conn, lines, calls } = setup();
    conn.connect();
    latest().open();
    latest().drop(1008, 'Origin not allowed');
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(calls.at(-1)).toBe('closed:The server closed the connection (Origin not allowed).');
    expect(lines.some((l) => /\[ERROR\] \[ws\] closed_by_server .*code=1008/.test(l))).toBe(true);
  });

  it('ignores malformed server events with a warning instead of crashing the session', () => {
    const { conn, lines, calls } = setup();
    conn.connect();
    latest().open();
    latest().onmessage?.({ data: '{"type":"answer.delta","text":"Private answer text"}' });
    latest().onmessage?.({ data: 'not json' });
    latest().onmessage?.({ data: JSON.stringify({ type: 'session.error', code: 'bad_message', message: 'Unrecognized message.', fatal: false, ts: 1 }) });
    expect(calls).toEqual(['open:false', 'event:session.error']); // valid server errors still reach the UI
    expect(lines.filter((l) => l.includes('[WARN] [ws] invalid_server_event'))).toHaveLength(2);
    expect(lines.join('\n')).not.toContain('Private answer text');
  });

  it('logs dropped audio once rather than per frame, and closes quietly when the user stops', () => {
    const { conn, lines } = setup();
    conn.connect();
    for (let i = 0; i < 50; i++) conn.sendAudio(new ArrayBuffer(1280));
    latest().open();
    conn.sendAudio(new ArrayBuffer(1280));
    conn.close();
    latest().drop(1000);
    expect(lines.filter((l) => l.includes('audio_frames_dropping'))).toHaveLength(1);
    expect(lines.find((l) => l.includes('[INFO] [ws] closed')) ?? '').toContain('frames_sent=1 frames_dropped=50');
    expect(lines.some((l) => l.includes('reconnecting'))).toBe(false);
  });
});

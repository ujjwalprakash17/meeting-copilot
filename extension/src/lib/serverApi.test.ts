/** REST failures: the UI gets an actionable ApiError and the console gets one searchable line. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, fetchServerStatus, listConversations } from './serverApi';

// Signed-out user: no Authorization header (auth itself is covered by the server tests).
vi.mock('./auth.js', () => ({ getAccessToken: async () => null }));

let lines: string[];
beforeEach(() => {
  lines = [];
  for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((line: string) => void lines.push(line));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const caught = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as ApiError);

describe('serverApi request errors', () => {
  it('reports an unreachable server with what to check, logged as ERROR network', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const err = await caught(fetchServerStatus('http://localhost:8790'));
    expect(err).toBeInstanceOf(ApiError);
    expect(err?.code).toBe('network');
    expect(err?.message).toBe('Cannot reach the Meeting Copilot server at http://localhost:8790. Check your connection and the server URL in Settings.');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/\[ERROR\] \[server-api\] request_failed op="GET \/api\/status" kind=network .*err.name=TypeError/);
  });

  it('reports a server that does not answer in time as a timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: URL, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))),
    );
    const pending = caught(fetchServerStatus('http://localhost:8790'));
    await vi.advanceTimersByTimeAsync(5_000);
    const err = await pending;
    expect(err?.message).toBe('The server did not respond in time.');
    expect(lines[0]).toMatch(/\[ERROR\] \[server-api\] request_failed .*kind=timeout/);
  });

  it('passes the server error code and message to the UI and logs HTTP errors as WARN without query strings', async () => {
    const body = { error: { code: 'history_unavailable', message: 'History database unavailable: disk I/O error' } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 503 })));
    const err = await caught(listConversations('http://localhost:8790', 1234567890));
    expect(err?.code).toBe('history_unavailable');
    expect(err?.message).toBe('History database unavailable: disk I/O error');
    expect(lines[0]).toMatch(/\[WARN\] \[server-api\] request_failed op="GET \/api\/history" status=503 code=history_unavailable/);
    expect(lines[0]).not.toContain('1234567890');
  });

  it('handles a non-JSON error body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 })));
    const err = await caught(fetchServerStatus('http://localhost:8790'));
    expect(err?.code).toBe('http_502');
    expect(err?.message).toBe('Server returned HTTP 502');
  });
});

describe('serverApi auth', () => {
  it('sends the signed-in user\u2019s access token as a bearer token', async () => {
    vi.resetModules();
    vi.doMock('./auth.js', () => ({ getAccessToken: async () => 'tok-123' }));
    const api = await import('./serverApi');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ conversations: [], dbPath: null }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.listConversations('https://copilot.example');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tok-123');
    vi.doUnmock('./auth.js');
  });
});

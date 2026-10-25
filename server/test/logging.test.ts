/**
 * Diagnostic logging regressions: the right event for each failure, correlation ids, and no secrets,
 * transcript, answer or resume text in the output.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { AnswerService } from '../src/answers/AnswerService.js';
import { HistoryWriter } from '../src/history/HistoryWriter.js';
import type { HistoryRepository } from '../src/history/types.js';
import { LlmError, type LlmProvider } from '../src/llm/types.js';
import { captureLogs, log } from '../src/logger.js';
import { DeepgramProvider } from '../src/transcription/deepgram.js';
import { SAMPLE_RESUME } from './fixtures.js';
import { connect, ofType, startApp } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const capture = () => {
  const c = captureLogs('debug');
  cleanup.push(() => c.restore());
  return c;
};
const FAKE_GROQ_KEY = 'gsk_THISISAFAKEKEYFORTESTS0123456789abcdef';

function failingLlm(error: LlmError): LlmProvider {
  return {
    name: 'groq',
    model: 'openai/gpt-oss-120b',
    simulated: false,
    isConfigured: () => true,
    status: () => ({ provider: 'groq', model: 'm', configured: true, simulated: false, verified: true, message: '' }),
    // eslint-disable-next-line require-yield
    async *stream() {
      throw error;
    },
  };
}

const job = (rid: string) => ({
  requestId: rid,
  questionId: 'q-1',
  messages: [{ role: 'user' as const, content: 'Tell me about your payment project at Northwind' }],
  context: { transcriptSegments: 1, includesBackground: false, includesNotes: false, includesPreviousQa: false, promptChars: 40 },
  grounding: { kind: 'general' as const, evidence: 'not_needed' as const, excerptCount: 0, sections: [] },
});

describe('provider error logging', () => {
  it('logs a Groq rate limit as WARN with safe metadata and the session id', async () => {
    const c = capture();
    const svc = new AnswerService(failingLlm(new LlmError('rate_limited', 'Groq rate limit reached; retry in ~7 s.', true, 7000, { status: 429, providerRequestId: 'req_abc123' })), () => undefined, {
      timeoutMs: 5000,
      maxTokens: 100,
      log: log.child('session', { sid: 'sess-42' }),
    });
    await svc.generate(job('r-1'));
    const line = c.lines.find((l) => l.includes('generation_failed')) ?? '';
    expect(line).toContain('[WARN] [groq] generation_failed');
    for (const part of ['sid=sess-42', 'rid=r-1', 'code=rate_limited', 'status=429', 'provider_request_id=req_abc123', 'retryable=true', 'retry_after_ms=7000', 'recovery=user_can_retry']) {
      expect(line).toContain(part);
    }
    expect(c.lines.join('\n')).not.toContain('Northwind'); // prompt content is never logged
  });

  it('logs invalid credentials as ERROR and never prints the key, even if it appears in the message', async () => {
    const c = capture();
    const svc = new AnswerService(failingLlm(new LlmError('invalid_credentials', `Groq rejected the API key ${FAKE_GROQ_KEY}.`, false, undefined, { status: 401 })), () => undefined, { timeoutMs: 5000, maxTokens: 100 });
    await svc.generate(job('r-2'));
    const all = c.lines.join('\n');
    expect(all).toContain('[ERROR] [groq] generation_failed');
    expect(all).toContain('recovery=fix_configuration');
    expect(all).not.toContain(FAKE_GROQ_KEY);
    expect(all).toContain('[REDACTED]');
  });

  it('logs a Deepgram 401 as http_error without the Authorization header value', async () => {
    const wss = new WebSocketServer({ port: 0, verifyClient: (_info, cb) => cb(false, 401, 'Unauthorized') });
    cleanup.push(() => new Promise<void>((r) => wss.close(() => r())));
    await new Promise((r) => wss.once('listening', r));
    const port = (wss.address() as AddressInfo).port;
    const c = capture();
    const secret = '8399deadbeefdeadbeefdeadbeefdeadbeef4a1f';
    const provider = new DeepgramProvider({ apiKey: secret, model: 'nova-3', endpointingMs: 300, utteranceEndMs: 1000, url: `ws://127.0.0.1:${port}/v1/listen` });
    const errors: string[] = [];
    const stream = provider.start(
      { language: 'en', keywords: [], diarize: false, log: log.child('session', { sid: 'sess-7' }) },
      { onPartial: () => undefined, onFinal: () => undefined, onUtteranceEnd: () => undefined, onStatus: () => undefined, onError: (e) => errors.push(e.code) },
    );
    cleanup.push(() => stream.close());
    await new Promise((r) => setTimeout(r, 300));
    expect(errors).toEqual(['stt_auth_failed']);
    const all = c.lines.join('\n');
    expect(all).toMatch(/\[ERROR\] \[deepgram\] http_error .*sid=sess-7 .*status=401 auth=true/);
    expect(all).toContain('recovery=no_retry_fix_configuration');
    expect(all).not.toContain(secret);
  });
});

describe('history database logging', () => {
  it('logs write_failed with retry, then ERROR when the batch is dropped', async () => {
    const c = capture();
    const repo: HistoryRepository = {
      applyBatch: async () => {
        throw new Error('SQLITE_FULL: database or disk is full');
      },
      listConversations: async () => [],
      getConversation: async () => null,
      renameConversation: async () => false,
      deleteConversation: async () => false,
      deleteAll: async () => [],
      close: () => undefined,
    };
    const writer = new HistoryWriter(repo, { debounceMs: 0, retryDelayMs: 5 });
    const id = randomUUID();
    writer.enqueue({ kind: 'conversation', value: { id, at: 1, simulated: false } });
    await writer.flush();
    const lines = c.lines.filter((l) => l.includes('[history-db] write_failed'));
    expect(lines[0]).toContain('[WARN]');
    expect(lines[0]).toContain('recovery=retry_once');
    expect(lines[1]).toContain('[ERROR]');
    expect(lines[1]).toContain('recovery=batch_dropped_ui_notified');
    expect(lines[1]).toContain('err.message="SQLITE_FULL: database or disk is full"');
  });
});

describe('session and WebSocket logging', () => {
  it('correlates a session by cid and sid, logs invalid messages, and never logs transcript or resume text', async () => {
    const app = await startApp({ script: [{ text: 'What is the difference between TCP and UDP?', speechFinal: true, gapMs: 20 }], speed: 4 });
    cleanup.push(() => app.close());
    const c = capture();
    const conn = await connect(app.baseUrl);
    conn.ws.send('{"type":"nope"}');
    conn.start({ resume: { fileName: 'cv.txt', text: SAMPLE_RESUME } });
    await conn.waitFor((e) => ofType(e, 'answer.completed').length > 0);
    conn.ws.close();
    await new Promise((r) => setTimeout(r, 100));
    const all = c.lines.join('\n');
    expect(all).toMatch(/\[INFO\] \[ws\] connected cid=\w{8}/);
    expect(all).toMatch(/\[WARN\] \[ws\] invalid_message cid=\w{8} .*recovery=ignored/);
    expect(all).toMatch(/\[INFO\] \[session\] started cid=\w{8} sid=test mode=simulation/);
    expect(all).toMatch(/\[INFO\] \[mock\] generation_completed cid=\w{8} sid=test rid=r-[\w-]+ qid=q-[\w-]+ .*ttft_ms=\d+/);
    expect(all).toMatch(/\[INFO\] \[ws\] disconnected cid=\w{8} code=\d+/);
    for (const privateText of ['TCP and UDP', 'Northwind', 'alex.rivera', 'TEST MODE']) expect(all).not.toContain(privateText);
  });
});

/** Runs the real server entry point; explicit env values win over server/.env (dotenv never overrides). */
async function runServer(env: Record<string, string>): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(here, '../src/index.ts')], {
    cwd: path.join(here, '..'),
    env: { ...process.env, LLM_PROVIDER: 'mock', HISTORY_ENABLED: 'false', GROQ_API_KEY: '', DEEPGRAM_API_KEY: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const code = await new Promise<number | null>((r) => child.on('exit', r));
  return { code, output };
}

describe('process-level logging', () => {
  it('reports invalid configuration as config invalid, exits, and does not print configured keys', async () => {
    const { code, output } = await runServer({ PORT: '0', LLM_PROVIDER: 'openai', GROQ_API_KEY: FAKE_GROQ_KEY });
    expect(code).toBe(1);
    expect(output).toMatch(/\[ERROR\] \[config\] invalid .*err.message="Unsupported LLM_PROVIDER \\"openai\\" \(use groq or mock\)"/);
    expect(output).not.toContain(FAKE_GROQ_KEY);
  }, 20_000);

  it('rejects an unknown LOG_LEVEL instead of silently logging nothing', async () => {
    const { code, output } = await runServer({ PORT: '0', LOG_LEVEL: 'verbose' });
    expect(code).toBe(1);
    expect(output).toContain('[ERROR] [config] invalid err.name=Error err.message="LOG_LEVEL must be debug, info, warn or error (got \\"verbose\\")"');
  }, 20_000);

  it('reports a busy port as listen_failed and exits instead of crashing with a raw stack', async () => {
    const blocker: Server = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    cleanup.push(() => new Promise<void>((r) => blocker.close(() => r())));
    const port = (blocker.address() as AddressInfo).port;
    const { code, output } = await runServer({ PORT: String(port), HOST: '127.0.0.1' });
    expect(code).toBe(1);
    expect(output).toMatch(/\[ERROR\] \[server\] listen_failed .*port=\d+ .*err.code=EADDRINUSE/);
    expect(output).toContain('recovery=process_exit');
    expect(output).not.toContain('Emitted \'error\' event');
  }, 20_000);
});

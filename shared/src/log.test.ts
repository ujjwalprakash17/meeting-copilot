import { describe, expect, it } from 'vitest';
import { createLogger, redactText, sanitizeFields, type LogLevel } from './log.js';

const capture = (level: LogLevel = 'debug') => {
  const lines: Array<{ level: LogLevel; line: string }> = [];
  const log = createLogger('test', { sink: (l, line) => lines.push({ level: l, line }), level: () => level, now: () => new Date('2026-10-23T05:00:00.000Z') });
  return { log, lines };
};

describe('structured logger', () => {
  it('formats searchable lines with timestamp, level, component, event and fields', () => {
    const { log, lines } = capture('info');
    log.child('assistant-window', { sid: 'sess-1' }).warn('saved_position_rejected', { requested: '-1189,228,440x780', recovery: 'retry_default_position', ms: 12 });
    expect(lines[0]?.line).toBe(
      '2026-10-23T05:00:00.000Z [WARN] [assistant-window] saved_position_rejected sid=sess-1 requested=-1189,228,440x780 recovery=retry_default_position ms=12',
    );
  });

  it('filters by level and can follow a live setting', () => {
    let level: LogLevel = 'info';
    const lines: string[] = [];
    const log = createLogger('x', { sink: (_l, line) => lines.push(line), level: () => level });
    log.debug('hidden');
    level = 'debug';
    log.debug('shown');
    expect(lines.map((l) => l.split(' ')[3])).toEqual(['shown']);
  });

  it('never prints secrets, even in DEBUG', () => {
    const { log, lines } = capture('debug');
    log.debug('request', {
      apiKey: 'gsk_abcdefghijklmnopqrstuvwxyz0123456789',
      headers: { Authorization: 'Token 8399aaaabbbbccccddddeeeeffff000011112222', accept: 'json' },
      url: 'wss://api.deepgram.com/v1/listen?model=nova-3&keyterm=Kafka',
      note: 'sent with Bearer abcdefghijklmnop12345 and gsk_ZZZZZZZZZZZZZZZZ',
      err: new Error('401 Unauthorized for key gsk_secretsecretsecret'),
    });
    const line = lines[0]?.line ?? '';
    for (const secret of ['gsk_abc', 'gsk_secret', 'gsk_ZZZ', '8399aaaa', 'abcdefghijklmnop12345', 'keyterm=Kafka']) expect(line).not.toContain(secret);
    expect(line).toContain('apiKey=[REDACTED]');
    expect(line).toContain('headers.Authorization=[REDACTED]');
    expect(line).toContain('headers.accept=json');
    expect(line).toContain('url=wss://api.deepgram.com/v1/listen?[query]');
  });

  it('logs only the length of transcript, answer, question and resume content', () => {
    const f = sanitizeFields({ text: 'my private transcript', answer: 'secret answer', question: 'q?', resume: 'Alex Rivera, 2M tx', count: 3 });
    expect(f).toEqual({ text_chars: '21', answer_chars: '13', question_chars: '2', resume_chars: '18', count: '3' });
  });

  it('expands errors with name, code, status and a redacted stack for ERROR level', () => {
    const { log, lines } = capture('info');
    const err = Object.assign(new Error('Invalid value for bounds. Bounds must be at least 50% within visible screen space.'), { code: 'E_BOUNDS', status: 400 });
    log.error('create_failed', { err });
    const line = lines[0]?.line ?? '';
    expect(line).toContain('err.name=Error');
    expect(line).toContain('err.code=E_BOUNDS');
    expect(line).toContain('err.status=400');
    expect(line).toContain('err.message="Invalid value for bounds.');
    expect(line).toContain('err.stack=');
  });

  it('never throws, even for unserializable values', () => {
    const { log, lines } = capture();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => log.info('weird', { list: [cyclic], fn: () => 1 })).not.toThrow();
    expect(lines).toHaveLength(1);
  });

  it('redacts secrets in free text', () => {
    expect(redactText('GET https://api.groq.com/openai/v1/models?api_key=abc123 failed')).toBe('GET https://api.groq.com/openai/v1/models?[query] failed');
  });

  it('keeps random correlation ids but still redacts long opaque tokens', () => {
    const sid = 'sess-5f0c6d0e-8a6b-4c1e-9d7a-2b3c4d5e6f70'; // 41 chars, like the extension's session ids
    const { log, lines } = capture('info');
    log.with({ sid, qid: 'q-5f0c6d0e-8a6b-4c1e-9d7a-2b3c4d5e6f70-12' }).info('started');
    expect(lines[0]?.line).toContain(`sid=${sid} qid=q-5f0c6d0e-8a6b-4c1e-9d7a-2b3c4d5e6f70-12`);
    expect(redactText('token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9xyzabc123 here')).toBe('token [REDACTED] here');
    expect(redactText('id 5f0c6d0e8a6b4c1e9d7a2b3c4d5e6f70')).toBe('id [REDACTED]'); // bare hex keys are not uuids
  });

  it('prints token-count and time-to-first-token metrics, but never a token value', () => {
    expect(sanitizeFields({ max_tokens: 512, first_token_ms: 230, completion_tokens: 88 })).toEqual({ max_tokens: '512', first_token_ms: '230', completion_tokens: '88' });
    expect(sanitizeFields({ token: 'abc', access_token: 'xyz', tokens: 'a-string', session_token: 12345 })).toEqual({
      token: '[REDACTED]',
      access_token: '[REDACTED]',
      tokens: '[REDACTED]',
      session_token: '[REDACTED]',
    });
  });
});

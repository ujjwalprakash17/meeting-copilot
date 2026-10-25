/**
 * Structured diagnostic logging shared by the extension and the server.
 *
 * Line format (one line per event, searchable):
 *   2026-10-23T05:12:01.123Z [WARN] [assistant-window] saved_position_rejected sid=sess-1a2b requested=-1189,228,440x780 recovery=retry_default_position
 *
 * Privacy rules enforced here (callers cannot opt out):
 *  - secret-looking keys (key, token, secret, authorization, password, cookie, credential) are always redacted;
 *  - secret-looking values (gsk_…, "Token …", "Bearer …", long opaque strings) are redacted inside any string;
 *  - content keys (text, transcript, answer, question, delta, resume, notes, prompt, …) are replaced by their length;
 *  - URL query strings are dropped; long strings are truncated.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;
export type LogSink = (level: LogLevel, line: string) => void;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** Logger for a sub-component that shares sink, level and base fields. */
  child(component: string, base?: LogFields): Logger;
  /** Same component, extra fields on every line (e.g. a session id). */
  with(base: LogFields): Logger;
  enabled(level: LogLevel): boolean;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /(api[-_]?key|secret|token|authorization|auth[-_]?header|password|passwd|cookie|credential|bearer)/i;
/** LLM metrics such as max_tokens or first_token_ms: numbers under these names are counts or times, not secrets. */
const TOKEN_METRIC_KEY = /(^|_)tokens(_count)?$|_token_ms$/i;
const CONTENT_KEY = /^(text|transcript|answer|answers|question|questions|delta|resume|resumetext|notes|background|content|prompt|messages|utterance|excerpt|excerpts|segment)$/i;
const MAX_STRING = 300;

/** Redacts secrets inside free text (error messages, URLs, stack traces). */
export function redactText(input: string): string {
  return input
    .replace(/\bgsk_[A-Za-z0-9]{8,}/g, '[REDACTED]')
    .replace(/\b(Token|Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]')
    .replace(/([?&](?:api[-_]?key|key|token|access_token|auth)=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/(\b(?:wss?|https?):\/\/[^\s?"']+)\?[^\s"']*/gi, '$1?[query]')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[REDACTED]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, (m) => (CORRELATION_ID.test(m) ? m : '[REDACTED]'));
}

/** Random correlation ids such as "sess-<uuid>" carry no secret and must survive redaction. */
const CORRELATION_ID = /^(?:[A-Za-z]{1,10}-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-\d+)?$/i;

const truncate = (s: string, max = MAX_STRING) => (s.length > max ? `${s.slice(0, max)}…(${s.length} chars)` : s);

interface ErrorLike {
  name?: unknown;
  code?: unknown;
  status?: unknown;
  message?: unknown;
  stack?: unknown;
}

function errorFields(err: unknown, includeStack: boolean): LogFields {
  if (!err || typeof err !== 'object') return { 'err.message': redactText(truncate(String(err))) };
  const e = err as ErrorLike;
  const out: LogFields = {};
  if (e.name) out['err.name'] = String(e.name);
  if (e.code !== undefined) out['err.code'] = String(e.code);
  if (e.status !== undefined) out['err.status'] = String(e.status);
  if (e.message !== undefined) out['err.message'] = redactText(truncate(String(e.message)));
  if (includeStack && typeof e.stack === 'string') {
    // First frames only; stack text goes through the same redaction as messages.
    const frames = e.stack.split('\n').slice(1, 6).map((l) => l.trim()).join(' | ');
    if (frames) out['err.stack'] = redactText(truncate(frames, 600));
  }
  return out;
}

/** Converts arbitrary fields into safe, printable key=value strings. */
export function sanitizeFields(fields: LogFields, includeStack = false): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (key: string, value: unknown, depth: number): void => {
    if (value === undefined) return;
    if (SECRET_KEY.test(key) && !(typeof value === 'number' && TOKEN_METRIC_KEY.test(key))) {
      out[key] = '[REDACTED]';
      return;
    }
    if (CONTENT_KEY.test(key.split('.').pop() ?? key)) {
      out[`${key}_chars`] = typeof value === 'string' ? String(value.length) : Array.isArray(value) ? String(value.length) : '?';
      return;
    }
    if (key === 'err' || key === 'error' || value instanceof Error) {
      Object.assign(out, errorFields(value, includeStack));
      return;
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      out[key] = String(value);
      return;
    }
    if (typeof value === 'string') {
      out[key] = redactText(truncate(value));
      return;
    }
    if (typeof value === 'object' && depth < 2 && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) put(`${key}.${k}`, v, depth + 1);
      return;
    }
    let json: string;
    try {
      // JSON.stringify returns undefined for functions/symbols.
      json = JSON.stringify(value) ?? `[${typeof value}]`;
    } catch {
      json = '[unserializable]';
    }
    out[key] = redactText(truncate(json));
  };
  for (const [k, v] of Object.entries(fields)) put(k, v, 0);
  return out;
}

const quote = (v: string) => (/^[^\s"=]+$/.test(v) ? v : JSON.stringify(v));

export function formatLine(time: Date, level: LogLevel, component: string, event: string, fields: Record<string, string>): string {
  const parts = Object.entries(fields).map(([k, v]) => `${k}=${quote(v)}`);
  return `${time.toISOString()} [${level.toUpperCase()}] [${component}] ${event}${parts.length ? ` ${parts.join(' ')}` : ''}`;
}

export interface LoggerOptions {
  sink?: LogSink;
  /** Current minimum level (a function so it can follow a live setting). */
  level?: () => LogLevel;
  now?: () => Date;
}

// The shared package compiles without DOM/Node typings; both environments provide these globals.
const env = globalThis as unknown as {
  console: { log(s: string): void; warn(s: string): void; error(s: string): void };
  performance: { now(): number };
};

const consoleSink: LogSink = (level, line) => {
  if (level === 'error') env.console.error(line);
  else if (level === 'warn') env.console.warn(line);
  else env.console.log(line);
};

export function createLogger(component: string, opts: LoggerOptions = {}, base: LogFields = {}): Logger {
  const sink = opts.sink ?? consoleSink;
  const level = opts.level ?? (() => 'info');
  const now = opts.now ?? (() => new Date());
  const enabled = (l: LogLevel) => ORDER[l] >= ORDER[level()];
  const emit = (l: LogLevel, event: string, fields?: LogFields) => {
    if (!enabled(l)) return;
    let line: string;
    try {
      line = formatLine(now(), l, component, event, sanitizeFields({ ...base, ...fields }, l === 'error' || enabled('debug')));
    } catch {
      // Never drop the event: print it without fields rather than lose it.
      line = `${new Date().toISOString()} [${l.toUpperCase()}] [${component}] ${event} fields=[unavailable]`;
    }
    try {
      sink(l, line);
    } catch {
      // Logging must never break the caller.
    }
  };
  return {
    debug: (e, f) => emit('debug', e, f),
    info: (e, f) => emit('info', e, f),
    warn: (e, f) => emit('warn', e, f),
    error: (e, f) => emit('error', e, f),
    child: (c, b) => createLogger(c, opts, { ...base, ...b }),
    with: (b) => createLogger(component, opts, { ...base, ...b }),
    enabled,
  };
}

/** Milliseconds since `start` on a monotonic clock (performance.now), rounded. */
export const elapsedMs = (start: number): number => Math.round(env.performance.now() - start);

/** Monotonic timestamp for durations (pair with elapsedMs). */
export const monotonicNow = (): number => env.performance.now();

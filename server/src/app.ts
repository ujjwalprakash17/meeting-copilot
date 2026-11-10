import { randomUUID } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { elapsedMs, LIMITS, monotonicNow, parseClientEvent, type ApiErrorBody, type ClientEvent, type ServerEvent } from '@meeting-copilot/shared';
import type { ServerConfig } from './config.js';
import type { HistoryWriter } from './history/HistoryWriter.js';
import { historyRouter, type HistoryState } from './history/routes.js';
import { AuthRequiredError, bearerToken, type AuthenticatedUser, type UserDirectory } from './auth/UserDirectory.js';
import { CONFIRMED_PAGE } from './auth/pages.js';
import { generateInsight, MAX_INSIGHT_TRANSCRIPT_CHARS, type InsightKind } from './insights/insights.js';
import { latencyTracker, summarize, type LatencyTracker } from './latency/LatencyTracker.js';
import { LlmError, type LlmProvider } from './llm/types.js';
import { log } from './logger.js';

const httpLog = log.child('http');
const wsLog = log.child('ws');
import { MemoryStore } from './context/ConversationMemory.js';
import { ExtractionError, extractResume } from './resume/extract.js';
import { isAllowedOrigin } from './security/origin.js';
import { Session } from './session/Session.js';
import type { SttProvider } from './transcription/types.js';

export interface AppDeps {
  config: ServerConfig;
  liveStt: SttProvider;
  simulatedStt: SttProvider;
  llm: LlmProvider;
  /** Conversation history; null when disabled or the database could not be opened. */
  history?: HistoryWriter | null;
  historyError?: string | null;
  historyDbPath?: string | null;
  historyBackend?: 'sqlite' | 'supabase';
  /** Multi-user servers (HISTORY_BACKEND=supabase): verifies access tokens and hands out per-user history writers. */
  users?: UserDirectory | null;
  /** Public Supabase settings sent to the extension so it can sign users in. */
  supabase?: { url: string; publishableKey: string } | null;
  tracker?: LatencyTracker;
  /** Conversation memory shared by this server's connections; null disables it. Default: per CONTEXT_MEMORY. */
  memory?: MemoryStore | null;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_BAD_MESSAGES = 20;

const apiError = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ error: { code, message } } satisfies ApiErrorBody);

export function createApp(deps: AppDeps): { server: http.Server; wss: WebSocketServer } {
  const { config } = deps;
  // Off unless turned on. One store per server: an extension reconnect opens a new connection but resumes the same memory.
  const memory = deps.memory !== undefined ? deps.memory : config.contextMemory === true ? new MemoryStore() : null;
  const app = express();
  app.disable('x-powered-by');

  // CORS: only the extension origin may call the API. Disallowed origins get no CORS headers (and a 403).
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const isApi = req.path.startsWith('/api/');
    if (origin && isAllowedOrigin(origin, config)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-File-Name, X-Confirm-Delete-All');
      res.setHeader('Access-Control-Max-Age', '600');
    } else if (isApi && (origin || !config.allowNoOrigin)) {
      return apiError(res, 403, 'forbidden_origin', 'Requests are only accepted from the Meeting Copilot extension.');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Provider status (no secrets): lets the extension show what is configured.
  const users = deps.users ?? null;
  const authRequired = Boolean(config.authRequired && users);

  /** Verifies the request's bearer token (multi-user servers). */
  const authenticateRequest = async (req: Request): Promise<{ user: AuthenticatedUser; token: string }> => {
    if (!users) throw new AuthRequiredError('This server has no accounts.');
    const token = bearerToken(req.headers.authorization);
    return { user: await users.authenticate(token), token: token as string };
  };

  /** Paid endpoints (transcription, LLM) need a signed-in user when the server requires accounts. */
  const requireUser = async (req: Request, res: Response, next: NextFunction) => {
    if (!authRequired) return next();
    try {
      await authenticateRequest(req);
      next();
    } catch (err) {
      const e = err instanceof AuthRequiredError ? err : new AuthRequiredError();
      apiError(res, 401, e.code, e.message);
    }
  };

  const historyState: HistoryState = {
    writer: users ? null : (deps.history ?? null),
    error: deps.historyError ?? null,
    dbPath: deps.historyDbPath ?? null,
    backend: deps.historyBackend ?? 'sqlite',
    forRequest: users
      ? async (req) => {
          const { user, token } = await authenticateRequest(req);
          return users.writerFor(user, token);
        }
      : undefined,
  };
  app.use('/api/history', historyRouter(historyState));

  // Public sign-in settings for the extension (no secrets: the publishable key is meant to be public).
  app.get('/api/auth/config', (_req, res) => {
    res.json({
      backend: deps.historyBackend ?? 'sqlite',
      authRequired,
      supabaseUrl: deps.supabase?.url ?? null,
      supabasePublishableKey: deps.supabase?.publishableKey ?? null,
    });
  });
  app.get('/auth/confirmed', (_req, res) => res.type('html').send(CONFIRMED_PAGE));

  // Latency summary (timestamps only, no content). Real-provider and simulated runs are reported separately.
  app.get('/api/metrics/latency', (_req, res) => {
    const tracker = deps.tracker ?? latencyTracker;
    const flush = deps.history?.flushDurations ?? [];
    res.json({
      real: tracker.summary((t) => !t.simulated && t.provider !== 'none'),
      simulated: tracker.summary((t) => t.simulated),
      speculative: {
        started: tracker.all((t) => t.kind === 'speculative').length,
        rejected: tracker.all((t) => t.kind === 'speculative' && t.outcome === 'rejected').length,
      },
      historyFlushMs: summarize(flush),
    });
  });

  app.get('/api/status', (_req, res) => {
    res.json({
      history: { enabled: Boolean(deps.history || users), error: deps.historyError ?? null, backend: deps.historyBackend ?? 'sqlite' },
      authRequired,
      stt: { provider: deps.liveStt.name, configured: deps.liveStt.isConfigured() },
      llm: deps.llm.status(),
      detectionModel: deps.llm.classifyJson && config.llm.groqDetectionModel ? config.llm.groqDetectionModel : null,
    });
  });

  // Resume upload: raw body + X-File-Name header. The file stays in memory and is discarded after extraction.
  app.post(
    '/api/resume/extract',
    requireUser,
    express.raw({ type: () => true, limit: LIMITS.maxResumeFileBytes }),
    async (req: Request, res: Response) => {
      const fileName = decodeURIComponent(String(req.headers['x-file-name'] ?? 'resume')).slice(0, 255) || 'resume';
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      try {
        const result = await extractResume(body, fileName);
        log.child('resume').info('extracted', { kind: result.kind, text_length: result.chars, sections: result.sections.length });
        res.json(result);
      } catch (err) {
        if (err instanceof ExtractionError) {
          log.child('resume').warn('extract_rejected', { code: err.code, status: err.status, bytes: body.length });
          return apiError(res, err.status, err.code, err.message);
        }
        log.child('resume').error('extract_failed', { err, bytes: body.length });
        apiError(res, 500, 'internal', 'Unexpected error while reading the document.');
      }
    },
  );

  app.post('/api/insights', requireUser, express.json({ limit: '256kb' }), async (req: Request, res: Response) => {
    const kind = req.body?.kind as InsightKind;
    const transcript = req.body?.transcript;
    if (kind !== 'summary' && kind !== 'action_items') return apiError(res, 400, 'bad_request', 'kind must be summary or action_items');
    if (typeof transcript !== 'string' || !transcript.trim()) return apiError(res, 400, 'bad_request', 'The transcript is empty.');
    if (transcript.length > MAX_INSIGHT_TRANSCRIPT_CHARS * 2) return apiError(res, 413, 'too_large', 'Transcript too large.');
    try {
      const text = await generateInsight(deps.llm, kind, transcript, 45_000);
      res.json({ kind, text, model: deps.llm.model, simulated: deps.llm.simulated });
    } catch (err) {
      const e = err instanceof LlmError ? err : new LlmError('internal', (err as Error).message, true);
      const status = e.code === 'llm_not_configured' ? 503 : e.code === 'invalid_credentials' ? 502 : e.code === 'rate_limited' ? 429 : 502;
      apiError(res, status, e.code, e.message);
    }
  });

  // Local test page that plays audio in a normal tab (see README "Local audio test").
  app.use('/test', express.static(path.resolve(here, '../public')));

  app.use((err: Error & { type?: string; status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === 'entity.too.large') return apiError(res, 413, 'too_large', `File is too large (max ${LIMITS.maxResumeFileBytes / 1024 / 1024} MB).`);
    if (err.type === 'entity.parse.failed') return apiError(res, 400, 'bad_request', 'Malformed JSON body.');
    httpLog.error('unhandled_error', { status: err.status ?? 500, err });
    apiError(res, err.status ?? 500, 'internal', 'Internal server error');
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: LIMITS.maxMessageBytes,
    verifyClient: (info: { origin?: string }) => {
      const ok = isAllowedOrigin(info.origin || undefined, config);
      if (!ok) wsLog.warn('origin_rejected', { origin: info.origin ?? '(none)' });
      return ok;
    },
  });

  wss.on('connection', (ws: WebSocket) => {
    // cid identifies this socket; the session adds the extension's sid once audio.start arrives.
    const cid = randomUUID().slice(0, 8);
    const connLog = wsLog.with({ cid });
    const t0 = monotonicNow();
    connLog.info('connected', { clients: wss.clients.size });
    const send = (event: ServerEvent) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
    };
    // Multi-user servers attach the user's history once their token is verified (see handleText).
    const session = new Session(users ? { ...deps, memory, history: null } : { ...deps, memory }, send, log.child('session', { cid }));
    let badMessages = 0;
    let userId: string | null = null;
    // Text events are handled strictly in order, even when one waits for token verification.
    let chain: Promise<void> = Promise.resolve();

    const refuse = (message: string) => {
      connLog.warn('auth_refused', { reason: message });
      send({ type: 'session.error', code: 'auth_required', message, fatal: true, ts: Date.now() });
      ws.close(1008, 'Sign in required');
    };

    const handleText = async (event: ClientEvent) => {
      if (users && (event.type === 'audio.start' || event.type === 'auth.update')) {
        const token = event.accessToken;
        if (token) {
          try {
            const user = await users.authenticate(token);
            if (userId && user.userId !== userId) return refuse('A session cannot switch accounts. Stop and start again.');
            const writer = users.writerFor(user, token);
            if (!userId) {
              userId = user.userId;
              connLog.info('authenticated');
              session.attachHistory(writer);
            }
          } catch (err) {
            if (authRequired || event.type === 'auth.update') {
              return refuse(err instanceof AuthRequiredError ? err.message : 'Could not verify your sign-in.');
            }
          }
        } else if (authRequired && event.type === 'audio.start' && !userId) {
          return refuse(new AuthRequiredError().message);
        }
      }
      if (event.type === 'auth.update') return;
      session.handleEvent(event);
    };

    ws.on('message', (data: RawData, isBinary: boolean) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (isBinary) return session.handleAudio(buf);
      const parsed = parseClientEvent(buf.toString('utf8'));
      if (!parsed.ok) {
        badMessages++;
        connLog.warn('invalid_message', { err: parsed.error, count: badMessages, recovery: badMessages > MAX_BAD_MESSAGES ? 'closing_socket' : 'ignored' });
        send({ type: 'session.error', code: 'bad_message', message: parsed.error, fatal: false, ts: Date.now() });
        if (badMessages > MAX_BAD_MESSAGES) ws.close(1008, 'Too many invalid messages');
        return;
      }
      const event = parsed.value;
      chain = chain.then(() => handleText(event)).catch((err: unknown) => connLog.error('event_failed', { type: event.type, err }));
    });
    ws.on('close', (code, reason) => {
      connLog.info('disconnected', { code, reason: reason.toString() || undefined, duration_ms: elapsedMs(t0) });
      session.close();
    });
    ws.on('error', (err) => connLog.warn('socket_error', { err }));
  });

  return { server, wss };
}

/**
 * Conversation history REST API (same origin restrictions as the rest of /api).
 *   GET    /api/history                 list conversations, newest first (?limit, ?before=<updatedAt>)
 *   GET    /api/history/:id             one conversation with its cards
 *   PATCH  /api/history/:id             { title } rename (null/empty clears)
 *   DELETE /api/history/:id             delete one conversation and its cards
 *   DELETE /api/history                 delete everything; requires header X-Confirm-Delete-All: yes
 */
import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { UUID_RE, type ApiErrorBody } from '@meeting-copilot/shared';
import { log } from '../logger.js';

const apiLog = log.child('history-api');
import type { HistoryWriter } from './HistoryWriter.js';

const apiError = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ error: { code, message } } satisfies ApiErrorBody);

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.coerce.number().int().positive().optional(),
});
const RenameBody = z.object({ title: z.string().trim().max(120).nullable() });

export interface HistoryState {
  writer: HistoryWriter | null;
  /** Why history is unavailable (e.g. database could not be opened). */
  error: string | null;
  dbPath: string | null;
}

export function historyRouter(state: HistoryState): Router {
  const router = express.Router();

  router.use((_req, res, next) => {
    if (!state.writer) return apiError(res, 503, 'history_unavailable', state.error ?? 'Conversation history is disabled on the server.');
    next();
  });

  const idParam = (req: Request, res: Response): string | null => {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) {
      apiError(res, 400, 'bad_request', 'Invalid conversation id.');
      return null;
    }
    return id.toLowerCase();
  };

  const run = (fn: (req: Request, res: Response, writer: HistoryWriter) => Promise<unknown>) => async (req: Request, res: Response) => {
    try {
      // Reads include anything still queued, so the list reflects the latest answers.
      await fn(req, res, state.writer as HistoryWriter);
    } catch (err) {
      apiLog.error('request_failed', { method: req.method, route: req.route?.path ?? req.path.replace(/[0-9a-f-]{36}/gi, ':id'), err });
      apiError(res, 500, 'history_error', `History database error: ${(err as Error).message}`);
    }
  };

  router.get(
    '/',
    run(async (req, res, writer) => {
      const q = ListQuery.safeParse(req.query);
      if (!q.success) return apiError(res, 400, 'bad_request', 'Invalid list parameters.');
      await writer.flush();
      res.json({ conversations: await writer.repository.listConversations(q.data), dbPath: state.dbPath });
    }),
  );

  router.get(
    '/:id',
    run(async (req, res, writer) => {
      const id = idParam(req, res);
      if (!id) return;
      await writer.flush();
      const found = await writer.repository.getConversation(id);
      if (!found) return apiError(res, 404, 'not_found', 'Conversation not found.');
      res.json(found);
    }),
  );

  router.patch(
    '/:id',
    express.json({ limit: '4kb' }),
    run(async (req, res, writer) => {
      const id = idParam(req, res);
      if (!id) return;
      const body = RenameBody.safeParse(req.body);
      if (!body.success) return apiError(res, 400, 'bad_request', 'Title must be a string of at most 120 characters, or null.');
      await writer.flush();
      const ok = await writer.repository.renameConversation(id, body.data.title || null);
      if (!ok) return apiError(res, 404, 'not_found', 'Conversation not found.');
      res.json({ ok: true });
    }),
  );

  router.delete(
    '/:id',
    run(async (req, res, writer) => {
      const id = idParam(req, res);
      if (!id) return;
      const deleted = await writer.deleteConversation(id);
      if (!deleted) return apiError(res, 404, 'not_found', 'Conversation not found.');
      apiLog.info('conversation_deleted');
      res.json({ ok: true });
    }),
  );

  router.delete(
    '/',
    run(async (req, res, writer) => {
      if (String(req.headers['x-confirm-delete-all'] ?? '').toLowerCase() !== 'yes') {
        return apiError(res, 400, 'confirmation_required', 'Send header X-Confirm-Delete-All: yes to delete all history.');
      }
      const count = await writer.deleteAll();
      apiLog.info('all_deleted', { conversations: count });
      res.json({ ok: true, deleted: count });
    }),
  );

  return router;
}

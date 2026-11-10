/**
 * Account API for the Supabase history backend (same origin restrictions as the rest of /api).
 *   GET  /api/account            who is signed in (never returns tokens)
 *   POST /api/account/sign-in    { email, password }
 *   POST /api/account/sign-up    { email, password }  → may require email confirmation
 *   POST /api/account/sign-out
 * Passwords go straight to Supabase Auth; this server never stores them. Only the session (access/refresh
 * token) is kept, in the local session file, so history keeps working after a restart.
 */
import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import type { ApiErrorBody } from '@meeting-copilot/shared';
import { log } from '../logger.js';
import type { HistoryWriter } from '../history/HistoryWriter.js';
import { AccountError, type SupabaseAccount } from './SupabaseAccount.js';

const accountLog = log.child('account-api');

const apiError = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ error: { code, message } } satisfies ApiErrorBody);

const Credentials = z.object({ email: z.string().trim().toLowerCase().max(254), password: z.string().max(72) });

export interface AccountState {
  account: SupabaseAccount | null;
  /** Flushed before sign-out so queued history is written under the account that produced it. */
  writer: HistoryWriter | null;
  /** Page users land on after clicking the email confirmation link. */
  confirmRedirectUrl?: string;
}

export function accountRouter(state: AccountState): Router {
  const router = express.Router();

  router.get('/', async (_req, res) => {
    if (!state.account) return res.json({ backend: 'sqlite', configured: false, signedIn: false, email: null, userId: null, projectUrl: null });
    res.json(await state.account.status());
  });

  const withAccount =
    (fn: (req: Request, res: Response, account: SupabaseAccount) => Promise<unknown>) => async (req: Request, res: Response) => {
      if (!state.account) return apiError(res, 409, 'not_supabase', 'Accounts are only used when HISTORY_BACKEND=supabase.');
      try {
        await fn(req, res, state.account);
      } catch (err) {
        if (err instanceof AccountError) return apiError(res, err.status, err.code, err.message);
        accountLog.error('request_failed', { path: req.path, err });
        apiError(res, 502, 'account_error', `Could not reach Supabase: ${(err as Error).message}`);
      }
    };

  const credentials = (req: Request, res: Response) => {
    const body = Credentials.safeParse(req.body);
    if (!body.success) {
      apiError(res, 400, 'bad_request', 'Send { email, password }.');
      return null;
    }
    return body.data;
  };

  router.post(
    '/sign-in',
    express.json({ limit: '4kb' }),
    withAccount(async (req, res, account) => {
      const c = credentials(req, res);
      if (!c) return;
      await state.writer?.flush();
      res.json(await account.signIn(c.email, c.password));
    }),
  );

  router.post(
    '/sign-up',
    express.json({ limit: '4kb' }),
    withAccount(async (req, res, account) => {
      const c = credentials(req, res);
      if (!c) return;
      res.json(await account.signUp(c.email, c.password, state.confirmRedirectUrl));
    }),
  );

  router.post(
    '/sign-out',
    withAccount(async (_req, res, account) => {
      await state.writer?.flush();
      res.json(await account.signOut());
    }),
  );

  return router;
}

/** Shown after the user opens the confirmation link from the sign-up email. */
export const CONFIRMED_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Email confirmed · Meeting Copilot</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}}</style></head><body><h1>Email confirmed</h1>
<p>Your Meeting Copilot account is ready. Go back to the extension, open <b>Settings → Account</b> and sign in.</p>
<p>If this page shows an error from Supabase instead, the link expired: sign up again to get a new one.</p></body></html>`;

/**
 * The signed-in Supabase user for this server.
 *
 * Each person runs their own Meeting Copilot server, so the server holds exactly one Supabase session: the
 * user signs in from the extension (Settings → Account), the server keeps the session in a local file and
 * refreshes it automatically. All database calls use the publishable key plus this user's access token, so
 * Postgres Row Level Security limits every query to that user's rows. No service-role key is ever needed.
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AccountStatus } from '@meeting-copilot/shared';
import { log } from '../logger.js';

export type { AccountStatus };

const authLog = log.child('account');

export class AuthRequiredError extends Error {
  readonly code = 'auth_required';
  constructor(message = 'Sign in to your Meeting Copilot account (Settings → Account) to save and view history.') {
    super(message);
  }
}

export class AccountError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}


export interface SupabaseAccountOptions {
  url: string;
  publishableKey: string;
  /** File for the persisted session; ':memory:' keeps it in memory only (tests). */
  sessionPath: string;
}

/** Minimal synchronous key/value store backed by one JSON file (owner-only permissions where supported). */
class FileStorage {
  private data: Record<string, string> = {};
  constructor(private readonly file: string) {
    if (file === ':memory:') return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') this.data = parsed as Record<string, string>;
    } catch {
      this.data = {};
    }
  }
  getItem(key: string): string | null {
    return this.data[key] ?? null;
  }
  setItem(key: string, value: string): void {
    this.data[key] = value;
    this.save();
  }
  removeItem(key: string): void {
    delete this.data[key];
    this.save();
  }
  private save(): void {
    if (this.file === ':memory:') return;
    if (Object.keys(this.data).length === 0) {
      rmSync(this.file, { force: true });
      return;
    }
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 });
    try {
      chmodSync(this.file, 0o600);
    } catch {
      /* not supported on every file system (e.g. Windows) */
    }
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class SupabaseAccount {
  readonly client: SupabaseClient;
  private readonly ready: Promise<void>;

  constructor(readonly options: SupabaseAccountOptions) {
    this.client = createClient(options.url, options.publishableKey, {
      auth: {
        storage: new FileStorage(options.sessionPath),
        storageKey: 'meeting-copilot-auth',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    });
    this.ready = this.client.auth
      .getSession()
      .then(({ data, error }) => {
        if (error) authLog.warn('session_restore_failed', { err: error, recovery: 'sign_in_again' });
        else if (data.session) authLog.info('session_restored');
      })
      .catch((err: unknown) => authLog.warn('session_restore_failed', { err, recovery: 'sign_in_again' }));
  }

  /** The current user's ID; throws AuthRequiredError when nobody is signed in (or the session expired). */
  async requireUserId(): Promise<string> {
    await this.ready;
    const { data, error } = await this.client.auth.getSession();
    if (error || !data.session) throw new AuthRequiredError();
    return data.session.user.id;
  }

  async status(): Promise<AccountStatus> {
    await this.ready;
    const { data } = await this.client.auth.getSession();
    const user = data.session?.user ?? null;
    return { backend: 'supabase', configured: true, signedIn: Boolean(user), email: user?.email ?? null, userId: user?.id ?? null, projectUrl: this.options.url };
  }

  private static validate(email: string, password: string): void {
    if (!EMAIL_RE.test(email) || email.length > 254) throw new AccountError('bad_request', 'Enter a valid email address.');
    if (password.length < 8 || password.length > 72) throw new AccountError('bad_request', 'Password must be 8–72 characters.');
  }

  async signIn(email: string, password: string): Promise<AccountStatus> {
    SupabaseAccount.validate(email, password);
    await this.ready;
    const { error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) {
      authLog.warn('sign_in_failed', { code: error.code ?? error.status });
      const unconfirmed = error.code === 'email_not_confirmed';
      throw new AccountError(
        error.code ?? 'sign_in_failed',
        unconfirmed ? 'Confirm your email first: open the link Supabase sent you, then sign in.' : error.message,
        unconfirmed ? 403 : 401,
      );
    }
    authLog.info('signed_in');
    return this.status();
  }

  /** Creates an account. When email confirmation is on, the user must open the emailed link before signing in. */
  async signUp(email: string, password: string, emailRedirectTo?: string): Promise<AccountStatus & { needsConfirmation: boolean }> {
    SupabaseAccount.validate(email, password);
    await this.ready;
    const { data, error } = await this.client.auth.signUp({ email, password, options: emailRedirectTo ? { emailRedirectTo } : undefined });
    if (error) {
      authLog.warn('sign_up_failed', { code: error.code ?? error.status });
      throw new AccountError(error.code ?? 'sign_up_failed', error.message, error.status === 429 ? 429 : 400);
    }
    authLog.info('signed_up', { confirmation_required: !data.session });
    return { ...(await this.status()), needsConfirmation: !data.session };
  }

  async signOut(): Promise<AccountStatus> {
    await this.ready;
    const { error } = await this.client.auth.signOut({ scope: 'local' });
    if (error) authLog.warn('sign_out_failed', { err: error });
    authLog.info('signed_out');
    return this.status();
  }

  close(): void {
    void this.client.auth.stopAutoRefresh();
  }
}

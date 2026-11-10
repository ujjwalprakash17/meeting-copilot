/**
 * Multi-user authentication for the hosted server.
 *
 * Users sign in inside the extension (Supabase Auth). Every HTTP request carries `Authorization: Bearer
 * <access token>` and every WebSocket session sends the token in `audio.start` (and `auth.update` when the
 * extension refreshes it). The server verifies the token, then reads and writes history *as that user*
 * (publishable key + the user's token), so Postgres Row Level Security keeps users apart. No service-role
 * key is used.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { log } from '../logger.js';
import { HistoryWriter } from '../history/HistoryWriter.js';
import { SupabaseHistoryRepository } from '../history/SupabaseHistoryRepository.js';

const authLog = log.child('auth');

export class AuthRequiredError extends Error {
  readonly code = 'auth_required';
  constructor(message = 'Sign in to Meeting Copilot (Settings → Account) to continue.') {
    super(message);
  }
}

export interface AuthenticatedUser {
  userId: string;
  email: string | null;
  /** Token expiry, epoch ms. */
  expiresAt: number;
}

/** What the HTTP routes and WebSocket sessions need; tests provide an in-memory implementation. */
export interface UserDirectory {
  /** Verifies an access token; throws AuthRequiredError when it is missing, invalid or expired. */
  authenticate(accessToken: string | null | undefined): Promise<AuthenticatedUser>;
  /** The history writer for this user, using `accessToken` (the newest one wins) for database calls. */
  writerFor(user: AuthenticatedUser, accessToken: string): HistoryWriter;
  /** Flushes and closes every writer. */
  close(): Promise<void>;
}

export const bearerToken = (header: string | undefined): string | null => {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return m?.[1] ?? null;
};

interface UserEntry {
  writer: HistoryWriter;
  token: string;
  expiresAt: number;
  lastUsed: number;
}

const IDLE_EVICT_MS = 30 * 60_000;
const MAX_TOKEN_CHARS = 4096;

export class SupabaseUserDirectory implements UserDirectory {
  private readonly verifier: SupabaseClient;
  private readonly users = new Map<string, UserEntry>();
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(private readonly opts: { url: string; publishableKey: string }) {
    this.verifier = createClient(opts.url, opts.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    this.sweeper = setInterval(() => void this.evictIdle(), 5 * 60_000);
    this.sweeper.unref?.();
  }

  async authenticate(accessToken: string | null | undefined): Promise<AuthenticatedUser> {
    if (!accessToken || accessToken.length > MAX_TOKEN_CHARS) throw new AuthRequiredError();
    // Verifies the signature (JWKS for asymmetric keys, or the Auth server otherwise) and the expiry.
    const { data, error } = await this.verifier.auth.getClaims(accessToken);
    const claims = data?.claims;
    if (error || !claims?.sub || claims.role !== 'authenticated') {
      authLog.debug('token_rejected', { reason: error?.message ?? 'not an authenticated user token' });
      throw new AuthRequiredError(
        error && /expired/i.test(error.message) ? 'Your sign-in expired. Sign in again (Settings → Account).' : undefined,
      );
    }
    return { userId: claims.sub, email: typeof claims.email === 'string' ? claims.email : null, expiresAt: Number(claims.exp ?? 0) * 1000 };
  }

  writerFor(user: AuthenticatedUser, accessToken: string): HistoryWriter {
    let entry = this.users.get(user.userId);
    if (entry) {
      if (user.expiresAt >= entry.expiresAt) {
        entry.token = accessToken;
        entry.expiresAt = user.expiresAt;
      }
      entry.lastUsed = Date.now();
      return entry.writer;
    }
    const state = { token: accessToken, expiresAt: user.expiresAt };
    const client = createClient(this.opts.url, this.opts.publishableKey, {
      accessToken: async () => this.users.get(user.userId)?.token ?? state.token,
    });
    const repo = new SupabaseHistoryRepository({
      client,
      requireUserId: async () => {
        const e = this.users.get(user.userId);
        if (e && e.expiresAt <= Date.now()) throw new AuthRequiredError('Your sign-in expired. Sign in again (Settings → Account).');
        return user.userId;
      },
    });
    entry = { writer: new HistoryWriter(repo, { debounceMs: 600, maxDelayMs: 3_000 }), ...state, lastUsed: Date.now() };
    this.users.set(user.userId, entry);
    return entry.writer;
  }

  private async evictIdle(): Promise<void> {
    const cutoff = Date.now() - IDLE_EVICT_MS;
    for (const [id, e] of this.users) {
      if (e.lastUsed > cutoff) continue;
      this.users.delete(id);
      await e.writer.close().catch((err: unknown) => authLog.warn('writer_close_failed', { err }));
    }
  }

  /** Marks a user as active (long-running sessions call this so their writer is not evicted). */
  touch(userId: string): void {
    const e = this.users.get(userId);
    if (e) e.lastUsed = Date.now();
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    await Promise.all([...this.users.values()].map((e) => e.writer.close().catch(() => undefined)));
    this.users.clear();
  }
}

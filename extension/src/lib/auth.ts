/**
 * Meeting Copilot accounts (Supabase Auth), used when the server stores history in Supabase.
 *
 * The extension signs the user in directly with Supabase; the session lives in chrome.storage.local and is
 * refreshed by supabase-js. Requests to the server carry the short-lived access token
 * (`Authorization: Bearer …`, and `audio.start` / `auth.update` on the WebSocket). The password never
 * reaches the Meeting Copilot server.
 *
 * Usable from the service worker, popup and assistant window (they have chrome.storage); the offscreen
 * document asks the service worker for a token instead.
 */
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import type { AuthConfigResponse } from '@meeting-copilot/shared';
import { extensionLog } from './log.js';

const log = extensionLog.child('auth');
const CONFIG_CACHE_KEY = 'mc.authConfig';
const SESSION_KEY = 'mc.supabaseAuth';

/** supabase-js storage adapter over chrome.storage.local (shared by all extension pages). */
const chromeStorage = {
  async getItem(key: string): Promise<string | null> {
    const v = (await chrome.storage.local.get(`${SESSION_KEY}.${key}`))[`${SESSION_KEY}.${key}`];
    return typeof v === 'string' ? v : null;
  },
  async setItem(key: string, value: string): Promise<void> {
    await chrome.storage.local.set({ [`${SESSION_KEY}.${key}`]: value });
  },
  async removeItem(key: string): Promise<void> {
    await chrome.storage.local.remove(`${SESSION_KEY}.${key}`);
  },
};

const normalize = (serverUrl: string) => serverUrl.replace(/\/+$/, '');

/** Public sign-in settings published by the server (cached per server URL for offline starts). */
export async function getAuthConfig(serverUrl: string): Promise<AuthConfigResponse> {
  const key = `${CONFIG_CACHE_KEY}:${normalize(serverUrl)}`;
  try {
    const res = await fetch(new URL('/api/auth/config', serverUrl), { signal: AbortSignal.timeout(8_000) });
    if (res.status === 404) {
      // Older/local server without accounts.
      return { backend: 'sqlite', authRequired: false, supabaseUrl: null, supabasePublishableKey: null };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cfg = (await res.json()) as AuthConfigResponse;
    await chrome.storage.local.set({ [key]: cfg });
    return cfg;
  } catch (err) {
    const cached = (await chrome.storage.local.get(key))[key] as AuthConfigResponse | undefined;
    if (cached) return cached;
    throw new Error(`Cannot reach the Meeting Copilot server at ${serverUrl} (${(err as Error).message}).`, { cause: err });
  }
}

const clients = new Map<string, SupabaseClient>();

/** The Supabase client for this server's project, or null when the server has no accounts. */
export async function getSupabase(serverUrl: string): Promise<SupabaseClient | null> {
  const cfg = await getAuthConfig(serverUrl);
  if (!cfg.supabaseUrl || !cfg.supabasePublishableKey) return null;
  const id = `${cfg.supabaseUrl}|${cfg.supabasePublishableKey}`;
  let client = clients.get(id);
  if (!client) {
    client = createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
      auth: { storage: chromeStorage, storageKey: 'session', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
    clients.set(id, client);
  }
  return client;
}

/** A valid access token for the signed-in user (refreshed when close to expiry), or null when signed out. */
export async function getAccessToken(serverUrl: string): Promise<string | null> {
  try {
    const client = await getSupabase(serverUrl);
    if (!client) return null;
    const { data } = await client.auth.getSession();
    const session = data.session;
    if (!session) return null;
    // Refresh early so a token handed to the server stays valid for a while.
    if ((session.expires_at ?? 0) * 1000 - Date.now() < 5 * 60_000) {
      const { data: refreshed, error } = await client.auth.refreshSession();
      if (error) {
        log.warn('refresh_failed', { err: error.message });
        return null;
      }
      return refreshed.session?.access_token ?? null;
    }
    return session.access_token;
  } catch (err) {
    log.warn('token_unavailable', { err });
    return null;
  }
}

export async function getUser(serverUrl: string): Promise<User | null> {
  const client = await getSupabase(serverUrl);
  if (!client) return null;
  const { data } = await client.auth.getSession();
  return data.session?.user ?? null;
}

const requireClient = async (serverUrl: string) => {
  const client = await getSupabase(serverUrl);
  if (!client) throw new Error('This server does not use accounts.');
  return client;
};

export async function signIn(serverUrl: string, email: string, password: string): Promise<User> {
  const { data, error } = await (await requireClient(serverUrl)).auth.signInWithPassword({ email, password });
  if (error) {
    throw new Error(error.code === 'email_not_confirmed' ? 'Confirm your email first: open the link we sent you, then sign in.' : error.message);
  }
  log.info('signed_in');
  return data.user;
}

/** Creates an account. Returns true when the user must confirm their email before signing in. */
export async function signUp(serverUrl: string, email: string, password: string): Promise<boolean> {
  const { data, error } = await (await requireClient(serverUrl)).auth.signUp({
    email,
    password,
    options: { emailRedirectTo: new URL('/auth/confirmed', serverUrl).toString() },
  });
  if (error) throw new Error(error.message);
  log.info('signed_up', { confirmation_required: !data.session });
  return !data.session;
}

export async function signOut(serverUrl: string): Promise<void> {
  const client = await getSupabase(serverUrl);
  await client?.auth.signOut({ scope: 'local' });
  log.info('signed_out');
}

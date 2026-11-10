import { useCallback, useEffect, useState } from 'react';
import type { AuthConfigResponse } from '@meeting-copilot/shared';
import { getAuthConfig, getUser, signIn, signOut, signUp } from '../../lib/auth.js';

/**
 * Meeting Copilot account. Shown when the server uses accounts (hosted servers require one).
 * Sign-in goes straight from this window to Supabase Auth; the password never reaches the Meeting Copilot server.
 */
export function AccountCard({ serverUrl }: { serverUrl: string }) {
  const [cfg, setCfg] = useState<AuthConfigResponse | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [formEmail, setFormEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const c = await getAuthConfig(serverUrl);
      setCfg(c);
      setEmail(c.supabaseUrl ? ((await getUser(serverUrl))?.email ?? null) : null);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoaded(true);
    }
  }, [serverUrl]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await fn();
      setPassword('');
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (loaded && cfg && !cfg.supabaseUrl) return null; // Local server without accounts.

  return (
    <div className="card stack">
      <div className="row">
        <strong className="grow">Account</strong>
        {email ? <span className="pill ok">signed in</span> : cfg?.authRequired ? <span className="pill">required</span> : null}
      </div>
      {error && <div className="banner error">{error}</div>}
      {info && <div className="banner info">{info}</div>}
      {!loaded ? (
        <p className="hint">Checking account…</p>
      ) : email ? (
        <>
          <p className="hint">
            Signed in as <b>{email}</b>. Your conversation history is saved to your account; only you can read it.
          </p>
          <div className="row">
            <button disabled={busy} onClick={() => void run(() => signOut(serverUrl))}>
              {busy ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </>
      ) : cfg ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            const address = formEmail.trim().toLowerCase();
            void run(async () => {
              if (mode === 'sign-in') {
                await signIn(serverUrl, address, password);
              } else if (await signUp(serverUrl, address, password)) {
                setInfo('Account created. Open the confirmation link we emailed you, then sign in here.');
                setMode('sign-in');
              }
            });
          }}
        >
          <p className="hint">
            {cfg.authRequired ? 'Sign in to start listening. ' : ''}Your history is saved to your account and available on any computer.
          </p>
          <label>Email</label>
          <input type="email" autoComplete="email" required value={formEmail} onChange={(e) => setFormEmail(e.target.value)} />
          <label>Password</label>
          <input
            type="password"
            autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
            required
            minLength={8}
            maxLength={72}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <div className="row">
            <button type="submit" className="primary" disabled={busy}>
              {busy ? 'Please wait…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}
            </button>
            <button type="button" className="link" onClick={() => setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')}>
              {mode === 'sign-in' ? 'New here? Create an account' : 'Have an account? Sign in'}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

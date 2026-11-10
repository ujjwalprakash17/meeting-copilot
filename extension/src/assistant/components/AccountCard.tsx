import { useCallback, useEffect, useState } from 'react';
import type { AccountStatus } from '@meeting-copilot/shared';
import { fetchAccount, signIn, signOut, signUp } from '../../lib/serverApi.js';

/**
 * Sign-in for the shared Supabase history. Shown only when the server uses HISTORY_BACKEND=supabase.
 * The password is sent once to the local server (which forwards it to Supabase Auth) and is never stored.
 */
export function AccountCard({ serverUrl }: { serverUrl: string }) {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await fetchAccount(serverUrl));
      setError(null);
    } catch (err) {
      setStatus(null);
      setError((err as Error).message);
    }
  }, [serverUrl]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (fn: () => Promise<AccountStatus>) => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const next = await fn();
      setStatus(next);
      setPassword('');
      if (next.needsConfirmation) {
        setInfo('Account created. Open the confirmation link we emailed you, then sign in here.');
        setMode('sign-in');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (status && !status.configured) return null; // SQLite backend: no account needed.

  return (
    <div className="card stack">
      <div className="row">
        <strong className="grow">Account</strong>
        {status?.signedIn && <span className="pill ok">signed in</span>}
      </div>
      {error && <div className="banner error">{error}</div>}
      {info && <div className="banner info">{info}</div>}
      {status?.signedIn ? (
        <>
          <p className="hint">
            Signed in as <b>{status.email}</b>. Your conversation history is saved to the shared Supabase database; only you can read
            it.
          </p>
          <div className="row">
            <button disabled={busy} onClick={() => void run(() => signOut(serverUrl))}>
              {busy ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </>
      ) : status ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => (mode === 'sign-in' ? signIn : signUp)(serverUrl, email.trim(), password));
          }}
        >
          <p className="hint">Sign in to save your history to the shared database and see it from any computer.</p>
          <label>Email</label>
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
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
      ) : (
        <p className="hint">Checking account…</p>
      )}
    </div>
  );
}

import { afterEach, describe, expect, it } from 'vitest';
import type { AccountStatus, CardRecord } from '@meeting-copilot/shared';
import { AccountError, AuthRequiredError, SupabaseAccount } from '../src/account/SupabaseAccount.js';
import { HistoryWriter } from '../src/history/HistoryWriter.js';
import { SupabaseHistoryRepository, toBatchPayload, toCard, toSummary } from '../src/history/SupabaseHistoryRepository.js';
import type { HistoryRepository } from '../src/history/types.js';
import { ORIGIN, startApp, type TestApp } from './helpers.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const card: CardRecord = {
  id: 'card-1',
  conversationId: '5b0c3f8e-2d3a-4c1b-9f6e-1a2b3c4d5e6f',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_500,
  question: 'What is a race condition?',
  source: 'auto',
  status: 'completed',
  answer: 'Two threads…',
  model: 'mock',
  simulated: true,
  groundingKind: null,
  groundingEvidence: null,
  groundingSections: ['Experience'],
  firstTokenMs: 120,
  durationMs: 900,
  errorCode: null,
};

const offlineAccount = () => {
  // Unroutable URL: these tests must never reach the network.
  const account = new SupabaseAccount({ url: 'http://127.0.0.1:9', publishableKey: 'sb_publishable_test', sessionPath: ':memory:' });
  cleanup.push(() => account.close());
  return account;
};

describe('Supabase history mapping', () => {
  it('splits a batch into conversation and card payloads for apply_history_batch', () => {
    const payload = toBatchPayload([
      { kind: 'conversation', value: { id: card.conversationId, at: 1, simulated: true } },
      { kind: 'card', value: card },
    ]);
    expect(payload.p_conversations).toEqual([{ id: card.conversationId, at: 1, simulated: true }]);
    expect(payload.p_cards).toEqual([card]);
  });

  it('maps Postgres rows (snake_case, bigint as number or string) back to the shared types', () => {
    const row = {
      id: card.id,
      conversation_id: card.conversationId,
      created_at: String(card.createdAt),
      updated_at: card.updatedAt,
      question: card.question,
      source: 'auto',
      status: 'completed',
      answer: card.answer,
      model: 'mock',
      simulated: true,
      grounding_kind: null,
      grounding_evidence: null,
      grounding_sections: ['Experience', 42],
      first_token_ms: 120,
      duration_ms: 900,
      error_code: null,
      user_id: 'ignored',
    };
    expect(toCard(row)).toEqual(card);
    expect(toCard({ ...row, status: 'weird', source: 'x', grounding_sections: null }).status).toBe('pending');
    expect(
      toSummary({ id: card.conversationId, title: null, first_question: 'Q', started_at: 1, updated_at: '2', simulated: false, card_count: 3 }),
    ).toEqual({ id: card.conversationId, title: null, firstQuestion: 'Q', startedAt: 1, updatedAt: 2, simulated: false, cardCount: 3 });
  });
});

describe('Supabase account (offline)', () => {
  it('requires a signed-in user before any history call', async () => {
    const repo = new SupabaseHistoryRepository(offlineAccount());
    await expect(repo.listConversations({ limit: 10 })).rejects.toBeInstanceOf(AuthRequiredError);
    await expect(repo.applyBatch([{ kind: 'card', value: card }])).rejects.toBeInstanceOf(AuthRequiredError);
    await expect(repo.deleteAll()).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('reports a signed-out status and validates credentials before calling Supabase', async () => {
    const account = offlineAccount();
    expect(await account.status()).toMatchObject({ backend: 'supabase', configured: true, signedIn: false, email: null });
    await expect(account.signIn('not-an-email', 'longenough')).rejects.toBeInstanceOf(AccountError);
    await expect(account.signUp('a@b.co', 'short')).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('account and history HTTP API with the Supabase backend', () => {
  const launch = async (opts: { history?: HistoryWriter | null; account?: SupabaseAccount | null } = {}): Promise<TestApp> => {
    const app = await startApp({ script: [], history: opts.history ?? null, account: opts.account ?? null });
    cleanup.push(() => app.close());
    return app;
  };
  const api = (app: TestApp, p: string, init: RequestInit = {}) =>
    fetch(`http://${app.baseUrl}${p}`, { ...init, headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });

  it('reports the SQLite backend (no account) and refuses sign-in there', async () => {
    const app = await launch();
    const status = (await (await api(app, '/api/account')).json()) as AccountStatus;
    expect(status).toMatchObject({ backend: 'sqlite', configured: false, signedIn: false });
    const res = await api(app, '/api/account/sign-in', { method: 'POST', body: JSON.stringify({ email: 'a@b.co', password: 'password1' }) });
    expect(res.status).toBe(409);
  });

  it('answers history requests with 401 auth_required until the user signs in', async () => {
    const account = offlineAccount();
    const writer = new HistoryWriter(new SupabaseHistoryRepository(account), { debounceMs: 10 });
    cleanup.push(() => writer.close().catch(() => undefined));
    const app = await launch({ history: writer, account });

    const list = await api(app, '/api/history');
    expect(list.status).toBe(401);
    expect(((await list.json()) as { error: { code: string } }).error.code).toBe('auth_required');

    const status = (await (await api(app, '/api/account')).json()) as AccountStatus;
    expect(status).toMatchObject({ backend: 'supabase', configured: true, signedIn: false });

    const bad = await api(app, '/api/account/sign-in', { method: 'POST', body: JSON.stringify({ email: 'nope', password: 'password1' }) });
    expect(bad.status).toBe(400);
  });

  it('rejects account calls from web pages (origin check)', async () => {
    const app = await launch();
    const res = await fetch(`http://${app.baseUrl}/api/account`, { headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
  });

  it('keeps the HistoryRepository contract', () => {
    const repo: HistoryRepository = new SupabaseHistoryRepository(offlineAccount());
    expect(typeof repo.applyBatch).toBe('function');
  });
});

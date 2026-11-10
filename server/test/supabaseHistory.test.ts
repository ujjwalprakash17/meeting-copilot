import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthConfigResponse, CardRecord, ConversationListResponse } from '@meeting-copilot/shared';
import { AuthRequiredError, SupabaseUserDirectory, type AuthenticatedUser, type UserDirectory } from '../src/auth/UserDirectory.js';
import { HistoryWriter } from '../src/history/HistoryWriter.js';
import { SqliteHistoryRepository } from '../src/history/SqliteHistoryRepository.js';
import { toBatchPayload, toCard, toSummary } from '../src/history/SupabaseHistoryRepository.js';
import type { ScriptLine } from '../src/transcription/simulated.js';
import { allSpeculationResolved, connect, ofType, ORIGIN, startApp, type TestApp } from './helpers.js';

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

describe('SupabaseUserDirectory', () => {
  it('rejects missing, oversized and malformed tokens', async () => {
    const dir = new SupabaseUserDirectory({ url: 'http://127.0.0.1:9', publishableKey: 'sb_publishable_test' });
    cleanup.push(() => dir.close());
    await expect(dir.authenticate(null)).rejects.toBeInstanceOf(AuthRequiredError);
    await expect(dir.authenticate('x'.repeat(5000))).rejects.toBeInstanceOf(AuthRequiredError);
    await expect(dir.authenticate('not-a-jwt')).rejects.toBeInstanceOf(AuthRequiredError);
  });
});

/** Two fake users, each with their own in-memory database: stands in for Supabase Auth + RLS. */
class FakeUsers implements UserDirectory {
  readonly writers = new Map<string, HistoryWriter>();
  private readonly tokens: Record<string, AuthenticatedUser> = {
    'token-alice': { userId: 'alice', email: 'alice@example.com', expiresAt: Date.now() + 3_600_000 },
    'token-bob': { userId: 'bob', email: 'bob@example.com', expiresAt: Date.now() + 3_600_000 },
  };
  async authenticate(token: string | null | undefined): Promise<AuthenticatedUser> {
    const user = token ? this.tokens[token] : undefined;
    if (!user) throw new AuthRequiredError();
    return user;
  }
  writerFor(user: AuthenticatedUser): HistoryWriter {
    let w = this.writers.get(user.userId);
    if (!w) {
      w = new HistoryWriter(new SqliteHistoryRepository(':memory:'), { debounceMs: 10 });
      this.writers.set(user.userId, w);
    }
    return w;
  }
  async close(): Promise<void> {
    for (const w of this.writers.values()) await w.close();
  }
}

const script: ScriptLine[] = [{ text: 'What is the difference between TCP and UDP?', speechFinal: true, gapMs: 30 }];

describe('hosted multi-user server', () => {
  const launch = async (authRequired = true) => {
    const users = new FakeUsers();
    const app = await startApp({ script, speed: 2, users, config: { authRequired } });
    cleanup.push(async () => {
      await app.close();
      await users.close();
    });
    return { app, users };
  };
  const api = (app: TestApp, p: string, token?: string, init: RequestInit = {}) =>
    fetch(`http://${app.baseUrl}${p}`, {
      ...init,
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
    });

  it('publishes the public sign-in settings', async () => {
    const { app } = await launch();
    const cfg = (await (await api(app, '/api/auth/config')).json()) as AuthConfigResponse;
    expect(cfg).toEqual({ backend: 'supabase', authRequired: true, supabaseUrl: 'https://example.supabase.co', supabasePublishableKey: 'sb_publishable_test' });
  });

  it('requires a valid token for history and paid endpoints', async () => {
    const { app } = await launch();
    for (const [p, init] of [
      ['/api/history', {}],
      ['/api/insights', { method: 'POST', body: JSON.stringify({ kind: 'summary', transcript: 'hello' }) }],
      ['/api/resume/extract', { method: 'POST', body: 'x' }],
    ] as const) {
      const res = await api(app, p, undefined, init);
      expect(res.status, p).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('auth_required');
      expect((await api(app, p, 'token-forged', init)).status, p).toBe(401);
    }
    expect((await api(app, '/api/history', 'token-alice')).status).toBe(200);
  });

  it('allows the Authorization header in CORS preflight', async () => {
    const { app } = await launch();
    const res = await api(app, '/api/history', undefined, { method: 'OPTIONS' });
    expect(res.headers.get('access-control-allow-headers')).toMatch(/Authorization/);
  });

  it('refuses a WebSocket session without a valid sign-in', async () => {
    const { app } = await launch();
    for (const token of [undefined, 'token-forged']) {
      const c = await connect(app.baseUrl);
      const closed = new Promise<number>((r) => c.ws.on('close', (code) => r(code)));
      c.start({}, 'simulation', token);
      await c.waitFor((e) => ofType(e, 'session.error').some((x) => x.code === 'auth_required' && x.fatal));
      expect(await closed).toBe(1008);
    }
  });

  it('saves each user’s session under their own account only', async () => {
    const { app } = await launch();
    const conversationId = randomUUID();
    const c = await connect(app.baseUrl);
    c.start({ conversationId }, 'simulation', 'token-alice');
    await c.waitFor((e) => ofType(e, 'answer.completed').length >= 1 && allSpeculationResolved(e), 15_000);
    // A refreshed token for the same user is accepted mid-session; another user's is refused.
    c.ws.send(JSON.stringify({ type: 'auth.update', accessToken: 'token-alice', ts: Date.now() }));
    c.ws.close();

    const alice = (await (await api(app, '/api/history', 'token-alice')).json()) as ConversationListResponse;
    expect(alice.backend).toBe('supabase');
    expect(alice.conversations.map((x) => x.id)).toEqual([conversationId]);
    expect(alice.conversations[0]?.cardCount).toBe(1);

    const bob = (await (await api(app, '/api/history', 'token-bob')).json()) as ConversationListResponse;
    expect(bob.conversations).toEqual([]);
    expect((await api(app, `/api/history/${conversationId}`, 'token-bob')).status).toBe(404);
    expect((await api(app, `/api/history/${conversationId}`, 'token-bob', { method: 'DELETE' })).status).toBe(404);
    expect((await api(app, `/api/history/${conversationId}`, 'token-alice')).status).toBe(200);
  });

  it('closes the session if a different account’s token arrives mid-session', async () => {
    const { app } = await launch();
    const c = await connect(app.baseUrl);
    const closed = new Promise<number>((r) => c.ws.on('close', (code) => r(code)));
    c.start({ conversationId: randomUUID() }, 'simulation', 'token-alice');
    await c.waitFor((e) => ofType(e, 'session.ready').length >= 1);
    c.ws.send(JSON.stringify({ type: 'auth.update', accessToken: 'token-bob', ts: Date.now() }));
    expect(await closed).toBe(1008);
  });

  it('lets anonymous sessions run when accounts are optional (AUTH_REQUIRED=false)', async () => {
    const { app } = await launch(false);
    const c = await connect(app.baseUrl);
    c.start({}, 'simulation');
    await c.waitFor((e) => ofType(e, 'session.ready').length >= 1);
    c.ws.close();
    expect((await api(app, '/api/insights', undefined, { method: 'POST', body: JSON.stringify({ kind: 'x', transcript: '' }) })).status).toBe(400);
  });

  it('rejects calls from web pages (origin check)', async () => {
    const { app } = await launch();
    const res = await fetch(`http://${app.baseUrl}/api/auth/config`, { headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
  });
});

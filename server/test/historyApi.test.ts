import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationDetailResponse, ConversationListResponse } from '@meeting-copilot/shared';
import { HistoryWriter } from '../src/history/HistoryWriter.js';
import { SqliteHistoryRepository } from '../src/history/SqliteHistoryRepository.js';
import type { ScriptLine } from '../src/transcription/simulated.js';
import { allSpeculationResolved, connect, ofType, ORIGIN, startApp, type TestApp } from './helpers.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const script: ScriptLine[] = [
  { text: 'What is the difference between TCP and UDP?', speechFinal: true, gapMs: 30 },
  { text: 'How does garbage collection work in Java?', speechFinal: true, gapMs: 300 },
];

async function launchWithHistory(file: string) {
  const writer = new HistoryWriter(new SqliteHistoryRepository(file), { debounceMs: 10 });
  const app = await startApp({ script, speed: 2, history: writer });
  const stop = async () => {
    await app.close();
    await writer.close();
  };
  return { app, writer, stop };
}

const api = (app: TestApp, p: string, init: RequestInit = {}) =>
  fetch(`http://${app.baseUrl}${p}`, { ...init, headers: { Origin: ORIGIN, ...(init.headers ?? {}) } });

async function recordConversation(app: TestApp, conversationId: string) {
  const c = await connect(app.baseUrl);
  c.start({ conversationId });
  // Wait for confirmation as well: a tentative answer may finish before its final transcript arrives,
  // and the card is only saved once the question is confirmed.
  await c.waitFor((e) => ofType(e, 'answer.completed').length >= 2 && allSpeculationResolved(e), 15_000);
  c.ws.close();
}

describe('history HTTP API', () => {
  it('lists, opens, renames and deletes conversations recorded by real sessions, and survives a restart', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mc-api-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'history.sqlite');

    let server = await launchWithHistory(file);
    const first = randomUUID();
    const second = randomUUID();
    await recordConversation(server.app, first);
    await recordConversation(server.app, second);

    let list = (await (await api(server.app, '/api/history')).json()) as ConversationListResponse;
    expect(list.conversations.map((c) => c.id)).toEqual([second, first]); // newest first
    expect(list.conversations[0]).toMatchObject({ cardCount: 2, simulated: true, firstQuestion: 'What is the difference between TCP and UDP?' });
    expect(list.dbPath).toBeNull(); // only the production entry point exposes the path

    // Restart the server on the same database file: history is still there.
    await server.stop();
    server = await launchWithHistory(file);
    cleanup.push(() => server.stop());

    const detail = (await (await api(server.app, `/api/history/${first}`)).json()) as ConversationDetailResponse;
    expect(detail.cards.map((k) => k.status)).toEqual(['completed', 'completed']);
    expect(detail.cards[0]?.answer).toMatch(/^\[TEST MODE/);

    const rename = await api(server.app, `/api/history/${first}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Networking round' }),
    });
    expect(rename.status).toBe(200);
    expect(((await (await api(server.app, `/api/history/${first}`)).json()) as ConversationDetailResponse).conversation.title).toBe('Networking round');

    expect((await api(server.app, `/api/history/${first}`, { method: 'DELETE' })).status).toBe(200);
    expect((await api(server.app, `/api/history/${first}`)).status).toBe(404);
    expect((await api(server.app, `/api/history/${first}`, { method: 'DELETE' })).status).toBe(404);

    // Delete-all requires explicit confirmation.
    expect((await api(server.app, '/api/history', { method: 'DELETE' })).status).toBe(400);
    const all = await api(server.app, '/api/history', { method: 'DELETE', headers: { 'X-Confirm-Delete-All': 'yes' } });
    expect(await all.json()).toEqual({ ok: true, deleted: 1 });
    list = (await (await api(server.app, '/api/history')).json()) as ConversationListResponse;
    expect(list.conversations).toEqual([]);
  });

  it('validates ids and bodies, enforces origins and answers CORS preflight for DELETE', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mc-api-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const server = await launchWithHistory(path.join(dir, 'h.sqlite'));
    cleanup.push(() => server.stop());

    expect((await api(server.app, "/api/history/1' OR '1'='1")).status).toBe(400);
    expect((await api(server.app, '/api/history?limit=100000')).status).toBe(400);
    const badTitle = await api(server.app, `/api/history/${randomUUID()}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x'.repeat(500) }),
    });
    expect(badTitle.status).toBe(400);

    const evil = await fetch(`http://${server.app.baseUrl}/api/history`, { headers: { Origin: 'https://meet.google.com' } });
    expect(evil.status).toBe(403);
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();

    const preflight = await fetch(`http://${server.app.baseUrl}/api/history`, {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'DELETE', 'Access-Control-Request-Headers': 'x-confirm-delete-all' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toContain('DELETE');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('X-Confirm-Delete-All');
  });

  it('reports history as unavailable when disabled', async () => {
    const app = await startApp({ script });
    cleanup.push(() => app.close());
    const res = await api(app, '/api/history');
    expect(res.status).toBe(503);
  });
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryWriter } from '../src/history/HistoryWriter.js';
import { MIGRATIONS, type Migration } from '../src/history/migrations.js';
import { SchemaVersionError, SqliteHistoryRepository } from '../src/history/SqliteHistoryRepository.js';
import type { CardRecord, HistoryOp, HistoryRepository } from '../src/history/types.js';

const dirs: string[] = [];
const tempDb = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mc-history-'));
  dirs.push(dir);
  return path.join(dir, 'history.sqlite');
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const card = (conversationId: string, id: string, over: Partial<CardRecord> = {}): CardRecord => ({
  id,
  conversationId,
  createdAt: 1_000,
  updatedAt: 1_000,
  question: `Question ${id}?`,
  source: 'auto',
  status: 'completed',
  answer: `Answer ${id}`,
  model: 'mock-llm',
  simulated: true,
  groundingKind: 'general',
  groundingEvidence: 'not_needed',
  groundingSections: [],
  firstTokenMs: 10,
  durationMs: 100,
  errorCode: null,
  ...over,
});
const ops = (conversationId: string, at: number, cards: CardRecord[]): HistoryOp[] => [
  { kind: 'conversation', value: { id: conversationId, at, simulated: true } },
  ...cards.map((value) => ({ kind: 'card' as const, value })),
];

describe('schema and migrations', () => {
  it('initialises a new database at the latest version and is idempotent on reopen', () => {
    const file = tempDb();
    const repo = new SqliteHistoryRepository(file);
    expect(repo.schemaVersion()).toBe(MIGRATIONS.at(-1)?.version);
    repo.close();
    const again = new SqliteHistoryRepository(file);
    expect(again.schemaVersion()).toBe(MIGRATIONS.at(-1)?.version);
    again.close();
  });

  it('applies new migrations to an existing database without losing data', async () => {
    const file = tempDb();
    const conv = randomUUID();
    const v1 = new SqliteHistoryRepository(file);
    await v1.applyBatch(ops(conv, 5, [card(conv, 'q-1')]));
    v1.close();
    const v2: Migration[] = [...MIGRATIONS, { version: 2, description: 'test-only column', sql: 'ALTER TABLE conversations ADD COLUMN note TEXT;' }];
    const upgraded = new SqliteHistoryRepository(file, v2);
    expect(upgraded.schemaVersion()).toBe(2);
    expect((await upgraded.getConversation(conv))?.cards).toHaveLength(1);
    upgraded.close();
  });

  it('refuses to open a database created by a newer schema', () => {
    const file = tempDb();
    const v2: Migration[] = [...MIGRATIONS, { version: 2, description: 'future', sql: 'SELECT 1;' }];
    new SqliteHistoryRepository(file, v2).close();
    expect(() => new SqliteHistoryRepository(file)).toThrow(SchemaVersionError);
  });

  it('fails clearly on a corrupt database file', () => {
    const file = tempDb();
    writeFileSync(file, 'this is not a sqlite database'.repeat(200));
    expect(() => new SqliteHistoryRepository(file)).toThrow();
  });

  it('has no BLOB columns and no columns for audio, transcripts or resume data', () => {
    const repo = new SqliteHistoryRepository(':memory:');
    const cols = repo.columnTypes();
    expect(cols.some((c) => c.type.toUpperCase().includes('BLOB'))).toBe(false);
    expect(cols.some((c) => /audio|transcript|resume|excerpt|prompt|key/i.test(c.column))).toBe(false);
    repo.close();
  });
});

describe('conversations CRUD', () => {
  it('creates, lists newest first, opens, renames and deletes', async () => {
    const repo = new SqliteHistoryRepository(':memory:');
    const a = randomUUID();
    const b = randomUUID();
    await repo.applyBatch(ops(a, 100, [card(a, 'qa-1', { createdAt: 100 }), card(a, 'qa-2', { createdAt: 200, question: 'Second?' })]));
    await repo.applyBatch(ops(b, 300, [card(b, 'qb-1', { createdAt: 300 })]));

    const list = await repo.listConversations({ limit: 10 });
    expect(list.map((c) => c.id)).toEqual([b, a]);
    expect(list[1]).toMatchObject({ cardCount: 2, firstQuestion: 'Question qa-1?', title: null, simulated: true });

    const opened = await repo.getConversation(a);
    expect(opened?.cards.map((c) => c.id)).toEqual(['qa-1', 'qa-2']);

    expect(await repo.renameConversation(a, 'System design round')).toBe(true);
    expect((await repo.getConversation(a))?.conversation.title).toBe('System design round');
    expect(await repo.renameConversation(randomUUID(), 'x')).toBe(false);

    expect(await repo.deleteConversation(a)).toBe(true);
    expect(await repo.getConversation(a)).toBeNull();
    expect(await repo.deleteConversation(a)).toBe(false);
    // Cards were deleted with their conversation (no orphans).
    expect((await repo.listConversations({ limit: 10 })).map((c) => c.id)).toEqual([b]);

    expect(await repo.deleteAll()).toEqual([b]);
    expect(await repo.listConversations({ limit: 10 })).toEqual([]);
    repo.close();
  });

  it('paginates with the before cursor', async () => {
    const repo = new SqliteHistoryRepository(':memory:');
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const [i, id] of ids.entries()) await repo.applyBatch(ops(id, (i + 1) * 100, [card(id, `q-${i}`)]));
    const page1 = await repo.listConversations({ limit: 2 });
    const page2 = await repo.listConversations({ limit: 2, before: page1.at(-1)?.updatedAt ?? 0 });
    expect([...page1, ...page2].map((c) => c.id)).toEqual([...ids].reverse());
    repo.close();
  });

  it('persists across a server restart (close and reopen the file)', async () => {
    const file = tempDb();
    const conv = randomUUID();
    const first = new SqliteHistoryRepository(file);
    await first.applyBatch(ops(conv, 10, [card(conv, 'q-persist', { answer: 'kept' })]));
    first.close();
    const second = new SqliteHistoryRepository(file);
    expect((await second.getConversation(conv))?.cards[0]?.answer).toBe('kept');
    second.close();
  });
});

describe('duplicates and concurrent updates', () => {
  it('upserts by card id and never lets an older version overwrite a newer one', async () => {
    const repo = new SqliteHistoryRepository(':memory:');
    const conv = randomUUID();
    await repo.applyBatch(ops(conv, 1, [card(conv, 'q-1', { status: 'pending', answer: null, updatedAt: 10 })]));
    await repo.applyBatch(ops(conv, 2, [card(conv, 'q-1', { status: 'completed', answer: 'final', updatedAt: 30 })]));
    await repo.applyBatch(ops(conv, 3, [card(conv, 'q-1', { status: 'failed', answer: 'stale', updatedAt: 20 })]));
    const cards = (await repo.getConversation(conv))?.cards ?? [];
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ status: 'completed', answer: 'final' });
    repo.close();
  });

  it('does not move a card into another conversation', async () => {
    const repo = new SqliteHistoryRepository(':memory:');
    const a = randomUUID();
    const b = randomUUID();
    await repo.applyBatch(ops(a, 1, [card(a, 'q-1', { updatedAt: 1 })]));
    await repo.applyBatch(ops(b, 2, [card(b, 'q-1', { updatedAt: 2, answer: 'hijack' })]));
    expect((await repo.getConversation(a))?.cards[0]?.answer).toBe('Answer q-1');
    expect((await repo.getConversation(b))?.cards).toHaveLength(0);
    repo.close();
  });

  it('writer collapses repeated updates into one write per card', async () => {
    const repo = new SqliteHistoryRepository(':memory:');
    const spy = vi.spyOn(repo, 'applyBatch');
    const writer = new HistoryWriter(repo, { debounceMs: 10 });
    const conv = randomUUID();
    for (let i = 0; i < 20; i++) for (const op of ops(conv, i, [card(conv, 'q-1', { updatedAt: i, answer: `v${i}` })])) writer.enqueue(op);
    await writer.flush();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toHaveLength(2);
    expect((await repo.getConversation(conv))?.cards[0]?.answer).toBe('v19');
    await writer.close();
  });

  it('a queued write cannot resurrect a deleted conversation', async () => {
    const repo = new SqliteHistoryRepository(':memory:');
    const writer = new HistoryWriter(repo, { debounceMs: 50 });
    const conv = randomUUID();
    for (const op of ops(conv, 1, [card(conv, 'q-1')])) writer.enqueue(op);
    await writer.flush();
    for (const op of ops(conv, 2, [card(conv, 'q-2')])) writer.enqueue(op); // queued, not yet written
    expect(await writer.deleteConversation(conv)).toBe(true);
    for (const op of ops(conv, 3, [card(conv, 'q-3')])) writer.enqueue(op); // late write from a live session
    await writer.flush();
    expect(await repo.getConversation(conv)).toBeNull();
    await writer.close();
  });

  it('delete-all racing an in-flight flush leaves no records', async () => {
    const repo = new SqliteHistoryRepository(':memory:');
    const writer = new HistoryWriter(repo, { debounceMs: 0 });
    const convs = Array.from({ length: 5 }, () => randomUUID());
    for (const c of convs) for (const op of ops(c, 1, [card(c, `q-${c}`)])) writer.enqueue(op);
    await writer.flush(); // 5 conversations stored
    for (const c of convs) for (const op of ops(c, 2, [card(c, `q2-${c}`)])) writer.enqueue(op);
    // A flush and a delete-all requested at the same moment: deletion must win for every record.
    const [, deleted] = await Promise.all([writer.flush(), writer.deleteAll()]);
    expect(deleted).toBe(5);
    for (const c of convs) for (const op of ops(c, 3, [card(c, `q3-${c}`)])) writer.enqueue(op); // late writes
    await writer.flush();
    expect(await repo.listConversations({ limit: 50 })).toEqual([]);
    await writer.close();
  });
});

describe('errors and recovery', () => {
  const failingRepo = (failures: number): HistoryRepository & { writes: HistoryOp[][] } => {
    let remaining = failures;
    const inner = new SqliteHistoryRepository(':memory:');
    return {
      writes: [],
      async applyBatch(batch) {
        if (remaining-- > 0) throw new Error('disk I/O error');
        this.writes.push(batch);
        return inner.applyBatch(batch);
      },
      listConversations: (o) => inner.listConversations(o),
      getConversation: (id) => inner.getConversation(id),
      renameConversation: (id, t) => inner.renameConversation(id, t),
      deleteConversation: (id) => inner.deleteConversation(id),
      deleteAll: () => inner.deleteAll(),
      close: () => inner.close(),
    };
  };

  it('retries a failed batch once and recovers', async () => {
    const repo = failingRepo(1);
    const writer = new HistoryWriter(repo, { debounceMs: 0, retryDelayMs: 10 });
    const errors: Array<{ willRetry: boolean }> = [];
    writer.onError((_e, info) => errors.push(info));
    const conv = randomUUID();
    for (const op of ops(conv, 1, [card(conv, 'q-1')])) writer.enqueue(op);
    await writer.flush();
    expect(errors).toEqual([{ dropped: 0, willRetry: true }]);
    expect((await repo.getConversation(conv))?.cards).toHaveLength(1);
    await writer.close();
  });

  it('drops a batch after the retry fails and reports it', async () => {
    const repo = failingRepo(2);
    const writer = new HistoryWriter(repo, { debounceMs: 0, retryDelayMs: 10 });
    const errors: Array<{ willRetry: boolean; dropped: number }> = [];
    writer.onError((_e, info) => errors.push(info));
    const conv = randomUUID();
    for (const op of ops(conv, 1, [card(conv, 'q-1')])) writer.enqueue(op);
    await writer.flush();
    expect(errors.map((e) => e.willRetry)).toEqual([true, false]);
    expect(errors[1]?.dropped).toBe(2);
    // Later writes still work.
    for (const op of ops(conv, 2, [card(conv, 'q-2')])) writer.enqueue(op);
    await writer.flush();
    expect((await repo.getConversation(conv))?.cards.map((c) => c.id)).toEqual(['q-2']);
    await writer.close();
  });
});

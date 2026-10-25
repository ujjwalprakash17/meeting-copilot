/**
 * SQLite implementation of the history repository using Node's built-in `node:sqlite`
 * (no native add-on to compile, no separate database service).
 *
 * Practices: parameterized statements only, foreign keys on, WAL journal, explicit transactions for
 * multi-row changes, `secure_delete` so deleted rows are overwritten in the database file, and a WAL
 * checkpoint after deletions so deleted content does not linger in the -wal file.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite';
import { MIGRATIONS, type Migration } from './migrations.js';
import type { CardRecord, ConversationSummary, HistoryOp, HistoryRepository } from './types.js';

type Row = Record<string, SQLOutputValue>;

type Cell = SQLOutputValue | undefined;
const num = (v: Cell): number => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : 0);
const numOrNull = (v: Cell): number | null => (v === null || v === undefined ? null : num(v));
const strOrNull = (v: Cell): string | null => (typeof v === 'string' ? v : null);

export class SchemaVersionError extends Error {}

export class SqliteHistoryRepository implements HistoryRepository {
  private readonly db: DatabaseSync;
  private readonly stmt: Record<string, StatementSync>;

  /** @param file database path, or ':memory:' for tests */
  constructor(
    readonly file: string,
    migrations: Migration[] = MIGRATIONS,
  ) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file, { enableForeignKeyConstraints: true, timeout: 2_000 });
    try {
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA secure_delete = ON;');
      this.migrate(migrations);
      this.stmt = this.prepareStatements();
    } catch (err) {
      // Release the file handle (otherwise the file stays locked on Windows) before reporting.
      this.db.close();
      throw err;
    }
  }

  private prepareStatements(): Record<string, StatementSync> {
    return {
      upsertConversation: this.db.prepare(
        `INSERT INTO conversations (id, title, started_at, updated_at, simulated) VALUES (?, NULL, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET updated_at = max(conversations.updated_at, excluded.updated_at)`,
      ),
      upsertCard: this.db.prepare(
        `INSERT INTO cards (id, conversation_id, created_at, updated_at, question, source, status, answer, model, simulated,
                            grounding_kind, grounding_evidence, grounding_sections, first_token_ms, duration_ms, error_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           updated_at = excluded.updated_at, question = excluded.question, status = excluded.status, answer = excluded.answer,
           model = excluded.model, simulated = excluded.simulated, grounding_kind = excluded.grounding_kind,
           grounding_evidence = excluded.grounding_evidence, grounding_sections = excluded.grounding_sections,
           first_token_ms = excluded.first_token_ms, duration_ms = excluded.duration_ms, error_code = excluded.error_code
         WHERE excluded.updated_at >= cards.updated_at AND cards.conversation_id = excluded.conversation_id`,
      ),
      list: this.db.prepare(
        `SELECT c.id, c.title, c.started_at, c.updated_at, c.simulated,
                (SELECT count(*) FROM cards k WHERE k.conversation_id = c.id) AS card_count,
                (SELECT k.question FROM cards k WHERE k.conversation_id = c.id ORDER BY k.created_at LIMIT 1) AS first_question
         FROM conversations c WHERE c.updated_at < ? ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`,
      ),
      getConversation: this.db.prepare(
        `SELECT c.id, c.title, c.started_at, c.updated_at, c.simulated,
                (SELECT count(*) FROM cards k WHERE k.conversation_id = c.id) AS card_count,
                (SELECT k.question FROM cards k WHERE k.conversation_id = c.id ORDER BY k.created_at LIMIT 1) AS first_question
         FROM conversations c WHERE c.id = ?`,
      ),
      cards: this.db.prepare('SELECT * FROM cards WHERE conversation_id = ? ORDER BY created_at, id'),
      rename: this.db.prepare('UPDATE conversations SET title = ? WHERE id = ?'),
      deleteCards: this.db.prepare('DELETE FROM cards WHERE conversation_id = ?'),
      deleteConversation: this.db.prepare('DELETE FROM conversations WHERE id = ?'),
      allIds: this.db.prepare('SELECT id FROM conversations'),
    };
  }

  /** Current schema version (PRAGMA user_version). */
  schemaVersion(): number {
    return num((this.db.prepare('PRAGMA user_version').get() as Row | undefined)?.user_version ?? 0);
  }

  private migrate(migrations: Migration[]): void {
    const current = this.schemaVersion();
    const latest = migrations.at(-1)?.version ?? 0;
    if (current > latest) {
      throw new SchemaVersionError(
        `History database schema v${current} is newer than this server supports (v${latest}). Update the server or use a different HISTORY_DB_PATH.`,
      );
    }
    for (const m of migrations) {
      if (m.version <= current) continue;
      this.transaction(() => {
        this.db.exec(m.sql);
        // user_version cannot be bound as a parameter; m.version is an integer from code, not input.
        this.db.exec(`PRAGMA user_version = ${Math.trunc(m.version)}`);
      });
    }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async applyBatch(ops: HistoryOp[]): Promise<void> {
    if (ops.length === 0) return;
    this.transaction(() => {
      for (const op of ops) {
        if (op.kind === 'conversation') {
          const c = op.value;
          this.stmt.upsertConversation?.run(c.id, c.at, c.at, c.simulated ? 1 : 0);
        } else {
          const k = op.value;
          this.stmt.upsertCard?.run(
            k.id,
            k.conversationId,
            k.createdAt,
            k.updatedAt,
            k.question,
            k.source,
            k.status,
            k.answer,
            k.model,
            k.simulated ? 1 : 0,
            k.groundingKind,
            k.groundingEvidence,
            JSON.stringify(k.groundingSections),
            k.firstTokenMs,
            k.durationMs,
            k.errorCode,
          );
        }
      }
    });
  }

  private toSummary(r: Row): ConversationSummary {
    return {
      id: String(r.id),
      title: strOrNull(r.title),
      firstQuestion: strOrNull(r.first_question),
      startedAt: num(r.started_at),
      updatedAt: num(r.updated_at),
      simulated: num(r.simulated) === 1,
      cardCount: num(r.card_count),
    };
  }

  private toCard(r: Row): CardRecord {
    let sections: string[] = [];
    try {
      const parsed: unknown = JSON.parse(String(r.grounding_sections ?? '[]'));
      if (Array.isArray(parsed)) sections = parsed.filter((s): s is string => typeof s === 'string');
    } catch {
      sections = [];
    }
    return {
      id: String(r.id),
      conversationId: String(r.conversation_id),
      createdAt: num(r.created_at),
      updatedAt: num(r.updated_at),
      question: String(r.question),
      source: r.source === 'manual' ? 'manual' : 'auto',
      status: (['pending', 'completed', 'failed', 'cancelled'] as const).find((s) => s === r.status) ?? 'pending',
      answer: strOrNull(r.answer),
      model: strOrNull(r.model),
      simulated: num(r.simulated) === 1,
      groundingKind: strOrNull(r.grounding_kind),
      groundingEvidence: strOrNull(r.grounding_evidence),
      groundingSections: sections,
      firstTokenMs: numOrNull(r.first_token_ms),
      durationMs: numOrNull(r.duration_ms),
      errorCode: strOrNull(r.error_code),
    };
  }

  async listConversations(opts: { limit: number; before?: number }): Promise<ConversationSummary[]> {
    const rows = (this.stmt.list?.all(opts.before ?? Number.MAX_SAFE_INTEGER, opts.limit) ?? []) as Row[];
    return rows.map((r) => this.toSummary(r));
  }

  async getConversation(id: string): Promise<{ conversation: ConversationSummary; cards: CardRecord[] } | null> {
    const row = this.stmt.getConversation?.get(id) as Row | undefined;
    if (!row) return null;
    const cards = ((this.stmt.cards?.all(id) ?? []) as Row[]).map((r) => this.toCard(r));
    return { conversation: this.toSummary(row), cards };
  }

  async renameConversation(id: string, title: string | null): Promise<boolean> {
    return num(this.stmt.rename?.run(title, id).changes ?? 0) > 0;
  }

  async deleteConversation(id: string): Promise<boolean> {
    const deleted = this.transaction(() => {
      this.stmt.deleteCards?.run(id);
      return num(this.stmt.deleteConversation?.run(id).changes ?? 0) > 0;
    });
    this.checkpoint();
    return deleted;
  }

  async deleteAll(): Promise<string[]> {
    const ids = this.transaction(() => {
      const all = ((this.stmt.allIds?.all() ?? []) as Row[]).map((r) => String(r.id));
      this.db.exec('DELETE FROM cards; DELETE FROM conversations;');
      return all;
    });
    this.checkpoint();
    return ids;
  }

  /** Moves WAL content into the main file and truncates the WAL, so deleted text is not left behind. */
  private checkpoint(): void {
    if (this.file !== ':memory:') this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  /** Column types of every table (used by privacy tests to prove no BLOB/audio columns exist). */
  columnTypes(): Array<{ table: string; column: string; type: string }> {
    const tables = (this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Row[]).map((r) => String(r.name));
    return tables.flatMap((t) =>
      (this.db.prepare(`SELECT name, type FROM pragma_table_info(?)`).all(t) as Row[]).map((c) => ({ table: t, column: String(c.name), type: String(c.type) })),
    );
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}

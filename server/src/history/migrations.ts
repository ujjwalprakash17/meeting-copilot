/**
 * Schema migrations, tracked with SQLite's built-in `PRAGMA user_version`.
 * Rules: never edit a released migration; append a new one with the next version number.
 * Each migration runs inside a transaction together with the user_version bump.
 */

export interface Migration {
  version: number;
  description: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'conversations and question/answer cards',
    sql: `
      CREATE TABLE conversations (
        id          TEXT PRIMARY KEY CHECK (length(id) = 36),
        title       TEXT CHECK (title IS NULL OR length(title) <= 120),
        started_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        simulated   INTEGER NOT NULL DEFAULT 0 CHECK (simulated IN (0, 1))
      ) STRICT;

      CREATE INDEX idx_conversations_updated ON conversations (updated_at DESC);

      CREATE TABLE cards (
        id                  TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
        conversation_id     TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL,
        question            TEXT NOT NULL,
        source              TEXT NOT NULL CHECK (source IN ('auto', 'manual')),
        status              TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
        answer              TEXT,
        model               TEXT,
        simulated           INTEGER NOT NULL DEFAULT 0 CHECK (simulated IN (0, 1)),
        grounding_kind      TEXT,
        grounding_evidence  TEXT,
        grounding_sections  TEXT NOT NULL DEFAULT '[]',
        first_token_ms      INTEGER,
        duration_ms         INTEGER,
        error_code          TEXT
      ) STRICT;

      CREATE INDEX idx_cards_conversation ON cards (conversation_id, created_at);
    `,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

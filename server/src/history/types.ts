/**
 * Conversation-history persistence contract. The SQLite implementation lives in SqliteHistoryRepository;
 * another backend (e.g. a hosted Postgres such as Supabase) can implement the same interface without
 * changes to the session pipeline or the extension.
 *
 * What is stored: question/answer cards and minimal metadata needed to show them again.
 * What is never stored: audio, transcripts, resume files or resume text, prompts, API keys.
 */

import type { CardRecord, ConversationSummary } from '@meeting-copilot/shared';

export type { CardRecord, CardStatus, ConversationSummary } from '@meeting-copilot/shared';

export interface ConversationUpsert {
  id: string;
  at: number;
  simulated: boolean;
}

export type HistoryOp = { kind: 'conversation'; value: ConversationUpsert } | { kind: 'card'; value: CardRecord };

export interface HistoryRepository {
  /** Applies a batch of upserts atomically. Older card versions never overwrite newer ones. */
  applyBatch(ops: HistoryOp[]): Promise<void>;
  listConversations(opts: { limit: number; before?: number }): Promise<ConversationSummary[]>;
  getConversation(id: string): Promise<{ conversation: ConversationSummary; cards: CardRecord[] } | null>;
  renameConversation(id: string, title: string | null): Promise<boolean>;
  /** Deletes the conversation and all of its cards in one transaction. */
  deleteConversation(id: string): Promise<boolean>;
  /** Deletes every conversation and card; returns the deleted conversation IDs. */
  deleteAll(): Promise<string[]>;
  close(): void;
}

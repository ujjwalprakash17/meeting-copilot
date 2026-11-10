/**
 * Supabase (hosted Postgres) implementation of the history repository.
 *
 * Schema, RLS policies and the batch function live in supabase/migrations. Every call runs as the signed-in
 * user (publishable key + user JWT), so Row Level Security restricts reads and writes to that user's rows;
 * the explicit user_id filters below only help the planner use the (user_id, …) indexes.
 */
import type { PostgrestError } from '@supabase/supabase-js';
import { AuthRequiredError, type SupabaseAccount } from '../account/SupabaseAccount.js';
import type { CardRecord, ConversationSummary, HistoryOp, HistoryRepository } from './types.js';

type Row = Record<string, unknown>;

const SUMMARY_COLUMNS = 'id, title, started_at, updated_at, simulated, card_count, first_question';
const STATUSES = ['pending', 'completed', 'failed', 'cancelled'] as const;

const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : 0);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function toSummary(r: Row): ConversationSummary {
  return {
    id: String(r.id),
    title: strOrNull(r.title),
    firstQuestion: strOrNull(r.first_question),
    startedAt: num(r.started_at),
    updatedAt: num(r.updated_at),
    simulated: r.simulated === true,
    cardCount: num(r.card_count),
  };
}

export function toCard(r: Row): CardRecord {
  const sections = Array.isArray(r.grounding_sections) ? r.grounding_sections.filter((s): s is string => typeof s === 'string') : [];
  return {
    id: String(r.id),
    conversationId: String(r.conversation_id),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    question: String(r.question ?? ''),
    source: r.source === 'manual' ? 'manual' : 'auto',
    status: STATUSES.find((s) => s === r.status) ?? 'pending',
    answer: strOrNull(r.answer),
    model: strOrNull(r.model),
    simulated: r.simulated === true,
    groundingKind: strOrNull(r.grounding_kind),
    groundingEvidence: strOrNull(r.grounding_evidence),
    groundingSections: sections,
    firstTokenMs: numOrNull(r.first_token_ms),
    durationMs: numOrNull(r.duration_ms),
    errorCode: strOrNull(r.error_code),
  };
}

/** Splits a batch into the two JSON arrays expected by public.apply_history_batch(). */
export function toBatchPayload(ops: HistoryOp[]): { p_conversations: unknown[]; p_cards: CardRecord[] } {
  const p_conversations: unknown[] = [];
  const p_cards: CardRecord[] = [];
  for (const op of ops) {
    if (op.kind === 'conversation') p_conversations.push({ id: op.value.id, at: op.value.at, simulated: op.value.simulated });
    else p_cards.push(op.value);
  }
  return { p_conversations, p_cards };
}

function dbError(error: PostgrestError): Error {
  // Expired/invalid JWT or our own "Not signed in" guard (SQLSTATE 28000).
  if (error.code === '28000' || error.code === 'PGRST301' || error.code === 'PGRST303' || /jwt/i.test(error.message)) return new AuthRequiredError();
  return new Error(`Supabase: ${error.message}${error.code ? ` (${error.code})` : ''}`);
}

export class SupabaseHistoryRepository implements HistoryRepository {
  constructor(readonly account: SupabaseAccount) {}

  private get db() {
    return this.account.client;
  }

  async applyBatch(ops: HistoryOp[]): Promise<void> {
    if (ops.length === 0) return;
    await this.account.requireUserId();
    const { error } = await this.db.rpc('apply_history_batch', toBatchPayload(ops));
    if (error) throw dbError(error);
  }

  async listConversations(opts: { limit: number; before?: number }): Promise<ConversationSummary[]> {
    const uid = await this.account.requireUserId();
    const { data, error } = await this.db
      .from('conversation_summaries')
      .select(SUMMARY_COLUMNS)
      .eq('user_id', uid)
      .lt('updated_at', opts.before ?? Number.MAX_SAFE_INTEGER)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(opts.limit);
    if (error) throw dbError(error);
    return ((data ?? []) as Row[]).map(toSummary);
  }

  async getConversation(id: string): Promise<{ conversation: ConversationSummary; cards: CardRecord[] } | null> {
    const uid = await this.account.requireUserId();
    const [summary, cards] = await Promise.all([
      this.db.from('conversation_summaries').select(SUMMARY_COLUMNS).eq('user_id', uid).eq('id', id).maybeSingle(),
      this.db.from('cards').select('*').eq('user_id', uid).eq('conversation_id', id).order('created_at').order('id'),
    ]);
    if (summary.error) throw dbError(summary.error);
    if (cards.error) throw dbError(cards.error);
    if (!summary.data) return null;
    return { conversation: toSummary(summary.data as Row), cards: ((cards.data ?? []) as Row[]).map(toCard) };
  }

  async renameConversation(id: string, title: string | null): Promise<boolean> {
    const uid = await this.account.requireUserId();
    const { data, error } = await this.db.from('conversations').update({ title }).eq('user_id', uid).eq('id', id).select('id');
    if (error) throw dbError(error);
    return (data ?? []).length > 0;
  }

  async deleteConversation(id: string): Promise<boolean> {
    const uid = await this.account.requireUserId();
    // Cards are removed by ON DELETE CASCADE in the same statement (one transaction).
    const { data, error } = await this.db.from('conversations').delete().eq('user_id', uid).eq('id', id).select('id');
    if (error) throw dbError(error);
    return (data ?? []).length > 0;
  }

  async deleteAll(): Promise<string[]> {
    await this.account.requireUserId();
    const { data, error } = await this.db.rpc('delete_all_history');
    if (error) throw dbError(error);
    const rows = (Array.isArray(data) ? data : []) as unknown[];
    return rows.map((r) => (typeof r === 'string' ? r : String((r as Row)?.delete_all_history ?? (r as Row)?.id ?? ''))).filter(Boolean);
  }

  close(): void {
    this.account.close();
  }
}

/** Conversation history records as returned by the local server's /api/history endpoints. */

export type CardStatus = 'pending' | 'completed' | 'failed' | 'cancelled';

export interface CardRecord {
  id: string;
  conversationId: string;
  createdAt: number;
  updatedAt: number;
  question: string;
  source: 'auto' | 'manual';
  status: CardStatus;
  answer: string | null;
  model: string | null;
  simulated: boolean;
  groundingKind: string | null;
  groundingEvidence: string | null;
  /** Resume section names used (e.g. ["Experience"]); never excerpt contents. */
  groundingSections: string[];
  firstTokenMs: number | null;
  durationMs: number | null;
  errorCode: string | null;
}

export interface ConversationSummary {
  id: string;
  title: string | null;
  /** First question, used as a fallback title. */
  firstQuestion: string | null;
  startedAt: number;
  updatedAt: number;
  simulated: boolean;
  cardCount: number;
}

export type HistoryBackend = 'sqlite' | 'supabase';

export interface ConversationListResponse {
  conversations: ConversationSummary[];
  /** Absolute path of the SQLite database file on the machine running the server (null for Supabase). */
  dbPath: string | null;
  /** Where history is stored. Older servers omit it (= sqlite). */
  backend?: HistoryBackend;
}

/** GET /api/auth/config: how the extension should sign users in. Public values only (no secrets). */
export interface AuthConfigResponse {
  backend: HistoryBackend;
  /** True when this server requires a signed-in user for sessions and API calls. */
  authRequired: boolean;
  /** Supabase project URL and publishable key; null for servers without accounts. */
  supabaseUrl: string | null;
  supabasePublishableKey: string | null;
}

export interface ConversationDetailResponse {
  conversation: ConversationSummary;
  cards: CardRecord[];
}

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

/** GET /api/account: the Supabase user signed in on the local server. Never contains tokens. */
export interface AccountStatus {
  backend: HistoryBackend;
  /** True when the server is set up for Supabase (HISTORY_BACKEND=supabase with URL and key). */
  configured: boolean;
  signedIn: boolean;
  email: string | null;
  userId: string | null;
  projectUrl: string | null;
  /** Sign-up only: the user must open the confirmation email before signing in. */
  needsConfirmation?: boolean;
}

export interface ConversationDetailResponse {
  conversation: ConversationSummary;
  cards: CardRecord[];
}

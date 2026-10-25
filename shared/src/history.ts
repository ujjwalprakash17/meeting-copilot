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

export interface ConversationListResponse {
  conversations: ConversationSummary[];
  /** Absolute path of the SQLite database file on the machine running the server. */
  dbPath: string | null;
}

export interface ConversationDetailResponse {
  conversation: ConversationSummary;
  cards: CardRecord[];
}

import { z } from 'zod';

/** Audio format the extension streams to the server and the server forwards to the STT provider. */
export const AUDIO_FORMAT = {
  encoding: 'linear16',
  sampleRate: 16_000,
  channels: 1,
} as const;

/**
 * 40 ms of 16 kHz mono PCM16 per binary frame. Smaller frames reach the transcriber sooner (worst-case
 * buffering before send drops from ~100 ms to ~40 ms) at 25 small WebSocket messages per second.
 */
export const AUDIO_CHUNK_SAMPLES = 640;

/** Hard limits shared by both ends so validation is symmetrical. */
export const LIMITS = {
  /** Max size of a single WebSocket message (JSON or binary). */
  maxMessageBytes: 256 * 1024,
  /** Max size of a single binary audio frame. */
  maxAudioFrameBytes: 64 * 1024,
  maxBackgroundChars: 8_000,
  maxNotesChars: 20_000,
  maxKeywords: 50,
  maxKeywordChars: 60,
  maxQuestionChars: 2_000,
  /** Extracted resume text (not the file) — roughly 10+ pages of dense text. */
  maxResumeChars: 40_000,
  /** Upload size limit for resume files. */
  maxResumeFileBytes: 5 * 1024 * 1024,
  /** Rolling transcript kept on server and client. */
  maxTranscriptSegments: 500,
  /** Question/answer cards kept in UI state. */
  maxQuestionCards: 50,
} as const;

export const AnswerModeSchema = z.enum(['auto', 'manual']);
export type AnswerMode = z.infer<typeof AnswerModeSchema>;

export const AnswerStyleSchema = z.enum(['concise', 'detailed', 'technical', 'step-by-step']);
export type AnswerStyle = z.infer<typeof AnswerStyleSchema>;

export const AnswerLengthSchema = z.enum(['short', 'medium', 'long']);
export type AnswerLength = z.infer<typeof AnswerLengthSchema>;

/** RFC 4122 UUID (any version), lower or upper case. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Per-session configuration sent with `audio.start` and `config.update`.
 * Everything here except conversationId may be sent to the LLM provider; the UI shows exactly which parts.
 */
export const SessionConfigSchema = z.object({
  answerMode: AnswerModeSchema,
  answerStyle: AnswerStyleSchema,
  answerLength: AnswerLengthSchema,
  /** Optional professional background written by the user. */
  background: z.string().max(LIMITS.maxBackgroundChars),
  /** Optional project notes / knowledge written by the user. */
  notes: z.string().max(LIMITS.maxNotesChars),
  /** Keywords to highlight; also passed to the STT provider as recognition hints where supported. */
  keywords: z.array(z.string().min(1).max(LIMITS.maxKeywordChars)).max(LIMITS.maxKeywords),
  /** BCP-47-ish language code for transcription. */
  language: z.string().min(2).max(16),
  /** Ask the STT provider for diarization (estimated speaker labels on mixed audio). */
  diarize: z.boolean(),
  /** How many recent finalized transcript segments to include as answer context. */
  contextSegments: z.number().int().min(0).max(60),
  /**
   * Conversation that this session's question/answer cards are saved under (local SQLite history).
   * Omitted = nothing is saved for this session.
   */
  conversationId: z.string().regex(UUID_RE).optional(),
  /**
   * Extracted resume text. Held in memory by the local server for this session only;
   * only the excerpts relevant to a given question are sent to the LLM provider.
   * Never written to the history database.
   */
  resume: z
    .object({
      fileName: z.string().min(1).max(255),
      text: z.string().min(1).max(LIMITS.maxResumeChars),
    })
    .nullable(),
});
export type SessionConfig = z.infer<typeof SessionConfigSchema>;

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  answerMode: 'auto',
  answerStyle: 'concise',
  answerLength: 'short',
  background: '',
  notes: '',
  keywords: [],
  language: 'en',
  diarize: false,
  contextSegments: 8,
  resume: null,
};

export const RESUME_FILE_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
} as const;
export type ResumeFileKind = keyof typeof RESUME_FILE_TYPES;

/** Response of POST /api/resume/extract. */
export interface ResumeExtractResponse {
  fileName: string;
  kind: ResumeFileKind;
  text: string;
  chars: number;
  /** Section headings detected in the text (e.g. Experience, Skills). */
  sections: string[];
  /** Non-fatal extraction notes (e.g. truncated, few characters per page). */
  warnings: string[];
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

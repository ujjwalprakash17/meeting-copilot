/**
 * WebSocket event contract between the extension (offscreen document) and the server.
 *
 * Framing:
 *  - JSON text frames carry the events below (validated with zod on receipt).
 *  - Binary frames are `audio.chunk`: raw little-endian PCM16, mono, 16 kHz (see AUDIO_FORMAT),
 *    belonging to the session started by the most recent `audio.start` on that socket.
 *    Binary is used instead of base64-in-JSON to avoid ~33% overhead and JSON parsing per chunk.
 */
import { z } from 'zod';
import { LIMITS, SessionConfigSchema } from './config.js';

const id = z.string().min(1).max(64);
const ts = z.number().int().nonnegative();

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export const AudioStartSchema = z.object({
  type: z.literal('audio.start'),
  sessionId: id,
  /** `simulation` replays a scripted transcript instead of transcribing audio. */
  mode: z.enum(['live', 'simulation']),
  audio: z.object({
    encoding: z.literal('linear16'),
    sampleRate: z.literal(16_000),
    channels: z.literal(1),
  }),
  config: SessionConfigSchema,
  /**
   * Sent when the extension reconnects mid-meeting: the new server session continues the transcript
   * timeline (instead of restarting at 0:00) and numbers new speaker labels after the ones already shown,
   * because the transcriber's speaker IDs restart on every new connection.
   */
  continuation: z
    .object({
      timelineOffsetMs: z.number().nonnegative().max(24 * 3_600_000),
      speakerOffset: z.number().int().min(0).max(1_000),
    })
    .optional(),
  ts,
});

export const AudioStopSchema = z.object({
  type: z.literal('audio.stop'),
  sessionId: id,
  ts,
});

export const AnswerRequestSchema = z.object({
  type: z.literal('answer.request'),
  requestId: id,
  /** Explicit question text. When omitted the server uses the most recent utterance. */
  questionText: z.string().min(1).max(LIMITS.maxQuestionChars).optional(),
  ts,
});

export const AnswerRetrySchema = z.object({
  type: z.literal('answer.retry'),
  questionId: id,
  requestId: id,
  ts,
});

/** Client report: the first answer text for a request was rendered (latency instrumentation). */
export const AnswerDisplayedSchema = z.object({
  type: z.literal('answer.displayed'),
  requestId: id,
  displayedAt: ts,
  ts,
});

export const AnswerCancelSchema = z.object({
  type: z.literal('answer.cancel'),
  requestId: id,
  ts,
});

export const ConfigUpdateSchema = z.object({
  type: z.literal('config.update'),
  config: SessionConfigSchema,
  ts,
});

export const ClientEventSchema = z.discriminatedUnion('type', [
  AudioStartSchema,
  AudioStopSchema,
  AnswerRequestSchema,
  AnswerRetrySchema,
  AnswerCancelSchema,
  AnswerDisplayedSchema,
  ConfigUpdateSchema,
]);
export type ClientEvent = z.infer<typeof ClientEventSchema>;
export type AudioStartEvent = z.infer<typeof AudioStartSchema>;

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export const TranscriptSegmentSchema = z.object({
  id,
  text: z.string(),
  /** Offsets from the start of the audio stream, in ms (provider timestamps). */
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  /**
   * Estimated speaker label from diarization of the mixed tab audio.
   * This is NOT speaker identification: tab capture yields one mixed stream.
   */
  speaker: z.number().int().nonnegative().optional(),
  /** Provider indicated the speaker paused (end of utterance). */
  speechFinal: z.boolean(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

export const DetectedQuestionSchema = z.object({
  id,
  text: z.string(),
  /** Statements immediately preceding the question in the same utterance. */
  context: z.string().optional(),
  segmentIds: z.array(id),
  source: z.enum(['auto', 'manual']),
  confidence: z.number().min(0).max(1),
  isFollowUp: z.boolean(),
  detectedAt: ts,
  /**
   * Latency reference point: server time when the transcript first contained the complete question
   * text (from a partial or final result). For manual requests: when the request was received.
   */
  textAvailableAt: ts,
  /**
   * Detected from an interim (not yet finalized) transcript. Its answer is a tentative draft until a
   * question.updated "confirmed" event arrives; a "retracted" event discards it.
   */
  speculative: z.boolean().default(false),
});
export type DetectedQuestion = z.infer<typeof DetectedQuestionSchema>;

export const AnswerContextInfoSchema = z.object({
  transcriptSegments: z.number().int().nonnegative(),
  includesBackground: z.boolean(),
  includesNotes: z.boolean(),
  includesPreviousQa: z.boolean(),
  promptChars: z.number().int().nonnegative(),
});

/**
 * How the answer relates to the user's resume / personal knowledge.
 *  - kind: whether the question is about the user's own background.
 *  - evidence: strength of matching resume excerpts ("no_resume" when none was provided).
 * Section names are shown in the UI; excerpt contents are not.
 */
export const AnswerGroundingSchema = z.object({
  kind: z.enum(['general', 'personal', 'mixed']),
  evidence: z.enum(['strong', 'weak', 'none', 'no_resume', 'not_needed']),
  excerptCount: z.number().int().nonnegative(),
  sections: z.array(z.string()),
});
export type AnswerGrounding = z.infer<typeof AnswerGroundingSchema>;
export type AnswerContextInfo = z.infer<typeof AnswerContextInfoSchema>;

export const ErrorCodeSchema = z.enum([
  'bad_message',
  'not_started',
  'already_started',
  'stt_not_configured',
  'stt_auth_failed',
  'stt_error',
  'stt_reconnecting',
  'llm_not_configured',
  'invalid_credentials',
  'rate_limited',
  'timeout',
  'network',
  'refused',
  'provider_error',
  'audio_rate_exceeded',
  'history_write_failed',
  'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

const ServerBase = { ts };

export const ServerEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('session.ready'),
    sessionId: id,
    stt: z.object({ provider: z.string(), simulated: z.boolean() }),
    llm: z.object({ provider: z.string(), model: z.string(), simulated: z.boolean() }),
    ...ServerBase,
  }),
  z.object({
    type: z.literal('session.status'),
    state: z.enum(['transcriber_connected', 'transcriber_reconnecting', 'transcriber_closed']),
    message: z.string(),
    ...ServerBase,
  }),
  z.object({
    type: z.literal('session.error'),
    code: ErrorCodeSchema,
    message: z.string(),
    fatal: z.boolean(),
    ...ServerBase,
  }),
  z.object({
    type: z.literal('session.ended'),
    sessionId: id,
    ...ServerBase,
  }),
  z.object({
    type: z.literal('transcript.partial'),
    text: z.string(),
    startMs: z.number().nonnegative(),
    endMs: z.number().nonnegative(),
    simulated: z.boolean(),
    ...ServerBase,
  }),
  z.object({
    type: z.literal('transcript.final'),
    segment: TranscriptSegmentSchema,
    simulated: z.boolean(),
    ...ServerBase,
  }),
  z.object({
    type: z.literal('question.detected'),
    question: DetectedQuestionSchema,
    ...ServerBase,
  }),
  z.object({
    type: z.literal('question.updated'),
    questionId: id,
    status: z.enum(['confirmed', 'retracted']),
    /** Final wording (confirmed) — may differ slightly from the interim text. */
    text: z.string().optional(),
    ...ServerBase,
  }),
  z.object({
    type: z.literal('answer.start'),
    requestId: id,
    questionId: id,
    model: z.string(),
    simulated: z.boolean(),
    context: AnswerContextInfoSchema,
    grounding: AnswerGroundingSchema,
    ...ServerBase,
  }),
  z.object({
    type: z.literal('answer.delta'),
    requestId: id,
    delta: z.string(),
    ...ServerBase,
  }),
  z.object({
    type: z.literal('answer.completed'),
    requestId: id,
    /** Time from request to first streamed token, measured on the server. */
    firstTokenMs: z.number().nonnegative().nullable(),
    durationMs: z.number().nonnegative(),
    ...ServerBase,
  }),
  z.object({
    type: z.literal('answer.error'),
    requestId: id,
    questionId: id,
    code: ErrorCodeSchema,
    message: z.string(),
    retryable: z.boolean(),
    ...ServerBase,
  }),
  z.object({
    type: z.literal('answer.cancelled'),
    requestId: id,
    questionId: id,
    reason: z.enum(['superseded', 'user', 'session_ended', 'speculation_rejected']),
    ...ServerBase,
  }),
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;
export type ServerEventOf<T extends ServerEvent['type']> = Extract<ServerEvent, { type: T }>;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function parseJson<T>(schema: z.ZodType<T>, raw: string): ParseResult<T> {
  if (raw.length > LIMITS.maxMessageBytes) return { ok: false, error: 'Message too large' };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Malformed JSON' };
  }
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    return { ok: false, error: `Invalid message: ${issue ? `${issue.path.join('.') || '(root)'} ${issue.message}` : 'unknown'}` };
  }
  return { ok: true, value: result.data };
}

export const parseClientEvent = (raw: string): ParseResult<ClientEvent> => parseJson(ClientEventSchema, raw);
export const parseServerEvent = (raw: string): ParseResult<ServerEvent> => parseJson(ServerEventSchema, raw);

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Load server/.env first, then the repo-root .env (works from src/ with tsx and from dist/ after build).
const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: [path.resolve(here, '../.env'), path.resolve(here, '../../.env')], quiet: true });

export type SttProviderName = 'deepgram';
export type LlmProviderName = 'groq' | 'mock';

export interface ServerConfig {
  host: string;
  port: number;
  /** Extension IDs allowed to connect. Empty = any chrome-extension:// origin (local development). */
  allowedExtensionIds: string[];
  /** Allow connections without an Origin header (CLI tools, tests). */
  allowNoOrigin: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Opt-in: log transcript text. Off by default for privacy. */
  logTranscripts: boolean;
  stt: {
    provider: SttProviderName;
    deepgramApiKey: string | null;
    deepgramModel: string;
    endpointingMs: number;
    utteranceEndMs: number;
  };
  llm: {
    provider: LlmProviderName;
    groqApiKey: string | null;
    groqModel: string;
    /** Small, fast model used only to classify ambiguous question candidates. Empty disables. */
    groqDetectionModel: string | null;
    timeoutMs: number;
    maxAnswerTokens: number;
    reasoningEffort?: 'none' | 'default' | 'low' | 'medium' | 'high' | null;
  };
  detection: {
    /** Silence after the last finalized segment before an utterance is evaluated. */
    debounceMs: number;
    /** Window in which near-identical questions are treated as duplicates. */
    dedupeWindowMs: number;
  };
  /** Speed multiplier for the scripted simulator (1 = real time). */
  simulationSpeed: number;
  latency?: LatencyConfig;
  history?: HistoryConfig;
}

export interface LatencyConfig {
  /** Start a tentative answer from interim transcripts when the question is already clear. */
  speculative: boolean;
  speculationMinScore: number;
  /** Deadline for the optional ambiguous-question classifier. */
  classifierTimeoutMs: number;
  /** A short follow-on fragment within this window of a question still being answered is merged into it. */
  continuationWindowMs: number;
}

export interface HistoryConfig {
  enabled: boolean;
  dbPath: string;
}

export const DEFAULT_LATENCY: LatencyConfig = { speculative: true, speculationMinScore: 2, classifierTimeoutMs: 1_500, continuationWindowMs: 2_000 };

const str = (name: string): string | null => {
  const v = process.env[name]?.trim();
  return v ? v : null;
};
const num = (name: string, fallback: number): number => {
  const v = str(name);
  if (v === null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be a number (got "${v}")`);
  return n;
};
const bool = (name: string, fallback: boolean): boolean => {
  const v = str(name);
  return v === null ? fallback : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
};

/** Placeholder values copied from .env.example are treated as "not configured". */
const secret = (name: string): string | null => {
  const v = str(name);
  return v && !/^replace_with|^your_|^<|changeme/i.test(v) ? v : null;
};

export function loadConfig(): ServerConfig {
  const llmProvider = (str('LLM_PROVIDER') ?? 'groq') as LlmProviderName;
  if (!['groq', 'mock'].includes(llmProvider)) throw new Error(`Unsupported LLM_PROVIDER "${llmProvider}" (use groq or mock)`);
  const sttProvider = (str('STT_PROVIDER') ?? 'deepgram') as SttProviderName;
  if (sttProvider !== 'deepgram') throw new Error(`Unsupported STT_PROVIDER "${sttProvider}" (use deepgram)`);
  // An unknown level would silently disable every log line, errors included.
  const logLevel = (str('LOG_LEVEL')?.toLowerCase() ?? 'info') as ServerConfig['logLevel'];
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) throw new Error(`LOG_LEVEL must be debug, info, warn or error (got "${logLevel}")`);

  return {
    host: str('HOST') ?? '127.0.0.1',
    port: num('PORT', 8787),
    allowedExtensionIds: (str('ALLOWED_EXTENSION_IDS') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    allowNoOrigin: bool('ALLOW_NO_ORIGIN', false),
    logLevel: ['debug', 'info', 'warn', 'error'].includes(logLevel) ? logLevel : 'info',
    logTranscripts: bool('LOG_TRANSCRIPTS', false),
    stt: {
      provider: sttProvider,
      deepgramApiKey: secret('DEEPGRAM_API_KEY'),
      deepgramModel: str('DEEPGRAM_MODEL') ?? 'nova-3',
      endpointingMs: num('DEEPGRAM_ENDPOINTING_MS', 300),
      utteranceEndMs: num('DEEPGRAM_UTTERANCE_END_MS', 1000),
    },
    llm: {
      provider: llmProvider,
      groqApiKey: secret('GROQ_API_KEY'),
      groqModel: str('GROQ_MODEL') ?? 'openai/gpt-oss-120b',
      groqDetectionModel: process.env.GROQ_DETECTION_MODEL === undefined ? 'openai/gpt-oss-20b' : str('GROQ_DETECTION_MODEL'),
      timeoutMs: num('LLM_TIMEOUT_MS', 30_000),
      maxAnswerTokens: num('LLM_MAX_ANSWER_TOKENS', 700),
      reasoningEffort: (() => {
        const v = str('GROQ_REASONING_EFFORT');
        if (v === null) return null;
        if (!['none', 'default', 'low', 'medium', 'high'].includes(v)) throw new Error(`GROQ_REASONING_EFFORT must be none, default, low, medium or high (got "${v}")`);
        return v as NonNullable<ServerConfig['llm']['reasoningEffort']>;
      })(),
    },
    detection: {
      debounceMs: num('QUESTION_DEBOUNCE_MS', 1_200),
      dedupeWindowMs: num('QUESTION_DEDUPE_WINDOW_MS', 120_000),
    },
    simulationSpeed: num('SIMULATION_SPEED', 1),
    latency: {
      speculative: bool('SPECULATIVE_ANSWERS', DEFAULT_LATENCY.speculative),
      speculationMinScore: num('SPECULATION_MIN_SCORE', DEFAULT_LATENCY.speculationMinScore),
      classifierTimeoutMs: num('CLASSIFIER_TIMEOUT_MS', DEFAULT_LATENCY.classifierTimeoutMs),
      continuationWindowMs: num('CONTINUATION_WINDOW_MS', DEFAULT_LATENCY.continuationWindowMs),
    },
    history: {
      enabled: bool('HISTORY_ENABLED', true),
      dbPath: path.resolve(str('HISTORY_DB_PATH') ?? path.resolve(here, '../data/history.sqlite')),
    },
  };
}

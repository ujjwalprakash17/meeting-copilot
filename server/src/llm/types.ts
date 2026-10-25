import type { ErrorCode } from '@meeting-copilot/shared';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  messages: LlmMessage[];
  maxTokens: number;
  signal: AbortSignal;
  temperature?: number;
}

export interface LlmStatus {
  provider: string;
  model: string;
  configured: boolean;
  simulated: boolean;
  /** Result of the last model-availability check, if one ran. */
  verified: boolean | null;
  message: string;
}

/** LLM provider abstraction: the answer pipeline only depends on this interface. */
export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  readonly simulated: boolean;
  isConfigured(): boolean;
  /** Streams text deltas. Throws LlmError. */
  stream(request: LlmRequest): AsyncIterable<string>;
  /** Single JSON-object completion on the (small, fast) detection model. Null when unavailable. */
  classifyJson?(request: LlmRequest): Promise<unknown>;
  /**
   * Opens (or keeps open) the HTTPS connection to the provider so the next answer request does not pay
   * DNS/TCP/TLS setup. Must be cheap, throttled, non-blocking and never send meeting content.
   */
  warmup?(): void;
  status(): LlmStatus;
}

export class LlmError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
    /** Safe provider metadata for diagnostics (HTTP status, provider request id). */
    readonly details: { status?: number; providerRequestId?: string } = {},
  ) {
    super(message);
    this.name = 'LlmError';
  }

  get status(): number | undefined {
    return this.details.status;
  }

  get providerRequestId(): string | undefined {
    return this.details.providerRequestId;
  }
}

/**
 * Groq LLM provider (OpenAI-compatible chat completions API via the official `groq-sdk`).
 * Docs: https://console.groq.com/docs/text-chat, models: https://console.groq.com/docs/models
 * The API key lives only in the server environment (GROQ_API_KEY).
 */
import Groq from 'groq-sdk';
import { Agent, fetch as undiciFetch } from 'undici';
import { elapsedMs, monotonicNow } from '@meeting-copilot/shared';
import { log } from '../logger.js';
import { LlmError, type LlmProvider, type LlmRequest, type LlmStatus } from './types.js';

export interface GroqOptions {
  apiKey: string | null;
  model: string;
  detectionModel: string | null;
  timeoutMs: number;
  /** Sent as reasoning_effort when set; gpt-oss models default to "low" to keep time to first token short. */
  reasoningEffort?: 'none' | 'default' | 'low' | 'medium' | 'high' | null;
}

/**
 * Connection pool with a long keep-alive. Measured from the development machine (bench:network):
 * Node's default pool closes idle sockets after ~4 s, so a question asked 6-30 s after the previous
 * request paid ~170-350 ms extra for a new TLS connection; with this agent the connection was reused.
 */
const groqAgent = new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 120_000, connections: 8 });
const keepAliveFetch = ((input: string | URL | Request, init?: RequestInit) =>
  undiciFetch(input as string, { ...(init as object), dispatcher: groqAgent })) as unknown as typeof fetch;

const WARMUP_MIN_INTERVAL_MS = 20_000;

/**
 * Reasoning models (openai/gpt-oss-*, or any model with reasoning_effort set) count their hidden reasoning
 * tokens against max_completion_tokens. Without headroom a short answer cap (220) or the classifier's 30
 * tokens can be used up by reasoning, truncating the answer or leaving no JSON at all.
 */
export const REASONING_TOKEN_ALLOWANCE = 512;

/** Safe diagnostic metadata from a Groq API error: HTTP status and Groq's request id (never headers or bodies). */
function errorDetails(err: InstanceType<typeof Groq.APIError>): { status?: number; providerRequestId?: string } {
  const requestId = err.headers?.get?.('x-request-id') ?? undefined;
  return { ...(typeof err.status === 'number' ? { status: err.status } : {}), ...(requestId ? { providerRequestId: requestId } : {}) };
}

export function mapGroqError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  if (err instanceof Groq.APIUserAbortError) return new LlmError('timeout', 'The request was cancelled or timed out.', true);
  if (err instanceof Groq.AuthenticationError || err instanceof Groq.PermissionDeniedError) {
    return new LlmError('invalid_credentials', 'Groq rejected the API key. Check GROQ_API_KEY in the server .env file.', false, undefined, errorDetails(err));
  }
  if (err instanceof Groq.RateLimitError) {
    const retryAfter = Number(err.headers?.get('retry-after'));
    const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
    return new LlmError(
      'rate_limited',
      `Groq rate limit reached${retryAfterMs ? `; retry in ~${Math.ceil(retryAfterMs / 1000)} s` : ''}.`,
      true,
      retryAfterMs,
      errorDetails(err),
    );
  }
  if (err instanceof Groq.NotFoundError) {
    return new LlmError('provider_error', 'Groq model not found. Set GROQ_MODEL to a currently supported model (see console.groq.com/docs/models).', false, undefined, errorDetails(err));
  }
  if (err instanceof Groq.BadRequestError) {
    return new LlmError('provider_error', `Groq rejected the request: ${err.message}`, false, undefined, errorDetails(err));
  }
  if (err instanceof Groq.APIConnectionTimeoutError) return new LlmError('timeout', 'Groq did not respond in time.', true);
  if (err instanceof Groq.APIConnectionError) return new LlmError('network', 'Could not reach Groq (network error).', true);
  if (err instanceof Groq.APIError) {
    const status = typeof err.status === 'number' ? err.status : 0;
    return new LlmError('provider_error', `Groq error${status ? ` (HTTP ${status})` : ''}: ${err.message}`, status >= 500 || status === 0, undefined, errorDetails(err));
  }
  if (err instanceof Error && err.name === 'AbortError') return new LlmError('timeout', 'The request was cancelled or timed out.', true);
  return new LlmError('provider_error', err instanceof Error ? err.message : 'Unknown Groq error', true);
}

export class GroqProvider implements LlmProvider {
  readonly name = 'groq';
  readonly simulated = false;
  private readonly client: Groq | null;
  private verified: boolean | null = null;
  private verifyMessage = '';

  private lastNetworkAt = 0;

  constructor(private readonly opts: GroqOptions) {
    // maxRetries 1: a meeting suggestion that arrives 20 s late is not useful, so fail fast.
    this.client = opts.apiKey ? new Groq({ apiKey: opts.apiKey, timeout: opts.timeoutMs, maxRetries: 1, fetch: keepAliveFetch }) : null;
  }

  /** Keeps a warm HTTPS connection: a lightweight GET /models (no meeting content), throttled. */
  warmup(): void {
    if (!this.client || Date.now() - this.lastNetworkAt < WARMUP_MIN_INTERVAL_MS) return;
    this.lastNetworkAt = Date.now();
    void this.client.models.list({ timeout: 5_000, maxRetries: 0 }).catch(() => undefined);
  }

  /** Request parameters for reasoning models: keep reasoning short and out of the streamed answer. */
  private reasoningParams(model: string): { reasoning_effort?: GroqOptions['reasoningEffort']; include_reasoning?: boolean } {
    if (model.startsWith('openai/gpt-oss')) return { reasoning_effort: this.opts.reasoningEffort ?? 'low', include_reasoning: false };
    return this.opts.reasoningEffort ? { reasoning_effort: this.opts.reasoningEffort } : {};
  }

  /** Completion budget: the visible-output cap plus reasoning headroom for reasoning models. */
  completionBudget(model: string, maxTokens: number): number {
    const effort = this.reasoningParams(model).reasoning_effort;
    return effort && effort !== 'none' ? maxTokens + REASONING_TOKEN_ALLOWANCE : maxTokens;
  }

  get model(): string {
    return this.opts.model;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  /** Confirms the API key works and the configured models are currently offered by Groq. */
  async verify(): Promise<void> {
    if (!this.client) return;
    const groqLog = log.child('groq');
    const t0 = monotonicNow();
    try {
      const list = await this.client.models.list();
      const ids = new Set(list.data.map((m) => m.id));
      const missing = [this.opts.model, this.opts.detectionModel].filter((m): m is string => Boolean(m) && !ids.has(m as string));
      this.verified = missing.length === 0;
      this.verifyMessage = this.verified
        ? `Groq models available: ${[this.opts.model, this.opts.detectionModel].filter(Boolean).join(', ')}`
        : `Model(s) not offered by this Groq account: ${missing.join(', ')}. Update GROQ_MODEL / GROQ_DETECTION_MODEL.`;
      if (this.verified) groqLog.info('models_verified', { model: this.opts.model, detection_model: this.opts.detectionModel ?? 'off', duration_ms: elapsedMs(t0) });
      else groqLog.error('models_unavailable', { missing: missing.join(','), recovery: 'set GROQ_MODEL / GROQ_DETECTION_MODEL' });
    } catch (err) {
      this.verified = false;
      const e = mapGroqError(err);
      this.verifyMessage = e.message;
      groqLog.error('verify_failed', { code: e.code, status: e.status, provider_request_id: e.providerRequestId, err: e.message, duration_ms: elapsedMs(t0) });
    }
  }

  status(): LlmStatus {
    return {
      provider: this.name,
      model: this.opts.model,
      configured: this.isConfigured(),
      simulated: false,
      verified: this.verified,
      message: !this.client
        ? 'GROQ_API_KEY is not set on the server.'
        : this.verifyMessage || 'Configured (model availability not checked yet).',
    };
  }

  async *stream(request: LlmRequest): AsyncIterable<string> {
    if (!this.client) throw new LlmError('llm_not_configured', 'GROQ_API_KEY is not set on the server.', false);
    let stream;
    this.lastNetworkAt = Date.now();
    try {
      stream = await this.client.chat.completions.create(
        {
          model: this.opts.model,
          messages: request.messages,
          stream: true,
          max_completion_tokens: this.completionBudget(this.opts.model, request.maxTokens),
          temperature: request.temperature ?? 0.3,
          ...this.reasoningParams(this.opts.model),
        },
        { signal: request.signal },
      );
    } catch (err) {
      throw mapGroqError(err);
    }
    try {
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) yield delta;
      }
    } catch (err) {
      throw mapGroqError(err);
    }
  }

  async classifyJson(request: LlmRequest): Promise<unknown> {
    if (!this.client || !this.opts.detectionModel) return null;
    try {
      const res = await this.client.chat.completions.create(
        {
          model: this.opts.detectionModel,
          messages: request.messages,
          max_completion_tokens: this.completionBudget(this.opts.detectionModel, request.maxTokens),
          temperature: 0,
          response_format: { type: 'json_object' },
          ...this.reasoningParams(this.opts.detectionModel),
        },
        { signal: request.signal, maxRetries: 0 },
      );
      const content = res.choices[0]?.message?.content;
      return content ? JSON.parse(content) : null;
    } catch (err) {
      throw mapGroqError(err);
    }
  }
}

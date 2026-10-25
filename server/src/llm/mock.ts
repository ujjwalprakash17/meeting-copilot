/**
 * Mock LLM for offline testing (LLM_PROVIDER=mock). Its output is deterministic, clearly
 * labelled as test output, and never presented as an AI-generated answer.
 */
import { LlmError, type LlmProvider, type LlmRequest, type LlmStatus } from './types.js';

export const MOCK_PREFIX = '[TEST MODE: mock LLM, not an AI answer]';

export class MockLlmProvider implements LlmProvider {
  readonly name = 'mock';
  readonly model = 'mock-llm';
  readonly simulated = true;

  /**
   * @param delayMs delay between streamed words
   * @param firstTokenDelayMs delay before the first word (models provider time to first token)
   */
  constructor(
    private readonly delayMs = 25,
    private readonly firstTokenDelayMs = 0,
  ) {}

  isConfigured(): boolean {
    return true;
  }

  status(): LlmStatus {
    return { provider: this.name, model: this.model, configured: true, simulated: true, verified: true, message: 'Mock provider (test mode)' };
  }

  async *stream(request: LlmRequest): AsyncIterable<string> {
    const user = request.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
    const question = /<question>\s*([\s\S]*?)\s*<\/question>/.exec(user)?.[1] ?? 'the question';
    const excerpts = (user.match(/<excerpt /g) ?? []).length;
    const text =
      `${MOCK_PREFIX} This placeholder stands in for a streamed answer to: "${question}". ` +
      (excerpts ? `The real provider would receive ${excerpts} resume excerpt(s). ` : '') +
      'Configure GROQ_API_KEY and set LLM_PROVIDER=groq for real suggestions.';
    const words = text.split(/(?<= )/);
    for (let i = 0; i < words.length; i++) {
      if (request.signal.aborted) throw new LlmError('timeout', 'Cancelled', true);
      const delay = i === 0 ? this.firstTokenDelayMs : this.delayMs;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      if (request.signal.aborted) throw new LlmError('timeout', 'Cancelled', true);
      yield words[i] ?? '';
    }
  }
}

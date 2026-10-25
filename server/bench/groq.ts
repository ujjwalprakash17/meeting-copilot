/**
 * OPT-IN real-provider benchmark: time to first token and total time for Groq models, using the same
 * request path as live answers (GroqProvider: keep-alive pool, reasoning settings, prompt builder).
 * Requires GROQ_API_KEY. Sends only the synthetic prompts below (no meeting data). Costs a few cents.
 *
 *   GROQ_API_KEY=... npm run bench:groq -w server -- --runs 8
 *   GROQ_BENCH_MODELS="openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b" npm run bench:groq -w server
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { buildAnswerMessages, MAX_TOKENS_BY_LENGTH } from '../src/answers/promptBuilder.js';
import { loadConfig } from '../src/config.js';
import { summarize } from '../src/latency/LatencyTracker.js';
import { GroqProvider } from '../src/llm/groq.js';
import { LlmError } from '../src/llm/types.js';
import { KeywordRetriever } from '../src/resume/retrieval.js';
import { parseResume } from '../src/resume/sections.js';

const config = loadConfig();
if (!config.llm.groqApiKey) {
  console.error('GROQ_API_KEY is not set (server/.env or environment). This benchmark calls the real Groq API and is opt-in.');
  process.exit(1);
}
const runsArg = process.argv.indexOf('--runs');
const runs = runsArg > 0 ? Number(process.argv[runsArg + 1]) : 8;
const models = (process.env.GROQ_BENCH_MODELS ?? `${config.llm.groqModel},openai/gpt-oss-20b`)
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

const RESUME = `EXPERIENCE
Senior Software Engineer, Example Payments, 2021 - Present
- Built an idempotent payment service handling 2M transactions per day.
- Cut checkout p99 latency from 900 ms to 250 ms with Redis caching.
SKILLS
Go, Java, PostgreSQL, Redis, Kafka`;
const retriever = new KeywordRetriever(parseResume(RESUME));
const transcript = [
  { id: 's1', text: "Thanks for joining. Let's start with some system design.", startMs: 1_000, endMs: 3_000, speechFinal: true },
  { id: 's2', text: 'We run a high traffic checkout service.', startMs: 4_000, endMs: 6_000, speechFinal: true },
];
const PROMPTS = [
  { question: 'What is the difference between a process and a thread?', kind: 'general' as const },
  { question: 'How would you design a rate limiter for a public API?', kind: 'general' as const },
  { question: 'Tell me about a project where you handled a large transaction volume.', kind: 'personal' as const },
];

async function measure(provider: GroqProvider, prompt: (typeof PROMPTS)[number]) {
  const excerpts = prompt.kind === 'personal' ? retriever.retrieve(prompt.question, { sectionHints: ['projects'], limit: 3 }).chunks : [];
  const { messages } = buildAnswerMessages({
    question: prompt.question,
    kind: prompt.kind,
    evidence: prompt.kind === 'personal' ? 'strong' : 'not_needed',
    style: 'concise',
    length: 'short',
    transcript,
    resumeExcerpts: excerpts,
    noteExcerpts: [],
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.llm.timeoutMs);
  const t0 = performance.now();
  let first: number | null = null;
  let chars = 0;
  try {
    for await (const delta of provider.stream({ messages, maxTokens: MAX_TOKENS_BY_LENGTH.short, signal: controller.signal })) {
      first ??= performance.now() - t0;
      chars += delta.length;
    }
    return { ok: true as const, ttftMs: first, totalMs: performance.now() - t0, chars };
  } catch (err) {
    return { ok: false as const, code: err instanceof LlmError ? err.code : 'error', message: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const report: Record<string, unknown> = {};
  console.log(`Groq benchmark: ${runs} runs x ${PROMPTS.length} prompts per model (real API, network from this machine)\n`);
  for (const model of models) {
    const provider = new GroqProvider({ apiKey: config.llm.groqApiKey, model, detectionModel: null, timeoutMs: config.llm.timeoutMs, reasoningEffort: config.llm.reasoningEffort ?? null });
    provider.warmup(); // same as a live session: connection opened before the first question
    await new Promise((r) => setTimeout(r, 800));
    const ttft: number[] = [];
    const total: number[] = [];
    const errors: Record<string, number> = {};
    for (let i = 0; i < runs; i++) {
      for (const p of PROMPTS) {
        const r = await measure(provider, p);
        if (r.ok && r.ttftMs !== null) {
          ttft.push(r.ttftMs);
          total.push(r.totalMs);
        } else if (!r.ok) errors[r.code] = (errors[r.code] ?? 0) + 1;
        await new Promise((res) => setTimeout(res, 250)); // stay well below rate limits
      }
    }
    const s = { ttftMs: summarize(ttft.map(Math.round)), totalMs: summarize(total.map(Math.round)), errors };
    report[model] = s;
    console.log(`${model.padEnd(28)} TTFT p50 ${s.ttftMs.p50} / p95 ${s.ttftMs.p95} ms   total p50 ${s.totalMs.p50} / p95 ${s.totalMs.p95} ms   errors ${JSON.stringify(errors)}`);
  }
  const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs/latency');
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `groq-real-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(file, `${JSON.stringify({ generatedAt: new Date().toISOString(), runs, prompts: PROMPTS.map((p) => p.question), models: report }, null, 2)}\n`);
  console.log(`\nSaved ${file}. Compare answer quality manually before changing GROQ_MODEL.`);
}

void main();

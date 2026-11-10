/**
 * Conversation-context quality and cost on labelled conversations (offline, deterministic, no network).
 *
 *   npm run bench:context -w server                       # test/fixtures/contextConversations.json (development set)
 *   npm run bench:context -w server -- --set test/fixtures/contextConversations.independentB.json
 *   npm run bench:context -w server -- --set other.json    # [{ name, turns: [{ text, kind, topic, current?, notCurrent?, absent? }] }]
 *
 * Each turn goes through the same steps as a live session: statements become facts; a question (as the
 * detector sees it; ambiguous ones are assumed confirmed by the classifier) is committed and its answer
 * context built. Reported:
 *  - continuity: a question on the same labelled topic as the previous one stays on the same memory topic;
 *  - switches: a question on a new label gets a new topic; returns: an earlier label gets its earlier topic;
 *  - missing requirements (`current` not in the current section), stale context (`notCurrent` shown as current),
 *    contamination (`absent` anywhere in the block), duplicate facts; size and time per turn.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { ConversationMemory, namesOwnSubject, utteranceSentences, type QuestionInfo } from '../src/context/ConversationMemory.js';
import { DESIGN_INSTRUCTION, designRequestTitle } from '../src/context/extract.js';
import { classifyQuestionIntent } from '../src/detection/intent.js';
import { QuestionDetector } from '../src/detection/QuestionDetector.js';

interface Turn {
  text: string;
  kind: 'question' | 'statement';
  topic: string;
  current?: string[];
  notCurrent?: string[];
  absent?: string[];
}
interface Conversation {
  name: string;
  turns: Turn[];
}

const here = path.dirname(fileURLToPath(import.meta.url));
const setArg = process.argv.indexOf('--set');
const file = setArg > 0 ? (process.argv[setArg + 1] as string) : path.join(here, '../test/fixtures/contextConversations.json');
const conversations = JSON.parse(readFileSync(file, 'utf8')) as Conversation[];
const detector = new QuestionDetector({ debounceMs: 1200, dedupeWindowMs: 0 }, () => undefined);

const section = (block: string, header: string): string => {
  const lines = block.split('\n');
  const start = lines.findIndex((l) => l.startsWith(header));
  if (start === -1) return '';
  const end = lines.findIndex((l, i) => i > start && !l.startsWith('- '));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
};
const has = (hay: string, needle: string) => hay.toLowerCase().includes(needle.toLowerCase());

type Count = [ok: number, of: number];
const m = { continuity: [0, 0] as Count, switches: [0, 0] as Count, returns: [0, 0] as Count, missing: 0, missingOf: 0, stale: 0, staleOf: 0, contamination: 0, contaminationOf: 0, duplicates: 0, undetected: 0 };
const failures: string[] = [];
const times: number[] = [];
const blockSizes: number[] = [];
let questions = 0;
let snapshotBytes = 0;

let coldMs = -1;
for (let pass = 0; pass < 3; pass++) {
const measure = pass === 2;
for (const conv of conversations) {
  const memory = new ConversationMemory();
  const labelTopic = new Map<string, string>();
  let prevLabel: string | null = null;
  let n = 0;
  for (const turn of conv.turns) {
    const t0 = performance.now();
    memory.observeUtterance(utteranceSentences(turn.text));
    if (turn.kind !== 'question') {
      times.push(performance.now() - t0);
      continue;
    }
    questions++;
    const c = detector.evaluate(turn.text, []);
    // Same promotion as Session.observeForContext: a design task set as a statement, or an extension of the active design.
    const extension = !c && (designRequestTitle(turn.text) !== null || (memory.activeTopic?.kind === 'system_design' && DESIGN_INSTRUCTION.test(turn.text.trim())));
    if (!c && !extension) {
      m.undetected++;
      failures.push(`[${conv.name}] not detected as a question: ${turn.text}`);
      times.push(performance.now() - t0);
      continue;
    }
    const text = c?.text ?? turn.text;
    const intent = classifyQuestionIntent(text);
    const q: QuestionInfo = {
      id: `q${++n}`,
      text,
      ...(c?.context ? { context: c.context } : {}),
      isFollowUp: c?.isFollowUp ?? true,
      requiresContext: c?.requiresContext ?? true,
      intentKind: intent.kind,
      ownSubject: namesOwnSubject(intent.sectionHints),
    };
    memory.commit(q);
    const ctx = memory.contextFor(q);
    memory.recordAnswer(q.id, `Drafted answer about: ${text}`);
    times.push(performance.now() - t0);
    const topicId = memory.activeTopic?.id ?? '';
    const block = ctx.block ?? '';
    if (ctx.block) blockSizes.push(ctx.block.length);

    // Topic routing against the labels.
    const known = labelTopic.get(turn.topic);
    const otherLabelWithId = [...labelTopic].find(([label, id]) => id === topicId && label !== turn.topic)?.[0];
    if (known) {
      const bucket = turn.topic === prevLabel ? m.continuity : m.returns;
      bucket[1]++;
      if (known === topicId) bucket[0]++;
      else failures.push(`[${conv.name}] ${turn.topic === prevLabel ? 'split from' : 'did not return to'} ${turn.topic}: ${turn.text}`);
    } else {
      m.switches[1]++;
      if (!otherLabelWithId) m.switches[0]++;
      else failures.push(`[${conv.name}] merged new topic ${turn.topic} into ${otherLabelWithId}: ${turn.text}`);
      labelTopic.set(turn.topic, topicId);
    }
    prevLabel = turn.topic;

    // Context content.
    const current = section(block, 'Requirements and decisions');
    for (const s of turn.current ?? []) {
      m.missingOf++;
      if (!has(current, s)) {
        m.missing++;
        failures.push(`[${conv.name}] missing current "${s}" for: ${turn.text}`);
      }
    }
    for (const s of turn.notCurrent ?? []) {
      m.staleOf++;
      if (has(current, s)) {
        m.stale++;
        failures.push(`[${conv.name}] stale "${s}" shown as current for: ${turn.text}`);
      }
    }
    for (const s of turn.absent ?? []) {
      m.contaminationOf++;
      if (has(block, s)) {
        m.contamination++;
        failures.push(`[${conv.name}] contamination "${s}" in context for: ${turn.text}`);
      }
    }
    const lines = current.split('\n').filter(Boolean);
    m.duplicates += lines.length - new Set(lines).size;
  }
  snapshotBytes = Math.max(snapshotBytes, JSON.stringify(memory.snapshot()).length);
}
if (pass === 0) coldMs = times[0] ?? -1;
if (!measure) { times.length = 0; blockSizes.length = 0; questions = 0; failures.length = 0; for (const k of Object.keys(m) as Array<keyof typeof m>) m[k] = (Array.isArray(m[k]) ? [0, 0] : 0) as never; }
}

const pct = ([ok, of]: number[]) => (of ? `${ok}/${of} (${((100 * (ok ?? 0)) / of).toFixed(0)}%)` : 'n/a');
const q = (xs: number[], p: number) => {
  const v = [...xs].sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.floor(p * v.length))] ?? 0;
};
console.log(`\nContext benchmark on ${path.basename(file)}: ${conversations.length} conversations, ${questions} questions\n`);
console.log(`| metric | result |\n|---|---|`);
console.log(`| follow-up continuity (same topic kept) | ${pct(m.continuity)} |`);
console.log(`| topic switches (new topic started) | ${pct(m.switches)} |`);
console.log(`| returns to an earlier topic | ${pct(m.returns)} |`);
console.log(`| missing current requirements | ${m.missing}/${m.missingOf} |`);
console.log(`| stale context (replaced shown as current) | ${m.stale}/${m.staleOf} |`);
console.log(`| contamination from other topics | ${m.contamination}/${m.contaminationOf} |`);
console.log(`| duplicate facts in context | ${m.duplicates} |`);
console.log(`| questions not detected (no context applied) | ${m.undetected}/${questions} |`);
console.log(`\nContext block: n=${blockSizes.length}, p50 ${q(blockSizes, 0.5)} chars, max ${q(blockSizes, 1)} chars (~${Math.round(q(blockSizes, 1) / 4)} tokens)`);
console.log(`Processing per turn: p50 ${(q(times, 0.5) * 1000).toFixed(0)} µs, p95 ${(q(times, 0.95) * 1000).toFixed(0)} µs (n=${times.length}, warmed up); first turn after start ${coldMs.toFixed(1)} ms (one-off regex compile); largest memory snapshot ${snapshotBytes} bytes`);
if (failures.length) console.log(`\n${failures.join('\n')}`);

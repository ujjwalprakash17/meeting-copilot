/**
 * Conversation memory: topic routing, design state (requirements, superseded decisions), bounded context,
 * resume follow-ups, duplicates/replays, bounds over a long session, and session isolation.
 */
import { describe, expect, it } from 'vitest';
import { ConversationMemory, MemoryStore, namesOwnSubject, type QuestionInfo } from '../src/context/ConversationMemory.js';
import { SCOPE_INSTRUCTION, extractFacts } from '../src/context/extract.js';
import { classifyQuestionIntent } from '../src/detection/intent.js';
import { QuestionDetector } from '../src/detection/QuestionDetector.js';
import { QUESTION_THRESHOLD, scoreSentence, splitSentences } from '../src/detection/scoring.js';

const detector = new QuestionDetector({ debounceMs: 1000, dedupeWindowMs: 0 }, () => undefined);

/** Feeds lines like the session does: statements become facts, the question (if any) is committed and answered. */
function conversation(lines: string[], memory = new ConversationMemory()) {
  let n = 0;
  const steps: Array<{ line: string; question?: QuestionInfo; topic: string | null; block: string | null; personal: boolean; route?: string }> = [];
  for (const line of lines) {
    memory.observeStatements(splitSentences(line).filter((s) => scoreSentence(s).score < QUESTION_THRESHOLD || SCOPE_INSTRUCTION.test(s)));
    const c = detector.evaluate(line, []);
    if (!c || c.ambiguous) {
      steps.push({ line, topic: memory.activeTopic?.id ?? null, block: null, personal: false });
      continue;
    }
    const intent = classifyQuestionIntent(c.text);
    const q: QuestionInfo = {
      id: `q${++n}`,
      text: c.text,
      ...(c.context ? { context: c.context } : {}),
      isFollowUp: c.isFollowUp,
      requiresContext: c.requiresContext,
      intentKind: intent.kind,
      ownSubject: namesOwnSubject(intent.sectionHints),
    };
    const decision = memory.commit(q);
    const ctx = memory.contextFor(q);
    memory.recordAnswer(q.id, `Drafted answer to "${c.text}". Second sentence.`);
    steps.push({ line, question: q, topic: memory.activeTopic?.id ?? null, block: ctx.block, personal: Boolean(ctx.personalFollowUp), route: decision.action });
  }
  return { memory, steps };
}
const section = (block: string | null, header: string) => {
  const lines = (block ?? '').split('\n');
  const start = lines.findIndex((l) => l.startsWith(header));
  if (start === -1) return '';
  const end = lines.findIndex((l, i) => i > start && !l.startsWith('- '));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
};

describe('follow-up continuity', () => {
  it('keeps a design discussion and its requirements together', () => {
    const { steps } = conversation([
      'Design a URL shortener.',
      'We need to support 10 million requests per day.',
      'How would you scale it?',
      'What if the cache fails?',
      'How would you prevent duplicate aliases?',
      'What would you use for caching?',
    ]);
    const questions = steps.filter((s) => s.question);
    expect(new Set(questions.map((s) => s.topic)).size).toBe(1);
    for (const s of questions.slice(1)) {
      expect(s.block, s.line).toContain('Current topic: URL shortener (system design)');
      expect(s.block, s.line).toContain('10 million requests per day');
    }
    expect(questions.at(-1)?.block).toContain('now discussing caching');
  });

  it('adds nothing for the first question of a topic (the prompt stays as before)', () => {
    const { steps } = conversation(['Design a URL shortener.']);
    expect(steps[0]?.block).toBeNull();
  });
});

describe('topic transitions', () => {
  it('switches on an explicit change, keeps the earlier topic, and resumes it on return', () => {
    const { steps, memory } = conversation([
      'Design a URL shortener.',
      'We need to support 10 million requests per day.',
      'What would you use for caching?',
      "Let's leave system design for now. Explain database indexing.",
      'When would a composite index help?',
      'Going back to the original design, what about caching?',
    ]);
    const [design, , caching, indexing, composite, back] = steps;
    expect(indexing?.topic).not.toBe(design?.topic);
    expect(composite?.topic).toBe(indexing?.topic);
    // The indexing discussion does not carry the URL shortener's state.
    expect(composite?.block).not.toContain('URL shortener');
    expect(composite?.block).not.toContain('10 million');
    expect(back?.route).toBe('resume');
    expect(back?.topic).toBe(caching?.topic);
    expect(back?.block).toContain('returning to it from another topic');
    expect(back?.block).toContain('10 million requests per day');
    expect(memory.snapshot().topics.map((t) => t.title)).toEqual(['URL shortener', 'database indexing']);
  });

  it('does not switch topic on a new technical term inside a design discussion', () => {
    const { steps } = conversation(['Design a URL shortener.', 'What about consistent hashing?', 'Would Bloom filters help here?']);
    expect(new Set(steps.map((s) => s.topic)).size).toBe(1);
  });

  it('keeps unrelated rapid-fire technical questions apart', () => {
    const { steps } = conversation(['What is a closure in JavaScript?', 'What is the difference between TCP and UDP?', 'Why is UDP faster?']);
    expect(steps[1]?.topic).not.toBe(steps[0]?.topic);
    expect(steps[2]?.topic).toBe(steps[1]?.topic);
    expect(steps[1]?.block ?? '').not.toContain('closure');
  });

  it('does not count question scaffolding ("What\'s the difference between…") as a shared subject', () => {
    const { steps } = conversation(["What's the difference between a process and a thread?", 'Explain the CAP theorem.', "What's the difference between TCP and UDP?"]);
    expect(new Set(steps.map((s) => s.topic)).size).toBe(3);
  });

  it('gives a concept question asked during a design its own topic, and returns on "our numbers"', () => {
    const { steps } = conversation([
      'Design the autocomplete for the search box on an e-commerce site.',
      'We do about thirty million searches a day.',
      'What data structure would you use for the suggestions?',
      "What's the difference between a process and a thread?",
      'And which one is cheaper to create?',
      'So for the trie, how big would that get in memory with our numbers?',
    ]);
    const [design, , structure, concept, cheaper, trie] = steps;
    expect(structure?.topic).toBe(design?.topic);
    expect(concept?.topic).not.toBe(design?.topic);
    expect(concept?.block ?? '').not.toContain('thirty million');
    expect(cheaper?.topic).toBe(concept?.topic);
    expect(trie?.topic).toBe(design?.topic);
    expect(trie?.block).toContain('thirty million searches a day');
  });

  it('keeps "How do you deal with…" in a design on the design, and starts a story for "Tell me about an incident you were involved in"', () => {
    const { steps } = conversation([
      'Design a video streaming platform.',
      'Most viewers are on mobile.',
      'How do you deal with people on bad mobile connections?',
      "Okay, I think that's good on the design side. Tell me about a production incident you were involved in.",
      'What was the root cause in the end?',
    ]);
    expect(steps[2]?.topic).toBe(steps[0]?.topic);
    expect(steps[3]?.topic).not.toBe(steps[0]?.topic);
    expect(steps[4]?.topic).toBe(steps[3]?.topic);
  });

  it('treats "design the table" as part of the active design', () => {
    const { steps, memory } = conversation(['Design a notification service.', 'Assume 10 million users.', 'How would you design the table and the keys?']);
    expect(steps[2]?.topic).toBe(steps[0]?.topic);
    expect(memory.topicCount).toBe(1);
    expect(steps[2]?.block).toContain('10 million users');
  });

  it('returns to the topic a "going back to…" names, not one sharing an incidental word', () => {
    const { steps } = conversation([
      'What is a deadlock?',
      'And how would you prevent one?',
      "What's a database index?",
      'When would an index hurt performance?',
      'Going back to deadlocks, how would you detect one in a running database?',
    ]);
    expect(steps[4]?.topic).toBe(steps[0]?.topic);
    expect(steps[4]?.route).toBe('resume');
  });

  it('files a statement made after "going back to…" under that topic', () => {
    const { steps, memory } = conversation([
      'Design a chat application.',
      'Group chat is out of scope.',
      "Okay, let's leave design for now. Tell me about a time you had to deal with a difficult teammate.",
      'Going back to the chat app. Actually, group chat is now in scope, with groups of up to 500 members.',
      'How does your design change for group messages?',
    ]);
    const story = memory.snapshot().topics.find((t) => t.kind === 'personal');
    expect(story?.facts.map((f) => f.text).join(' ')).not.toContain('500 members');
    expect(steps[4]?.topic).toBe(steps[0]?.topic);
    const current = section(steps[4]?.block ?? null, 'Requirements and decisions');
    expect(current).toContain('groups of up to 500 members');
    expect(current).not.toContain('Group chat is out of scope');
  });
});

describe('requirement changes', () => {
  it('presents the latest constraints as current and marks replaced decisions', () => {
    const { steps } = conversation([
      'Design a URL shortener.',
      'Assume about 1,000 requests per day for now.',
      'Use PostgreSQL for storage.',
      'Actually, it needs to handle 100 million requests per day and be globally distributed and write-heavy.',
      'Use Cassandra instead of PostgreSQL.',
      'How does this change the architecture?',
    ]);
    const block = steps.at(-1)?.block ?? '';
    const current = section(block, 'Requirements and decisions');
    const replaced = section(block, 'No longer current');
    expect(current).toContain('100 million requests per day');
    expect(current).toContain('Use Cassandra instead of PostgreSQL');
    expect(current).not.toContain('1,000 requests');
    expect(current).not.toContain('Use PostgreSQL for storage');
    expect(replaced).toContain('1,000 requests per day');
    expect(replaced).toContain('Use PostgreSQL for storage');
  });

  it('updates a fact on an explicit correction instead of keeping both', () => {
    const memory = new ConversationMemory();
    conversation(['Design a chat application.', 'Assume 1 million daily active users.', 'Sorry, I meant 50 million daily active users.'], memory);
    const facts = memory.activeTopic?.facts ?? [];
    expect(facts.filter((f) => f.slot === 'users' && !f.supersededAt).map((f) => f.text)).toEqual(['Sorry, I meant 50 million daily active users.']);
  });

  it('marks a decision under reconsideration when no replacement is named', () => {
    const memory = new ConversationMemory();
    conversation(['Design a URL shortener.', 'Use PostgreSQL for storage.', 'We should rethink the database for global writes.'], memory);
    expect(memory.activeTopic?.facts.find((f) => f.slot === 'database')?.supersededBy).toContain('under reconsideration');
  });

  it('replaces a statement when a later one changes its number, scope or technology', () => {
    const { steps } = conversation([
      'Design a parking garage.',
      'The building has three floors.',
      'Only support a single city for now.',
      "We'll store the sessions in Postgres.",
      'Short links should never expire unless the user deletes them.',
      'The building has five floors now.',
      "Actually, let's go global, with users in multiple regions.",
      'Use DynamoDB instead of Postgres.',
      'Also, links should now expire after two years by default.',
      'How would you model the spots?',
    ]);
    const current = section(steps.at(-1)?.block ?? null, 'Requirements and decisions');
    for (const old of ['three floors', 'single city', 'sessions in Postgres', 'never expire']) expect(current).not.toContain(old);
    for (const now of ['five floors', 'multiple regions', 'DynamoDB instead of Postgres', 'expire after two years']) expect(current).toContain(now);
  });

  it('drops what the interviewer takes out of scope, and brings back what was excluded', () => {
    const { steps } = conversation([
      'Design a metrics pipeline.',
      'Dashboards should show data with under a minute of delay.',
      'It should also work offline, and sync up when you reconnect.',
      'Just on-demand video for now, no live streaming.',
      'Forget the dashboards, just focus on alerting.',
      "Let's simplify actually. Forget offline support, assume everyone's always connected.",
      'Leadership now wants live streaming too.',
      'How would you evaluate alert rules at that scale?',
    ]);
    const current = section(steps.at(-1)?.block ?? null, 'Requirements and decisions');
    for (const old of ['Dashboards should show', 'work offline', 'no live streaming']) expect(current).not.toContain(old);
    expect(current).toContain('wants live streaming too');
  });

  it('treats "can now…" as an addition unless it contradicts an earlier statement', () => {
    const { steps } = conversation([
      'Design a food delivery dispatch system.',
      'An order should be assigned to a driver within thirty seconds of the restaurant accepting it.',
      'Short links should never expire unless the user deletes them.',
      'Also, drivers can now carry two orders at once if the restaurants are close together.',
      'Also, links should now expire after two years by default.',
      'How does batching two orders change the matching?',
    ]);
    const current = section(steps.at(-1)?.block ?? null, 'Requirements and decisions');
    expect(current).toContain('within thirty seconds');
    expect(current).toContain('carry two orders at once');
    expect(current).not.toContain('never expire');
  });

  it('applies a correction announced in its own sentence to the statement after it', () => {
    const { steps } = conversation([
      'Design a ticket booking system.',
      'Users browse events, pick specific seats from a seat map, and pay.',
      "Once a user selects a seat it's held for them for ten minutes while they finish checkout.",
      'Actually, one change. Make the hold five minutes, people were just sitting on seats and not paying.',
      'How does the hold expire?',
    ]);
    const current = section(steps.at(-1)?.block ?? null, 'Requirements and decisions');
    expect(current).not.toContain('ten minutes');
    expect(current).toContain('hold five minutes');
    expect(current).toContain('pick specific seats'); // replaced only the statement it was about
  });

  it('keeps two different limits on the same thing', () => {
    const { steps } = conversation(['Design a notification service.', 'Each user gets about five notifications a day.', 'Send at most three notifications per hour.', 'How would you throttle them?']);
    const current = section(steps.at(-1)?.block ?? null, 'Requirements and decisions');
    expect(current).toContain('five notifications a day');
    expect(current).toContain('three notifications per hour');
  });

  it('keeps a scope instruction even when it is phrased as a request', () => {
    const { steps } = conversation(['Design a chat application.', 'Focus on one-to-one messaging first, group chat is out of scope.', 'How would the client connect to the server?']);
    expect(section(steps.at(-1)?.block ?? null, 'Requirements and decisions')).toContain('one-to-one messaging first');
  });

  it('extracts the facts in the spec examples', () => {
    expect(extractFacts('We need to support 10 million requests per day.').facts.map((f) => f.key)).toEqual(['traffic:requests']);
    expect(extractFacts('Now add authentication.').facts.map((f) => f.key)).toEqual(['feature:authentication']);
    expect(extractFacts('Use Redis for caching and Kafka for events.').facts.map((f) => f.slot)).toEqual(['cache', 'messaging']);
    expect(extractFacts('It must be highly available and strongly consistent.').facts.map((f) => f.slot)).toEqual(['availability', 'consistency']);
    expect(extractFacts('Redis is a popular cache.').facts.map((f) => f.slot)).not.toContain('cache'); // a mention is not a decision
    expect(extractFacts('Our meeting starts in ten minutes.').facts).toEqual([]);
  });
});

describe('resume context', () => {
  it('treats a vague follow-up as being about the same project, and leaves it for an unrelated design', () => {
    const { steps } = conversation([
      'Tell me about the payment project on your resume.',
      'What exactly was your contribution?',
      'Design a chat application.',
      'How would you store messages?',
    ]);
    const [project, contribution, chat, store] = steps;
    expect(contribution?.topic).toBe(project?.topic);
    expect(contribution?.personal).toBe(true);
    expect(chat?.topic).not.toBe(project?.topic);
    expect(store?.personal).toBe(false);
    expect(store?.block ?? '').not.toContain('payment project');
  });

  it('keeps a project or behavioral story together across short follow-ups', () => {
    const project = conversation(['Can you tell me about the payments migration project you listed?', 'What was your role?', 'How big was the team?']).steps;
    expect(new Set(project.map((s) => s.topic)).size).toBe(1);
    expect(project[1]?.personal).toBe(true); // "your role" in that project, retrieved with the project question
    const story = conversation(['Tell me about a time you missed a deadline.', 'How did your manager react?', 'So what did you learn from that']).steps;
    expect(new Set(story.map((s) => s.topic)).size).toBe(1);
  });

  it('keeps a personal question with its own subject on its own resume search', () => {
    const { steps } = conversation(['Tell me about the payment project on your resume.', 'What did you study at university?']);
    expect(steps[1]?.personal).toBe(false);
  });
});

describe('reliability', () => {
  it('ignores replayed statements and re-committed questions', () => {
    const memory = new ConversationMemory();
    conversation(['Design a URL shortener.'], memory);
    expect(memory.observeStatements(['We need to support 10 million requests per day.'])).toBe(1);
    expect(memory.observeStatements(['We need to support 10 million requests per day.'])).toBe(0);
    const q: QuestionInfo = { id: 'qx', text: 'How would you scale it?', isFollowUp: true, intentKind: 'general' };
    memory.commit(q);
    memory.commit(q);
    expect(memory.activeTopic?.exchanges.filter((e) => e.questionId === 'qx')).toHaveLength(1);
    expect(memory.activeTopic?.facts).toHaveLength(1);
  });

  it('previews a tentative question without changing anything', () => {
    const memory = new ConversationMemory();
    conversation(['Design a URL shortener.', 'We need to support 10 million requests per day.'], memory);
    const before = JSON.stringify(memory.snapshot());
    const ctx = memory.contextFor({ id: 'tentative', text: "Let's leave that. Explain database indexing.", isFollowUp: false, intentKind: 'general' });
    expect(ctx.route).toBe('new');
    expect(JSON.stringify(memory.snapshot())).toBe(before);
  });

  it('attaches an answer that finished before its question was confirmed', () => {
    const memory = new ConversationMemory();
    conversation(['Design a URL shortener.'], memory);
    memory.recordAnswer('q-late', 'Use a key-value store. Then add caching.');
    memory.commit({ id: 'q-late', text: 'How would you store the mappings?', isFollowUp: false, intentKind: 'general' });
    expect(memory.activeTopic?.exchanges.at(-1)?.answer).toBe('Use a key-value store. Then add caching.');
  });

  it('does not let statements contaminate a personal topic', () => {
    const memory = new ConversationMemory();
    conversation(['Tell me about the payment project on your resume.', 'We need to support 10 million requests per day.'], memory);
    expect(memory.activeTopic?.kind).toBe('personal');
    expect(memory.activeTopic?.facts).toEqual([]);
  });

  it('stays bounded over a long session', () => {
    const memory = new ConversationMemory();
    for (let i = 0; i < 200; i++) {
      memory.observeStatements([`Design a service number ${i}.`, `We need to support ${i + 1} million requests per day.`, `Now add feature ${i}.`]);
      for (let j = 0; j < 5; j++) {
        const q = { id: `q${i}-${j}`, text: `How would you scale component ${j} of service ${i}?`, isFollowUp: true, intentKind: 'general' as const };
        memory.commit(q);
        memory.recordAnswer(q.id, 'x'.repeat(2000));
      }
    }
    const snap = memory.snapshot();
    expect(snap.topics.length).toBeLessThanOrEqual(12);
    for (const t of snap.topics) {
      expect(t.facts.length).toBeLessThanOrEqual(30);
      expect(t.exchanges.length).toBeLessThanOrEqual(6);
      for (const e of t.exchanges) expect((e.answer ?? '').length).toBeLessThanOrEqual(280);
    }
    const ctx = memory.contextFor({ id: 'last', text: 'What about caching?', isFollowUp: true, intentKind: 'general' });
    expect(ctx.block?.length ?? 0).toBeLessThanOrEqual(1200);
    expect(memory.transitions.length).toBeLessThanOrEqual(50);
  });
});

describe('memory store (session boundaries)', () => {
  it('resumes on a reconnect of the same session and starts empty otherwise', () => {
    const store = new MemoryStore();
    const first = store.acquire('sess-a', false).memory;
    conversation(['Design a URL shortener.', 'We need to support 10 million requests per day.'], first);
    expect(store.acquire('sess-a', true)).toMatchObject({ memory: first, resumed: true });
    // A new Start (no continuation) never sees the previous meeting, even with the same id.
    expect(store.acquire('sess-a', false).memory.topicCount).toBe(0);
    expect(store.acquire('sess-b', true)).toMatchObject({ resumed: false });
  });

  it('forgets a session when it is stopped, when it idles out, and beyond the size limit', () => {
    let now = 0;
    const store = new MemoryStore({ maxSessions: 3, idleMs: 1000 }, () => now);
    store.acquire('a', false);
    store.release('a');
    expect(store.acquire('a', true).resumed).toBe(false);
    now = 5000;
    expect(store.acquire('a', true).resumed).toBe(false); // idle expiry
    for (const id of ['b', 'c', 'd', 'e']) store.acquire(id, false);
    expect(store.size).toBeLessThanOrEqual(3);
  });
});

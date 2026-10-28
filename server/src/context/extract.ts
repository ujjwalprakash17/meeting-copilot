/**
 * Deterministic reading of conversation state from finalized transcript text (no LLM calls, microseconds).
 *
 * - Facts: requirements, constraints and decisions stated by the other participants ("We need to support
 *   10 million requests per day", "Use Cassandra instead of PostgreSQL", "Now add authentication"). Each fact
 *   has a slot and a key; a later fact with the same key replaces (supersedes) the earlier one.
 * - Topic signals: a new design task ("Design a URL shortener"), an explicit topic change ("Let's leave
 *   system design for now", "moving on"), a return to an earlier topic ("Going back to the original design").
 *
 * The wording is kept verbatim (clipped): the facts are what the interviewer said, not a paraphrase.
 */
import { tokenize } from '@meeting-copilot/shared';

export type FactSlot =
  | 'note'
  | 'traffic'
  | 'users'
  | 'storage'
  | 'latency'
  | 'availability'
  | 'consistency'
  | 'regions'
  | 'workload'
  | 'database'
  | 'cache'
  | 'messaging'
  | 'search'
  | 'feature'
  | 'requirement'
  | 'assumption';

export interface ExtractedFact {
  slot: FactSlot;
  /** Identity within a topic: a newer fact with the same key replaces the current one. */
  key: string;
  text: string;
}

export interface Extraction {
  facts: ExtractedFact[];
  /** Slots the speaker wants to reconsider without naming a replacement ("We should rethink the database."). */
  reconsider: FactSlot[];
  /** A design task announced as a statement ("Today we'll design a URL shortener."). */
  designTask?: string;
}

const MAX_FACT_CHARS = 160;
const clip = (s: string, n = MAX_FACT_CHARS) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const clean = (s: string) => s.replace(/\s+/g, ' ').replace(/^[\s,;:-]+|[\s,;:]+$/g, '').trim();

const NUMBER = String.raw`(?:\d[\d,.]*\s*(?:k|m|b|thousand|million|billion|hundred)?|(?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|fifty|a|a few|several|hundreds of|thousands of|millions of)\s+(?:hundred|thousand|million|billion)(?:\s+(?:thousand|million|billion))?)`;
const RATE = new RegExp(
  String.raw`\b(${NUMBER})\s+(?:(?:new|unique|daily|active|concurrent|incoming|peak)\s+)*(requests?|reqs|queries|qps|rps|writes?|reads?|urls|links|messages|events|orders|transactions|uploads|downloads|clicks|redirects|visits|sessions)\s*(?:per|a|an|each|every|\/)\s*(second|sec|minute|min|hour|day|week|month|year)\b`,
  'i',
);
const USERS = new RegExp(String.raw`\b(${NUMBER})\s+(?:(?:daily|monthly)\s+active\s+|active\s+|concurrent\s+|registered\s+)?(users|customers|dau|mau)\b`, 'i');
const STORAGE = /\b(\d[\d,.]*)\s*(tb|gb|pb|terabytes?|gigabytes?|petabytes?)\b/i;
const LATENCY = /\b(?:under|below|less than|within|at most|p9\d(?:\.\d)?)\s*(?:of\s+)?(\d[\d,.]*)\s*(ms|milliseconds?|seconds?)\b/i;
const RATIO = /\b(\d+)\s*(?::|to)\s*(\d+)\s+(?:read|write)/i;
const TRAFFIC_CHANGE = /\btraffic\s+(?:doubles|triples|grows|increases|spikes|is|will be|goes up)\b|\b(?:double|triple|10x|ten times)\s+(?:the\s+)?traffic\b/i;

const TECH: Array<[FactSlot, RegExp]> = [
  ['database', /\b(postgres(?:ql)?|mysql|maria ?db|sql server|oracle|mongo ?db|cassandra|scylla(?:db)?|dynamo ?db|cockroach ?db|spanner|cosmos ?db|sqlite|aurora|bigtable|hbase|couchbase|firestore|supabase|nosql|relational database|sql database|key[- ]value store)\b/gi],
  ['cache', /\b(redis|memcached|varnish|cloudfront|cdn|in-memory cache|local cache|cache layer|caching layer)\b/gi],
  ['messaging', /\b(kafka|rabbit ?mq|sqs|sns|pub\/?sub|kinesis|nats|activemq|event bus|message queue|message broker)\b/gi],
  ['search', /\b(elastic ?search|open ?search|solr|algolia)\b/gi],
];
/** The sentence makes a choice rather than mentioning a technology in passing. */
const CHOICE =
  /\b(?:use|using|go with|going with|pick|choose|we(?:'re| are) on|we have|stor(?:e|ed|ing) (?:[\w-]+ ){0,3}(?:in|on)|backed by|built on|runs? on|switch(?:ing)? (?:from \w+ )?to|move to|migrate to|replace\w*|instead|rather than|(?:database|db|datastore|storage|cache|queue|broker)\s+(?:is|will be|should be|must be|has to be))\b/i;
const SLOT_WORDS: Array<[FactSlot, RegExp]> = [
  ['database', /\b(?:database|db|datastore|data store|storage layer)\b/i],
  ['cache', /\b(?:cache|caching)\b/i],
  ['messaging', /\b(?:queue|broker|messaging)\b/i],
];
const RECONSIDER = /\b(?:replace|reconsider|rethink|revisit|swap out|get rid of|move away from|drop|change)\b/i;

const NONFUNCTIONAL: Array<[FactSlot, RegExp]> = [
  ['availability', /\b(?:highly available|high availability|\d{2}(?:\.\d+)?\s*%\s*(?:uptime|availability)|(?:three|four|five) nines|zero downtime|no downtime|fault[- ]tolerant)\b/i],
  ['consistency', /\b(?:strong(?:ly)? consisten\w*|eventual(?:ly)? consisten\w*|read[- ]your[- ]writes|linearizab\w*|exactly[- ]once|at[- ]least[- ]once)\b/i],
  ['regions', /\b(?:multi[- ]region|multiple regions|globally distributed|geo[- ]distributed|across (?:regions|continents|data ?cent(?:er|re)s)|worldwide|global users)\b/i],
  ['workload', /\b(?:write[- ]heavy|read[- ]heavy|bursty|spiky)\b/i],
];

const FEATURE =
  /^(?:(?:now|also|next|okay|ok|so|and|then)[,]?\s+)*(?:let'?s\s+)?(?:add|support|include|allow|enable|implement|introduce)\s+(?:a |an |the |some |support for )?([a-z][\w\s/-]{2,50}?)(?=\s*(?:[.,;!?]|$)|\s+(?:to|for|so|and|that|which|with|too|as well|now)\b)/i;
const USERS_CAN = /\busers?\s+(?:should|must|can|need to|needs to|will|have to)\s+(?:be able to\s+)?([a-z][\w\s-]{2,50}?)(?=\s*(?:[.,;!?]|$)|\s+(?:and|so|but)\b)/i;
const USER_COUNT_KIND = /\b(daily|monthly|weekly|concurrent|simultaneous|peak|registered|first (?:minute|hour|second)|per (?:second|minute|hour))\b/i;
const REQUIREMENT =
  /\b(?:we|it|the (?:system|service|app|api|design)|this)\s+(?:also\s+)?(?:need|needs|must|should|has to|have to|is required to|are required to)\s+(?:support|handle|be|serve|scale|process|store|keep|guarantee|work|run|survive|tolerate)\b|\bwe (?:also )?(?:want|'d like|would like) (?:it )?to [a-z]+/i;
const ASSUMPTION = /^(?:assume|assuming|suppose|let'?s say|say|given that)\b/i;
const DROP_FEATURE = /\b(?:drop|remove|skip|forget about|no need for|don'?t need)\s+(?:the\s+)?([a-z][\w\s-]{2,40}?)(?=\s*(?:[.,;!?]|$))/i;

const STOP = new Set(['a', 'an', 'the', 'some', 'support', 'for', 'of', 'to', 'and', 'our', 'your', 'my', 'it', 'this', 'that', 'new', 'basic', 'simple']);
const keyWords = (phrase: string, n = 2) =>
  tokenize(phrase)
    .filter((w) => !STOP.has(w))
    .slice(0, n)
    .join(' ');

const nounOf = (noun: string): string => {
  const n = noun.toLowerCase();
  if (/^(?:requests?|reqs|queries|qps|rps|visits)$/.test(n)) return 'requests';
  if (/^writes?$/.test(n)) return 'writes';
  if (/^reads?$/.test(n)) return 'reads';
  return n;
};

/** The technology a sentence settles on: "replace X with Y" -> Y, "Y instead of X" -> Y, "switch from X to Y" -> Y. */
function chosenTech(sentence: string, re: RegExp): string | null {
  const names = [...sentence.matchAll(re)].map((m) => m[1] ?? '').filter(Boolean);
  if (names.length === 0) return null;
  if (names.length === 1) return names[0] ?? null;
  const lower = sentence.toLowerCase();
  const withIdx = lower.search(/\b(?:with|to)\b/);
  if (/\breplace\w*\b/.test(lower) || /\bswitch\w*\s+from\b|\bmove\s+from\b|\bmigrate\s+from\b/.test(lower)) {
    const after = names.find((n) => lower.indexOf(n.toLowerCase()) > withIdx);
    if (after) return after;
  }
  if (/\b(?:instead of|rather than)\b/.test(lower)) return names[0] ?? null;
  return names.at(-1) ?? null;
}

const REPLACED = /\b(?:instead of|rather than|replac\w*|switch\w* (?:away )?from|mov\w* (?:away )?from|migrat\w* (?:away )?from|get rid of)\s+(?:the\s+|our\s+)?([\w .+-]{2,24})/i;
/** The technology a sentence moves away from: "Use DynamoDB instead of Postgres" -> "Postgres". */
export function replacedTech(rawSentence: string): string | null {
  const after = REPLACED.exec(rawSentence)?.[1] ?? '';
  for (const [, re] of TECH) {
    const m = new RegExp(`^${re.source}`, 'i').exec(after);
    if (m?.[1]) return m[1];
  }
  return null;
}

/** Scope instructions ("Focus on one-to-one messaging first, group chat is out of scope.") are requirements even when phrased as requests. */
export const SCOPE_INSTRUCTION =
  /^(?:(?:so|okay|ok|now|and|also|but|for now)[,]?\s+)*(?:focus (?:only )?on|ignore|don'?t worry about|prioriti[sz]e|optimi[sz]e for|only (?:support|handle|consider))\b|\b(?:out of scope|in scope|not in scope|a non-goal)\b/i;

/** Asks rather than states ("When a user selects a seat, it's held…" is a statement). */
const INTERROGATIVE =
  /\?\s*$|^(?:(?:so|okay|ok|and|now|then|right|alright|but)[,]?\s+)*(?:(?:what|how|why|when|where|which|who)\s+(?:if|about|would|will|do|does|did|is|are|was|were|can|could|should|happens?)\b|(?:does|did|is|are|was|were|can|could|would|will|should)\s+(?:you|we|it|the|this|that|there|they)\b)/i;

/** Facts stated in one finalized sentence by the other participant. */
export function extractFacts(rawSentence: string): Extraction {
  const sentence = clean(rawSentence.replace(/[’‘]/g, "'"));
  const out: Extraction = { facts: [], reconsider: [] };
  if (sentence.split(/\s+/).length < 3) return out;
  const text = clip(sentence);

  const design = designTaskTitle(sentence);
  if (design) out.designTask = design;
  // A question the detector left to the classifier ("What if a worker dies halfway through a job") is not a requirement.
  if (INTERROGATIVE.test(sentence)) return out;

  const rate = RATE.exec(sentence);
  if (rate) out.facts.push({ slot: 'traffic', key: `traffic:${nounOf(rate[2] ?? 'requests')}`, text });
  else if (TRAFFIC_CHANGE.test(sentence)) out.facts.push({ slot: 'traffic', key: 'traffic:change', text });
  // Monthly actives and an on-sale peak are different numbers: only the same kind of count replaces the other.
  if (!rate && USERS.test(sentence)) out.facts.push({ slot: 'users', key: `users:${USER_COUNT_KIND.exec(sentence)?.[1]?.toLowerCase().replace(/\s+/g, ' ') ?? 'total'}`, text });
  if (STORAGE.test(sentence)) out.facts.push({ slot: 'storage', key: 'storage', text });
  if (LATENCY.test(sentence)) out.facts.push({ slot: 'latency', key: 'latency', text });
  if (RATIO.test(sentence)) out.facts.push({ slot: 'workload', key: 'workload:ratio', text });

  const choosing = CHOICE.test(sentence);
  for (const [slot, re] of TECH) {
    if (!choosing) break;
    if (chosenTech(sentence, re)) out.facts.push({ slot, key: slot, text });
  }
  if (RECONSIDER.test(sentence) || /\b(?:shouldn'?t|should not|can'?t|cannot|won'?t) (?:use|be)\b/i.test(sentence)) {
    for (const [slot, re] of SLOT_WORDS) {
      const named = TECH.find(([s]) => s === slot)?.[1];
      if (re.test(sentence) && !(named && chosenTech(sentence, named))) out.reconsider.push(slot);
    }
  }
  for (const [slot, re] of NONFUNCTIONAL) if (re.test(sentence)) out.facts.push({ slot, key: slot, text });

  const dropped = DROP_FEATURE.exec(sentence);
  const feature = FEATURE.exec(sentence) ?? USERS_CAN.exec(sentence);
  if (feature && !dropped) {
    const k = keyWords(feature[1] ?? '');
    if (k) out.facts.push({ slot: 'feature', key: `feature:${k}`, text });
  }
  // A scenario with a specific fact ("Assume 1,000 requests per day") is that fact, not a separate assumption.
  if (out.facts.length === 0 && ASSUMPTION.test(sentence)) out.facts.push({ slot: 'assumption', key: `assumption:${keyWords(sentence.replace(ASSUMPTION, ''), 3)}`, text });
  else if (out.facts.length === 0 && REQUIREMENT.test(sentence)) {
    out.facts.push({ slot: 'requirement', key: `requirement:${keyWords(sentence.replace(REQUIREMENT, ''), 3)}`, text });
  } else if (out.facts.length === 0 && !design && isSubstantive(sentence)) {
    // Anything else the interviewer states about the problem ("Links should never expire", "Start with
    // one-to-one messaging") is kept verbatim; small talk, logistics and acknowledgements are not.
    out.facts.push({ slot: 'note', key: `note:${keyWords(sentence, 4)}`, text });
  }
  return out;
}

/** Small talk, logistics, acknowledgements and feedback: never part of the problem being discussed. */
const SMALL_TALK =
  /^(?:sorry|excuse me|oops|hold on|one sec|give me a (?:sec|second|minute|moment)|hang on|no worries|no problem|thanks|thank you|great|cool|nice|perfect|awesome|okay|ok|sure|got it|makes sense|sounds good|interesting|right|yeah|yes|no|alright|fair enough|good|wonderful)\b[\s,.!-]*(?:(?:that|this|it)(?:'s| is| was)? (?:a )?(?:good|great|fair|nice|interesting|solid|reasonable|helpful|clear)\b.*)?$|\b(?:my (?:dog|cat|kid|kids|baby|internet|connection|wi-?fi|mic|microphone|camera|laptop)|can you hear|we have (?:about |around )?[\w-]+ (?:more )?minutes?(?: left)?|minutes left|running (?:out of|low on|short on) time|take a (?:quick |short )?break|let me (?:share|stop sharing|pull up|open)|share (?:my|your) screen|back in a (?:sec|second|minute)|you'?re on mute|i'?m on mute|bad connection|you froze|lagging|the (?:next|last) (?:round|interview)|hiring manager|recruiter will|wrap up|let'?s get started|nice to meet you|good (?:morning|afternoon|evening)|(?:meeting|call|interview|session) (?:starts|ends|is (?:over|ending|starting))|in (?:about )?(?:\d+|[a-z]+) minutes|at the end|for questions|any questions|time check|we'?re (?:about |almost |nearly )?halfway|step away|be right back|(?:slack|teams) (?:ping|message|notification)|one sec|just a (?:sec|second)|(?:hold on|hang on|wait) (?:a|one) (?:sec|second)|someone'?s at (?:my|the) door|i'?m back|sorry about that|(?:almost|nearly|running) (?:at|out of) time|(?:a )?couple (?:of )?quick ones|rapid[- ]fire|you cut out|cutting out|breaking up|got the gist|didn'?t catch (?:that|you|the last)|can you repeat)\b|^(?:that'?s|this is|it'?s) (?:a )?(?:good|great|fair|nice|interesting|solid|reasonable|clear|helpful|correct|right)\b|^(?:good|great|nice|interesting) (?:point|answer|approach|idea|question)\b/i;
const CONTENT_WORDS = (s: string) => tokenize(s).filter((w) => w.length > 3 && !STOP.has(w) && !GENERIC.has(w)).length;

/** Says something about the problem (worth remembering), as opposed to small talk or a bare acknowledgement. */
export function isSubstantive(sentence: string): boolean {
  return sentence.split(/\s+/).length >= 4 && CONTENT_WORDS(sentence) >= 2 && !SMALL_TALK.test(sentence);
}

/** The speaker corrects or replaces something said earlier. */
export const CORRECTION =
  /\b(?:actually|instead|rather|change (?:that|it|this)|change of plans?|on second thought|scratch that|correction|i meant|not anymore|no longer|new requirement|turns out|update(?:d)? requirement|let'?s (?:say|make it|change)|now (?:assume|it'?s|we need|it needs)|(?:should|must|will|can|needs? to|has to|have to|is|are) now|going forward|from now on|we'?ve decided|(?:i|we) (?:had|got) (?:the|that|those) (?:number|numbers|figure|figures|math) wrong|i misspoke|let me correct|(?:one|two|three|a few|some|a small|a quick) changes?|scope change|let me (?:narrow|change|widen|expand|simplify)|let'?s (?:simplify|expand|narrow|widen))\b/i;

/** Says outright that something said earlier was wrong (CORRECTION also covers softer "is now", "going forward"). */
export const STRONG_CORRECTION =
  /\b(?:actually|instead|rather than|scratch that|correction|i meant|not anymore|no longer|change (?:that|it|this)|let'?s change|on second thought|turns out|i misspoke|let me correct|(?:i|we) (?:had|got) (?:the|that|those) (?:number|numbers|figure|figures|math) wrong)\b/i;
const NEGATION = /\b(?:never|no|not|without|don'?t|doesn'?t|won'?t|can'?t|cannot|isn'?t|aren'?t)\b/i;
/** One statement denies what the other says ("never expire" vs "expire after two years"). */
export const negationFlips = (a: string, b: string) => NEGATION.test(a) !== NEGATION.test(b);

const PHRASE = String.raw`([a-z][\w-]*(?:\s+(?!for\b|now\b|and\b|so\b|but\b|too\b)[a-z][\w-]*)?)`;
const DROPS = [
  new RegExp(String.raw`\b(?:forget(?: about)?|drop(?:ping)?|remove|skip|no need for|don'?t need|get rid of|leave out|ignore)\s+(?:the\s+|any\s+|all\s+)?${PHRASE}`, 'gi'),
  new RegExp(String.raw`\b${PHRASE}\s+(?:is|are)\s+(?:out of scope|not needed|no longer needed|not required)`, 'gi'),
];
const EXCLUDES = new RegExp(String.raw`\b(?:no|not|without|excluding)\s+${PHRASE}|\b${PHRASE}\s+(?:is|are)\s+(?:out of scope|not in scope|not needed)`, 'gi');
const ADDS_BACK = /\b(?:too|as well|also|now|in scope|add|adding|include|support)\b/i;

const phrases = (re: RegExp, text: string) =>
  [...text.matchAll(re)].map((m) => significantWords(m[1] ?? m[2] ?? '')).filter((w) => w.size > 0 && w.size <= 2);

/** What a statement takes out of the design: "Forget the dashboards" -> {dashboard}. */
export function droppedSubjects(text: string): Array<Set<string>> {
  return DROPS.flatMap((re) => phrases(re, text));
}
/** What a statement excludes: "no live streaming" -> {live, streaming}. */
export function excludedSubjects(text: string): Array<Set<string>> {
  return phrases(EXCLUDES, text);
}
/** A later statement brings an excluded thing back: "Leadership now wants live streaming too." */
export function bringsBack(text: string, subject: Set<string>): boolean {
  const words = significantWords(text);
  return [...subject].every((w) => words.has(w)) && ADDS_BACK.test(text) && !excludedSubjects(text).some((s) => [...subject].every((w) => s.has(w)));
}

const NUMBER_WORD = String.raw`(?:\d[\d,.]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred|a hundred|thousand|million|billion|single|a single|one single)`;
const QUANTITY = new RegExp(String.raw`\b(${NUMBER_WORD})(?:\s+(?:thousand|million|billion|k|m))?\s+([a-z][a-z-]+)(?:\s+([a-z]{3,}))?\b`, 'gi');
const QUANTITY_NOISE = /^(?:of|to|and|or|per|a|an|the|for|in|on|at|with|by|now|then|each|total|more|less|left|times|ways|things|parts)$/i;

/**
 * "has three floors" -> { floor: { n: "three", lead: "has" } }: a newer statement with another number for the same
 * noun can replace it. Both words after the number count ("20 million daily active users" -> daily, active); the
 * word before it tells "every five seconds" from "within thirty seconds".
 */
export function quantities(text: string): Map<string, { n: string; lead: string }> {
  const out = new Map<string, { n: string; lead: string }>();
  for (const m of text.matchAll(QUANTITY)) {
    const lead = /([a-z']+)\s*$/i.exec(text.slice(0, m.index))?.[1]?.toLowerCase() ?? '';
    for (const word of [m[2], m[3]]) {
      const noun = (word ?? '').toLowerCase();
      if (noun.length < 3 || QUANTITY_NOISE.test(noun)) continue;
      out.set(noun.replace(/ies$/, 'y').replace(/(?:es|s)$/, ''), { n: (m[1] ?? '').toLowerCase(), lead });
    }
  }
  return out;
}

/** Scope statements: "a single city for now" is replaced by "multiple regions" / "go global". */
export const SINGLE_SCOPE = /\b(?:single|one|a single) (?:city|region|country|data ?cent(?:er|re)|market|zone)\b|\bjust (?:one|a single) (?:city|region|country)\b/i;
export const WIDE_SCOPE = /\b(?:multi[- ]region|multiple (?:regions|cities|countries)|globally|global(?:ly)? (?:users|launch|rollout|scale)?|go(?:ing)? global|worldwide|across (?:regions|countries|continents))\b/i;

/** Feature named for removal in a sentence ("We can drop analytics."), as a feature key. */
export function droppedFeatureKey(rawSentence: string): string | null {
  const m = DROP_FEATURE.exec(clean(rawSentence));
  const k = m ? keyWords(m[1] ?? '') : '';
  return k ? `feature:${k}` : null;
}

// ---------------------------------------------------------------------------
// Topic signals
// ---------------------------------------------------------------------------

const DESIGN_TASK =
  /\b(?:design|architect)\s+(?:me\s+)?(?:a|an|the|our|your own)\s+([a-z0-9][\w\s.'/-]{1,48}?)(?=\s*(?:[.?!,;]|$)|\s+(?:that|which|for|with|where|who|to|from|in|using|like|so|and|at|on)\b)/i;
const DESIGN_LEAD = /\b(?:design|architect)\b/i;
const TITLE_NOISE = /^(?:simple|basic|scalable|distributed|highly available|high[- ]level|large[- ]scale|global|robust|reliable|production[- ]grade|new)\s+/i;

/** "The design problem is a food delivery app" / "Today's system design question is a ticketing site". */
const DESIGN_TOPIC =
  /\b(?:system )?design (?:problem|question|exercise|task|prompt)(?: for today| today)? (?:is|will be)[,:]?\s+(?:to (?:design|build) )?(?:a|an|the)\s+([a-z0-9][\w\s.'/-]{1,48}?)(?=\s*(?:[.?!,;]|$)|\s+(?:that|which|for|with|where|who|to|from|in|using|like|so|and|but|at|on)\b)/i;

/** "Design a URL shortener", "How would you design a rate limiter for…" -> "URL shortener" / "rate limiter". */
export function designTaskTitle(sentence: string): string | null {
  if (!DESIGN_LEAD.test(sentence)) return null;
  const m = DESIGN_TASK.exec(sentence) ?? DESIGN_TOPIC.exec(sentence);
  if (!m) return null;
  let title = clean(m[1] ?? '');
  while (TITLE_NOISE.test(title)) title = title.replace(TITLE_NOISE, '');
  title = title.replace(/\s+(?:system|service)$/i, '').trim();
  if (!title || /^(?:it|this|that|one|something|thing|way)$/i.test(title)) return null;
  return clip(title, 48);
}

/** "How would you design the table and the keys?": while a design is discussed, part of it rather than a new task. */
export const DESIGN_PART = /\b(?:design|architect)\s+(?:the|its|their|our)\s/i;

const DESIGN_REQUEST =
  /\b(?:let'?s|let us|we(?:'ll| will|'re going to| are going to)|i'?d like (?:you )?to|i want (?:you )?to|(?:your|the|today'?s) (?:task|question|problem|exercise) is(?: to)?)[,:]?\s+(?:(?:now|try to|go ahead and|quickly)\s+)?(?:design|architect)\b/i;
const LATER = /\b(?:later|afterwards|after (?:that|this)|next time|tomorrow|next round|before we)\b/i;

/** A design task set as a statement ("Okay, today let's design a ride-sharing service like Uber.") -> its title. */
export function designRequestTitle(text: string): string | null {
  for (const sentence of text.split(/(?<=[.?!])\s+/)) {
    if (DESIGN_REQUEST.test(sentence) && !LATER.test(sentence)) {
      const title = designTaskTitle(sentence);
      if (title) return title;
    }
  }
  return null;
}

export const EXPLICIT_SWITCH =
  /\b(?:let'?s|let us)\s+(?:now\s+)?(?:leave|park|drop|stop|pause|set aside|put aside|move (?:on|away) from|wrap up)\b|\b(?:unrelated|next question|different question|separate question|another (?:question|topic)|new topic|totally different|completely different|something (?:different|else))\b|^(?:(?:okay|ok|so|alright)[,.]?\s+)?last (?:one|question)\b|\b(?:moving on|move on|next topic|different topic|switch(?:ing)? (?:gears|topics?)|chang(?:e|ing) (?:of )?topics?|enough (?:about|on)|that'?s enough)\b|\b(?:let'?s|let us|now let'?s|now we'?ll|now i'?d like to)\s+(?:talk about|discuss|move (?:on )?to|switch to|turn to|go (?:on )?to|look at|cover|shift to|focus on)\b/i;
export const RETURN_TO_EARLIER =
  /\b(?:go(?:ing)? back to|back to (?:the|our|your)|return(?:ing)? to|com(?:e|ing) back to|revisit(?:ing)?|(?:one )?more on (?:the|our|your)|as (?:we|you) (?:discussed|said|mentioned) (?:earlier|before)|the original (?:design|question|problem|system)|earlier (?:design|problem|system|discussion|topic)|the (?:design|system) (?:from )?(?:earlier|before))\b/i;
const RETURN_TARGET = /\b(?:go(?:ing)? back to|back to|return(?:ing)? to|com(?:e|ing) back to|revisit(?:ing)?|(?:one )?more on)\s+([^,.?!;]+)/i;
/** Names an earlier design by its subject: "So in the dispatch system, would you use Kafka anywhere". */
export const NAMED_DESIGN = /\b(?:in|for|on|to|with|into) (?:the|our|your) ([\w-]+(?: [\w-]+){0,2}) (?:system|design|service|app|platform|pipeline)\b/i;
/** The user's own history, as opposed to "How do you handle retries?" asked about a design. */
export const OWN_HISTORY =
  /\b(?:did you|have you|had you|were you|you'?ve|you (?:worked|led|built|handled|shipped|owned|managed|mentored|faced)|your (?:experience|background|resume|cv|career|team|role|project|projects|previous|last|current|company|job|manager))\b|\btell (?:me|us) about (?:a time|yourself|your)\b/i;
/** What a "going back to…" names: "Going back to deadlocks, how would you…" -> "deadlocks". */
export function returnTarget(text: string): string | null {
  return RETURN_TARGET.exec(text)?.[1] ?? null;
}
/** Mentions earlier discussion without naming a topic ("what did we decide earlier?"). */
export const EARLIER_HINT = /\b(?:earlier|before|previously|so far|we discussed|we talked about|you said|you mentioned|we decided)\b/i;
/** Refers back to something already in the conversation. */
export const REFERENCE = /\b(?:it|this|that|these|those|them|the (?:design|system|service|database|cache|api|architecture|solution|approach|current setup))\b/i;
/** "What about…", "What if…", "How would you scale…": continues the current design discussion. */
export const CONTINUATION_CUE =
  /^(?:(?:and|so|okay|ok|now|also|then)[,]?\s+)*(?:which (?:one|two|three|of (?:them|these|those|the (?:two|three)))\b|where were we\b|as i was saying|what about|how about|what if|what happens|what would happen|how would you (?:scale|improve|test|monitor|secure|handle|deal with|extend|change|modify)|how do you (?:scale|handle)|now (?:add|make|support|let'?s add)|add\b|also\b|then\b|can we (?:replace|change|swap|use|add|make)|what are the (?:trade-?offs|bottlenecks|risks|failure modes)|where (?:is|are) the bottleneck)/i;
/** A technical question that introduces its own subject ("What's a bloom filter?", "Explain the CAP theorem."). */
export const NEW_SUBJECT =
  /^(?:(?:okay|ok|so|alright|now|and|next|also|then)[,.]?\s+)*(?:(?:can|could) you\s+)?(?:what(?:'s| is| are)\s+(?:a|an)\s|explain\s|define\s|(?:what(?:'s| is) )?the difference between|difference between|what does (?:a|an)\s|(?!(?:okay|ok|so|right|alright|and|now|well|yeah|then)\s*,)[\w' -]{2,40},\s*what (?:is|are) (?:it|they)\s*[?.]?$|how does (?:a|an)\s|how do (?:a|an)\s|tell me about (?:a|an)\s(?!time)|walk me through (?:how )?(?:a|an)\s|write (?:a|an)\s|implement (?:a|an)\s)/i;
/** Follow-up cues that hold inside quick technical Q&A ("Why?", "What about…", "Which one…"). */
export const TECH_FOLLOW_UP =
  /^(?:(?:and|so|also|then|okay|ok)[,]?\s+)*(?:what about|how about|which (?:one|two|three|of)\b|why\b|how so|and then|what else|any other|can you elaborate|elaborate|give me an example|for example|what'?s the (?:time|space) complexity|can you (?:optimi[sz]e|improve) it)/i;
/** Refers to a design discussed earlier ("How does your design change for…"). */
export const DESIGN_ARTIFACT = /\b(?:your|the|this|our|that) (?:design|system|architecture|schema|backend)\b|\bour (?:numbers|scale|estimates|requirements|constraints|traffic)\b/i;
/** Starts a new behavioral story rather than following up on the current one. */
export const NEW_STORY =
  /^(?:(?:okay|ok|so|now|alright|and|next)[,]?\s+)*(?:tell (?:me|us) about|describe (?:a|an|the|your)|give (?:me|us) an example|walk (?:me|us) through (?:a|an|your)|talk about (?:a|an|your)|why (?:are|did|do|would) you|what (?:made|makes) you|how do you (?:handle|deal with|approach)|what are your|have you (?:ever )?(?:had|been in|faced|dealt with|disagreed|worked with|led|built))\b/i;

/** Extending an active design: "Now add authentication.", "Support custom aliases too." */
export const DESIGN_EXTENSION = /^(?:(?:now|next|also|okay|ok|so|and|then)[,]?\s+)*(?:let'?s\s+)?(?:add|support|introduce|include|extend (?:it|this|the design) with|make it)\b/i;

const SUBTOPICS: Array<[string, RegExp]> = [
  ['caching', /\b(?:cach\w*|redis|memcached|cdn)\b/i],
  ['database', /\b(?:database|db|schema|data model|sql|nosql|postgres\w*|mysql|cassandra|dynamo\w*|mongo\w*|index\w*)\b/i],
  ['scaling', /\b(?:scal\w*|shard\w*|partition\w*|replica\w*|load balanc\w*|traffic|throughput|horizontal|vertical)\b/i],
  ['reliability', /\b(?:fail\w*|availability|outage|down|disaster|redundan\w*|backup|multi[- ]region|regions?)\b/i],
  ['api design', /\b(?:api|endpoint\w*|interface|rest|grpc|graphql)\b/i],
  ['security', /\b(?:secur\w*|auth\w*|permission\w*|encrypt\w*|rate limit\w*|abuse|spam)\b/i],
  ['messaging', /\b(?:queue\w*|kafka|messag\w*|event\w*|pub\/?sub|async\w*)\b/i],
  ['testing', /\b(?:test\w*|qa)\b/i],
  ['monitoring', /\b(?:monitor\w*|observab\w*|metric\w*|alert\w*|logging)\b/i],
  ['consistency', /\b(?:consisten\w*|transaction\w*|duplicat\w*|idempoten\w*|collision\w*|conflict\w*)\b/i],
  ['cost', /\b(?:cost\w*|budget|cheap\w*|expens\w*)\b/i],
];

/** Area of the current topic a question is about ("What would you use for caching?" -> "caching"). */
export function subtopicOf(text: string): string | undefined {
  return SUBTOPICS.find(([, re]) => re.test(text))?.[0];
}

const REQUEST_LEAD =
  /^(?:(?:so|okay|ok|now|and|then|alright|right)[,]?\s+)*(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:explain|describe|tell (?:me|us) about|talk (?:about|through)|walk (?:me|us) through|what (?:is|are)|what'?s|how (?:does|do|is|are)|give (?:me|us) an overview of|define|compare|let'?s (?:talk about|discuss|move (?:on )?to|switch to|turn to|look at|cover)|let us (?:talk about|discuss))\s+/i;

/** Short label for a new non-design topic, from the request ("Explain database indexing." -> "database indexing"). */
export function topicTitleOf(text: string): string {
  const core = clean(text.replace(REQUEST_LEAD, '').replace(/[.?!]+$/, ''));
  const words = core.split(/\s+/).filter((w) => !/^(?:the|a|an|your|our|my)$/i.test(w));
  return clip(words.slice(0, 5).join(' ') || 'general questions', 48);
}

/** Crude stem so "index"/"indexing" or "alias"/"aliases" match. */
const stem = (w: string) => (w.endsWith('ies') && w.length > 4 ? `${w.slice(0, -3)}y` : w.length > 5 ? w.replace(/(?:ing|ed|es|s)$/, '') : w.length > 3 ? w.replace(/s$/, '') : w);

/** Significant (stemmed) words, for matching a question to an earlier topic. */
export function significantWords(text: string): Set<string> {
  return new Set(
    tokenize(text)
      .filter((w) => w.length > 2 && !STOP.has(w) && !GENERIC.has(w))
      .map(stem),
  );
}
const GENERIC = new Set([
  'what', 'how', 'why', 'would', 'you', 'can', 'could', 'should', 'about', 'with', 'from', 'have', 'does', 'did', 'was', 'were', 'are', 'not',
  'back', 'going', 'original', 'earlier', 'design', 'system', 'explain', 'tell', 'use', 'make', 'like', 'more', 'then', 'now', 'let', 'lets',
  'discuss', 'talk', 'there', 'their', 'they', 'them', 'these', 'those', 'which', 'when', 'where', 'into', 'over', 'also', 'just', 'really',
  // Question scaffolding that says nothing about the subject ("What's the difference between…", "Okay, one more").
  'whats', 'difference', 'between', 'okay', 'one', 'two', 'right', 'used', 'using', 'had', 'has', 'time', 'next', 'goes', 'happen', 'happens',
  'thing', 'things', 'way', 'get', 'got', 'well', 'need', 'want', 'think', 'quick', 'question', 'questions', 'moment',
  'user', 'users', 'people', 'data', 'sec', 'bit', 'stuff', 'actually',
]);

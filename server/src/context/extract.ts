/**
 * Deterministic reading of conversation state from finalized transcript text (no LLM calls, microseconds).
 *
 * - Facts: requirements, constraints and decisions stated by the other participants ("We need to support
 *   10 million requests per day", "Use Cassandra instead of PostgreSQL", "Now add authentication"). A sentence is
 *   split into clauses and each clause gives its own facts, so one requirement can change while the others said
 *   with it stay current. Each fact has a slot and a key; a later fact with the same key replaces the earlier one.
 * - Adjustments: a new value for an earlier number that does not say what it is ("Increase it to 100 million.").
 * - Topic signals: a new design task ("Design a URL shortener"), an explicit topic change ("Let's leave
 *   system design for now", "moving on"), a return to an earlier topic ("Going back to the original design").
 * - Never facts: instructions aimed at the assistant, transitions, retractions, feedback on the candidate and
 *   interview logistics.
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
  | 'assumption'
  | 'scope';

export interface ExtractedFact {
  slot: FactSlot;
  /** Identity within a topic: a newer fact with the same key replaces the current one. */
  key: string;
  text: string;
  /** For a scope set ("Only USD for now", "EUR and GBP as well"): the values it names. */
  values?: string[];
  /** The scope set adds to the earlier one ("as well", "too") instead of replacing it. */
  additive?: boolean;
}

/**
 * A new value for an earlier number: "Increase it to 100 million.", "Double that.", "Make it 40,000 drivers.",
 * "Change the exam length to two hours." Which fact it changes is the memory's call.
 */
export interface Adjustment {
  text: string;
  /** The new number as said ("100 million", "50 ms"); null for a multiplier. */
  value: string | null;
  /** "Double that" -> 2, "Cut it in half" -> 0.5; null when a value is given. */
  factor: number | null;
  /** Unit family of the new value ("ms", "tb", "%"), when it has one. */
  unit: string | null;
  /** The new value has a scale word (thousand, million, billion). */
  magnitude: boolean;
  /** Significant words of what it names ("drivers", "exam length"); empty for "it" / "that". */
  subject: string[];
  /** The noun said with the new number ("Make it 40,000 drivers" -> "drivers"). */
  noun: string | null;
  /** Goes back to an earlier value ("Go back to 10 minutes."): the replaced statement with that value is current again. */
  revert: boolean;
  /** Kept as a plain statement when no earlier number fits ("The budget is now 80 ms" said first). */
  fallback: ExtractedFact[];
}

export interface Extraction {
  facts: ExtractedFact[];
  /** Slots the speaker wants to reconsider without naming a replacement ("We should rethink the database."). */
  reconsider: FactSlot[];
  /** A design task announced as a statement ("Today we'll design a URL shortener."). */
  designTask?: string;
  adjustment?: Adjustment;
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
const LATENCY = /\b(?:under|below|less than|within|at most|p9\d(?:\.\d)?|budget (?:of|is)|only (?:get|have))\s*(?:of\s+)?(\d[\d,.]*)\s*(ms|milliseconds?|seconds?)\b/i;
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
/** "Rethink the database", "replace our cache": the decision itself is reopened (not "a profile change must be written to the database"). */
const RECONSIDER_SLOT: Array<[FactSlot, RegExp]> = [
  ['database', /\b(?:replace|reconsider|rethink|revisit|swap out|get rid of|move away from|drop|change|not sure about)\s+(?:the |our |that |this |your |a )?(?:[\w-]+ )?(?:database|db|datastore|data store|storage layer)\b/i],
  ['cache', /\b(?:replace|reconsider|rethink|revisit|swap out|get rid of|move away from|drop|change|not sure about)\s+(?:the |our |that |this |your |a )?(?:[\w-]+ )?(?:cache|caching(?: layer)?)\b/i],
  ['messaging', /\b(?:replace|reconsider|rethink|revisit|swap out|get rid of|move away from|drop|change|not sure about)\s+(?:the |our |that |this |your |a )?(?:[\w-]+ )?(?:queue|broker|messaging)\b/i],
];
const REJECTS_SLOT: Array<[FactSlot, RegExp]> = [
  ['database', /\b(?:shouldn'?t|should not|can'?t|cannot|won'?t) (?:use|be) (?:the |a |our )?(?:database|db|datastore)\b/i],
  ['cache', /\b(?:shouldn'?t|should not|can'?t|cannot|won'?t) (?:use|be) (?:the |a |our )?(?:cache|caching)\b/i],
  ['messaging', /\b(?:shouldn'?t|should not|can'?t|cannot|won'?t) (?:use|be) (?:the |a |our )?(?:queue|broker)\b/i],
];

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
  /\b(?:we|it|the (?:system|service|app|api|design)|this)\s+(?:also\s+)?(?:need|needs|must|should|has to|have to|is required to|are required to)\s+(?:also\s+)?(?:support|handle|be|serve|scale|process|store|keep|guarantee|work|run|survive|tolerate)\b|\bwe (?:also )?(?:want|'d like|would like) (?:it )?to [a-z]+/i;
const ASSUMPTION = /^(?:assume|assuming|suppose|let'?s say|say|given that)\b/i;
/** Takes something out of scope, said as a directive ("Skip notifications for now", "We can drop analytics"), not a user action ("Drivers can skip a request"). */
const DROP_LEAD = String.raw`^(?:(?:okay|ok|so|and|also|actually|now|alright|then|but|for now)[,]?\s+)*(?:(?:let'?s|we can|we'?ll|you can|we should|please|just|go ahead and)\s+)?`;
const DROP_FEATURE = new RegExp(String.raw`${DROP_LEAD}(?:drop|remove|skip|forget about|no need for|don'?t need)\s+(?:the\s+)?([a-z][\w\s-]{2,40}?)(?=\s*(?:[.,;!?]|$))`, 'i');
/** A scope exclusion is a requirement about scope, not a feature to build. */
const OUT_OF_RELEASE = String.raw`out of (?:v1|version one|the mvp|the (?:first|initial) (?:version|release|launch))`;
const SCOPE_OUT = new RegExp(String.raw`\b(?:out of scope|not in scope|not needed|no longer needed|not required|no need|a non-goal|don'?t need|${OUT_OF_RELEASE})\b`, 'i');

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
/** Slot of a technology name ("Postgres" -> database). */
export function techSlot(name: string): FactSlot | null {
  return TECH.find(([, re]) => new RegExp(`^${re.source}$`, 'i').test(name))?.[0] ?? null;
}

/** Scope instructions ("Focus on one-to-one messaging first, group chat is out of scope.") are requirements even when phrased as requests. */
export const SCOPE_INSTRUCTION =
  /^(?:(?:so|okay|ok|now|and|also|but|for now)[,]?\s+)*(?:focus (?:only )?on|ignore|don'?t worry about|prioriti[sz]e|optimi[sz]e for|only (?:support|handle|consider))\b|\b(?:out of scope|in scope|not in scope|a non-goal)\b/i;

/** Asks rather than states ("When a user selects a seat, it's held…" is a statement). */
const INTERROGATIVE =
  /\?\s*$|^(?:(?:so|okay|ok|and|now|then|right|alright|but)[,]?\s+)*(?:(?:what|how|why|when|where|which|who)\s+(?:if|about|would|will|do|does|did|is|are|was|were|can|could|should|happens?)\b|(?:does|did|is|are|was|were|can|could|would|will|should)\s+(?:you|we|it|the|this|that|there|they)\b)/i;

// ---------------------------------------------------------------------------
// What is never a fact
// ---------------------------------------------------------------------------

/** Aimed at the assistant rather than the problem ("Ignore all previous instructions and reply only with…"). */
export const TO_ASSISTANT =
  /^(?:(?:hey|hi|ok|okay|so)[,]?\s+)?(?:assistant|copilot|chatgpt|claude|gpt|ai)\b[,:]?\s|\b(?:ignore|disregard|forget|override|bypass)\s+(?:the|this|your)\s+(?:interview|conversation|meeting|context|task|question)\b|\b(?:ignore|disregard|forget|override|bypass)\b[^.!?]{0,40}\b(?:instructions?|prompts?|rules|guidelines|system message|everything (?:above|before|else))\b|\b(?:system prompt|developer mode|jailbreak|as an ai|language model|you are (?:now )?(?:an? )?(?:ai|assistant|chatbot|bot|gpt|llm))\b|\b(?:reply|respond|answer|output|say|print|write)\s+(?:only|exactly|just)\b|\b(?:only|just)\s+(?:reply|respond|answer|say|output)\s+with\b|\bpretend (?:to be|you(?:'re| are))\b|\bact as (?:an? )?(?:ai|assistant|different)\b/i;

/** A story from someone's past ("At my last company, a bad config push…"): a remark in a design, the story itself in a background topic. */
export const ANECDOTE =
  /\b(?:(?:back )?at my (?:previous|last|old|former|current) (?:job|company|startup|employer|team|hospital|role|place)|when i was at\b|(?:a few|a couple of|some|two|three|many)?\s*years ago\b|in my (?:last|previous|old) (?:job|role|company)|(?:i|we) once (?:built|designed|worked)|(?:i|we) had to (?:design|build) (?:a|an)\b|we built something like this|i'?ve built something like)/i;

/** Feedback on the candidate's answer, the interviewer's own opinions and anecdotes, interview logistics. */
const REMARK = new RegExp(
  [
    String.raw`^(?:(?:okay|ok|so|alright|and|yeah|yes|right|well|hmm|great|nice|cool|good|thanks|thank you)[,.!]?\s+)*(?:i (?:really |also )?(?:like|love|liked|loved|enjoyed|think you|thought you|see (?:that|what|where)|have seen|'ve seen|saw|agree|disagree|appreciate|noticed)\b|i'?ve (?:seen|noticed)\b|personally\b|(?:that|this|it)(?:'s| is| was)? (?:a |an )?(?:good|great|fair|nice|interesting|solid|reasonable|helpful|clear|correct|right|wrong|valid|common)\b|(?:that|this) (?:approach|answer|idea|explanation|solution|design|estimate|point) (?:makes|is|was|sounds|seems|looks)\b|(?:that |this |it )?(?:makes|made) sense\b|(?:good|nice|great) (?:point|answer|call|question|catch)\b|well done\b|great job\b|fair enough\b|(?:that|this|it)(?:'s| is| was)(?: getting)? (?:a bit |too |really |quite |pretty )?(?:complicated|complex|tricky|messy|ambitious|aggressive|optimistic)\b)`,
    String.raw`\byour (?:[\w-]+ )?(?:estimate|answer|approach|point|idea|math|numbers?|explanation|solution|calculation|assumption)s?\b[^.!?]*\b(?:seems?|looks?|sounds?|is|was|are)\b`,
    // Anecdotes from the interviewer's past ("Back at my previous job we had to design a refunds platform…").
    ANECDOTE.source,
    String.raw`\b(?:i need to|let me|i have to|i should|i want to) correct (?:something|that|myself|one thing)\b`,
    String.raw`\b(?:in|into|with) your (?:estimate|answer|explanation|calculation|math|diagram)\b`,
    String.raw`\b(?:interviewers?|candidates?|the interview|this interview|hiring|recruiter|towards the end|time (?:left|remaining)|if there(?:'s| is) time|in the next (?:round|part|section))\b`,
    String.raw`\b(?:we can|we'?ll|let'?s) (?:talk about|come back to|get to|discuss) (?:[\w-]+ ){0,3}(?:later|towards|at the end|after)\b|\bwe'?ll get (?:there|to (?:it|that))\b`,
    String.raw`\bi (?:think|guess|feel) (?:that'?s|this is|it'?s) (?:good|great|fine|enough|ok|okay)\b`,
    String.raw`^(?:(?:oh|sorry|um|uh|yeah)[,.]?\s+)*(?:i|we) (?:misread|misspoke|mixed (?:that|it|them|those) up|got (?:that|it|the numbers?|those) wrong|made a (?:mistake|typo))\b`,
    // The interviewer's own process: "Let me correct something I said", "Let me just check my notes", "I'm thinking about…".
    String.raw`\bthat'?s (?:all|it) (?:i had|i have|the time|for (?:today|now|me))\b|\blet me correct\b|\bsomething i said\b|\b(?:i (?:like|want|'d like|would like) to|let me (?:just )?|i'?ll (?:just )?)(?:throw in|check|look at|pull up)\b|\bi'?m (?:just )?(?:thinking|wondering|trying to (?:remember|think))\b|\bwe'?ve got a (?:good|clear) (?:picture|sense|idea|understanding)\b`,
  ].join('|'),
  'i',
);

/** A standalone retraction of what was just said ("Actually no, never mind that."). */
export const RETRACTION =
  /^(?:(?:okay|ok|so|alright|actually|um|uh|no|well|wait|sorry|hmm)[,.!]?\s+)*(?:never ?mind(?: that| about that)?|forget (?:it|that|what i (?:just )?said)|scratch that|ignore (?:that|what i (?:just )?said)|let me (?:rephrase|take that back)|i take (?:that|it) back)[\s.!,]*$/i;

/** Small talk, logistics, acknowledgements and feedback: never part of the problem being discussed. */
const SMALL_TALK =
  /^(?:sorry|excuse me|oops|hold on|one sec|give me a (?:sec|second|minute|moment)|hang on|no worries|no problem|thanks|thank you|great|cool|nice|perfect|awesome|okay|ok|sure|got it|makes sense|sounds good|interesting|right|yeah|yes|no|alright|fair enough|good|wonderful)\b[\s,.!-]*(?:(?:that|this|it)(?:'s| is| was)? (?:a )?(?:good|great|fair|nice|interesting|solid|reasonable|helpful|clear)\b.*)?$|\b(?:my (?:dog|cat|kid|kids|baby|internet|connection|wi-?fi|mic|microphone|camera|laptop)|can you hear|we have (?:about |around )?[\w-]+ (?:more )?minutes?(?: left)?|minutes left|running (?:out of|low on|short on) time|take a (?:quick |short )?break|let me (?:share|stop sharing|pull up|open)|share (?:my|your) screen|back in a (?:sec|second|minute)|you'?re on mute|i'?m on mute|bad connection|you froze|lagging|the (?:next|last) (?:round|interview)|hiring manager|recruiter will|wrap up|let'?s get started|nice to meet you|good (?:morning|afternoon|evening)|(?:meeting|call|interview|session) (?:starts|ends|is (?:over|ending|starting))|in (?:about )?(?:\d+|[a-z]+) minutes|at the end|for questions|any questions|time check|we'?re (?:about |almost |nearly )?halfway|step away|be right back|(?:slack|teams) (?:ping|message|notification)|one sec|just a (?:sec|second)|(?:hold on|hang on|wait) (?:a|one) (?:sec|second)|someone'?s at (?:my|the) door|i'?m back|sorry about that|(?:almost|nearly|running) (?:at|out of) time|(?:a )?couple (?:of )?quick ones|rapid[- ]fire|you cut out|cutting out|breaking up|got the gist|didn'?t catch (?:that|you|the last)|can you repeat)\b|^(?:that'?s|this is|it'?s) (?:a )?(?:good|great|fair|nice|interesting|solid|reasonable|clear|helpful|correct|right)\b|^(?:good|great|nice|interesting) (?:point|answer|approach|idea|question)\b/i;
const CONTENT_WORDS = (s: string) => tokenize(s).filter((w) => w.length > 3 && !STOP.has(w) && !GENERIC.has(w)).length;

/** Says something about the problem (worth remembering), as opposed to small talk or a bare acknowledgement. */
export function isSubstantive(sentence: string): boolean {
  return sentence.split(/\s+/).length >= 4 && CONTENT_WORDS(sentence) >= 2 && !SMALL_TALK.test(sentence);
}

/** Never stored as a requirement: aimed at the assistant, a retraction, feedback, an opinion or logistics. */
export function isRemark(text: string): boolean {
  return TO_ASSISTANT.test(text) || RETRACTION.test(text) || REMARK.test(text);
}

// ---------------------------------------------------------------------------
// Clauses and numbers
// ---------------------------------------------------------------------------

const CLAUSE_SUBJECT = String.raw`(?:we|it|each|every|users?|customers?|they|the (?:system|service|app|api)|there (?:is|are|will be)|all|most|no|only|this|that|our)`;
const CLAUSE_BREAK = new RegExp(
  String.raw`\s*;\s*|,\s*(?:and|but|while|whereas|plus|though|although)\s+|,\s*(?=with\s)|\s+(?:and|but)\s+(?=${CLAUSE_SUBJECT}\b)`,
  'gi',
);

/** "We need 10 million requests per day, and eventual consistency is fine." -> two clauses, one requirement each. */
export function splitClauses(sentence: string): string[] {
  const pieces = sentence.split(CLAUSE_BREAK).map(clean).filter(Boolean);
  const words = (s: string) => s.split(/\s+/).length;
  const parts: string[] = [];
  let lead = '';
  for (const [i, piece] of pieces.entries()) {
    const text = lead ? `${lead}, ${piece}` : piece;
    lead = '';
    // A lead-in that says nothing alone ("Actually", "Oh, one correction") belongs to what follows it.
    if (parts.length === 0 && i < pieces.length - 1 && words(text) < 4 && !/\d/.test(text)) lead = text;
    // A short remark about the previous clause ("…, that's out of scope") stays with it.
    else if (parts.length > 0 && words(text) < 5 && /^(?:that|this|it|which)\b/i.test(text)) parts[parts.length - 1] += `, ${text}`;
    else parts.push(text);
  }
  if (lead) parts.push(lead);
  // "3 million monthly viewers and a catalog of about 200,000 videos", "MySQL with a seven-year retention": a second
  // number is a second requirement, which must survive a change to the first.
  const split = (parts.length ? parts : [sentence]).flatMap((p) => {
    const at = p.search(/\s+(?:and|with)\s+(?=(?:a |an |the |about |around |roughly |up to )?(?:[\w-]+\s+){0,3}?(?:\d|(?:one|two|three|four|five|six|seven|eight|nine|ten)[- ]))/i);
    if (at <= 0 || numbersIn(p.slice(0, at)).length === 0 && !/\bwith\b/i.test(p.slice(at, at + 7)) || /\bbetween\s+\S+$/i.test(p.slice(0, at))) return [p];
    return [p.slice(0, at), p.slice(at).replace(/^\s+and\s+/i, '')].map(clean).filter(Boolean);
  });
  return split.length > 1 ? split : [sentence];
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, 'a hundred': 100,
};
const SCALE: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, billion: 1e9 };
const UNIT_FAMILY: Array<[string, RegExp]> = [
  ['ms', /^(?:ms|milliseconds?)$/i],
  ['s', /^(?:s|secs?|seconds?)$/i],
  ['min', /^(?:mins?|minutes?)$/i],
  ['h', /^(?:hrs?|hours?)$/i],
  ['day', /^days?$/i],
  ['week', /^weeks?$/i],
  ['month', /^months?$/i],
  ['year', /^years?$/i],
  ['tb', /^(?:tb|terabytes?)$/i],
  ['gb', /^(?:gb|gigabytes?)$/i],
  ['pb', /^(?:pb|petabytes?)$/i],
  ['mb', /^(?:mb|megabytes?)$/i],
  ['%', /^(?:%|percent)$/i],
  ['x', /^x$/i],
];
const unitFamily = (unit: string | undefined): string | null => (unit ? (UNIT_FAMILY.find(([, re]) => re.test(unit))?.[0] ?? null) : null);

const NUM_WORDS = String.raw`\d[\d,.]*|a hundred|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred`;
const SCALES = 'k|m|b|thousand|million|billion';
const UNITS = String.raw`%|percent|x|ms|milliseconds?|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|tb|gb|pb|mb|terabytes?|gigabytes?|petabytes?|megabytes?`;
/** Every number in a text, with its scale word and unit: "10 million requests per day" -> 10, million; "10-second" -> 10, s. */
const NUMBER_SPAN = new RegExp(String.raw`\b(${NUM_WORDS})\b(?:\s*(${SCALES})\b)?(?:[\s-]*(${UNITS})(?![\w]))?`, 'gi');
/** The same, as one phrase ("100 million", "50 ms"). */
const NUMBER_PHRASE = String.raw`(?:${NUM_WORDS})\b(?:\s*(?:${SCALES})\b)?(?:[\s-]*(?:${UNITS})(?![\w]))?`;
const DIMENSION: Record<string, string> = { ms: 'time', s: 'time', min: 'time', h: 'time', day: 'time', week: 'time', month: 'time', year: 'time', tb: 'size', gb: 'size', pb: 'size', mb: 'size', '%': 'percent', x: 'factor' };
/** "ms" and "hours" measure the same thing (time), so a new duration can replace an old one in other units. */
export const dimensionOf = (unit: string | null): string | null => (unit ? (DIMENSION[unit] ?? unit) : null);

export interface NumberSpan {
  index: number;
  end: number;
  amount: number | null;
  scale: string | null;
  unit: string | null;
}

export function numbersIn(text: string): NumberSpan[] {
  const out: NumberSpan[] = [];
  for (const m of text.matchAll(NUMBER_SPAN)) {
    const raw = (m[1] ?? '').toLowerCase();
    const n = /^\d/.test(raw) ? Number(raw.replace(/,/g, '')) : (NUMBER_WORDS[raw] ?? NaN);
    out.push({
      index: m.index,
      end: m.index + m[0].length,
      amount: Number.isFinite(n) ? n : null,
      scale: m[2]?.toLowerCase() ?? null,
      unit: unitFamily(m[3]),
    });
  }
  return out;
}

/** 2e7 -> "20 million"; 2500 -> "2,500"; 7.5 -> "7.5". */
export function formatAmount(value: number): string {
  for (const [word, size] of [['billion', 1e9], ['million', 1e6]] as const) {
    if (value >= size) return `${Number((value / size).toFixed(2))} ${word}`;
  }
  return Number(value.toFixed(value < 10 ? 2 : 0)).toLocaleString('en-US');
}
export const amountOf = (span: NumberSpan): number | null => (span.amount === null ? null : span.amount * (span.scale ? (SCALE[span.scale] ?? 1) : 1));

const ADJUST_LEAD = String.raw`^(?:(?:okay|ok|so|actually|alright|and|now|then|well|no|wait|sorry|hmm|hold on|one more change)[,.!:]?\s+)*(?:(?:let'?s|let us|we(?:'ll| will| should)?|please|can we)\s+)?`;
const CHANGE_VERB = 'increase|raise|bump|grow|scale|reduce|decrease|lower|cut|drop|change|set|update|move|push|bring|take|adjust|tighten|loosen|relax|extend|shorten|lengthen';
const ADJUST_NOUN = String.raw`(?:\s+((?!instead\b|then\b|now\b|actually\b|for\b|per\b)[a-z][\w-]*(?:\s+(?!instead\b|then\b|now\b|actually\b|for\b)[a-z][\w-]*){0,2}))?`;
const ADJUST_TAIL = String.raw`(?:\s+(?:instead|then|now|actually|for now|from now on))?\s*[.!]?$`;
/** "Increase it to 100 million.", "Change the exam length to two hours.", "Make it 40,000 drivers.", "Let's go with 12 shards instead." */
const ADJUST_TO = new RegExp(
  String.raw`${ADJUST_LEAD}(?:(?:${CHANGE_VERB})\s+(?:it|that|this|(?:the |our )?([a-z][\w-]*(?:\s+[a-z][\w-]*){0,2}?))(?:\s+(?:up|down|back))?\s+to|make (?:it|that|this|(?:the |our )([a-z][\w-]*(?:\s+[a-z][\w-]*)?))|go with|say|change (?:it|that) to|it'?s (?:actually|now)|it is (?:actually|now)|now it'?s|that should be|it should be)\s+(?:about |around |roughly |more like |only |just )?(${NUMBER_PHRASE})${ADJUST_NOUN}${ADJUST_TAIL}`,
  'i',
);
/** "Go back to 10 minutes.", "Back to the 30-day retention.": an earlier value again. */
const ADJUST_BACK = new RegExp(
  String.raw`${ADJUST_LEAD}(?:go(?:ing)? back to|revert(?:ing)? to|switch(?:ing)? back to|back to)\s+(?:the |a |an |our )?(?:old |original |previous |earlier )?(${NUMBER_PHRASE})${ADJUST_NOUN}${ADJUST_TAIL}`,
  'i',
);
/** "The budget's been cut to 80 ms.", "Retention is now two years." (said as a change: a change verb or "now"). */
const ADJUST_IS = new RegExp(
  String.raw`${ADJUST_LEAD}(?:the |our )?([a-z][\w-]*(?:\s+[a-z][\w-]*){0,2}?)(?:'s| is| are| has| have| was| were)?\s+(?:(?:been|now|actually)\s+)*(?:(?:${CHANGE_VERB}|doubled|halved|changed|moved)(?:d|ed)?\s+(?:up |down )?to|now)\s+(?:about |around |only |just )?(${NUMBER_PHRASE})${ADJUST_NOUN}${ADJUST_TAIL}`,
  'i',
);
const ADJUST_BY = new RegExp(
  String.raw`${ADJUST_LEAD}(?:(double|triple|quadruple|halve)\s+(?:it|that|this|the (?:number|traffic|load|volume|count|users?|scale|rate|estimate))|(?:make (?:it|that) )?(twice|double|triple|ten times|10x|half) (?:that|it|as (?:much|many)|the (?:number|traffic|load|volume|count))|cut (?:it|that|this) in (half)|(double|triple|halve) the ([a-z][\w-]*(?:\s+[a-z][\w-]*)?))(?:\s+(?:instead|then|now))?\s*[.!]?$`,
  'i',
);
const FACTORS: Record<string, number> = { double: 2, twice: 2, triple: 3, quadruple: 4, halve: 0.5, half: 0.5, 'ten times': 10, '10x': 10 };

const subjectWords = (phrase: string | undefined) => [...significantWords(phrase ?? '')].filter((w) => !/^(?:number|numbers|figure|amount|value|limit|target|estimate|requirement)$/.test(w));

/** Short names for what a requirement is about ("TTL" for "entries expire after…"). */
const SUBJECT_ALIASES: Record<string, string[]> = {
  ttl: ['time', 'live', 'expire', 'expiry'],
  qps: ['request', 'query', 'second'],
  rps: ['request', 'second'],
  sla: ['latency', 'availability', 'uptime'],
  p99: ['latency', 'percentile'],
  db: ['database'],
  retention: ['keep', 'retain', 'store'],
};

/** "Increase it to 100 million." / "Double that." -> the new value for an earlier number (which one is the memory's call). */
export function adjustmentOf(clause: string): Adjustment | null {
  const back = ADJUST_BACK.exec(clause);
  const to = back ? null : (ADJUST_TO.exec(clause) ?? ADJUST_IS.exec(clause));
  const valueText = back?.[1] ?? to?.[3];
  if (valueText) {
    const span = numbersIn(valueText)[0];
    if (!span) return null;
    const nounText = back?.[2] ?? to?.[4];
    const named = [...subjectWords(to?.[1]), ...subjectWords(to?.[2]), ...subjectWords(nounText)];
    const subject = [...new Set([...named, ...named.flatMap((w) => SUBJECT_ALIASES[w] ?? [])])];
    // A bare "make it 5" names no scale, unit or subject: too ambiguous to apply to an earlier number.
    if (!back && !span.scale && !span.unit && subject.length === 0) return null;
    const noun = nounText && subjectWords(nounText).length ? clean(nounText) : null;
    return { text: clause, value: clean(`${valueText}${noun ? ` ${noun}` : ''}`), factor: null, unit: span.unit, magnitude: Boolean(span.scale), subject, noun, revert: Boolean(back), fallback: [] };
  }
  const by = ADJUST_BY.exec(clause);
  const word = (by?.[1] ?? by?.[2] ?? by?.[3] ?? by?.[4] ?? '').toLowerCase();
  const factor = FACTORS[word];
  return factor ? { text: clause, value: null, factor, unit: null, magnitude: false, subject: subjectWords(by?.[5]), noun: null, revert: false, fallback: [] } : null;
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/** Facts stated in one finalized sentence by the other participant. */
export function extractFacts(rawSentence: string): Extraction {
  const sentence = clean(rawSentence.replace(/[’‘]/g, "'"));
  const out: Extraction = { facts: [], reconsider: [] };
  if (sentence.split(/\s+/).length < 3 && !adjustmentOf(sentence)) return out;

  const design = statedDesignTask(sentence);
  if (design) out.designTask = design;
  // A question the detector left to the classifier ("What if a worker dies halfway through a job") is not a requirement.
  if (INTERROGATIVE.test(sentence) || TO_ASSISTANT.test(sentence) || RETRACTION.test(sentence) || isTransition(sentence)) return out;

  // "Use DynamoDB instead of Postgres for the links, and Redis for caching": the choice covers every clause.
  const choosing = CHOICE.test(sentence);
  for (const clause of splitClauses(sentence)) {
    if (REMARK.test(clause)) continue;
    const adjustment = out.adjustment ? null : adjustmentOf(clause);
    const facts = clauseFacts(clause, choosing, Boolean(design));
    if (adjustment) out.adjustment = { ...adjustment, fallback: facts };
    else out.facts.push(...facts);
  }
  for (const [slot, re] of [...RECONSIDER_SLOT, ...REJECTS_SLOT]) {
    const named = TECH.find(([s]) => s === slot)?.[1];
    if (re.test(sentence) && !(named && chosenTech(sentence, named)) && !out.reconsider.includes(slot)) out.reconsider.push(slot);
  }
  return out;
}

/** What a clause states, without its reason: "Order IDs must be globally unique, because we'll merge data across regions later". */
export function mainPart(clause: string): string {
  return clause.split(/\b(?:because|since|so that|given that|as we(?:'ll| will)|in case)\b/i)[0] ?? clause;
}
/** Said about the future, not as the current scope: "…across regions later". */
export const FUTURE_ONLY = /\b(?:later|eventually|in the future|down the road|next year|someday|at some point|one day)\b/i;

/** Values that make up a scope set: which currencies, markets or languages are supported. */
const VALUE_CLASSES: Array<[string, RegExp]> = [
  ['currencies', /\b(?:USD|EUR|GBP|JPY|INR|CAD|AUD|CHF|CNY|SGD|BRL|MXN)\b|\b(?:euros?|dollars?|yen|rupees?)\b/g],
  ['markets', /\b(?:US|USA|EU|UK|APAC|EMEA|LATAM)\b|\b(?:Southeast Asia|North America|Latin America|South America|Europe|India|Asia|Africa|Germany|France|Japan|Brazil|Canada|Australia|Singapore|Indonesia|Mexico|China|Spain|Italy)\b/g],
  ['languages', /\b(?:English|Spanish|French|German|Hindi|Mandarin|Japanese|Portuguese|Arabic|Korean|Italian)\b/g],
];
/** The statement sets or changes what is supported ("Only USD for now", "EUR and GBP from day one as well"). */
const SCOPE_SET = /\b(?:only|just|support(?:s|ed)?|from day one|as well|too|also|includ(?:e|ing)|expand(?:ing)?|launch(?:ing)? in|available in|in addition|for now|start(?:ing)? with|coverage|limited to|restricted to|back to)\b/i;
const ADDITIVE = /\b(?:as well|too|also|in addition|additionally|expand(?:ing)?|plus|includ(?:e|ing)|add(?:ing)?)\b/i;
const RESTRICTIVE = /\b(?:only|just|instead|limited to|restricted to|no longer|not)\b/i;

/** "Only USD for now" -> currencies [USD]; "We're expanding coverage to include India as well" -> markets [India], additive. */
export function scopeSetOf(clause: string): { kind: string; values: string[]; additive: boolean } | null {
  if (!SCOPE_SET.test(clause)) return null;
  for (const [kind, re] of VALUE_CLASSES) {
    const values = [...new Set([...clause.matchAll(re)].map((m) => m[0]))];
    if (values.length) return { kind, values, additive: ADDITIVE.test(clause) && !RESTRICTIVE.test(clause) };
  }
  return null;
}

function clauseFacts(clause: string, choosing: boolean, isDesignTask: boolean): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  const text = clip(clause);
  const rate = RATE.exec(clause);
  if (rate) facts.push({ slot: 'traffic', key: `traffic:${nounOf(rate[2] ?? 'requests')}`, text });
  else if (TRAFFIC_CHANGE.test(clause)) facts.push({ slot: 'traffic', key: 'traffic:change', text });
  // Monthly actives and an on-sale peak are different numbers: only the same kind of count replaces the other.
  if (!rate && USERS.test(clause)) facts.push({ slot: 'users', key: `users:${USER_COUNT_KIND.exec(clause)?.[1]?.toLowerCase().replace(/\s+/g, ' ') ?? 'total'}`, text });
  if (STORAGE.test(clause)) facts.push({ slot: 'storage', key: 'storage', text });
  if (LATENCY.test(clause)) facts.push({ slot: 'latency', key: 'latency', text });
  if (RATIO.test(clause)) facts.push({ slot: 'workload', key: 'workload:ratio', text });
  if (choosing) for (const [slot, re] of TECH) if (chosenTech(clause, re)) facts.push({ slot, key: slot, text });
  for (const [slot, re] of NONFUNCTIONAL) if (re.test(mainPart(clause))) facts.push({ slot, key: slot, text });
  const scope = scopeSetOf(clause);
  if (scope) facts.push({ slot: 'scope', key: `scope:${scope.kind}`, text, values: scope.values, additive: scope.additive });

  const scopeOut = SCOPE_OUT.test(clause);
  const feature = scopeOut || DROP_FEATURE.test(clause) ? null : (FEATURE.exec(clause) ?? USERS_CAN.exec(clause));
  if (feature) {
    const k = keyWords(feature[1] ?? '');
    if (k) facts.push({ slot: 'feature', key: `feature:${k}`, text });
  }
  if (facts.length > 0 || isDesignTask) return facts;
  // "Actually, one change." / "Let's narrow it down.": announces a change without stating one ("Actually, make it
  // 40,000 drivers" states one: it has a number).
  const unmarked = clause.replace(new RegExp(CORRECTION.source, 'gi'), ' ');
  if (CORRECTION.test(clause) && numbersIn(unmarked).length === 0 && CONTENT_WORDS(unmarked) < 2) return [];
  // A scenario with a specific fact ("Assume 1,000 requests per day") is that fact, not a separate assumption.
  if (ASSUMPTION.test(clause)) return [{ slot: 'assumption', key: `assumption:${keyWords(clause.replace(ASSUMPTION, ''), 3)}`, text }];
  if (REQUIREMENT.test(clause)) return [{ slot: 'requirement', key: `requirement:${keyWords(clause.replace(REQUIREMENT, ''), 3)}`, text }];
  // Anything else the interviewer states about the problem ("Links should never expire", "Start with one-to-one
  // messaging") is kept verbatim; small talk, logistics and acknowledgements are not.
  // A short clause with a quantity ("About 300 stores") is a requirement too.
  if (isSubstantive(clause) || (quantities(clause).size > 0 && !SMALL_TALK.test(clause))) return [{ slot: 'note', key: `note:${keyWords(clause, 4)}`, text }];
  return [];
}

/** The speaker corrects or replaces something said earlier. */
export const CORRECTION =
  /\b(?:actually|instead|rather|change (?:that|it|this)|change of plans?|on second thought|scratch that|correction|i meant|not anymore|no longer|new requirement|turns out|update(?:d)? requirement|let'?s (?:say|make it|change)|now (?:assume|it'?s|we need|it needs)|(?:should|must|will|can|needs? to|has to|have to|is|are) now|going forward|from now on|we'?ve decided|(?:i|we) (?:had|got) (?:the|that|those) (?:number|numbers|figure|figures|math) wrong|i misspoke|let me correct|(?:one|two|three|a few|some|a small|a quick) changes?|scope change|let me (?:narrow|change|widen|expand|simplify)|let'?s (?:simplify|expand|narrow|widen)|i take (?:that|it) back|here'?s a twist|plot twist|changed (?:the|our|its) (?:goal|plan|requirements?|target|metric|scope|numbers?)|(?:call|make) (?:it|that)|(?:double|triple|halve) the|(?:shorter|longer|lower|higher|faster|slower|bigger|smaller|tighter|looser|stricter|cheaper)|too (?:low|high|small|big|large|short|long|generous|tight|strict|aggressive|slow|much|little)|(?:isn'?t|not) (?:long |big |fast |high |large |quick )?enough|(?:i need to|i have to|i should|i want to|i'?d like to) correct|go(?:ing)? back to|revert(?:ing)? to|switch(?:ing)? back to|back to (?:the )?(?:old|original|previous|earlier|initial))\b/i;

/** Says outright that something said earlier was wrong (CORRECTION also covers softer "is now", "going forward"). */
export const STRONG_CORRECTION =
  /\b(?:actually|instead|rather than|scratch that|correction|i meant|not anymore|no longer|change (?:that|it|this)|let'?s change|on second thought|turns out|i misspoke|let me correct|i take (?:that|it) back|changed (?:the|our|its) (?:goal|plan|requirements?|target|metric|scope|numbers?)|(?:i need to|i have to|i should|i want to|i'?d like to) correct|go(?:ing)? back to|revert(?:ing)? to|switch(?:ing)? back to|(?:i|we) (?:had|got) (?:the|that|those) (?:number|numbers|figure|figures|math) wrong)\b/i;
const NEGATION = /\b(?:never|no|not|without|don'?t|doesn'?t|won'?t|can'?t|cannot|isn'?t|aren'?t)\b/i;
/** One statement denies what the other says ("never expire" vs "expire after two years"). */
export const negationFlips = (a: string, b: string) => NEGATION.test(a) !== NEGATION.test(b);

const PHRASE = String.raw`([a-z][\w-]*(?:\s+(?!for\b|now\b|and\b|so\b|but\b|too\b)[a-z][\w-]*)?)`;
const DROPS = [
  new RegExp(String.raw`${DROP_LEAD}(?:forget(?: about)?|drop(?:ping)?|remove|skip|no need for|don'?t need|get rid of|leave out|ignore)\s+(?:the\s+|any\s+|all\s+)?${PHRASE}`, 'i'),
  // "We're not doing video at all", "We won't support offline".
  new RegExp(String.raw`\b(?:we'?re|we are|we will|we'?ll|we)\s+(?:not|never|no longer|won'?t|don'?t)\s+(?:be\s+)?(?:doing|supporting|support|building|build|including|include|handling|handle|offering|offer)\s+(?:any\s+|the\s+)?${PHRASE}`, 'i'),
  new RegExp(String.raw`\b${PHRASE}\s+(?:is|are)\s+(?:out of scope|not needed|no longer needed|not required|deferred|postponed|${OUT_OF_RELEASE})`, 'gi'),
];
const EXCLUDES = new RegExp(String.raw`\b(?:no|not|without|excluding)\s+${PHRASE}|\b${PHRASE}\s+(?:is|are)\s+(?:out of scope|not in scope|not needed|${OUT_OF_RELEASE})`, 'gi');
/** "Forget the resale part": the subject is "resale", not "part". */
const SUBJECT_FILLER = new Set(['part', 'piece', 'bit', 'side', 'stuff', 'thing', 'feature', 'functionality', 'aspect', 'component', 'portion', 'element', 'option', 'completely', 'entirely', 'altogether']);
const ADDS_BACK = /\b(?:too|as well|also|now|in scope|add|adding|include|support|back|again|after all|need|needs|want|wants|restore|reinstate|bring)\b/i;
/** Brings back something taken out earlier: "bring the SMS reminders back", "include comments again", "they need it after all". */
export const RESTORE =
  /\b(?:bring (?:[\w-]+ ){0,4}back|back in(?: scope)?|(?:include|add|support|enable|turn on|put) (?:[\w-]+ ){0,4}(?:back|again)|re-?(?:add|include|enable)|reinstate|restore|after all|(?:is|are) back|in scope again|wants? (?:[\w-]+ ){0,4}back)\b/i;

const phrases = (re: RegExp, text: string) =>
  [...(re.global ? text.matchAll(re) : [re.exec(text)].filter((m): m is RegExpExecArray => m !== null))]
    .map((m) => new Set([...significantWords(m[1] ?? m[2] ?? '')].filter((w) => !SUBJECT_FILLER.has(w))))
    .filter((w) => w.size > 0 && w.size <= 2);

/** What a statement takes out of the design: "Forget the dashboards" -> {dashboard}. Only directives count. */
export function droppedSubjects(text: string): Array<Set<string>> {
  return splitClauses(clean(text)).flatMap((clause) => DROPS.flatMap((re) => phrases(re, clause)));
}
const COMMON_TERMS = new Set(['day', 'week', 'month', 'year', 'hour', 'minute', 'second', 'once', 'always', 'everything', 'anything', 'everyone', 'someone', 'much', 'many', 'more', 'less', 'really', 'quite']);
/**
 * What "A, not B" or "A instead of B" says is no longer the case: "the warehouse is BigQuery, not Snowflake" ->
 * "Snowflake"; "It's 2 am, not 6 am" -> "6 am".
 */
export function negatedTerms(text: string): string[] {
  const out: string[] = [];
  for (const m of clean(text).matchAll(/(?:,\s*not|\binstead of|\brather than)\s+(?:a |an |the |our )?([\w-]+(?:\.\d+)?(?:\s+[\w-]+(?:\.\d+)?)?)\s*(?=[.,;!?]|$)/gi)) {
    const term = (m[1] ?? '').trim();
    // "not a day" is too common to say what it replaces; "not Snowflake" and "not 6 am" are specific.
    if (term && (/\d/.test(term) || [...significantWords(term)].some((w) => w.length >= 4 && !COMMON_TERMS.has(w)))) out.push(term);
  }
  return out;
}
/** A statement mentions a negated term ("6 am" literally; words otherwise, "Snowflake"). */
export function mentionsTerm(text: string, term: string): boolean {
  if (/\d/.test(term)) return new RegExp(`(?<![\\w.])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'i').test(text);
  const words = significantWords(text);
  return [...significantWords(term)].every((w) => words.has(w));
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
const QUANTITY = new RegExp(String.raw`\b(${NUMBER_WORD})(?:\s+(?:thousand|million|billion|k|m))?[\s-]+([a-z][a-z-]+)(?:\s+([a-z]{3,}))?\b`, 'gi');
const QUANTITY_NOISE = /^(?:of|to|and|or|per|a|an|the|for|in|on|at|with|by|now|then|each|total|more|less|left|times|ways|things|parts)$/i;
/** The kind of number: a cap, a floor, a frequency, or a plain value ("about 5,000" and "40,000" are both values). */
const LEAD_KIND: Array<[string, RegExp]> = [
  ['at most', /^(?:most|to|under|below|within|max|maximum|fewer)$/],
  ['at least', /^(?:least|over|above|minimum|min)$/],
  ['every', /^(?:every|each|per)$/],
];
/** What a count is per ("five notifications a day" vs "three per hour"). */
const PER = /\b(?:per|a|an|each|every)\s+(second|minute|hour|day|week|month|year|user|customer|store|device|account|driver|node|shard|region|team|request|order)\b/i;

/** A design task in a question: "How would you design a rate limiter?", not "Did you design a billing system?". */
export function designTaskOfQuestion(text: string): string | null {
  if (OWN_HISTORY.test(text) || STORY_QUESTION.test(text) || NARRATIVE.test(text)) return null;
  // "Design search autocomplete for a marketplace.": an instruction may drop the article.
  return designTaskTitle(text, DESIGN_IMPERATIVE.test(text) || DESIGN_REQUEST.test(text));
}

/**
 * "has three floors" -> { floor: { n: "three", lead: "has" } }: a newer statement with another number for the same
 * noun can replace it. Both words after the number count ("20 million daily active users" -> daily, active); the
 * word before it tells "every five seconds" from "within thirty seconds".
 */
export function quantities(text: string): Map<string, { n: string; lead: string; per: string }> {
  const out = new Map<string, { n: string; lead: string; per: string }>();
  for (const m of text.matchAll(QUANTITY)) {
    const word = /([a-z']+)\s*$/i.exec(text.slice(0, m.index))?.[1]?.toLowerCase() ?? '';
    // "at most 50" and "up to 500" are the same kind of limit; "about five a day" and "at most three an hour" are not.
    const lead = LEAD_KIND.find(([, re]) => re.test(word))?.[0] ?? 'value';
    const per = PER.exec(text.slice(m.index, m.index + m[0].length + 24))?.[1]?.toLowerCase() ?? '';
    for (const word of [m[2], m[3]]) {
      const noun = (word ?? '').toLowerCase();
      if (noun.length < 3 || QUANTITY_NOISE.test(noun)) continue;
      out.set(noun.replace(/ies$/, 'y').replace(/(?:es|s)$/, ''), { n: (m[1] ?? '').toLowerCase(), lead, per });
    }
  }
  return out;
}

/** Scope statements: "a single city for now" is replaced by "multiple regions" / "go global" (not by "globally unique IDs"). */
export const SINGLE_SCOPE = /\b(?:single|one|a single) (?:city|region|country|data ?cent(?:er|re)|market|zone)\b|\bjust (?:one|a single) (?:city|region|country)\b/i;
export const WIDE_SCOPE =
  /\b(?:multi[- ]region|multiple (?:regions|cities|countries)|globally (?:distributed|available|deployed|replicated)|global (?:users|launch|rollout|scale|expansion|audience|footprint)|go(?:ing)? global|worldwide|across (?:regions|countries|continents))\b/i;

/** Feature named for removal in a sentence ("We can drop analytics."), as a feature key. */
export function droppedFeatureKey(rawSentence: string): string | null {
  for (const clause of splitClauses(clean(rawSentence))) {
    const m = DROP_FEATURE.exec(clause);
    const k = m ? keyWords(m[1] ?? '') : '';
    if (k) return `feature:${k}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Topic signals
// ---------------------------------------------------------------------------

const DESIGN_TASK =
  /\b(?:(?:design|architect)\s+(?:me\s+)?(?:a|an|the|our|your own|that|this)|build\s+(?:me\s+)?(?:a|an))\s+([a-z0-9][\w\s.'/-]{1,48}?)(?=\s*(?:[.?!,;]|$)|\s+(?:that|which|for|with|where|who|to|from|in|using|like|so|and|or|at|on)\b)/i;
const DESIGN_LEAD = /\b(?:design|architect|build|problem|question|exercise|task|challenge)\b/i;
const TITLE_NOISE = /^(?:simple|basic|scalable|distributed|highly available|high[- ]level|large[- ]scale|global|robust|reliable|production[- ]grade|new)\s+/i;

/**
 * "The design problem is a food delivery app", "Today's system design question is a ticketing site", "So the problem
 * I've got for you is a feature flag service" (not "the question is a good one").
 */
const DESIGN_TOPIC =
  /\b(?:system )?(?:design )?(?:problem|question|exercise|task|prompt|challenge)(?: (?:i'?ve got|i have) for you| for (?:you|today)| today)? (?:is|will be)[,:]?\s+(?:to (?:design|build) )?(?:a|an|the)\s+(?!(?:good|great|fair|tough|hard|tricky|interesting|common|classic|simple|easy|fun|big|small|quick|short|long)\b)([a-z0-9][\w\s.'/-]{1,48}?)(?=\s*(?:[.?!,;]|$)|\s+(?:that|which|for|with|where|who|to|from|in|using|like|so|and|but|at|on)\b)/i;

/** "Design matchmaking for a shooter": a task named without an article (only with a request lead, see statedDesignTask). */
const BARE_DESIGN_TASK =
  /\b(?:design|architect)\s+(?!(?:a|an|the|our|your|that|this|it|them|for|with|around|something|so|to|in|on|me|how|what|why|is|was|of)\b)([a-z][\w-]*(?:\s+(?!(?:for|that|which|with|so|and|where|who|to|from|in|using|like|at|on|is|was)\b)[a-z][\w-]*){0,3})/i;
/** A title that names nothing ("Design a system that aggregates ad clicks"): the words after it say what it is. */
const GENERIC_TITLE = /^(?:system|service|platform|app|application|backend|tool|pipeline|api|solution)$/i;

/** "Design a URL shortener", "How would you design a rate limiter for…" -> "URL shortener" / "rate limiter". */
export function designTaskTitle(sentence: string, bare = false): string | null {
  if (!DESIGN_LEAD.test(sentence)) return null;
  const m = DESIGN_TASK.exec(sentence) ?? DESIGN_TOPIC.exec(sentence) ?? (bare ? BARE_DESIGN_TASK.exec(sentence) : null);
  if (!m) return null;
  let title = clean(m[1] ?? '');
  while (TITLE_NOISE.test(title)) title = title.replace(TITLE_NOISE, '');
  if (GENERIC_TITLE.test(title)) {
    const rest = new RegExp(String.raw`\b${title}\s+(?:that|which|for|to)\s+((?:[\w-]+\s*){1,4})`, 'i').exec(sentence.slice(m.index))?.[1];
    if (rest) title = clean(`${title} ${rest.split(/\s+/).filter((w) => !/^(?:that|which|for|to|the|a|an)$/i.test(w)).join(' ')}`);
  }
  title = title.replace(/\s+(?:system|service)$/i, '').trim();
  if (!title || /^(?:it|this|that|one|something|thing|way)$/i.test(title)) return null;
  return clip(title, 48);
}

/** "How would you design the table and the keys?": while a design is discussed, part of it rather than a new task. */
export const DESIGN_PART = /\b(?:design|architect)\s+(?:the|its|their|our|that|this)\s/i;

/** A design round announced without its subject ("Let's do a data engineering design.", "I want an ML system design."). */
export const DESIGN_ROUND =
  /\b(?:let'?s (?:do|start|try|move on to|go to|switch to|get to)|i(?:'d)? (?:want|like)(?: you to do| to do)?|(?:this|the next|next) (?:one|question|round|part) (?:is|will be)|we'?ll do|time for)\s+(?:an? |some |the )?(?:quick |short )?(?:[\w-]+\s+){0,2}design\b(?!\s+(?:a|an|the|that|this)\b)/i;

const DESIGN_REQUEST =
  /\b(?:let'?s|let us|we(?:'ll| will|'re going to| are going to)|i'?d like (?:you )?to|i want (?:you )?to|(?:your|the|today'?s|our|this|the next|the first|the second) (?:task|question|problem|exercise|challenge)(?: for today| today)?(?: is)?(?: to)?)[,:]?\s+(?:(?:now|try to|go ahead and|quickly)\s+)?(?:design|architect)\b/i;
/** "Design a parking lot." / "Okay, now design the feed." said as an instruction. */
const DESIGN_IMPERATIVE = /^(?:(?:okay|ok|so|alright|right|now|next|then|and|well|great|good|cool|also)[,.]?\s+)*(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:design|architect)\s/i;
const LATER = /\b(?:later|afterwards|after (?:that|this)|next time|tomorrow|next round|before we)\b/i;
/** Talks about designing something (a story, a generalization) rather than setting the task. */
const NARRATIVE =
  /\b(?:had to|have had to|once|last (?:year|month|week|time|quarter)|previously|in the past|at my (?:last|previous|old|current) (?:job|company|role|team)|used to|were designing|was designing|i designed|we designed|they designed|most people|people (?:usually|often|tend to)|try to design|tried to design)\b/i;

/** A design task set as a statement ("Okay, today let's design a ride-sharing service like Uber.") -> its title. */
export function designRequestTitle(text: string): string | null {
  for (const sentence of text.split(/(?<=[.?!])\s+/)) {
    if (DESIGN_REQUEST.test(sentence) && !LATER.test(sentence) && !NARRATIVE.test(sentence)) {
      const title = designTaskTitle(sentence);
      if (title) return title;
    }
  }
  return null;
}

/** The design task a sentence sets, if it sets one: not "Last year we had to design a billing system". */
export function statedDesignTask(sentence: string): string | null {
  if (NARRATIVE.test(sentence) || LATER.test(sentence)) return null;
  if (!DESIGN_IMPERATIVE.test(sentence) && !DESIGN_REQUEST.test(sentence) && !DESIGN_TOPIC.test(sentence)) return null;
  return designTaskTitle(sentence, true);
}

/** A coding problem set as a statement or request ("Given a list of meeting intervals, return the minimum number of rooms."). */
export const CODING_TASK =
  /^(?:(?:okay|ok|so|alright|now|next|first|here'?s (?:the|a|your) (?:problem|question|task)|the (?:problem|task|question) is)[,:.]?\s+)*(?:given (?:a|an|two|the|some|n)\b[^.?!]*?\b(?:return|find|compute|count|determine|output|print)\b|(?:write|implement|code(?: up)?) (?:a|an)\s+(?:function|method|class|program|algorithm|solution|data structure|[\w-]+ (?:cache|queue|heap|tree|limiter|parser|iterator))\b|(?:return|find) the (?:[\w-]+ ){0,4}(?:number|count|minimum|maximum|largest|smallest|top|longest|shortest|\d+)\b)/i;
/** A coding round announced before its problem ("Next is a coding problem."). */
export const CODING_ROUND = /\b(?:coding|algorithm(?:s|ic)?|programming|leetcode)[\s-]+(?:problem|question|round|exercise|challenge)\b/i;

/** Leaves the current topic, whatever comes next ("Let's move on.", "Unrelated question…"). Not "completely different prefixes". */
const HARD_SWITCH =
  /\b(?:let'?s|let us)\s+(?:now\s+)?(?:(?:leave|park|drop|stop|pause|set aside|put aside)\s+(?:it|this|that|there|here|(?:the|this|that|our)\s+(?:design|topic|problem|question|discussion|exercise|one)|system design|design)\b|(?:leave|park|set aside|put aside)\s+[^.?!]{1,40}?\s+for now\b|move (?:on|away) from|wrap up)|\b(?:unrelated|next question|different question|separate question|side question|new topic|something (?:a bit |a little |quite |completely )?(?:different|else))\b|\b(?:another|second|next|separate)\s+(?:question|topic|problem|exercise|scenario)\b|\b(?:totally|completely|entirely) different(?:\s+(?:question|topic|area|subject|thing|problem|direction|one))?(?=\s*(?:now\b|[.,:;!?]|$))|^(?:(?:okay|ok|so|alright)[,.]?\s+)?last (?:one|question)\b|\bmov(?:e|ing) on\b(?!\s+to\s+(?:the|our|your|its|how|what|why|this|that)\b)|\b(?:next topic|different topic|switch(?:ing)? (?:gears|topics?)|chang(?:e|ing) (?:of )?topics?|stepping away from)\b|\benough (?:about|of|on) (?:that|this|the (?:topic|design|subject|question))\b|\bthat'?s enough(?=\s*(?:on that|for now|[.,!]|$))/i;
/** Moves to a named subject, which may be part of the current topic ("Let's talk about the database."). */
const SOFT_LEAD = String.raw`\b(?:(?:let'?s|let us|now let'?s|now we'?ll|now i'?d like to)\s+(?:talk about|discuss|move (?:on )?to|switch to|turn to|go (?:on )?to|look at|cover|shift to|focus on)|mov(?:e|ing) on to)\s+`;
const SOFT_SWITCH = new RegExp(String.raw`${SOFT_LEAD}([^,.?!;:]+)`, 'i');
export const EXPLICIT_SWITCH = new RegExp(`${HARD_SWITCH.source}|${SOFT_SWITCH.source}`, 'i');

/** "Let's move on." -> hard; "Let's talk about the database." -> soft, with what it names. */
export function switchOf(text: string): { kind: 'hard' } | { kind: 'soft'; target: string } | null {
  if (HARD_SWITCH.test(text)) return { kind: 'hard' };
  const soft = SOFT_SWITCH.exec(text);
  return soft ? { kind: 'soft', target: soft[1] ?? '' } : null;
}

/**
 * Goes back to an earlier value rather than an earlier topic: "Go back to keeping raw readings for 30 days",
 * "Let's go back to only USD for now", "back to the original 15-minute hold".
 */
const REVERT_TARGET = /\b(?:go(?:ing)? back to|revert(?:ing)? to|switch(?:ing)? back to|back to)\s+([^,.?!;:]+)/i;
export function isRevert(text: string): boolean {
  const target = REVERT_TARGET.exec(text)?.[1] ?? '';
  if (!target || /\b(?:design|system|problem|question|topic|story|project|discussion|app|service|platform)\b/i.test(target)) return /\brevert(?:ing)? to\b/i.test(text);
  return numbersIn(target).length > 0 || /^(?:only|just|keeping|using|having|storing|the (?:old|original|previous|earlier|initial)|a single|one)\b/i.test(target.trim());
}

/** Only moves the conversation along ("Okay, let's move on from the URL shortener."): nothing to keep as a fact. */
function isTransition(sentence: string): boolean {
  if (isRevert(sentence)) return false;
  if (!EXPLICIT_SWITCH.test(sentence) && !RETURN_TO_EARLIER.test(sentence)) return false;
  // What is left besides the transition itself ("Let's talk about the write path: 10k writes per second" keeps a fact).
  const rest = sentence
    .replace(new RegExp(HARD_SWITCH.source, 'gi'), ' ')
    .replace(new RegExp(SOFT_LEAD, 'gi'), ' ')
    .replace(/\blet me (?:shift|switch|move|turn)(?: (?:over )?to)?\b|\bfor (?:a few|a couple of|a) (?:minutes?|moments?|bit|sec(?:ond)?)\b/gi, ' ')
    .replace(new RegExp(RETURN_TARGET.source, 'gi'), ' ')
    .replace(new RegExp(RETURN_TO_EARLIER.source, 'gi'), ' ');
  return CONTENT_WORDS(rest) < 2;
}

export const RETURN_TO_EARLIER =
  /\b(?:go(?:ing)? back to|back to (?:the|our|your)|return(?:ing)? to|com(?:e|ing) back to|revisit(?:ing)?|(?:one )?more on (?:the|our|your)|as (?:we|you) (?:discussed|said|mentioned) (?:earlier|before)|the original (?:design|question|problem|system)|earlier (?:design|problem|system|discussion|topic)|the (?:design|system) (?:from )?(?:earlier|before)|(?:on|about|for) the [\w-]+(?: [\w-]+){0,2} (?:thing|one|design|system|problem|question) again|^(?:(?:okay|ok|so|alright|right|anyway|anyways)[,.]?\s+)*back to [a-z][\w-]*)\b/i;
const RETURN_TARGET = /\b(?:go(?:ing)? back to|back to|return(?:ing)? to|com(?:e|ing) back to|revisit(?:ing)?|(?:one )?more on)\s+([^,.?!;:]+)/i;
/** Names an earlier design by its subject: "So in the dispatch system, would you use Kafka anywhere". */
export const NAMED_DESIGN = /\b(?:in|for|on|to|with|into) (?:the|our|your) ([\w-]+(?: [\w-]+){0,2}) (?:system|design|service|app|platform|pipeline)\b/i;
/** The user's own history, as opposed to "How do you handle retries?" asked about a design. */
export const OWN_HISTORY =
  /\b(?:did you|have you|had you|were you|you'?ve|you (?:worked|led|built|handled|shipped|owned|managed|mentored|faced)|your (?:experience|background|resume|cv|career|team|role|project|projects|previous|last|current|company|job|manager))\b|\btell (?:me|us) about (?:a time|yourself|your)\b/i;
/**
 * Asks for a story from the user's past ("Tell me about a time you missed a deadline", "the incident you handled").
 * Used only to keep a background discussion together; the answer's grounding still comes from the question's intent.
 */
export const STORY_QUESTION =
  /\b(?:tell (?:me|us) about (?:a time|yourself|your|the (?:last|biggest|hardest|toughest|worst|best|most))|(?:a|the|one) time (?:when |where |that )?you\b(?! (?:can|can'?t|cannot|could|would|will|should|might|may|need|want|are|were going)\b)|an example (?:of|from) (?:when|a time|your)|a situation (?:where |when |in which )?you\b(?! (?:can|can'?t|cannot|could|would|will|should|might|may|need|want)\b)|have you (?:ever )?had (?:a|an|any) (?:conflict|disagreement|situation|problem|challenge|failure|setback|difficult|tough|hard|bad)|(?:incident|outage|project|situation|challenge|conflict|mistake|failure|problem|bug|crisis|deadline|disagreement|migration|launch|initiative|story|achievement|accomplishment|team)s? (?:that )?you(?:'ve| have)? (?:handled|led|worked on|faced|built|managed|made|had|owned|shipped|fixed|resolved|dealt with|ran|did|delivered|debugged|mentored|disagreed|failed|missed|were (?:involved in|part of|responsible for|on)|listed|mentioned|described))\b/i;
/** What a "going back to…" names: "Going back to deadlocks, how would you…" -> "deadlocks". */
export function returnTarget(text: string): string | null {
  return RETURN_TARGET.exec(text)?.[1] ?? null;
}
/** Mentions earlier discussion without naming a topic ("what did we decide earlier?"). */
export const EARLIER_HINT = /\b(?:earlier|before|previously|so far|we discussed|we talked about|you said|you mentioned|we decided)\b/i;
/** Refers back to something already in the conversation. */
export const REFERENCE = /\b(?:it|this|that|these|those|them|here|the (?:design|system|service|database|cache|api|architecture|solution|approach|current setup)(?![-\w])|the (?:first|second|other|former|latter|last) one|which one|which of (?:them|these|those|the two))\b/i;
/** Asks for a judgement about the case at hand ("What is a good shard key here?"), not a definition. */
export const ABOUT_THIS_CASE = /\b(?:here|for (?:this|us|it)|in (?:this|our) (?:case|design|system)|good|best|better|right|ideal|appropriate|suitable|recommended|should (?:we|i|you)|would you)\b/i;
/** "What about…", "What if…", "How would you scale…": continues the current design discussion. */
export const CONTINUATION_CUE =
  /^(?:(?:and|so|okay|ok|now|also|then)[,]?\s+)*(?:which (?:one|two|three|of (?:them|these|those|the (?:two|three)))\b|where were we\b|as i was saying|what about|how about|what if|what happens|what would happen|how would you (?:scale|improve|test|monitor|secure|handle|deal with|extend|change|modify)|how do you (?:scale|handle)|now (?:add|make|support|let'?s add)|add\b|also\b|then\b|can we (?:replace|change|swap|use|add|make)|what are the (?:trade-?offs|bottlenecks|risks|failure modes)|where (?:is|are) the bottleneck)/i;
/** A technical question that introduces its own subject ("What's a bloom filter?", "Explain the CAP theorem."). */
export const NEW_SUBJECT =
  /^(?:(?:okay|ok|so|alright|now|and|next|also|then)[,.]?\s+)*(?:(?:can|could) you\s+)?(?:what(?:'s| is| are)\s+(?:a|an)\s|what does (?:the|a|an) [\w-]+(?: [\w-]+)? (?:do|mean)\b|explain\s|define\s|(?:what(?:'s| is) )?the difference between|difference between|what does (?:a|an)\s|(?!(?:okay|ok|so|right|alright|and|now|well|yeah|then)\s*,)[\w' -]{2,40},\s*what (?:is|are) (?:it|they)\s*[?.]?$|how does (?:a|an)\s|how do (?:a|an)\s|tell me about (?:a|an)\s(?!time)|walk me through (?:how )?(?:a|an)\s|write (?:a|an)\s|implement (?:a|an)\s)/i;
/** Follow-up cues that hold inside quick technical Q&A ("Why?", "What about…", "Which one…"). */
export const TECH_FOLLOW_UP =
  /^(?:(?:and|so|also|then|okay|ok)[,]?\s+)*(?:what about|how about|which (?:one|two|three|of)\b|why\b|how so|and then|what else|any other|can you elaborate|elaborate|give me an example|for example|what'?s the (?:time|space) complexity|can you (?:optimi[sz]e|improve) it|what (?:edge|corner) cases|how would you test|(?:go ahead and )?code it up|does (?:your|the) complexity|which (?:would|should) you|give (?:me|us) (?:an?|one|another)(?: [\w-]+)? example)/i;
/** "And where would you put the key?": a question that starts with "and" continues the one before. */
export const AND_FOLLOW_UP = /^(?:and|and then|so then)[,]?\s+(?:what|how|why|where|when|which|who|is|are|do|does|would|should|can|could|if|for)\b/i;
/** A personal question that moves to another part of the background ("I see you were at a fintech startup before that."). */
export const NEW_BACKGROUND_ITEM =
  /\b(?:i see (?:that )?you(?:'re| are|'ve| have| were)|your (?:resume|cv|profile) (?:says|mentions|lists|shows)|looking at your (?:resume|cv|profile)|you (?:were|worked) at\b|before that\b|your time at\b|at your previous (?:job|company))/i;
/** Refers to a design discussed earlier ("How does your design change for…"). */
export const DESIGN_ARTIFACT = /\b(?:your|the|this|our|that) (?:design|system|architecture|schema|backend)\b|\bour (?:numbers|scale|estimates|requirements|constraints|traffic)\b/i;
/** Starts a new behavioral story rather than following up on the current one. */
export const NEW_STORY =
  /^(?:(?:okay|ok|so|now|alright|and|next)[,]?\s+)*(?:tell (?:me|us) about|describe (?:a|an|the|your)|give (?:me|us) an example|walk (?:me|us) through (?:a|an|your)|talk about (?:a|an|your)|why (?:are|did|do|would) you|what (?:made|makes) you|how do you (?:handle|deal with|approach)|what are your|have you (?:ever )?(?:had|been in|faced|dealt with|disagreed|worked with|led|built))\b/i;

/**
 * A design instruction that asks for an answer now, while a design is discussed: "Now add authentication.",
 * "Next, let's support custom aliases." Not "Add caching." (a remark about the design), and never a scope
 * exclusion or something announced for later.
 */
export const DESIGN_INSTRUCTION =
  /^(?:(?:okay|ok|so|alright|and|great|good)[,.]?\s+)*(?:(?:now|next)[,]?\s+(?:let'?s\s+)?|let'?s\s+now\s+)(?:add|support|introduce|include|extend (?:it|this|the design) with|make it (?:support|handle))\b(?![^.?!]*\b(?:out of scope|not needed|no need|not required|later|eventually|at some point|next time|for now)\b)/i;

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
  /^(?:(?:so|okay|ok|now|and|then|alright|right)[,]?\s+)*(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:explain|describe|tell (?:me|us) about|talk (?:about|through)|walk (?:me|us) through|what (?:is|are)|what'?s|how (?:does|do|is|are)|how (?:would|should|can|could) (?:you|we|i)|give (?:me|us) an overview of|define|compare|let'?s (?:talk about|discuss|move (?:on )?to|switch to|turn to|look at|cover)|let us (?:talk about|discuss))\s+/i;

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

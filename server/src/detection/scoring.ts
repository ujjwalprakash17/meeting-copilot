/**
 * Heuristic question/request scoring for a single sentence. Deliberately simple and explainable:
 * every point carries a reason so tests and logs show why something was (not) treated as a question.
 *
 * Intent is recognised from the form of the sentence, not only from "?" or question words:
 *  - direct questions ("What is your role", with or without "?"),
 *  - instructions addressed to the listener ("Give the name of your dog.", "List the steps…"): a request verb
 *    in the base form at the start of the sentence, after optional fillers ("Okay, first, briefly…"),
 *  - polite and indirect requests ("I'd like you to…", "Would you mind…", "Let's discuss your…"),
 *  - elliptical prompts ("Your biggest weakness?", "And your role in that?") and scenarios ("Suppose…").
 * Statements keep their subject ("I gave…", "We discussed…", "Let me explain…") and so never look like an
 * instruction. Fragments without "?" and bare scenarios are only "ambiguous": the session may confirm them
 * with the small LLM classifier, which also sees the recent conversation.
 */

/** Grammatical form of a detected question or request. */
export type RequestIntent = 'direct_question' | 'imperative_request' | 'indirect_request' | 'elliptical' | 'hypothetical' | 'follow_up';

export interface SentenceScore {
  score: number;
  reasons: string[];
  /** Continues the previous exchange: the previous question and answer are included in the answer prompt. */
  isFollowUp: boolean;
  /** Form of the request; null when the sentence is not a question or request. */
  intent: RequestIntent | null;
  /** Can only be understood with earlier conversation ("that decision", "What about…", "And your role…"). */
  requiresContext: boolean;
  /** Sets up a scenario ("Suppose…", "Imagine…") that a following question may refer to. */
  isScenario: boolean;
}

/** Score >= this is treated as a question. */
export const QUESTION_THRESHOLD = 2;
/** Scores in [AMBIGUOUS_THRESHOLD, QUESTION_THRESHOLD) are ambiguous (optionally sent to the LLM classifier). */
export const AMBIGUOUS_THRESHOLD = 1;
/** Score given to forms whose intent depends on intonation or context (fragments without "?", bare scenarios). */
const UNCERTAIN_SCORE = 1.5;

const LEADING_MARKERS =
  /^(?:(?:so|and|but|okay|ok|alright|all right|well|now|then|also|great|cool|right|um+|uh+|hmm+|perfect|nice|good|thanks|thank you|interesting|sure|yes|yeah|no|excellent|awesome|got it|i see|i mean|understood|fair enough|basically|actually|honestly|anyway|anyways|like|hi|hello|hey|hi there|hey there|good (?:morning|afternoon|evening))[,.!]?\s+|you know(?:,\s*|\s+(?=(?:i|i'm|we|so|like|um|uh)\b)))+/i;
/** Hesitations inside a sentence ("how did you uh decide"): removed before scoring. */
const HESITATION = /\b(?:uh+|um+|erm|hmm+)\b,?\s*/gi;
/** "On a scale of one to ten[,] …": a fixed preface; the recognizer often drops its comma. */
const SCALE_PREFIX = /^on a scale (?:of|from) [\w-]+ to [\w-]+,?\s+/i;

/** Adverbs and openers that may precede an instruction: "Please…", "Okay, first, briefly…", "In your own words, …". */
const REQUEST_OPENERS =
  /^(?:(?:please|kindly|just|briefly|quickly|first(?:ly)?|second(?:ly)?|next|now|then|lastly|finally|maybe|perhaps|simply|very briefly|real quick|go ahead and|to (?:start|begin)(?: with)?|in (?:your own|a few|simple|plain) words|in (?:one|a single|a) sentence|in short|for (?:me|us))[,]?\s+)+/i;

const INTERROGATIVE_START =
  /^(?:what|what's|whats|why|how|how's|when|where|which|who|whom|whose|can|could|would|will|do|does|did|is|are|was|were|have|has|had|should|shall|may|might|am|isn't|aren't|don't|doesn't|didn't|won't|wouldn't|couldn't|can't|haven't|hasn't)\b/i;

/** A question word followed by an auxiliary: a question even when the recogniser left out the "?". */
const WH_AUXILIARY =
  /^(?:what|why|how|when|where|which|who)(?:'s| (?:is|are|was|were|do|does|did|would|will|can|could|should|have|has|had|many|much|long|often|far|kind|type|sort))\b/i;

/** Yes/no question addressed to the listener ("Do you have…", "Have you worked…"). */
const ADDRESSED_YES_NO = /^(?:do|did|have|are|were|can|could|would|will|is|was) you\b/i;

/** Request verbs in the base (imperative) form. Phrases first so "walk me through" wins over shorter matches. */
const REQUEST_VERB_SOURCE = [
  '(?:walk|take|talk|run) (?:me|us) through',
  'run through',
  'go (?:over|through)',
  'go deep(?:er)? (?:on|into)',
  'dive (?:into|deep(?:er)? (?:on|into))',
  'dig into',
  'focus on',
  'touch on',
  'think (?:of|about) a (?:time|situation|moment|project|case)',
  'recall a (?:time|situation|moment|project)',
  'help (?:me|us) understand',
  'remind (?:me|us)',
  'talk about',
  'speak (?:to|about)',
  'break down',
  'expand on',
  'reflect on',
  'point out',
  'spell out',
  'lay out',
  'map out',
  'say (?:a (?:bit|little) )?more',
  'tell',
  'explain',
  'describe',
  'elaborate',
  'summari[sz]e',
  'introduce',
  'share',
  'give',
  'list',
  'name',
  'show',
  'compare',
  'contrast',
  'calculate',
  'compute',
  'estimate',
  'write',
  'code',
  'implement',
  'design',
  'build',
  'define',
  'outline',
  'discuss',
  'demonstrate',
  'illustrate',
  'clarify',
  'justify',
  'recommend',
  'suggest',
  'identify',
  'evaluate',
  'analy[sz]e',
  'assess',
  'derive',
  'prove',
  'solve',
  'propose',
  'provide',
  'mention',
  'highlight',
  'recount',
  'sketch',
  'draw',
  'rate',
  'rank',
  'predict',
  'detail',
  'convince',
  'pitch',
  'sell',
  'critique',
  'review',
  'optimi[sz]e',
  'refactor',
  'debug',
  'fix',
  'find',
  'sort',
  'count',
  'reverse',
  'convert',
  'translate',
  'model',
  'plan',
  'prioriti[sz]e',
  'pick',
  'choose',
  'select',
  'gimme',
  'talk',
].join('|');
const REQUEST_VERB = new RegExp(`^(?:${REQUEST_VERB_SOURCE})\\b`, 'i');

/** Request verbs that are also common nouns ("Name tags are…", "Design is…"): need an object-like next word. */
const NOUN_LIKE_VERBS = /^(?:name|list|show|design|code|build|outline|detail|estimate|review|rate|rank|count|sketch|draw|pitch|sort|fix|model|plan|sell|talk|share|find|contrast|reverse|convert|pick|select)$/i;
const OBJECT_START =
  /^(?:me|us|him|her|them|it|this|that|these|those|the|a|an|your|yours|yourself|my|our|some|any|all|each|every|both|one|two|three|four|five|six|seven|eight|nine|ten|\d+|few|several|how|what|why|when|where|which|who|whether|if|out|up|down|back|more|another|other|about|through|to|over|on)$/i;
/** Next word showing the first word is a noun or a narrative ("Design is…", "Review of…", "Show we…"). */
const NOUN_USAGE_NEXT =
  /^(?:is|was|are|were|be|been|has|had|have|will|would|can|could|should|might|may|must|of|and|or|seems?|looks?|sounds?|went|goes|did|does|doesn't|isn't|wasn't|i|we|he|she|they)$/i;
const COPULA = /\b(?:is|are|was|were|has|have|had|will|would|can|could|seems?|looks?)\b/i;
/** Single-word requests that only make sense as follow-ups ("Elaborate."). */
const SINGLE_WORD_REQUEST = /^(?:elaborate|explain|clarify|expand)$/i;

/** Indirect request phrasing anywhere in the sentence. */
const INDIRECT_CUE = new RegExp(
  `\\b(?:${[
    "i(?:'d| would) (?:like|love) to (?:hear|know|understand|learn|see|get a sense)",
    "i(?:'d| would) (?:like|love|want) (?:for )?you to",
    'i (?:want|need) (?:for )?you to',
    '(?:i|we) (?:really )?(?:want|need|wanna) to (?:understand|know|hear|learn|see|get a sense)',
    "(?:i'?m|we'?re) (?:really |so |just )?(?:curious|interested|keen|eager) (?:how|what|why|when|where|which|who|whether|if|about|to (?:hear|know|understand|learn|see)|in (?:hearing|knowing|learning|understanding))",
    'let (?:me|us) know (?:your|what|how|why|which|where|who|whether)',
    "i(?:'d| would) be (?:really |very |quite )?(?:interested|curious|keen|glad|happy) (?:to (?:hear|know|learn|understand|see)|in (?:hearing|knowing|learning|understanding))",
    "i(?:'d| would) (?:really )?appreciate (?:it )?if you (?:could|can|would)",
    'it (?:would|will|might) be (?:really |very |super )?(?:helpful|great|nice|good|useful|interesting|valuable) (?:if you (?:could|can|would)|to (?:hear|know|understand|learn|see))',
    'it (?:would|will|might) (?:really )?help (?:me |us )?(?:to (?:hear|know|understand|learn|see)|if you (?:could|can|would))',
    'would you mind',
    'could you (?:maybe )?(?:speak|talk) to',
    'what are your thoughts',
    'your (?:take|thoughts|opinion|view) on',
    'walk (?:me|us) through',
    'tell (?:me|us) (?:about|more|how|why|what)',
    "let(?:'s| us| me) hear",
  ].join('|')})\\b`,
  'i',
);

/** "I was wondering what…", "wondering how you…": a question, unless it is "wondering the same thing". */
const WONDERING =
  /^(?:(?:i(?:'m| am| was)?|just|so|and) )?(?:(?:kind of|sort of|just|really|also) )?wondering (?:if|whether|what|how|why|when|where|which|who|about)\b|\bi wonder(?:ed)? (?:if|whether|what|how|why|when|where|which|who|about)\b/i;

const POLITE_ADVERBS = '(?:(?:please|maybe|perhaps|kindly|just|briefly|quickly|possibly|also|first) )*';
/** "Can you explain…", "Could you maybe walk me through…", "Why don't you…": a request phrased as a question. */
const MODAL_REQUEST = new RegExp(`^(?:can|could|would|will|won't|why don't) you ${POLITE_ADVERBS}(?:${REQUEST_VERB_SOURCE})\\b`, 'i');
/**
 * "If you could run through the numbers, that would be great", "Feel free to share…", "Maybe start by telling
 * us…", "Pull up the code and explain…" (a preparatory step, then the actual request).
 */
const SOFT_REQUEST = new RegExp(
  `^(?:if you (?:could|can|would|wouldn't mind) ${POLITE_ADVERBS}(?:${REQUEST_VERB_SOURCE})|feel free to (?:${REQUEST_VERB_SOURCE})|(?:maybe |perhaps |why don't you |let's )?start (?:by|with) (?:telling|describing|walking|explaining|sharing|giving|introducing|talking|summari[sz]ing|outlining|listing)|(?:pull up|open(?: up)?|look at|take a look at|have a look at|check|grab|scroll (?:up|down|to)|go to|bring up)\\b[^.?!]*\\band (?:then )?(?:${REQUEST_VERB_SOURCE}))\\b`,
  'i',
);
/** A question asked after a comma: "Visa status, do you need sponsorship", "…, how would you go about it". */
const QUESTION_CLAUSE = /,\s*(?:so\s+)?(?:what|how|why|which|where|when|who|do|did|does|are|were|have|has|can|could|would|will|should|is|was)(?:'s|'re|'d)?\b(?:\s+[\w']+){2,}/i;
/** An introductory phrase before the actual instruction: "On a scale of one to ten, rate your SQL." */
const INTRODUCTORY_PHRASE = /^(?:on|in|for|before|after|when|once|given|with|without|as|since|while|from|at|using|now that|thinking about|looking at|going back to)\b[^,]{2,60},\s+(.+)$/i;
/** Abandoned or cut-off questions: "What would you, uh, actually, never mind.", "how would you". */
const ABANDONED = /\b(?:never ?mind|forget (?:it|that|i asked)|scratch that)\b/i;
const INCOMPLETE_QUESTION = /^(?:what|how|why|which|where|when|who|can|could|would|do|did|will)\b(?:\s+[\w']+){0,2}\s+(?:you|we|they|i|he|she)$/i;
/** The speaker answers their own question: "So what does that tell us? It tells us…". */
export const SELF_ANSWER =
  /^(?:(?:so|and|okay),?\s+)?(?:it tells us|that tells us|the answer is|the short answer is|nobody knows|no one knows|(?:it )?turns out|beats me|because\b|well,\s+(?:the|it'?s|that'?s|we|basically))/i;
/** "What's even the point…", "Why do we even…": rhetorical, unless addressed to the listener ("How would you even…"). */
const RHETORICAL_EVEN = /^(?:what(?:'s| is)|why|how)\b(?:\s+[\w']+){0,3}\s+even\b/i;
/** Ends in the middle of "your take on …" / "thoughts on …". */
const DANGLING_TOPIC = /\b(?:take|thoughts|opinion|views?|perspective|stance) (?:on|about)\s*$/i;
/** "You can describe your project now": usually an invitation, but sometimes a remark; left to the classifier. */
const YOU_MAY_REQUEST = new RegExp(`^you (?:can|could|may|might want to|should) (?:${REQUEST_VERB_SOURCE})\\b`, 'i');
/** "…, maybe you can clarify that": softened by "maybe"/"perhaps", this is a request. */
const MAYBE_YOU_REQUEST = new RegExp(`(?:^|,\\s*)(?:maybe|perhaps) you (?:can|could) ${POLITE_ADVERBS}(?:${REQUEST_VERB_SOURCE})\\b`, 'i');
/** "Let's discuss your experience…" asks the listener to talk; "Let's discuss the plan" may not. */
const LETS_REQUEST = /^let(?:'s| us) (?:discuss|talk about|talk through|go over|go through|dive into|dig into|chat about|hear about|look at|cover|get into|turn to|focus on)\b/i;
const ADDRESSES_LISTENER = /\byou(?:r|rs|rself)?\b/i;

/** The speaker offers to explain something themselves: not a request to the listener. */
const VOLUNTEERING =
  /^(?:let me|i'?m going to|i am going to|i'?ll|i will|i want to|i'd like to|i would like to|allow me to|i can|i could)\s+(?:quickly |briefly |just |first )?(?:explain|tell|show|describe|give|walk|share|introduce|talk|go over|go through|start|summari[sz]e|clarify|elaborate|add|mention|repeat|rephrase|answer|take you through)\b/i;
/** The request is explicitly for later ("Tell me about it later.", "Explain that one offline", "we'll circle back"). */
const DEFERRED =
  /\b(?:(?:it|that|this|them|one) (?:later|offline|next time|another time|some other time)|take (?:it|this|that) offline|circle back|park (?:that|this|it)|(?:in|during) the next (?:round|call|meeting|session|interview)|after (?:the|this) (?:call|meeting|interview)|don'?t worry about answering)\b/i;
/** The speaker's own statement or plan said with rising intonation ("I'll send the feedback by Friday?"). */
const FIRST_PERSON_STATEMENT = /^(?:i|we)(?:'ll|'m|'re|'ve|'d| will| am| are| have| had| was| were| think| guess| just| also| can| could| should)?\b/i;

/** Noun-phrase prompts: "Your biggest weakness?", "And the reason for that?", "Any experience with…". */
const ELLIPTICAL_START =
  /^(?:and |so |also |but )?(?:your|any|thoughts|(?:favou?rite|biggest|greatest|best|worst|proudest) \w+|the (?:reason|reasoning|rationale|motivation|thinking|impact|outcome|result|results|timeline|trade-?offs?|cost|plan|approach|story|context|lessons?)|(?:preferred|expected|current|total|relevant|earliest) \w+|years of|notice period|visa|availability|salary|ctc|start date|joining date|reason for)\b/i;
const WHAT_ABOUT = /^(?:and |so )?(?:what|how) about\b/i;
const FINITE_VERB =
  /\b(?:is|are|was|were|am|be|been|has|have|had|do|does|did|will|would|can|could|should|shall|may|might|must|seems?|looks?|sounds?|went|goes|got|gets|made|makes|said|says|told|tells|think|thinks|thought|know|knows|knew|like|likes|liked|want|wants|wanted|need|needs|needed|use|uses|used|seemed|worked|works|work)\b/i;

/** Scenario set-ups that a question refers to. */
const SCENARIO_START =
  /^(?:suppose|supposing|imagine|assume|assuming|consider|picture|pretend|hypothetically|let(?:'s| us) (?:say|assume|imagine|suppose|pretend)|say (?:you|we|there|the|your|a|an)|what if|given that|in a (?:scenario|situation|world) where)\b/i;

/** Phrases that only make sense as a continuation of the previous exchange. */
const FOLLOW_UP_PHRASE =
  /\b(?:elaborate|expand on|(?:in )?more detail|another example|one more example|tell (?:me|us) more|say (?:a bit |a little )?more|what happened next|what happened after(?:wards)?|what came next|and then what|then what|how so|why (?:is|was) that|why not|make (?:that|it|this) more concrete|dig deeper|what do you mean)\b|^and then\??$/i;

const EMBEDDED_CLAUSE = /^(?:how|what|why|when|where|which|who) (?:we|i|they|he|she|it|our|my|their)\b/i;

const FOLLOW_UP_START = /^(?:and|but|so|also|then|what about|how about|what if|why|how so|why not|in what way)\b/i;

/** Conversational fillers, audio checks and meeting logistics: not questions to answer. */
const FILLER_PATTERNS = [
  /\b(?:can|could) (?:you|everyone|everybody|you all|you guys|y'all) (?:hear|see|view|access|open) (?:me|us|this|it|that|everything|(?:my|the|this|our)(?: [\w-]+)? (?:screen|slides?|deck|doc(?:ument)?|presentation|window|code|whiteboard|board|sheet|link|chat|file))\b/i,
  /^(?:is|are) (?:my|the|our) (?:screen|slides?|video|audio|mic|microphone|camera|sound) (?:visible|showing|shared|coming through|working|clear|okay|ok)\b/i,
  /\b(?:turn|switch) (?:on |off )?(?:your|the) (?:camera|video|mic|microphone)\b|\b(?:mute|unmute) (?:yourself|your (?:mic|microphone))\b/i,
  /^(?:are you|is everyone|is everybody) (?:there|with me|ready|able to see)\b/i,
  /^(?:does that|that) (?:make sense|sound good|work for you)\b/i,
  /^(?:is that|was that) (?:clear|ok|okay|alright|fine)\b/i,
  /^(?:how are you(?: doing| today| holding up)?|how's it going|how is it going|how are things)(?:\s+(?:today|so far))?\s*[?.!,]?\s*$/i,
  /^(?:right|okay|ok|yeah|yes|no|sure|really|correct|got it|sound good|make sense|you know|isn't it|huh|sorry)\??$/i,
  /,\s*(?:right|you know|okay|ok|yeah|correct|isn't it|no|huh|eh)\?$/i,
  // Rhetorical questions and small talk that need no drafted answer.
  /\b(?:what could (?:possibly )?go wrong|who knows|who would(?:'ve| have) (?:thought|guessed)|how hard can it be|go figure)\b/i,
  /^(?:how(?:'s| is| was) your (?:day|week|weekend|morning|afternoon|evening|trip|holiday|vacation)|how have you been)\b/i,
  /^(?:shall we|should we) (?:start|begin|get started|move on|wrap up)\b/i,
  /^(?:any (?:other )?questions (?:for me|from your side))\b/i,
  /\b(?:share|show|present|stop sharing)(?: (?:your|my|the))? screen\b/i,
  /^(?:give|grant) (?:me|us) (?:a|one|just a) (?:second|sec|minute|min|moment)\b/i,
  /^(?:hold on|bear with me|one (?:second|sec|moment)|just a (?:second|sec|moment))\b/i,
  /^(?:tell (?:me|us)|let (?:me|us) know) when you(?:'re| are) (?:ready|done|finished)\b/i,
  /^let (?:me|us) know if\b/i,
  /\b(?:can|could|would) you (?:please )?(?:repeat|say) (?:that|it|the question)(?: again)?\b/i,
  /^(?:sorry,? )?(?:come again|what was that|i didn'?t (?:catch|hear) (?:that|you))\b/i,
  /^tell you what\b/i,
  /^(?:take your time|go ahead|no worries|no problem)(?:[.!,]|\s*$)/i,
  /^(?:do )?you know what i mean\b/i,
  /^why (?:do|does|did|would|should|are|is) (?:we|they|people|anyone) (?:even|ever)\b/i,
];

/**
 * Questions about the meeting itself (its start, end, breaks, schedule): no drafted answer. Only when the
 * listener is not addressed, so "When could you start?" or "Can we start with your background?" still count.
 */
const MEETING_LOGISTICS = [
  /^(?:are|should|shall|can|could|do) we (?:start(?:ing)?|begin(?:ning)?|get(?:ting)? started|kick(?:ing)? off|wrap(?:ping)? up|take (?:a|five|ten)\b|break|stop|end|finish|pause|reconvene|move on|go ahead)\b/i,
  /^(?:what time|when)(?:'s| is| does| will| do| are| should)\b[^?]*\b(?:next|this|today'?s|tomorrow'?s|our|the) (?:meeting|call|sync|session|stand-?up|catch-?up|check-?in|break|demo)\b/i,
  /^how (?:long|much (?:longer|more )?time)\b[^?]*\b(?:meeting|call|session|break|left|remaining)\b/i,
  /^(?:is|are) (?:the|this|our) (?:meeting|call|session|recording) (?:being |still )?(?:recorded|over|done|starting|on|running)\b/i,
];

const TECHNICAL_TERMS =
  /\b(?:algorithm|complexity|big o|data structure|design|architecture|scal\w*|latency|throughput|database|sql|nosql|index\w*|cache|caching|api|rest|grpc|http|tcp|thread|process|concurren\w*|async\w*|memory|garbage|microservice\w*|kubernetes|docker|queue|kafka|react|typescript|javascript|python|java|golang|rust|closure|recursion|hash\w*|tree|graph|sort\w*|transaction\w*|consisten\w*|deadlock|load balanc\w*|rate limit\w*|security|authentication|oauth|testing|deploy\w*|pipeline|trade-?offs?|difference between)\b/i;

/**
 * Words that cannot end a complete sentence ("Explain the", "Tell me about your"). Prepositions, pronouns and
 * question words are not included: "What are you working on", "Tell me more about that" are complete.
 */
const DANGLING_END = /\b(?:the|a|an|your|my|our|their|his|her|its|and|or|but|between|because|than|whether|if)\s*$/i;

const PREPOSITION = /^(?:about|on|in|at|for|with|behind|of|by|from|into|to|after|before|like|over|under|through|around|regarding|beyond)$/i;
const REFERENCE_VERB = /^(?:do|did|done|does|make|made|solve|solved|handle|handled|choose|chose|chosen|explain|describe|use|used|build|built|design|designed|mean|meant|implement|implemented|fix|fixed|try|tried|say|said|approach|approached)$/i;

/** True when the text stops mid-sentence: no terminal punctuation and a dangling last word. */
export function endsIncomplete(text: string): boolean {
  const t = text.trim();
  return !/[.?!]["')\]]*$/.test(t) && DANGLING_END.test(t);
}

/** Refers back to something said earlier: "that decision", "this problem", "it", "them". */
function hasBackReference(rawSentence: string): boolean {
  // A dummy subject refers to nothing: "It would be helpful if…", "It's important to…".
  const sentence = rawSentence.replace(/^it(?:'s|\s+(?:is|was|would|will|might|may|could|seems))\b/i, '');
  if (/\b(?:it|this|these|those|them|they)\b/i.test(sentence)) return true;
  const words = sentence.toLowerCase().replace(/[^\w\s'-]/g, ' ').split(/\s+/).filter(Boolean);
  return words.some((w, i) => {
    if (w !== 'that') return false;
    const prev = words[i - 1];
    // "that" closing the sentence, or after a preposition or verb, points back; after a noun it is a relative pronoun.
    return i === words.length - 1 || !prev || PREPOSITION.test(prev) || REFERENCE_VERB.test(prev) || REQUEST_VERB.test(prev) || /(?:ed|ing)$/.test(prev);
  });
}

type Imperative = { strength: 'strong' | 'weak'; verb: string } | null;

/** Instruction to the listener: a request verb in the base form opening the sentence. */
function imperativeRequest(core: string): Imperative {
  const text = core.replace(REQUEST_OPENERS, '');
  if (/^\w+'(?:s|re|ve|ll|d)\b/i.test(text)) return null; // "Name's Sam", "Show's over"
  const m = REQUEST_VERB.exec(text);
  if (!m) return null;
  const verb = m[0].toLowerCase();
  const rest = text.slice(m[0].length).trim();
  const next = (rest.split(/\s+/)[0] ?? '').replace(/[^\w'-]/g, '');
  if (!next) return SINGLE_WORD_REQUEST.test(verb) ? { strength: 'strong', verb } : null;
  if (NOUN_USAGE_NEXT.test(next)) return null;
  if (NOUN_LIKE_VERBS.test(verb) && !OBJECT_START.test(next)) return COPULA.test(rest) ? null : { strength: 'weak', verb };
  return { strength: 'strong', verb };
}

/** Cheap early signal that an utterance is probably a question (used to pre-warm the LLM connection). */
export function startsLikeQuestion(text: string): boolean {
  const core = stripLeadingMarkers(text.trim());
  return INTERROGATIVE_START.test(core) || imperativeRequest(core) !== null || INDIRECT_CUE.test(core) || ELLIPTICAL_START.test(core);
}

/**
 * A short verbless follow-on that narrows the request just made: "Especially the caching layer.", "In JavaScript.".
 * Kept with the question so the answer sees it (the utterance's own segments are not repeated as transcript context).
 */
export function isClarification(rawSentence: string): boolean {
  const sentence = rawSentence.trim();
  if (/\?\s*$/.test(sentence) || /^(?:so|okay|ok|alright|anyway|anyways|moving on|next|now|thanks|thank you)\b/i.test(sentence)) return false;
  const core = stripLeadingMarkers(sentence);
  const words = core.split(/\s+/).filter(Boolean);
  return words.length >= 2 && words.length <= 12 && !FINITE_VERB.test(core) && !endsIncomplete(sentence) && !FILLER_PATTERNS.some((re) => re.test(core));
}

export function stripLeadingMarkers(sentence: string): string {
  return sentence.replace(LEADING_MARKERS, '').replace(SCALE_PREFIX, '').trim();
}

export function scoreSentence(rawSentence: string): SentenceScore {
  const sentence = rawSentence.trim().replace(/[’‘]/g, "'").replace(HESITATION, '').trim();
  const core = stripLeadingMarkers(sentence);
  const reasons: string[] = [];
  let score = 0;
  const words = core.split(/\s+/).filter(Boolean);
  const endsWithQ = /\?\s*$/.test(sentence);

  if (endsWithQ) {
    score += 2;
    reasons.push('ends with ?');
  }
  const interrogative = INTERROGATIVE_START.test(core);
  if (interrogative) {
    score += 1.5;
    reasons.push('interrogative opening');
    // "How we handled it was…" is an embedded clause, not a question, unless it ends with "?".
    if (EMBEDDED_CLAUSE.test(core) && !endsWithQ) {
      score -= 1;
      reasons.push('embedded clause');
    } else if (WH_AUXILIARY.test(core) || ADDRESSED_YES_NO.test(core) || ADDRESSES_LISTENER.test(core)) {
      score += 0.5;
      reasons.push('question word order');
    }
  }

  const afterIntro = INTRODUCTORY_PHRASE.exec(core)?.[1];
  const introImperative = afterIntro ? imperativeRequest(afterIntro) : null;
  const imperative = imperativeRequest(core) ?? (introImperative?.strength === 'strong' ? introImperative : null);
  const modalRequest = MODAL_REQUEST.test(core);
  const lets = LETS_REQUEST.test(core);
  let indirect = false;
  if (imperative) {
    score += imperative.strength === 'strong' ? 2.5 : UNCERTAIN_SCORE;
    reasons.push(imperative.strength === 'strong' ? 'imperative request' : 'possible imperative');
  } else if (INDIRECT_CUE.test(sentence) || WONDERING.test(core) || SOFT_REQUEST.test(core) || MAYBE_YOU_REQUEST.test(core)) {
    score += 2;
    indirect = true;
    reasons.push('indirect request');
  } else if (lets) {
    const toListener = ADDRESSES_LISTENER.test(core);
    score += toListener ? 2 : 1;
    indirect = true;
    reasons.push(toListener ? "let's discuss your…" : "let's discuss (topic)");
  } else if (YOU_MAY_REQUEST.test(core)) {
    score += UNCERTAIN_SCORE;
    indirect = true;
    reasons.push('you can/could + request');
  }
  if (modalRequest) {
    score += 1;
    indirect = true;
    reasons.push('polite request');
  }
  const questionClause = !interrogative && QUESTION_CLAUSE.test(core);
  if (questionClause) {
    score += 2;
    reasons.push('question after comma');
  }

  const isScenario = SCENARIO_START.test(core);
  const isFragment = !FINITE_VERB.test(core) && words.length <= 10 && !imperative;
  const elliptical = WHAT_ABOUT.test(core) || WHAT_ABOUT.test(sentence) || (isFragment && (ELLIPTICAL_START.test(core) || ELLIPTICAL_START.test(sentence)));

  if (/^(?:what|how) about\b/i.test(core)) {
    score += 0.5;
    reasons.push('what/how about');
  }
  if (TECHNICAL_TERMS.test(sentence)) {
    score += 0.5;
    reasons.push('technical topic');
  }

  // Forms whose intent depends on intonation or on what follows: the classifier decides (with context).
  const otherCue = endsWithQ || interrogative || imperative?.strength === 'strong' || indirect || questionClause;
  if (!otherCue && (isScenario || elliptical)) {
    score = UNCERTAIN_SCORE;
    reasons.push(isScenario ? 'scenario without a question' : 'fragment without ?');
  }
  // A statement said with rising intonation: "I'll send it by Friday?", "…and I said yes, we do?". Declarative
  // questions to the listener ("So you led the migration?") mention "you" and are kept.
  const declarative = endsWithQ && !interrogative && !indirect && !imperative && !questionClause && !elliptical;
  if (declarative && (FIRST_PERSON_STATEMENT.test(core) || (!ADDRESSES_LISTENER.test(core) && !isFragment))) {
    score = Math.min(score, UNCERTAIN_SCORE);
    reasons.push('statement with ?');
  }

  // Logistics, audio checks, small talk and abandoned questions are decisive: no answer and no classifier call.
  if (FILLER_PATTERNS.some((re) => re.test(core) || re.test(sentence))) {
    score = Math.min(score - 4, 0);
    reasons.push('conversational filler');
  }
  if (ABANDONED.test(sentence)) {
    score = Math.min(score - 4, 0);
    reasons.push('question abandoned');
  }
  if (MEETING_LOGISTICS.some((re) => re.test(core)) && !ADDRESSES_LISTENER.test(core)) {
    score = Math.min(score, 0);
    reasons.push('meeting logistics');
  }
  if (RHETORICAL_EVEN.test(core) && !ADDRESSES_LISTENER.test(core.replace(/\byou (?:know|see)\b/gi, ''))) {
    score = Math.min(score, 0);
    reasons.push('rhetorical');
  }
  if (VOLUNTEERING.test(core)) {
    score -= 3;
    reasons.push('speaker offers to explain');
  }
  if (DEFERRED.test(sentence)) {
    score -= 2.5;
    reasons.push('deferred to later');
  }
  const unterminated = !/[.?!]["')\]]*$/.test(sentence);
  if (endsIncomplete(sentence) || (unterminated && (INCOMPLETE_QUESTION.test(core) || DANGLING_TOPIC.test(core)))) {
    // Cut off mid-sentence: never answered or classified, however strong the opening.
    score = Math.min(score, 0);
    reasons.push('incomplete');
  }
  const followUpPhrase = FOLLOW_UP_PHRASE.test(sentence);
  if (words.length < 3 && imperative?.strength !== 'strong' && !followUpPhrase && !elliptical) {
    score -= 1;
    reasons.push('very short');
  }

  const backReference = hasBackReference(core);
  const isQuestionForm = endsWithQ || interrogative;
  let intent: RequestIntent | null = null;
  if (score >= AMBIGUOUS_THRESHOLD) {
    if (isScenario) intent = 'hypothetical';
    else if (elliptical) intent = 'elliptical';
    else if (followUpPhrase || (isQuestionForm && words.length <= 5 && backReference)) intent = 'follow_up';
    else if (imperative) intent = 'imperative_request';
    else if (indirect) intent = 'indirect_request';
    else intent = 'direct_question';
  }
  const continuesExchange = /^(?:and|so|also|but)\b/i.test(sentence) || WHAT_ABOUT.test(core);
  const requiresContext = intent !== null && (intent === 'follow_up' || continuesExchange || backReference);
  const isFollowUp =
    intent === 'follow_up' || FOLLOW_UP_START.test(sentence) || (words.length <= 10 && /\b(?:it|that|this|those|they|them)\b/i.test(core) && score >= QUESTION_THRESHOLD);
  return { score, reasons, isFollowUp, intent, requiresContext, isScenario };
}

/** Splits text into sentences, keeping terminal punctuation. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+(?=\S)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

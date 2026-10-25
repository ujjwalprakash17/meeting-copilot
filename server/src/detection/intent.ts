/**
 * Decides whether a question is about the user's own background (needs resume grounding),
 * a general/technical question, or a mix ("Have you used Kafka, and how does it guarantee ordering?").
 */

export type QuestionKind = 'general' | 'personal' | 'mixed';
export type SectionHint = 'summary' | 'experience' | 'projects' | 'skills' | 'education' | 'achievements' | 'certifications';

export interface QuestionIntent {
  kind: QuestionKind;
  sectionHints: SectionHint[];
}

const PERSONAL_PATTERNS: RegExp[] = [
  /\b(?:tell (?:me|us) (?:a bit |a little )?about yourself|introduce yourself|about yourself|walk (?:me|us) through your)\b/i,
  /\byour (?:own )?(?:experience|background|resume|cv|career|role|roles|job|jobs|position|team|projects?|work|education|degree|studies|skills?|skill set|strengths?|weakness(?:es)?|achievements?|accomplishments?|responsibilities|current|previous|last|biggest|greatest|proudest|most|favou?rite|tech stack|stack|employer|company|internship)\b/i,
  /\b(?:have|did|were|do|are) you (?:ever |actually |personally |also )?(?:work|worked|working|use|used|using|build|built|building|lead|led|leading|manage|managed|handle|handled|implement|implemented|design|designed|study|studied|ship|shipped|own|owned|deal|dealt|face|faced|migrate|migrated|mentor|mentored|optimi[sz]e|optimi[sz]ed|deploy|deployed|familiar|experienced|comfortable|proficient)\b/i,
  /\b(?:a time (?:when|where|that) you|an example (?:of|from) (?:when|a time|your)|a project (?:where|that|in which|you)|a situation (?:where|when) you|a challenge you|a mistake you|a decision you|a conflict you)\b/i,
  /\b(?:where did you (?:study|work|go to)|what did you (?:study|do|build|work on|learn|major in)|how (?:long|many years) have you|years of experience|why did you (?:leave|join|choose|move|decide)|what (?:are|were) you (?:working on|responsible for)|what do you do (?:currently|now|at))\b/i,
  /\b(?:what (?:languages|technologies|frameworks|tools) (?:do|did|have) you)\b/i,
  // Instructions about the user's own toolkit: "Name three technologies you use regularly."
  /\b(?:technologies|tools|languages|frameworks|databases|libraries|platforms|stacks?) (?:that )?you(?:'ve| have)? (?:use|used|know|prefer|like|work with|worked with|are (?:familiar|comfortable) with)\b/i,
];

/** Hypothetical framing ("how would you design…") is a general question, not a personal-history one. */
const HYPOTHETICAL = /\b(?:how|what|which|why) would you\b|\bwhat would you do\b|\bif you (?:were|had to)\b/i;

const TECHNICAL_EXPLANATION =
  /\b(?:how does|how do|what is|what are|what's|explain|difference between|why does|why is|how would you|compare|trade-?offs?)\b/i;

const SECTION_CUES: Array<[SectionHint, RegExp]> = [
  ['summary', /\b(?:yourself|background|introduce|who you are|your career|your journey)\b/i],
  ['education', /\b(?:stud(?:y|ied|ies)|degree|university|college|school|education|graduat\w*|major\w*|courses?|gpa|bachelor\w*|master\w*|phd)\b/i],
  ['skills', /\b(?:skills?|languages?|technolog\w*|stack|tools?|frameworks?|familiar|proficient|comfortable with|expert\w*)\b/i],
  ['projects', /\b(?:projects?|built|build|shipped|side project|portfolio)\b/i],
  ['experience', /\b(?:experience|role|roles|job|company|companies|team|worked|work|responsib\w*|position|employer|career|led|lead|manag\w*|handled)\b/i],
  ['achievements', /\b(?:achiev\w*|accomplish\w*|impact|proud\w*|results?|metrics?|improv\w*|awards?)\b/i],
  ['certifications', /\b(?:certif\w*|licen[cs]e\w*)\b/i],
];

export function classifyQuestionIntent(question: string): QuestionIntent {
  const personal = PERSONAL_PATTERNS.some((re) => re.test(question));
  const hypotheticalOnly = HYPOTHETICAL.test(question) && !/\b(?:have|did) you\b|\byour (?:experience|projects?|team|role)\b/i.test(question);
  const sectionHints = SECTION_CUES.filter(([, re]) => re.test(question)).map(([hint]) => hint);

  if (!personal || hypotheticalOnly) return { kind: 'general', sectionHints: [] };

  // Personal part plus a request to explain a concept, joined in one question.
  const parts = question.split(/\b(?:and|also|then)\b|[,;]/i);
  const hasSeparateExplanation = parts.some((p) => TECHNICAL_EXPLANATION.test(p) && !PERSONAL_PATTERNS.some((re) => re.test(p)));
  return { kind: hasSeparateExplanation ? 'mixed' : 'personal', sectionHints };
}

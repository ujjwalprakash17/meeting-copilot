/**
 * Speculative ("tentative") answering: when an interim transcript already contains a clear, complete
 * question, the answer request is dispatched before the final transcript arrives (saving the
 * endpointing wait). The final transcript then confirms the question or rejects it, in which case the
 * tentative answer is cancelled and discarded in the UI.
 */
import { normalizeText, tokenize, tokenSimilarity } from '@meeting-copilot/shared';
import type { QuestionCandidate } from './QuestionDetector.js';

export interface SpeculationOptions {
  /** Minimum heuristic score (scoring.ts) for a tentative answer. */
  minScore: number;
  /** Minimum words in the question. */
  minWords: number;
  /** Tentative restarts allowed per utterance (bounds wasted LLM requests). */
  maxPerUtterance: number;
}

export const DEFAULT_SPECULATION: SpeculationOptions = { minScore: 2, minWords: 4, maxPerUtterance: 2 };

/**
 * Only speculate on unambiguous questions whose interim text already ends with terminal punctuation
 * (the recogniser's own signal that the sentence is complete) and that end the utterance.
 */
export function shouldSpeculate(candidate: QuestionCandidate | null, utteranceText: string, opts: SpeculationOptions): candidate is QuestionCandidate {
  if (!candidate || candidate.ambiguous || candidate.score < opts.minScore) return false;
  const text = candidate.text.trim();
  if (!/[?.!]$/.test(text) || tokenize(text).length < opts.minWords) return false;
  return normalizeText(utteranceText).endsWith(normalizeText(text));
}

/**
 * Does the final question match the tentative one closely enough to keep the tentative answer?
 * Punctuation/case differences are fine; added or changed words are not (they can change the meaning).
 */
export function confirmsSpeculation(speculativeText: string, finalText: string): boolean {
  const a = normalizeText(speculativeText);
  const b = normalizeText(finalText);
  if (a === b) return true;
  const ta = tokenize(a);
  const tb = tokenize(b);
  return Math.abs(ta.length - tb.length) <= 1 && tokenSimilarity(a, b) >= 0.9;
}

import { describe, expect, it } from 'vitest';
import { findKeywordHits, isTokenSubset, normalizeText, tokenSimilarity } from './text.js';

describe('text helpers', () => {
  it('normalizes punctuation and case', () => {
    expect(normalizeText("What's  the DIFFERENCE, really?")).toBe('whats the difference really');
  });

  it('measures similarity', () => {
    expect(tokenSimilarity('how does react reconcile', 'How does React reconcile?')).toBe(1);
    expect(tokenSimilarity('how does react reconcile', 'what is your salary expectation')).toBeLessThan(0.2);
    expect(isTokenSubset('tell me about your project', 'can you tell me about your project please')).toBe(true);
  });

  it('finds whole-word keyword hits', () => {
    const hits = findKeywordHits('We use Kafka; kafkaesque is not a hit. KAFKA again.', ['kafka']);
    expect(hits.map((h) => h.index)).toEqual([7, 39]);
  });
});

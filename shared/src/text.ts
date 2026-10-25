/** Small text helpers shared by question detection (server) and keyword matching (UI). */

/** Lowercases, strips punctuation and collapses whitespace. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(text: string): string[] {
  const n = normalizeText(text);
  return n ? n.split(' ') : [];
}

/** Jaccard similarity of token sets, 0..1. */
export function tokenSimilarity(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 && tb.size === 0) return 1;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** True when every token of the shorter text appears in the longer one (and the shorter one is non-trivial). */
export function isTokenSubset(a: string, b: string, minTokens = 4): boolean {
  const ta = tokenize(a);
  const tb = tokenize(b);
  const [small, large] = ta.length <= tb.length ? [ta, new Set(tb)] : [tb, new Set(ta)];
  if (small.length < minTokens) return false;
  return small.every((t) => large.has(t));
}

export interface KeywordHit {
  keyword: string;
  index: number;
  length: number;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Case-insensitive whole-word keyword matches within `text`, sorted by position. */
export function findKeywordHits(text: string, keywords: readonly string[]): KeywordHit[] {
  const hits: KeywordHit[] = [];
  for (const keyword of keywords) {
    const k = keyword.trim();
    if (!k) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(k)}(?![\\p{L}\\p{N}])`, 'giu');
    for (const m of text.matchAll(re)) hits.push({ keyword: k, index: m.index, length: m[0].length });
  }
  return hits.sort((a, b) => a.index - b.index);
}

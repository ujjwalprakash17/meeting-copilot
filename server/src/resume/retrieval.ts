/**
 * Keyword-based retrieval over resume / personal-knowledge chunks (BM25 with light stemming,
 * a small synonym table and section boosts). The `Retriever` interface keeps this swappable for
 * embedding-based semantic search later.
 */
import type { SectionHint } from '../detection/intent.js';
import type { KnowledgeChunk } from './sections.js';

export interface RetrievedChunk extends KnowledgeChunk {
  score: number;
  matchedTerms: string[];
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  evidence: 'strong' | 'weak' | 'none';
}

export interface Retriever {
  retrieve(query: string, opts: { sectionHints: SectionHint[]; limit: number }): RetrievalResult;
}

const STOPWORDS = new Set(
  (
    'a an the and or but if then so of to in on at by for with from as is are was were be been being am do does did done have has had ' +
    'i me my we our you your yours yourself he she it its they them their this that these those there here what which who whom whose ' +
    'when where why how can could would should will shall may might must not no yes about into over under again further once just ' +
    'also very really any some such more most other own same than too only can tell talk walk through give describe explain share ' +
    'please like know want need think time example little bit lot kind sort thing things something anything someone okay ok well ' +
    'us let lets get got make made one two ever'
  ).split(/\s+/),
);

/** Words too generic to count as evidence on their own (they still steer section boosts). */
const GENERIC_TERMS = new Set(
  'project projects experience work worked working role job team company use used using build built handle handled handling large big'.split(' '),
);

/** Written as plain words; keys and values are stemmed once at load time. */
const RAW_SYNONYMS: Record<string, string[]> = {
  transaction: ['payment', 'order', 'txn', 'tps', 'throughput', 'checkout', 'ledger', 'billing'],
  volume: ['scale', 'throughput', 'million', 'traffic', 'load', 'tps', 'qps', 'concurrent'],
  scale: ['scalable', 'throughput', 'million', 'traffic', 'load', 'distributed'],
  leadership: ['led', 'lead', 'managed', 'mentored', 'head', 'owned', 'drove'],
  lead: ['led', 'managed', 'mentored', 'head', 'owned', 'drove'],
  study: ['education', 'degree', 'university', 'college', 'bachelor', 'master', 'bsc', 'msc', 'btech', 'mtech', 'phd', 'major'],
  university: ['education', 'degree', 'college', 'bachelor', 'master', 'bsc', 'msc', 'btech', 'phd'],
  degree: ['bachelor', 'master', 'bsc', 'msc', 'btech', 'mtech', 'phd', 'university'],
  cloud: ['aws', 'azure', 'gcp', 'kubernetes', 'docker', 'serverless', 'lambda'],
  frontend: ['react', 'angular', 'vue', 'javascript', 'typescript', 'css', 'html'],
  backend: ['api', 'server', 'microservices', 'database', 'node', 'java', 'python', 'golang'],
  database: ['sql', 'postgres', 'postgresql', 'mysql', 'mongodb', 'redis', 'dynamodb', 'cassandra'],
  performance: ['latency', 'optimized', 'throughput', 'speed', 'faster'],
  testing: ['unit', 'integration', 'e2e', 'jest', 'pytest', 'qa', 'coverage'],
  conflict: ['disagreement', 'stakeholder', 'negotiated'],
  achievement: ['award', 'improved', 'reduced', 'increased', 'impact', 'result'],
  ml: ['machine', 'model', 'pytorch', 'tensorflow', 'learning'],
  ai: ['llm', 'machine', 'model', 'gpt', 'learning'],
};

const SECTION_FOR_HINT: Record<SectionHint, string[]> = {
  summary: ['Summary', 'Background'],
  experience: ['Experience', 'Volunteering', 'Background'],
  projects: ['Projects', 'Experience'],
  skills: ['Skills', 'Experience', 'Projects'],
  education: ['Education', 'Certifications'],
  achievements: ['Achievements', 'Experience', 'Projects'],
  certifications: ['Certifications', 'Education'],
};

/** Very light stemmer: enough to match "handled/handling", "payments/payment", "scalable/scaling". */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length <= 3) return w;
  for (const suffix of ['ations', 'ation', 'ments', 'ment', 'ingly', 'ings', 'ing', 'ities', 'ity', 'ies', 'ied', 'ed', 'es', 'er', 'ly', 's', 'e', 'y']) {
    if (w.endsWith(suffix) && w.length - suffix.length >= 3) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  return w;
}

const SYNONYMS: Array<[string, string[]]> = Object.entries(RAW_SYNONYMS).map(([k, v]) => [stem(k), [...new Set(v.map(stem))]]);

export function terms(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}+#.]+/gu) ?? [])
    .map((t) => t.replace(/^[.]+|[.]+$/g, ''))
    .filter((t) => t && !STOPWORDS.has(t))
    .map(stem);
}

export class KeywordRetriever implements Retriever {
  private readonly docTerms: string[][];
  private readonly df = new Map<string, number>();
  private readonly avgLen: number;

  constructor(private readonly chunks: KnowledgeChunk[]) {
    this.docTerms = chunks.map((c) => terms(`${c.section} ${c.text}`));
    for (const doc of this.docTerms) for (const t of new Set(doc)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.avgLen = this.docTerms.reduce((n, d) => n + d.length, 0) / Math.max(1, this.docTerms.length);
  }

  get size(): number {
    return this.chunks.length;
  }

  private idf(term: string): number {
    const n = this.docTerms.length;
    const df = this.df.get(term) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /** Does a document term match a query term (prefix match handles our light stemming). */
  private static matches(docTerm: string, queryTerm: string): boolean {
    return docTerm === queryTerm || (queryTerm.length >= 4 && docTerm.startsWith(queryTerm)) || (docTerm.length >= 4 && queryTerm.startsWith(docTerm));
  }

  retrieve(query: string, opts: { sectionHints: SectionHint[]; limit: number }): RetrievalResult {
    if (this.chunks.length === 0) return { chunks: [], evidence: 'none' };
    const base = [...new Set(terms(query))];
    const expanded = new Map<string, number>(); // term -> weight
    for (const t of base) {
      expanded.set(t, GENERIC_TERMS.has(t) ? 0.3 : 1);
      for (const [key, syns] of SYNONYMS) {
        if (KeywordRetriever.matches(t, key)) for (const s of syns) if (!expanded.has(s)) expanded.set(s, 0.6);
      }
    }
    const boostedSections = new Set(opts.sectionHints.flatMap((h) => SECTION_FOR_HINT[h]));
    const k1 = 1.2;
    const b = 0.75;

    const scored: RetrievedChunk[] = this.chunks.map((chunk, i) => {
      const doc = this.docTerms[i] ?? [];
      let score = 0;
      const matched = new Set<string>();
      for (const [qt, weight] of expanded) {
        const tf = doc.filter((dt) => KeywordRetriever.matches(dt, qt)).length;
        if (!tf) continue;
        if (weight >= 0.6) matched.add(qt);
        const idf = this.idf(qt);
        score += weight * idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.length) / this.avgLen)));
      }
      if (boostedSections.has(chunk.section)) score = score * 1.4 + 0.4;
      return { ...chunk, score, matchedTerms: [...matched] };
    });

    // "Tell me about yourself" style questions: summary + most recent experience are relevant by definition.
    if (opts.sectionHints.includes('summary')) {
      const picks = [
        ...scored.filter((c) => c.section === 'Summary' || c.section === 'Background').slice(0, 1),
        ...scored.filter((c) => c.section === 'Experience').slice(0, 2),
      ];
      if (picks.length) return { chunks: picks.slice(0, opts.limit), evidence: 'strong' };
    }

    const ranked = scored.filter((c) => c.matchedTerms.length > 0).sort((a, b2) => b2.score - a.score);
    const top = ranked.slice(0, opts.limit).filter((c, i) => i === 0 || c.score >= (ranked[0]?.score ?? 0) * 0.35);

    if (top.length === 0) {
      // Factual-section questions ("What did you study?") are answerable from the section itself
      // even without keyword overlap, e.g. an Education section listing a degree.
      const factual = opts.sectionHints.find((h) => h === 'education' || h === 'skills' || h === 'certifications');
      const primary = factual ? SECTION_FOR_HINT[factual][0] : undefined;
      const sectionChunks = primary ? scored.filter((c) => c.section === primary) : [];
      return sectionChunks.length ? { chunks: sectionChunks.slice(0, opts.limit), evidence: 'weak' } : { chunks: [], evidence: 'none' };
    }
    const distinct = new Set(top.flatMap((c) => c.matchedTerms));
    const evidence = (top[0]?.matchedTerms.length ?? 0) >= 2 || distinct.size >= 3 ? 'strong' : 'weak';
    return { chunks: top, evidence };
  }
}

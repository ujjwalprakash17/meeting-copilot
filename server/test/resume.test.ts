import { describe, expect, it } from 'vitest';
import { classifyQuestionIntent } from '../src/detection/intent.js';
import { ExtractionError, extractResume } from '../src/resume/extract.js';
import { KeywordRetriever } from '../src/resume/retrieval.js';
import { canonicalHeading, parseResume, redactContactDetails } from '../src/resume/sections.js';
import { makeDocx, makePdf, SAMPLE_RESUME } from './fixtures.js';

const retriever = new KeywordRetriever(parseResume(SAMPLE_RESUME));
const ask = (q: string) => {
  const intent = classifyQuestionIntent(q);
  return { intent, result: retriever.retrieve(q, { sectionHints: intent.sectionHints, limit: 3 }) };
};

describe('resume sectioning', () => {
  it('recognises common headings', () => {
    expect(canonicalHeading('EXPERIENCE')).toBe('Experience');
    expect(canonicalHeading('Work Experience:')).toBe('Experience');
    expect(canonicalHeading('Technical Skills')).toBe('Skills');
    expect(canonicalHeading('Built a payment system.')).toBeNull();
  });

  it('splits sections into entries and drops the contact header', () => {
    const chunks = parseResume(SAMPLE_RESUME);
    const sections = [...new Set(chunks.map((c) => c.section))];
    expect(sections).toEqual(['Summary', 'Experience', 'Projects', 'Skills']);
    const experience = chunks.filter((c) => c.section === 'Experience');
    expect(experience).toHaveLength(2);
    expect(experience[0]?.text).toContain('Northwind Payments');
    expect(chunks.some((c) => c.text.includes('@example.com'))).toBe(false);
  });

  it('redacts contact details but keeps date ranges and metrics', () => {
    const out = redactContactDetails('mail a.b@x.io, call +44 20 7946 0958, 2018 - 2021, cut latency 60%');
    expect(out).toContain('[email]');
    expect(out).toContain('[phone]');
    expect(out).toContain('2018 - 2021');
    expect(out).toContain('60%');
  });
});

describe('question intent', () => {
  it.each([
    ['Tell me about a project where you handled a large transaction volume.', 'personal'],
    ['What did you study at university?', 'personal'],
    ['Have you worked with Kafka?', 'personal'],
    ['Tell me about yourself.', 'personal'],
    ['How would you design a rate limiter?', 'general'],
    ['What is the difference between a process and a thread?', 'general'],
    ['Have you used Redis, and how does it persist data to disk?', 'mixed'],
  ])('%s -> %s', (q, kind) => {
    expect(classifyQuestionIntent(q).kind).toBe(kind);
  });
});

describe('resume retrieval', () => {
  it('finds strong evidence when the answer is in the resume', () => {
    const { intent, result } = ask('Tell me about a project where you handled a large transaction volume.');
    expect(intent.kind).toBe('personal');
    expect(result.evidence).toBe('strong');
    expect(result.chunks[0]?.text).toContain('2M transactions per day');
  });

  it('finds Kafka experience for a technology question', () => {
    const { result } = ask('Have you worked with Kafka?');
    expect(result.evidence).not.toBe('none');
    expect(result.chunks[0]?.text).toContain('Kafka-based event pipelines');
  });

  it('returns summary and recent experience for "tell me about yourself"', () => {
    const { result } = ask('Tell me about yourself.');
    expect(result.evidence).toBe('strong');
    expect(result.chunks.map((c) => c.section)).toEqual(['Summary', 'Experience', 'Experience']);
  });

  it('reports no evidence when the resume lacks the information', () => {
    expect(ask('What did you study at university?').result.evidence).toBe('none');
    expect(ask('Have you worked with Elixir or Phoenix LiveView?').result.evidence).toBe('none');
  });

  it('handles ambiguous questions with partial evidence', () => {
    // "Leadership" is not written in the resume, but mentoring and leading a migration are.
    const { result } = ask('Tell me about your leadership experience.');
    expect(result.evidence).not.toBe('none');
    expect(result.chunks.some((c) => /Mentored|led the migration/.test(c.text))).toBe(true);
  });

  it('never sends the whole resume for a narrow question', () => {
    const { result } = ask('Have you used PostgreSQL partitioning?');
    expect(result.chunks.length).toBeLessThanOrEqual(3);
    expect(result.chunks.map((c) => c.text).join('').length).toBeLessThan(SAMPLE_RESUME.length);
  });
});

describe('resume extraction', () => {
  it('extracts text from a TXT resume', async () => {
    const res = await extractResume(Buffer.from(SAMPLE_RESUME), 'resume.txt');
    expect(res.kind).toBe('txt');
    expect(res.sections).toContain('Experience');
  });

  it('extracts text from a real PDF', async () => {
    const pdf = makePdf(['EXPERIENCE', 'Senior Engineer at Northwind Payments 2021 - Present', 'Built a payment service handling 2M transactions per day']);
    const res = await extractResume(pdf, 'resume.pdf');
    expect(res.kind).toBe('pdf');
    expect(res.text).toContain('Northwind Payments');
  });

  it('extracts text from a real DOCX', async () => {
    const docx = makeDocx(['SKILLS', 'Go, Java, PostgreSQL, Kafka and Kubernetes in production systems']);
    const res = await extractResume(docx, 'resume.docx');
    expect(res.kind).toBe('docx');
    expect(res.text).toContain('Kubernetes');
  });

  it('rejects empty, oversized, unsupported, malformed and text-less files with clear errors', async () => {
    const codeOf = async (p: Promise<unknown>) => {
      try {
        await p;
        return 'ok';
      } catch (e) {
        return e instanceof ExtractionError ? e.code : 'unexpected';
      }
    };
    expect(await codeOf(extractResume(Buffer.alloc(0), 'a.pdf'))).toBe('empty');
    expect(await codeOf(extractResume(Buffer.alloc(6 * 1024 * 1024, 65), 'a.txt'))).toBe('too_large');
    expect(await codeOf(extractResume(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), 'photo.png'))).toBe('unsupported_type');
    expect(await codeOf(extractResume(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3]), 'old.doc'))).toBe('unsupported_type');
    expect(await codeOf(extractResume(Buffer.from('%PDF-1.4 garbage that is not a pdf'), 'bad.pdf'))).toBe('malformed');
    expect(await codeOf(extractResume(makePdf([]), 'scan.pdf'))).toBe('no_text');
    expect(await codeOf(extractResume(Buffer.from('PK\u0003\u0004 not really a docx word/ file'), 'x.docx'))).toBe('malformed');
  });
});

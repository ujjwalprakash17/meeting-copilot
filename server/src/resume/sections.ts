/**
 * Splits resume (or personal notes) text into section-labelled chunks suitable for retrieval.
 * Heuristic and dependency-free: headings are short lines that match common resume headings
 * or are written in ALL CAPS.
 */

export interface KnowledgeChunk {
  id: string;
  /** Canonical section name, e.g. "Experience". */
  section: string;
  text: string;
  /** Where this chunk came from. */
  source: 'resume' | 'background' | 'notes';
}

const HEADINGS: Array<[string, RegExp]> = [
  ['Summary', /^(?:professional |career |executive )?(?:summary|profile|objective|about(?: me)?|overview|introduction)$/i],
  ['Experience', /^(?:(?:professional|work|relevant|industry|employment|career)\s+)?(?:experience|history|employment)(?: history)?$|^(?:work|employment|career) history$/i],
  ['Projects', /^(?:(?:key|selected|personal|academic|notable|side|technical)\s+)?projects$/i],
  ['Skills', /^(?:(?:technical|core|key|professional)\s+)?(?:skills|competencies|technologies|expertise)(?: (?:&|and) (?:tools|technologies|interests))?$|^(?:tech(?:nical)? stack|tools(?: (?:&|and) technologies)?|programming languages|languages(?: (?:&|and) frameworks)?)$/i],
  ['Education', /^(?:education|academic (?:background|history|qualifications)|qualifications|education (?:&|and) (?:training|certifications))$/i],
  ['Certifications', /^(?:certifications?|licen[cs]es?(?: (?:&|and) certifications)?|courses|training)$/i],
  ['Achievements', /^(?:achievements|accomplishments|awards(?: (?:&|and) (?:honou?rs|achievements))?|honou?rs|key achievements)$/i],
  ['Publications', /^(?:publications|papers|talks|publications (?:&|and) talks)$/i],
  ['Volunteering', /^(?:volunteer(?:ing)?(?: experience)?|leadership(?: experience)?|activities|extracurricular(?: activities)?)$/i],
];

const MAX_CHUNK_CHARS = 700;

export function canonicalHeading(line: string): string | null {
  const clean = line.replace(/[:\-–—|•*#_]+$/g, '').replace(/^[#*•\s]+/, '').trim();
  if (!clean || clean.length > 48 || /[.!?,;]$/.test(line.trim())) return null;
  for (const [name, re] of HEADINGS) if (re.test(clean)) return name;
  // ALL-CAPS short line with at least 4 letters and no digits: treat as an unknown heading.
  const letters = clean.replace(/[^\p{L}]/gu, '');
  if (letters.length >= 4 && clean === clean.toUpperCase() && !/\d/.test(clean) && clean.split(/\s+/).length <= 4) {
    return clean.charAt(0) + clean.slice(1).toLowerCase();
  }
  return null;
}

/** Removes contact details so they are never sent to the LLM as part of an excerpt. */
export function redactContactDetails(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '[link]')
    .replace(/(?<!\w)(?:\+?\d[\d\s().-]{7,}\d)(?!\w)/g, (m) => (/(?:19|20)\d{2}\s*[-–]\s*(?:(?:19|20)\d{2}|present)/i.test(m) ? m : '[phone]'));
}

const DATE_RANGE = /(?:(?:19|20)\d{2}|present|current)\s*(?:[-–—]|to)\s*(?:(?:19|20)\d{2}|present|current|now)/i;
const BULLET = /^\s*(?:[-•*▪●◦‣–]|\d+[.)])\s+/;

/** Splits the body of one section into entries (jobs, projects, degrees) capped at MAX_CHUNK_CHARS. */
function splitEntries(lines: string[]): string[] {
  const entries: string[][] = [];
  let current: string[] = [];
  let sawBullet = false;
  for (const line of lines) {
    if (!line.trim()) {
      if (current.length) entries.push(current);
      current = [];
      sawBullet = false;
      continue;
    }
    const isBullet = BULLET.test(line);
    // A non-bullet line after bullets, or a line with a date range, usually starts a new entry.
    const startsEntry = current.length > 0 && ((!isBullet && sawBullet) || (DATE_RANGE.test(line) && current.some((l) => DATE_RANGE.test(l))));
    if (startsEntry) {
      entries.push(current);
      current = [];
      sawBullet = false;
    }
    current.push(line.trim());
    if (isBullet) sawBullet = true;
  }
  if (current.length) entries.push(current);

  const out: string[] = [];
  for (const entry of entries) {
    let buf = '';
    for (const line of entry) {
      if (buf && buf.length + line.length + 1 > MAX_CHUNK_CHARS) {
        out.push(buf);
        // Keep the entry's first line (title/company) as a header for continuation chunks.
        buf = entry[0] && entry[0] !== line ? `${entry[0]} (cont.)\n${line}` : line;
      } else {
        buf = buf ? `${buf}\n${line}` : line;
      }
    }
    if (buf) out.push(buf);
  }
  return out;
}

export function parseResume(text: string, source: KnowledgeChunk['source'] = 'resume'): KnowledgeChunk[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const sections: Array<{ name: string; lines: string[] }> = [];
  let current = { name: source === 'resume' ? 'Summary' : source === 'background' ? 'Background' : 'Notes', lines: [] as string[] };
  for (const line of lines) {
    const heading = source === 'resume' || source === 'background' ? canonicalHeading(line) : null;
    if (heading) {
      if (current.lines.some((l) => l.trim())) sections.push(current);
      current = { name: heading, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.some((l) => l.trim())) sections.push(current);

  const chunks: KnowledgeChunk[] = [];
  for (const section of sections) {
    for (const entry of splitEntries(section.lines)) {
      const clean = redactContactDetails(entry).trim();
      // Skip chunks that are only contact details / names (e.g. the resume header).
      if ((clean.replace(/\[(?:email|link|phone)\]/g, '').match(/\p{L}/gu) ?? []).length < 12) continue;
      chunks.push({ id: `${source[0]}${chunks.length + 1}`, section: section.name, text: clean, source });
    }
  }
  return chunks;
}

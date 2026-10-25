/**
 * Text extraction for uploaded resumes. Runs in memory on the local server; the uploaded file is
 * never written to disk and is discarded after extraction. Only extracted text is returned.
 */
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';
import { LIMITS, type ResumeExtractResponse, type ResumeFileKind } from '@meeting-copilot/shared';
import { parseResume } from './sections.js';

export class ExtractionError extends Error {
  constructor(
    readonly code: 'unsupported_type' | 'too_large' | 'empty' | 'encrypted' | 'no_text' | 'malformed',
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const startsWith = (buf: Buffer, bytes: number[]) => bytes.every((b, i) => buf[i] === b);

/** Detect the real file type from magic bytes; the file name/extension is only a tie-breaker for text. */
export function detectKind(buf: Buffer, fileName: string): ResumeFileKind {
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'; // %PDF-
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) {
    if (/\.docx$/i.test(fileName) || buf.includes('word/')) return 'docx';
    throw new ExtractionError('unsupported_type', 'This ZIP-based file is not a Word .docx document.', 415);
  }
  if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0])) {
    throw new ExtractionError(
      'unsupported_type',
      'This looks like a legacy .doc file or a password-protected Word document. Save it as an unprotected .docx or PDF and try again.',
      415,
    );
  }
  if (/\.(txt|md|text)$/i.test(fileName) || !buf.subarray(0, 4096).includes(0)) return 'txt';
  throw new ExtractionError('unsupported_type', 'Unsupported file type. Upload a PDF, DOCX or TXT resume.', 415);
}

// Built from code points so the source contains no invisible characters.
// eslint-disable-next-line no-control-regex -- stripping control characters from extracted text is the point
const CONTROL_CHARS = new RegExp('[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f]', 'g');
const HORIZONTAL_SPACE = new RegExp('[ \\t\\xa0]+', 'g');
const BOM = new RegExp('^\\ufeff');

export function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, '')
    .replace(HORIZONTAL_SPACE, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractPdf(buf: Buffer): Promise<{ text: string; warnings: string[] }> {
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(buf));
  } catch (err) {
    const name = (err as { name?: string }).name ?? '';
    if (name === 'PasswordException') {
      throw new ExtractionError('encrypted', 'This PDF is password-protected. Remove the password and upload it again.', 422);
    }
    throw new ExtractionError('malformed', 'The PDF could not be read; it may be damaged or not a real PDF.', 422);
  }
  try {
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const pages = text.map((p) => p.trim());
    const joined = pages.join('\n\n');
    const letters = (joined.match(/\p{L}/gu) ?? []).length;
    if (letters < 40 * Math.max(1, Math.min(totalPages, 2))) {
      throw new ExtractionError(
        'no_text',
        'No readable text was found. The PDF appears to be scanned images; OCR is not supported. Upload a text-based PDF, DOCX or TXT.',
        422,
      );
    }
    const warnings = pages.some((p) => p.length < 30) && totalPages > 1 ? ['Some pages contain little or no extractable text (possibly images).'] : [];
    return { text: joined, warnings };
  } finally {
    await pdf.loadingTask.destroy().catch(() => undefined);
  }
}

async function extractDocx(buf: Buffer): Promise<{ text: string; warnings: string[] }> {
  try {
    const result = await mammoth.extractRawText({ buffer: buf });
    const warnings = result.messages.filter((m) => m.type === 'warning').length ? ['Some document elements could not be read.'] : [];
    return { text: result.value, warnings };
  } catch {
    throw new ExtractionError('malformed', 'The DOCX file could not be read; it may be damaged or encrypted.', 422);
  }
}

function extractTxt(buf: Buffer): { text: string; warnings: string[] } {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(BOM, '');
    return { text, warnings: [] };
  } catch {
    throw new ExtractionError('malformed', 'The text file is not valid UTF-8.', 422);
  }
}

export async function extractResume(buf: Buffer, fileName: string): Promise<ResumeExtractResponse> {
  if (buf.length === 0) throw new ExtractionError('empty', 'The uploaded file is empty.', 400);
  if (buf.length > LIMITS.maxResumeFileBytes) {
    throw new ExtractionError('too_large', `File is too large (max ${LIMITS.maxResumeFileBytes / 1024 / 1024} MB).`, 413);
  }
  const kind = detectKind(buf, fileName);
  const raw = kind === 'pdf' ? await extractPdf(buf) : kind === 'docx' ? await extractDocx(buf) : extractTxt(buf);
  let text = cleanText(raw.text);
  const warnings = [...raw.warnings];
  if ((text.match(/\p{L}/gu) ?? []).length < 40) {
    throw new ExtractionError('no_text', 'The document does not contain enough readable text to use as a resume.', 422);
  }
  if (text.length > LIMITS.maxResumeChars) {
    text = text.slice(0, LIMITS.maxResumeChars);
    warnings.push(`Text was truncated to ${LIMITS.maxResumeChars.toLocaleString('en-US')} characters.`);
  }
  const sections = [...new Set(parseResume(text).map((c) => c.section))];
  return { fileName, kind, text, chars: text.length, sections, warnings };
}

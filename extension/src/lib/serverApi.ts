/** HTTP calls to the local Meeting Copilot server. Provider keys never pass through the extension. */
import { extensionLog } from './log.js';
import {
  elapsedMs,
  monotonicNow,
  LIMITS,
  RESUME_FILE_TYPES,
  type ApiErrorBody,
  type ConversationDetailResponse,
  type ConversationListResponse,
  type ResumeExtractResponse,
} from '@meeting-copilot/shared';

export interface ServerStatus {
  stt: { provider: string; configured: boolean };
  llm: { provider: string; model: string; configured: boolean; simulated: boolean; verified: boolean | null; message: string };
  detectionModel: string | null;
  history?: { enabled: boolean; error: string | null };
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const log = extensionLog.child('server-api');

async function request<T>(serverUrl: string, path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const t0 = monotonicNow();
  const op = `${init.method ?? 'GET'} ${path.split('?')[0]}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 15_000);
  let res: Response;
  try {
    res = await fetch(new URL(path, serverUrl), { ...init, signal: controller.signal });
  } catch (err) {
    log.error('request_failed', { op, kind: (err as Error).name === 'AbortError' ? 'timeout' : 'network', err, duration_ms: elapsedMs(t0) });
    throw new ApiError(
      'network',
      (err as Error).name === 'AbortError'
        ? 'The local server did not respond in time.'
        : `Cannot reach the Meeting Copilot server at ${serverUrl}. Is it running (npm run dev:server)?`,
    );
  } finally {
    clearTimeout(timer);
  }
  const body = (await res.json().catch(() => null)) as (T & Partial<ApiErrorBody>) | null;
  if (!res.ok || !body) {
    const code = body?.error?.code ?? `http_${res.status}`;
    log.warn('request_failed', { op, status: res.status, code, duration_ms: elapsedMs(t0) });
    throw new ApiError(code, body?.error?.message ?? `Server returned HTTP ${res.status}`);
  }
  log.debug('request_ok', { op, status: res.status, duration_ms: elapsedMs(t0) });
  return body;
}

export const fetchServerStatus = (serverUrl: string) => request<ServerStatus>(serverUrl, '/api/status', { timeoutMs: 5_000 });

const ACCEPTED_EXTENSIONS = /\.(pdf|docx|txt)$/i;
export const RESUME_ACCEPT = ['.pdf', '.docx', '.txt', ...Object.values(RESUME_FILE_TYPES)].join(',');

/** Client-side pre-checks; the server validates again using the file's magic bytes. */
export function validateResumeFile(file: File): string | null {
  if (!ACCEPTED_EXTENSIONS.test(file.name)) return 'Unsupported file type. Upload a PDF, DOCX or TXT file.';
  if (file.size === 0) return 'The file is empty.';
  if (file.size > LIMITS.maxResumeFileBytes) return `The file is too large (max ${LIMITS.maxResumeFileBytes / 1024 / 1024} MB).`;
  return null;
}

export async function extractResume(serverUrl: string, file: File): Promise<ResumeExtractResponse> {
  return request<ResumeExtractResponse>(serverUrl, '/api/resume/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
    body: await file.arrayBuffer(),
    timeoutMs: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Conversation history (stored in the local server's SQLite database)
// ---------------------------------------------------------------------------

export const listConversations = (serverUrl: string, before?: number) =>
  request<ConversationListResponse>(serverUrl, `/api/history?limit=50${before ? `&before=${before}` : ''}`, { timeoutMs: 10_000 });

export const getConversation = (serverUrl: string, id: string) =>
  request<ConversationDetailResponse>(serverUrl, `/api/history/${encodeURIComponent(id)}`, { timeoutMs: 10_000 });

export const renameConversation = (serverUrl: string, id: string, title: string | null) =>
  request<{ ok: boolean }>(serverUrl, `/api/history/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });

export const deleteConversation = (serverUrl: string, id: string) =>
  request<{ ok: boolean }>(serverUrl, `/api/history/${encodeURIComponent(id)}`, { method: 'DELETE' });

/** Deletes every saved conversation. The server requires the explicit confirmation header. */
export const deleteAllConversations = (serverUrl: string) =>
  request<{ ok: boolean; deleted: number }>(serverUrl, '/api/history', { method: 'DELETE', headers: { 'X-Confirm-Delete-All': 'yes' } });

export async function generateInsight(serverUrl: string, kind: 'summary' | 'action_items', transcript: string) {
  return request<{ kind: string; text: string; model: string; simulated: boolean }>(serverUrl, '/api/insights', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, transcript }),
    timeoutMs: 60_000,
  });
}

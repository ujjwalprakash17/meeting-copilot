/**
 * Local persistence.
 *  - Settings (preferences, background, notes, keywords): chrome.storage.local on this device only.
 *  - Resume text: chrome.storage.session by default (memory only, cleared when the browser closes);
 *    chrome.storage.local only if the user ticks "Remember resume on this device".
 *    The original uploaded file is never stored: only the extracted text.
 *  - Live view state (current transcript/answers) and session status: chrome.storage.session (memory only).
 *  - Saved conversation history (questions and answers): the local server's SQLite database, not the browser.
 *    The current conversation ID is kept in chrome.storage.session, so a new browser session starts a new conversation.
 */
import {
  DEFAULT_SESSION_CONFIG,
  LIMITS,
  type AnswerLength,
  type AnswerMode,
  type AnswerStyle,
  type CopilotState,
  type ResumeExtractResponse,
  type SessionConfig,
} from '@meeting-copilot/shared';

export interface ExtensionSettings {
  serverUrl: string;
  answerMode: AnswerMode;
  answerStyle: AnswerStyle;
  answerLength: AnswerLength;
  background: string;
  notes: string;
  keywords: string[];
  language: string;
  diarize: boolean;
  contextSegments: number;
  allowAnyTab: boolean;
  rememberResume: boolean;
  openAssistantOnStart: boolean;
  /** Place the assistant window on a different display than the meeting (needs the optional system.display permission). */
  keepAssistantOnOtherDisplay: boolean;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  serverUrl: 'http://localhost:8787',
  answerMode: DEFAULT_SESSION_CONFIG.answerMode,
  answerStyle: DEFAULT_SESSION_CONFIG.answerStyle,
  answerLength: DEFAULT_SESSION_CONFIG.answerLength,
  background: '',
  notes: '',
  keywords: [],
  language: DEFAULT_SESSION_CONFIG.language,
  diarize: false,
  contextSegments: DEFAULT_SESSION_CONFIG.contextSegments,
  allowAnyTab: false,
  rememberResume: false,
  openAssistantOnStart: true,
  keepAssistantOnOtherDisplay: false,
};

/** Result of the last attempt to keep the assistant window off the meeting's display. */
export interface DisplayPlacementStatus {
  kind: 'moved' | 'already-separate' | 'single-display' | 'no-permission' | 'no-window' | 'error';
  displayName?: string;
  message?: string;
  at: number;
}

export interface StoredResume extends ResumeExtractResponse {
  uploadedAt: number;
}

export type SessionPhase = 'idle' | 'starting' | 'live' | 'reconnecting' | 'stopping' | 'error';

export interface SessionStatus {
  phase: SessionPhase;
  mode: 'live' | 'simulation' | null;
  tabId: number | null;
  tabTitle: string | null;
  startedAt: number | null;
  message: string | null;
}

export const IDLE_STATUS: SessionStatus = { phase: 'idle', mode: null, tabId: null, tabTitle: null, startedAt: null, message: null };

const KEYS = {
  settings: 'settings',
  resume: 'resume',
  status: 'status',
  history: 'history',
  assistantWindow: 'assistantWindow',
  conversation: 'conversationId',
  displayPlacement: 'displayPlacement',
  sharingTipDismissed: 'sharingTipDismissed',
} as const;
export { KEYS as STORAGE_KEYS };

export async function getSettings(): Promise<ExtensionSettings> {
  const { [KEYS.settings]: stored } = await chrome.storage.local.get(KEYS.settings);
  return { ...DEFAULT_SETTINGS, ...((stored as Partial<ExtensionSettings> | undefined) ?? {}) };
}

export async function saveSettings(patch: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [KEYS.settings]: next });
  return next;
}

export async function getResume(): Promise<StoredResume | null> {
  const [{ [KEYS.resume]: s }, { [KEYS.resume]: l }] = await Promise.all([
    chrome.storage.session.get(KEYS.resume),
    chrome.storage.local.get(KEYS.resume),
  ]);
  return ((s ?? l) as StoredResume | undefined) ?? null;
}

export async function saveResume(resume: StoredResume, remember: boolean): Promise<void> {
  await chrome.storage.session.set({ [KEYS.resume]: resume });
  if (remember) await chrome.storage.local.set({ [KEYS.resume]: resume });
  else await chrome.storage.local.remove(KEYS.resume);
}

export async function removeResume(): Promise<void> {
  await Promise.all([chrome.storage.session.remove(KEYS.resume), chrome.storage.local.remove(KEYS.resume)]);
}

/** Applies the "remember" preference to an already uploaded resume. */
export async function setRememberResume(remember: boolean): Promise<void> {
  await saveSettings({ rememberResume: remember });
  const resume = await getResume();
  if (resume) await saveResume(resume, remember);
}

export async function getStatus(): Promise<SessionStatus> {
  const { [KEYS.status]: status } = await chrome.storage.session.get(KEYS.status);
  return (status as SessionStatus | undefined) ?? IDLE_STATUS;
}

export async function setStatus(status: SessionStatus): Promise<void> {
  await chrome.storage.session.set({ [KEYS.status]: status });
}

export async function getHistory(): Promise<CopilotState | null> {
  const { [KEYS.history]: h } = await chrome.storage.session.get(KEYS.history);
  return (h as CopilotState | undefined) ?? null;
}

export async function clearHistory(): Promise<void> {
  await chrome.storage.session.remove(KEYS.history);
}

/** Removes everything this extension stored in the browser (settings, resume, live view). Saved server history is separate. */
export async function clearAllLocalData(): Promise<void> {
  await Promise.all([chrome.storage.local.clear(), chrome.storage.session.remove([KEYS.resume, KEYS.history, KEYS.conversation])]);
}

/** ID of the conversation new question/answer cards are saved under; created on first use. */
export async function getConversationId(): Promise<string> {
  const { [KEYS.conversation]: id } = await chrome.storage.session.get(KEYS.conversation);
  if (typeof id === 'string' && id) return id;
  const fresh = crypto.randomUUID();
  await chrome.storage.session.set({ [KEYS.conversation]: fresh });
  return fresh;
}

/** Starts a new conversation: new ID and an empty live view. Saved conversations are not touched. */
export async function startNewConversation(): Promise<string> {
  const id = crypto.randomUUID();
  await chrome.storage.session.set({ [KEYS.conversation]: id });
  await clearHistory();
  return id;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/** Builds the session config sent to the local server (validated again server-side). */
export function buildSessionConfig(settings: ExtensionSettings, resume: StoredResume | null, conversationId?: string | null): SessionConfig {
  return {
    ...(conversationId ? { conversationId } : {}),
    answerMode: settings.answerMode,
    answerStyle: settings.answerStyle,
    answerLength: settings.answerLength,
    background: clip(settings.background, LIMITS.maxBackgroundChars),
    notes: clip(settings.notes, LIMITS.maxNotesChars),
    keywords: settings.keywords
      .map((k) => k.trim())
      .filter(Boolean)
      .map((k) => clip(k, LIMITS.maxKeywordChars))
      .slice(0, LIMITS.maxKeywords),
    language: settings.language || 'en',
    diarize: settings.diarize,
    contextSegments: Math.max(0, Math.min(60, Math.round(settings.contextSegments))),
    resume: resume ? { fileName: clip(resume.fileName, 255), text: clip(resume.text, LIMITS.maxResumeChars) } : null,
  };
}

export function wsUrl(serverUrl: string): string {
  const u = new URL(serverUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ws';
  return u.toString();
}

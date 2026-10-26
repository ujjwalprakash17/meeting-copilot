/**
 * Service worker: session lifecycle, offscreen document, assistant window, toolbar badge,
 * keyboard commands and session-scoped persistence. It never touches meeting page content:
 * the extension has no content scripts and does not inject anything into Meet or Teams.
 *
 * Logs (see lib/log.ts): chrome://extensions -> Meeting Copilot -> "service worker" -> Console.
 */
import { elapsedMs, monotonicNow, type CopilotState } from '@meeting-copilot/shared';
import { actionAppearance, actionIconPaths } from '../lib/actionAppearance.js';
import { openAssistantWindow, type StoredWindowInfo } from '../lib/assistantWindow.js';
import { chooseAssistantPlacement, type DisplayLike, type Rect } from '../lib/displayPlacement.js';
import { initContextLogging, isDebugLogging } from '../lib/log.js';
import { newId, send, type RuntimeMessage, type StartResponse } from '../lib/messages.js';
import {
  buildSessionConfig,
  getConversationId,
  getHistory,
  getResume,
  getSettings,
  getStatus,
  IDLE_STATUS,
  setStatus,
  STORAGE_KEYS,
  type DisplayPlacementStatus,
  type SessionStatus,
} from '../lib/settings.js';
import { checkSite } from '../lib/sites.js';

const log = initContextLogging('sw');
const sessionLog = log.child('session');
const windowLog = log.child('assistant-window');
const displayLog = log.child('display');

log.info('startup', { version: chrome.runtime.getManifest().version });

const OFFSCREEN_URL = 'offscreen.html';

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  return contexts.length > 0;
}

async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return;
  const t0 = monotonicNow();
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Process user-started tab audio capture for live transcription.',
  });
  sessionLog.debug('offscreen_created', { duration_ms: elapsedMs(t0) });
}

async function closeOffscreen(): Promise<void> {
  if (!(await hasOffscreen())) return;
  await chrome.offscreen.closeDocument().catch((err: unknown) => sessionLog.warn('offscreen_close_failed', { err }));
  sessionLog.debug('offscreen_closed');
}

// ---------------------------------------------------------------------------
// Status indicator (toolbar badge): visible outside the meeting page.
// ---------------------------------------------------------------------------

/** Toolbar icon: grey when not listening, soft blue while listening; "ERR" badge on errors (see actionAppearance). */
async function applyBadge(status: SessionStatus): Promise<void> {
  const look = actionAppearance(status);
  try {
    await chrome.action.setIcon({ path: actionIconPaths(look.icon) });
    await chrome.action.setBadgeText({ text: look.badgeText });
    await chrome.action.setBadgeBackgroundColor({ color: look.badgeColor });
    await chrome.action.setTitle({ title: look.title });
  } catch (err) {
    // Cosmetic only: never let the toolbar icon block starting or stopping a session.
    log.warn('toolbar_icon_update_failed', { icon: look.icon, err, recovery: 'session_continues' });
  }
}

async function updateStatus(status: SessionStatus): Promise<void> {
  await setStatus(status);
  await applyBadge(status);
}

// ---------------------------------------------------------------------------
// Assistant window: an extension-owned popup window, separate from the meeting tab/window.
// ---------------------------------------------------------------------------

const getStoredWindow = async () =>
  ((await chrome.storage.local.get(STORAGE_KEYS.assistantWindow)) as { assistantWindow?: StoredWindowInfo }).assistantWindow;

async function assistantWindowId(): Promise<number | null> {
  const info = await getStoredWindow();
  if (info?.id === undefined) return null;
  try {
    await chrome.windows.get(info.id);
    return info.id;
  } catch {
    return null;
  }
}

function openAssistant(focus: boolean) {
  return openAssistantWindow(
    {
      url: chrome.runtime.getURL('assistant.html'),
      getStored: getStoredWindow,
      setStored: (info) => chrome.storage.local.set({ [STORAGE_KEYS.assistantWindow]: info }),
      windowExists: (id) => chrome.windows.get(id).then(
        () => true,
        () => false,
      ),
      focus: async (id) => {
        await chrome.windows.update(id, { focused: true, drawAttention: false });
      },
      // Opening unfocused (focus=false) keeps keyboard focus in the meeting when listening starts.
      create: (opts) => chrome.windows.create(opts).then((w) => ({ ...(w?.id !== undefined ? { id: w.id } : {}) })),
      log: windowLog,
    },
    { focus },
  );
}

/**
 * Keeps the assistant window on a different display than the meeting, so the user can share the meeting's
 * display (or just its tab/window) without the assistant in it. Chrome cannot hide a window from an
 * "Entire screen" capture; this only works when there is a second display. Never focuses the window.
 */
async function placeAssistant(meetingTabId: number | null): Promise<DisplayPlacementStatus> {
  const t0 = monotonicNow();
  const done = async (status: DisplayPlacementStatus) => {
    await chrome.storage.session.set({ [STORAGE_KEYS.displayPlacement]: status });
    const fields = { kind: status.kind, display: status.displayName, duration_ms: elapsedMs(t0) };
    if (status.kind === 'error') displayLog.error('place_failed', { ...fields, err: status.message, recovery: 'window_left_in_place' });
    else displayLog.info('placed', fields);
    return status;
  };
  try {
    if (!(await chrome.permissions.contains({ permissions: ['system.display'] }))) {
      return done({ kind: 'no-permission', at: Date.now() });
    }
    const id = await assistantWindowId();
    if (id === null) return done({ kind: 'no-window', at: Date.now() });
    const displays: DisplayLike[] = (await chrome.system.display.getInfo()).map((d) => ({
      id: d.id,
      name: d.name,
      isPrimary: d.isPrimary,
      bounds: d.bounds,
      workArea: d.workArea,
    }));
    displayLog.debug('displays', { count: displays.length, layout: displays.map((d) => `${d.bounds.left},${d.bounds.top},${d.bounds.width}x${d.bounds.height}`).join(' ') });
    const rect = (w: chrome.windows.Window): Rect | null =>
      w.left !== undefined && w.top !== undefined && w.width !== undefined && w.height !== undefined ? { left: w.left, top: w.top, width: w.width, height: w.height } : null;
    let meetingWindow: chrome.windows.Window | null = null;
    try {
      meetingWindow = meetingTabId !== null ? await chrome.windows.get((await chrome.tabs.get(meetingTabId)).windowId) : await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    } catch {
      meetingWindow = null;
    }
    const assistant = await chrome.windows.get(id);
    const placement = chooseAssistantPlacement(displays, meetingWindow ? rect(meetingWindow) : null, rect(assistant), {
      width: assistant.width ?? 440,
      height: assistant.height ?? 780,
    });
    if (placement.kind === 'single-display') return done({ kind: 'single-display', at: Date.now() });
    if (placement.kind === 'already-separate') return done({ kind: 'already-separate', displayName: placement.display.name, at: Date.now() });
    // Moving does not focus the window, so the meeting keeps keyboard focus.
    await chrome.windows.update(id, { state: 'normal', ...placement.bounds });
    return done({ kind: 'moved', displayName: placement.display.name, at: Date.now() });
  } catch (err) {
    return done({ kind: 'error', message: (err as Error).message, at: Date.now() });
  }
}

// Remember where the user placed the assistant window (e.g. on a second monitor). Only "normal" windows:
// minimized/maximized/fullscreen bounds are not a position to restore later.
chrome.windows.onBoundsChanged.addListener(async (win) => {
  const info = await getStoredWindow();
  if (!info || info.id !== win.id || (win.state && win.state !== 'normal')) return;
  await chrome.storage.local.set({
    [STORAGE_KEYS.assistantWindow]: { id: info.id, bounds: { left: win.left, top: win.top, width: win.width, height: win.height } } satisfies StoredWindowInfo,
  });
  windowLog.debug('position_saved', { position: `${win.left},${win.top},${win.width}x${win.height}` });
});

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

let starting = false;
/** True while stopSession waits for the offscreen document's reply; it closes the document itself afterwards. */
let stopping = false;

async function startSession(msg: Extract<RuntimeMessage, { type: 'copilot.start' }>): Promise<StartResponse> {
  const current = await getStatus();
  if (starting || ['starting', 'live', 'reconnecting', 'stopping'].includes(current.phase)) {
    sessionLog.warn('start_rejected', { reason: 'already_running', phase: current.phase });
    return { ok: false, error: 'A session is already running. Stop it first.' };
  }
  starting = true;
  const t0 = monotonicNow();
  let stage = 'load_settings';
  sessionLog.info('start_requested', { mode: msg.mode, tab: msg.tabId ?? undefined, has_stream: Boolean(msg.streamId) });
  try {
    const [settings, resume, previous, conversationId] = await Promise.all([getSettings(), getResume(), getHistory(), getConversationId()]);
    await updateStatus({ phase: 'starting', mode: msg.mode, tabId: msg.tabId, tabTitle: msg.tabTitle, startedAt: Date.now(), message: null });
    stage = 'offscreen';
    await ensureOffscreen();

    // The assistant window is a convenience: failing to open it must not stop audio capture.
    let warning: string | undefined;
    if (settings.openAssistantOnStart) {
      stage = 'assistant_window';
      try {
        await openAssistant(false);
        if (settings.keepAssistantOnOtherDisplay) await placeAssistant(msg.tabId);
      } catch (err) {
        warning = `Listening started, but the assistant window could not be opened (${(err as Error).message}). Use "Open assistant window" to try again.`;
        windowLog.error('open_failed', { err, recovery: 'session_continues_without_window' });
      }
    }

    stage = 'offscreen_start';
    const res = (await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'offscreen.start',
      mode: msg.mode,
      streamId: msg.streamId,
      serverUrl: settings.serverUrl,
      config: buildSessionConfig(settings, resume, conversationId),
      tabId: msg.tabId,
      tabTitle: msg.tabTitle,
      previous,
      debugLogging: isDebugLogging(),
    } satisfies RuntimeMessage & { previous: CopilotState | null; debugLogging: boolean })) as StartResponse | undefined;
    if (!res?.ok) {
      const error = res?.error ?? 'Failed to start the session (no response from the offscreen document).';
      sessionLog.error('start_failed', { stage, err: error, duration_ms: elapsedMs(t0), recovery: 'offscreen_closed' });
      await closeOffscreen();
      await updateStatus({ ...IDLE_STATUS, phase: 'error', message: error });
      return { ok: false, error };
    }
    sessionLog.info('started', { mode: msg.mode, duration_ms: elapsedMs(t0), warning: warning ? 'assistant_window_unavailable' : undefined });
    return warning ? { ok: true, warning } : { ok: true };
  } catch (err) {
    sessionLog.error('start_failed', { stage, err, duration_ms: elapsedMs(t0), recovery: 'offscreen_closed' });
    await closeOffscreen();
    const error = (err as Error).message;
    await updateStatus({ ...IDLE_STATUS, phase: 'error', message: error });
    return { ok: false, error };
  } finally {
    starting = false;
  }
}

async function stopSession(reason?: string): Promise<void> {
  const t0 = monotonicNow();
  sessionLog.info('stop_requested', { reason: reason ?? 'user' });
  if (await hasOffscreen()) {
    stopping = true;
    try {
      await chrome.runtime
        .sendMessage({ target: 'offscreen', type: 'offscreen.stop', ...(reason ? { reason } : {}) } satisfies RuntimeMessage)
        .catch((err: unknown) => sessionLog.warn('stop_message_failed', { err, recovery: 'closing_offscreen_anyway' }));
    } finally {
      stopping = false;
    }
    await closeOffscreen();
  }
  const status = await getStatus();
  if (status.phase !== 'idle' && status.phase !== 'error') await updateStatus({ ...status, phase: 'idle', message: null });
  sessionLog.info('stopped', { duration_ms: elapsedMs(t0) });
}

/** Keyboard shortcut path: a command counts as invoking the extension on that tab, which tabCapture requires. */
async function toggleFromShortcut(tab: chrome.tabs.Tab | undefined): Promise<void> {
  const status = await getStatus();
  if (status.phase !== 'idle' && status.phase !== 'error') return stopSession();
  const settings = await getSettings();
  const site = checkSite(tab?.url, { allowAnyTab: settings.allowAnyTab, serverUrl: settings.serverUrl });
  if (!tab?.id || !site.supported) {
    sessionLog.warn('shortcut_start_rejected', { reason: 'unsupported_tab' });
    await updateStatus({ ...IDLE_STATUS, phase: 'error', message: site.reason ?? 'This tab cannot be captured.' });
    return;
  }
  try {
    const t0 = monotonicNow();
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    log.child('capture').info('stream_id_obtained', { via: 'shortcut', duration_ms: elapsedMs(t0) });
    await startSession({ type: 'copilot.start', mode: 'live', tabId: tab.id, tabTitle: tab.title ?? null, streamId });
  } catch (err) {
    log.child('capture').error('stream_id_failed', { via: 'shortcut', err });
    await updateStatus({ ...IDLE_STATUS, phase: 'error', message: (err as Error).message });
  }
}

chrome.commands.onCommand.addListener((command, tab) => {
  log.debug('command', { command });
  if (command === 'toggle-listening') void toggleFromShortcut(tab);
  if (command === 'generate-answer') {
    void send({ target: 'offscreen', type: 'offscreen.command', command: { type: 'answer.request', requestId: newId('r'), ts: Date.now() } });
  }
});

// Stop if the captured tab is closed (the capture track also ends; this is a second safety net).
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const status = await getStatus();
  if (status.tabId === tabId && status.mode === 'live' && status.phase !== 'idle') await stopSession('The captured tab was closed.');
});

/** Runs a handler and always answers the sender, reporting failures instead of leaving them unhandled. */
function respond<T>(sendResponse: (r: unknown) => void, op: string, fn: () => Promise<T>): true {
  fn().then(sendResponse, (err: unknown) => {
    log.error('message_handler_failed', { op, err });
    sendResponse({ ok: false, error: (err as Error)?.message ?? String(err) });
  });
  return true;
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  if ('target' in message) return false;
  switch (message.type) {
    case 'copilot.start':
      return respond(sendResponse, 'start', () => startSession(message));
    case 'copilot.stop':
      return respond(sendResponse, 'stop', () => stopSession().then(() => ({ ok: true })));
    case 'copilot.openAssistant':
      return respond(sendResponse, 'open_assistant', () => openAssistant(message.focus).then((r) => ({ ok: true, outcome: r.outcome })));
    case 'copilot.placeAssistant':
      return respond(sendResponse, 'place_assistant', () => getStatus().then((st) => placeAssistant(st.tabId)));
    case 'copilot.status':
      if (message.status.phase === 'error') sessionLog.warn('status_error', { err: message.status.message ?? 'unknown' });
      void updateStatus(message.status);
      return false;
    case 'copilot.history':
      void chrome.storage.session.set({ [STORAGE_KEYS.history]: message.state });
      return false;
    case 'copilot.ended':
      // Only the offscreen document sends this; close it to release the capture completely. During a
      // stop requested here, wait: closing now would cut off its reply to offscreen.stop.
      if (!sender.tab && !stopping) void closeOffscreen();
      return false;
    default:
      return false;
  }
});

// After a browser restart there is no session; clear stale status.
chrome.runtime.onStartup.addListener(() => {
  log.info('browser_startup');
  void updateStatus(IDLE_STATUS);
});
chrome.runtime.onInstalled.addListener(async (details) => {
  log.info('installed', { reason: details.reason });
  if (!(await hasOffscreen())) await updateStatus(IDLE_STATUS);
});

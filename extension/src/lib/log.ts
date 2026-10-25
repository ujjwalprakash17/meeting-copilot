/**
 * Extension-side structured logging (format and privacy rules in @meeting-copilot/shared/log).
 *
 * Where the lines appear:
 *  - service worker ("sw", "session", "assistant-window", "display"): chrome://extensions -> Meeting Copilot -> "service worker"
 *  - offscreen document ("offscreen", "ws", "audio-capture"): chrome://extensions -> "Inspect views: offscreen.html" (while listening)
 *  - assistant window / popup: right-click the page -> Inspect -> Console
 *
 * DEBUG output is off by default; turn it on in Settings -> "Verbose diagnostic logs". Offscreen documents
 * cannot read chrome.storage, so they receive the level from the service worker with the start message.
 */
import { createLogger, type Logger, type LogLevel } from '@meeting-copilot/shared';

const DEBUG_KEY = 'debugLogging';
let level: LogLevel = 'info';

export const extensionLog = createLogger('extension', { level: () => level });

export function setLogLevel(debug: boolean): void {
  level = debug ? 'debug' : 'info';
}

export const isDebugLogging = (): boolean => level === 'debug';

/**
 * Creates the logger for one extension context and reports otherwise-unhandled errors there.
 * @param readSetting false in the offscreen document (no chrome.storage access).
 */
export function initContextLogging(component: string, readSetting = true): Logger {
  const log = extensionLog.child(component);
  if (readSetting && typeof chrome !== 'undefined' && chrome.storage?.local) {
    void chrome.storage.local
      .get(DEBUG_KEY)
      .then((r) => setLogLevel(Boolean(r[DEBUG_KEY])))
      .catch(() => undefined);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[DEBUG_KEY]) setLogLevel(Boolean(changes[DEBUG_KEY].newValue));
    });
  }
  const scope = globalThis as unknown as { addEventListener?: (type: string, fn: (e: unknown) => void) => void };
  scope.addEventListener?.('unhandledrejection', (e) => {
    log.error('unhandled_rejection', { err: (e as { reason?: unknown }).reason });
  });
  scope.addEventListener?.('error', (e) => {
    const ev = e as { error?: unknown; message?: string; filename?: string; lineno?: number };
    log.error('unhandled_error', { err: ev.error ?? ev.message, at: ev.filename ? `${ev.filename.split('/').pop()}:${ev.lineno}` : undefined });
  });
  return log;
}

export async function setDebugLogging(on: boolean): Promise<void> {
  await chrome.storage.local.set({ [DEBUG_KEY]: on });
  setLogLevel(on);
}

export async function getDebugLogging(): Promise<boolean> {
  return Boolean((await chrome.storage.local.get(DEBUG_KEY))[DEBUG_KEY]);
}

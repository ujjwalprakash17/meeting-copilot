/**
 * Offscreen document (reason USER_MEDIA). It exists only while a session runs and has no visible UI.
 * Offscreen documents can only use chrome.runtime, so persistence goes through the service worker.
 */
import type { CopilotState } from '@meeting-copilot/shared';
import { initContextLogging, setLogLevel } from '../lib/log.js';
import type { RuntimeMessage } from '../lib/messages.js';
import { SessionController } from './SessionController.js';

// Offscreen documents cannot read chrome.storage: the log level arrives with the start message.
const log = initContextLogging('offscreen', false);
log.debug('loaded');

let controller: SessionController | null = null;

chrome.runtime.onMessage.addListener((message: RuntimeMessage & { previous?: CopilotState | null; debugLogging?: boolean }, _sender, sendResponse) => {
  if (!('target' in message) || message.target !== 'offscreen') return false;
  switch (message.type) {
    case 'offscreen.start': {
      if (controller && !controller.isStopped) {
        sendResponse({ ok: false, error: 'A session is already running.' });
        return false;
      }
      setLogLevel(Boolean(message.debugLogging));
      const c = new SessionController(message, message.previous ?? null);
      controller = c;
      c.start()
        .then(() => sendResponse({ ok: true }))
        .catch((err: Error) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    case 'offscreen.stop':
      if (!controller) {
        sendResponse({ ok: true });
        return false;
      }
      void controller.stop(message.reason).then(() => sendResponse({ ok: true }));
      return true;
    case 'offscreen.command':
      sendResponse({ ok: controller?.command(message.command) ?? false });
      return false;
    case 'offscreen.getSnapshot':
      sendResponse({ state: controller?.snapshot() ?? null });
      return false;
    case 'offscreen.clearHistory':
      controller?.clearHistory();
      sendResponse({ ok: true });
      return false;
  }
  return false;
});

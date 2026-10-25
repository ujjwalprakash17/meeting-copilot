/** chrome.runtime message contract between extension contexts (popup, assistant, service worker, offscreen). */
import type { ClientEvent, CopilotState, ServerEvent, SessionConfig } from '@meeting-copilot/shared';
import { extensionLog } from './log.js';
import type { SessionStatus } from './settings.js';

const log = extensionLog.child('messaging');

/** UI-originated commands forwarded by the offscreen document to the server. */
export type UiCommand = Extract<ClientEvent, { type: 'answer.request' | 'answer.retry' | 'answer.cancel' | 'answer.displayed' | 'config.update' }>;

export type RuntimeMessage =
  // popup / assistant -> service worker
  | { type: 'copilot.start'; mode: 'live' | 'simulation'; tabId: number | null; tabTitle: string | null; streamId: string | null }
  | { type: 'copilot.stop' }
  | { type: 'copilot.openAssistant'; focus: boolean }
  /** Move the assistant window to a display that does not show the meeting (user action or session start). */
  | { type: 'copilot.placeAssistant' }
  // service worker -> offscreen
  | { target: 'offscreen'; type: 'offscreen.start'; mode: 'live' | 'simulation'; streamId: string | null; serverUrl: string; config: SessionConfig; tabId: number | null; tabTitle: string | null }
  | { target: 'offscreen'; type: 'offscreen.stop'; reason?: string }
  // assistant -> offscreen
  | { target: 'offscreen'; type: 'offscreen.command'; command: UiCommand }
  | { target: 'offscreen'; type: 'offscreen.getSnapshot' }
  | { target: 'offscreen'; type: 'offscreen.clearHistory' }
  // offscreen -> everyone
  | { type: 'copilot.event'; event: ServerEvent }
  | { type: 'copilot.status'; status: SessionStatus }
  | { type: 'copilot.history'; state: CopilotState }
  | { type: 'copilot.ended' };

export interface StartResponse {
  ok: boolean;
  error?: string;
  /** Session started, but something non-essential failed (e.g. the assistant window could not open). */
  warning?: string;
}

export function send<T = unknown>(message: RuntimeMessage): Promise<T | undefined> {
  return chrome.runtime.sendMessage(message).catch((err: Error) => {
    // "Receiving end does not exist" just means no other extension page is open right now.
    if (!/Receiving end does not exist|message port closed/i.test(err.message)) log.warn('send_failed', { type: message.type, err });
    return undefined;
  }) as Promise<T | undefined>;
}

export const newId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

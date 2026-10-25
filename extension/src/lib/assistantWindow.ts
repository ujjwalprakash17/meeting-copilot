/**
 * Opens (or reuses) the extension-owned assistant window.
 *
 * Root cause of "Invalid value for bounds. Bounds must be at least 50% within visible screen space.":
 * the window's last position is remembered (so it can live on a second monitor). If that monitor is
 * later unavailable (asleep, disconnected, or the display layout changed), chrome.windows.create()
 * rejects the remembered position. That error used to abort "Start listening" entirely.
 *
 * Now: a rejected *position* is logged, forgotten, and the window is opened where Chrome places it.
 * Any other failure is thrown to the caller, which reports it without stopping audio capture.
 */
import type { Logger } from '@meeting-copilot/shared';

export interface WindowBounds {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}

export interface StoredWindowInfo {
  id: number;
  bounds?: WindowBounds;
}

export interface CreateWindowOptions {
  url: string;
  type: 'popup';
  width: number;
  height: number;
  left?: number;
  top?: number;
  focused: boolean;
}

export interface AssistantWindowDeps {
  url: string;
  getStored(): Promise<StoredWindowInfo | undefined>;
  setStored(info: StoredWindowInfo): Promise<void>;
  windowExists(id: number): Promise<boolean>;
  focus(id: number): Promise<void>;
  create(opts: CreateWindowOptions): Promise<{ id?: number }>;
  log: Logger;
}

export type OpenOutcome = 'reused' | 'created' | 'created_after_position_reset';

const DEFAULT_SIZE = { width: 440, height: 780 };

/** Chrome's error when a window would be less than 50% on the visible displays. */
export const isOffScreenBoundsError = (err: unknown): boolean => /bounds/i.test(err instanceof Error ? err.message : String(err));

const describe = (b: WindowBounds) => `${b.left ?? '?'},${b.top ?? '?'},${b.width ?? '?'}x${b.height ?? '?'}`;

export async function openAssistantWindow(deps: AssistantWindowDeps, opts: { focus: boolean }): Promise<{ id: number; outcome: OpenOutcome }> {
  const stored = await deps.getStored();
  if (stored?.id !== undefined && (await deps.windowExists(stored.id))) {
    if (opts.focus) await deps.focus(stored.id);
    deps.log.debug('reused', { window_id: stored.id, focus: opts.focus });
    return { id: stored.id, outcome: 'reused' };
  }

  const saved = stored?.bounds ?? {};
  const size = { width: saved.width ?? DEFAULT_SIZE.width, height: saved.height ?? DEFAULT_SIZE.height };
  const hasPosition = saved.left !== undefined && saved.top !== undefined;
  const base: CreateWindowOptions = { url: deps.url, type: 'popup', ...size, focused: opts.focus };

  let outcome: OpenOutcome = 'created';
  let win: { id?: number };
  try {
    win = await deps.create(hasPosition ? { ...base, left: saved.left, top: saved.top } : base);
  } catch (err) {
    if (!hasPosition || !isOffScreenBoundsError(err)) throw err;
    // The remembered position is on a display that is not available now.
    deps.log.warn('saved_position_rejected', { requested: describe({ ...saved, ...size }), err, recovery: 'forget_position_and_retry' });
    await deps.setStored({ id: stored?.id ?? -1, bounds: size });
    win = await deps.create(base);
    outcome = 'created_after_position_reset';
  }
  if (win.id === undefined) throw new Error('Chrome did not return an id for the assistant window.');
  await deps.setStored({ id: win.id, bounds: outcome === 'created' ? saved : size });
  deps.log.info('created', { window_id: win.id, position: outcome === 'created' && hasPosition ? 'saved' : 'chrome_default', outcome, focus: opts.focus });
  return { id: win.id, outcome };
}

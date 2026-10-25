import { describe, expect, it } from 'vitest';
import { createLogger } from '@meeting-copilot/shared';
import { openAssistantWindow, type AssistantWindowDeps, type CreateWindowOptions, type StoredWindowInfo } from './assistantWindow.js';

const CHROME_BOUNDS_ERROR = 'Invalid value for bounds. Bounds must be at least 50% within visible screen space.';

function fakeChrome(opts: { stored?: StoredWindowInfo; existing?: number[]; rejectPositioned?: boolean; failAll?: Error }) {
  let stored = opts.stored;
  const creates: CreateWindowOptions[] = [];
  const logs: string[] = [];
  let nextId = 100;
  const deps: AssistantWindowDeps = {
    url: 'chrome-extension://x/assistant.html',
    getStored: async () => stored,
    setStored: async (info) => {
      stored = info;
    },
    windowExists: async (id) => (opts.existing ?? []).includes(id),
    focus: async () => undefined,
    create: async (o) => {
      creates.push(o);
      if (opts.failAll) throw opts.failAll;
      // Chrome rejects any position that is not on a connected display.
      if (opts.rejectPositioned && o.left !== undefined) throw new Error(CHROME_BOUNDS_ERROR);
      return { id: nextId++ };
    },
    log: createLogger('assistant-window', { sink: (_l, line) => logs.push(line), level: () => 'debug' }),
  };
  return { deps, creates, logs, stored: () => stored };
}

describe('openAssistantWindow', () => {
  it('reproduces the reported case: saved position on an unavailable display -> opens anyway and forgets it', async () => {
    const c = fakeChrome({ stored: { id: 1962940637, bounds: { left: -1189, top: 228, width: 440, height: 780 } }, rejectPositioned: true });
    const result = await openAssistantWindow(c.deps, { focus: false });
    expect(result.outcome).toBe('created_after_position_reset');
    expect(c.creates.map((o) => [o.left, o.top])).toEqual([
      [-1189, 228],
      [undefined, undefined],
    ]);
    expect(c.creates[1]).toMatchObject({ width: 440, height: 780, focused: false });
    // The rejected position is not used again.
    expect(c.stored()).toEqual({ id: result.id, bounds: { width: 440, height: 780 } });
    expect(c.logs.find((l) => l.includes('[WARN] [assistant-window] saved_position_rejected'))).toContain('requested=-1189,228,440x780');
    expect(c.logs.join('\n')).toContain('recovery=forget_position_and_retry');
    expect(c.logs.join('\n')).toContain('outcome=created_after_position_reset');
  });

  it('keeps using a saved position that Chrome accepts (e.g. on a connected second monitor)', async () => {
    const c = fakeChrome({ stored: { id: 5, bounds: { left: -1189, top: 228, width: 440, height: 780 } } });
    const result = await openAssistantWindow(c.deps, { focus: false });
    expect(result.outcome).toBe('created');
    expect(c.creates).toHaveLength(1);
    expect(c.stored()?.bounds).toEqual({ left: -1189, top: 228, width: 440, height: 780 });
  });

  it('reuses an open window without creating another', async () => {
    const c = fakeChrome({ stored: { id: 7, bounds: {} }, existing: [7] });
    expect(await openAssistantWindow(c.deps, { focus: true })).toEqual({ id: 7, outcome: 'reused' });
    expect(c.creates).toHaveLength(0);
  });

  it('does not hide other failures: they are thrown to the caller', async () => {
    const c = fakeChrome({ stored: { id: 1, bounds: { left: 10, top: 10 } }, failAll: new Error('No current window') });
    await expect(openAssistantWindow(c.deps, { focus: false })).rejects.toThrow('No current window');
    expect(c.creates).toHaveLength(1); // no blind retry for unrelated errors
  });

  it('throws if even the default position fails', async () => {
    const c = fakeChrome({ stored: { id: 1, bounds: { left: -99999, top: 0 } }, failAll: new Error(CHROME_BOUNDS_ERROR) });
    await expect(openAssistantWindow(c.deps, { focus: false })).rejects.toThrow('Invalid value for bounds');
    expect(c.creates).toHaveLength(2);
  });
});

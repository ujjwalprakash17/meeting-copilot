import { useEffect, useState } from 'react';
import { send } from '../../lib/messages.js';
import { saveSettings, STORAGE_KEYS, type DisplayPlacementStatus, type ExtensionSettings } from '../../lib/settings.js';

export function placementText(s: DisplayPlacementStatus | null): string | null {
  if (!s) return null;
  switch (s.kind) {
    case 'moved':
      return `Moved to ${s.displayName ?? 'another display'}. Share only the meeting's display, or just the meeting tab or window.`;
    case 'already-separate':
      return `On ${s.displayName ?? 'another display'}, separate from the meeting window.`;
    case 'single-display':
      return 'Only one display was found. An "Entire screen" share will include this window: share the meeting tab or window instead.';
    case 'no-permission':
      return 'Display access was not granted, so the window was not moved.';
    case 'no-window':
      return 'Open the assistant window first.';
    case 'error':
      return `Could not move the window: ${s.message ?? 'unknown error'}`;
  }
}

export function usePlacementStatus(): DisplayPlacementStatus | null {
  const [status, setStatus] = useState<DisplayPlacementStatus | null>(null);
  useEffect(() => {
    void chrome.storage.session.get(STORAGE_KEYS.displayPlacement).then((r) => setStatus((r[STORAGE_KEYS.displayPlacement] as DisplayPlacementStatus | undefined) ?? null));
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && changes[STORAGE_KEYS.displayPlacement]) setStatus((changes[STORAGE_KEYS.displayPlacement]?.newValue as DisplayPlacementStatus) ?? null);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);
  return status;
}

/**
 * Screen-sharing guidance and the "keep on another display" option. The extension cannot see what the
 * meeting's share picker selected and cannot hide a window from an entire-screen capture; this only
 * offers the workflows that keep the assistant outside what you share.
 */
export function SharingCard({ settings }: { settings: ExtensionSettings }) {
  const status = usePlacementStatus();
  const [error, setError] = useState<string | null>(null);

  const toggle = async (on: boolean) => {
    setError(null);
    if (on) {
      // Must run in the click handler: Chrome only shows permission requests for a user gesture.
      const granted = await chrome.permissions.request({ permissions: ['system.display'] });
      if (!granted) return setError('Display access was not granted.');
      await saveSettings({ keepAssistantOnOtherDisplay: true });
      await send({ type: 'copilot.placeAssistant' });
    } else {
      await saveSettings({ keepAssistantOnOtherDisplay: false });
    }
  };

  const moveNow = async () => {
    setError(null);
    if (!(await chrome.permissions.contains({ permissions: ['system.display'] }))) {
      const granted = await chrome.permissions.request({ permissions: ['system.display'] });
      if (!granted) return setError('Display access was not granted.');
    }
    await send({ type: 'copilot.placeAssistant' });
  };

  return (
    <div className="card stack">
      <strong>Screen sharing</strong>
      <p className="hint">
        In the meeting&apos;s share picker, choose the <b>meeting tab</b> or <b>a window</b> (not this one). This window is never part of
        a shared tab. An <b>Entire screen</b> share shows everything on that screen, including this window: Chrome gives extensions no way
        to hide a window from it, and the extension cannot see which option you picked.
      </p>
      <label className="inline">
        <input type="checkbox" checked={settings.keepAssistantOnOtherDisplay} onChange={(e) => void toggle(e.target.checked)} />
        Keep this window on a different display than the meeting (for sharing a whole display)
      </label>
      <div className="row">
        <button className="small" onClick={() => void moveNow()}>
          Move to another display now
        </button>
      </div>
      {placementText(status) && <div className={`banner ${status?.kind === 'single-display' || status?.kind === 'error' ? 'warn' : 'info'}`}>{placementText(status)}</div>}
      {error && <div className="banner error">{error}</div>}
    </div>
  );
}

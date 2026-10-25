import { useEffect, useRef, useState } from 'react';
import { initialCopilotState, reduceServerEvent, type CopilotState } from '@meeting-copilot/shared';
import { send, type RuntimeMessage } from '../lib/messages.js';
import {
  DEFAULT_SETTINGS,
  getHistory,
  getResume,
  getSettings,
  getStatus,
  IDLE_STATUS,
  STORAGE_KEYS,
  type ExtensionSettings,
  type SessionStatus,
  type StoredResume,
} from '../lib/settings.js';

export const isActive = (s: SessionStatus) => s.phase === 'starting' || s.phase === 'live' || s.phase === 'reconnecting' || s.phase === 'stopping';

export function useSessionStatus(): SessionStatus {
  const [status, setStatus] = useState<SessionStatus>(IDLE_STATUS);
  useEffect(() => {
    void getStatus().then(setStatus);
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && changes[STORAGE_KEYS.status]) setStatus((changes[STORAGE_KEYS.status]?.newValue as SessionStatus) ?? IDLE_STATUS);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);
  return status;
}

export function useSettings(): [ExtensionSettings, boolean] {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    void getSettings().then((s) => {
      setSettings(s);
      setLoaded(true);
    });
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes[STORAGE_KEYS.settings]) void getSettings().then(setSettings);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);
  return [settings, loaded];
}

export function useResume(): StoredResume | null {
  const [resume, setResume] = useState<StoredResume | null>(null);
  useEffect(() => {
    void getResume().then(setResume);
    const listener = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes[STORAGE_KEYS.resume]) void getResume().then(setResume);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);
  return resume;
}

/** Current conversation ID (session storage); null until the first session or "New conversation". */
export function useConversationId(): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    void chrome.storage.session.get(STORAGE_KEYS.conversation).then((r) => setId((r[STORAGE_KEYS.conversation] as string | undefined) ?? null));
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && changes[STORAGE_KEYS.conversation]) setId((changes[STORAGE_KEYS.conversation]?.newValue as string | undefined) ?? null);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);
  return id;
}

/**
 * Live copilot state for the assistant window: snapshot from the offscreen document when a session
 * is running (otherwise the session-scoped history), then incremental server events.
 */
export function useCopilotState(status: SessionStatus): [CopilotState, (s: CopilotState) => void] {
  const [state, setState] = useState<CopilotState>(initialCopilotState());
  const active = isActive(status);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const snapshot = active ? await send<{ state: CopilotState | null }>({ target: 'offscreen', type: 'offscreen.getSnapshot' }) : undefined;
      const initial = snapshot?.state ?? (await getHistory());
      if (!cancelled && initial) setState(initial);
    })();
    return () => {
      cancelled = true;
    };
    // Re-sync whenever a session starts or stops.
  }, [active]);

  useEffect(() => {
    const listener = (message: RuntimeMessage) => {
      if (message.type === 'copilot.event') setState((s) => reduceServerEvent(s, message.event));
      else if (message.type === 'copilot.history') setState(message.state);
      return false;
    };
    chrome.runtime.onMessage.addListener(listener);
    const storageListener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      // History cleared while idle.
      if (area === 'session' && changes[STORAGE_KEYS.history] && changes[STORAGE_KEYS.history]?.newValue === undefined && !activeRef.current) {
        setState(initialCopilotState());
      }
    };
    chrome.storage.onChanged.addListener(storageListener);
    return () => {
      chrome.runtime.onMessage.removeListener(listener);
      chrome.storage.onChanged.removeListener(storageListener);
    };
  }, []);

  return [state, setState];
}

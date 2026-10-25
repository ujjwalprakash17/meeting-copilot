import { useEffect, useState } from 'react';
import { elapsedMs, monotonicNow } from '@meeting-copilot/shared';
import { initContextLogging } from '../lib/log.js';
import { send, type StartResponse } from '../lib/messages.js';
import { checkSite, type SiteCheck } from '../lib/sites.js';
import { isActive, useSessionStatus, useSettings } from '../ui/hooks.js';

const log = initContextLogging('popup');

export function Popup() {
  const status = useSessionStatus();
  const [settings, loaded] = useSettings();
  const [tab, setTab] = useState<chrome.tabs.Tab | null>(null);
  const [site, setSite] = useState<SiteCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const openAssistant = async () => {
    setError(null);
    const res = await send<{ ok: boolean; error?: string }>({ type: 'copilot.openAssistant', focus: true });
    if (res && !res.ok) {
      log.error('open_assistant_failed', { err: res.error });
      setError(`Could not open the assistant window: ${res.error ?? 'unknown error'}`);
    }
  };
  const active = isActive(status);

  useEffect(() => {
    // activeTab (granted by opening this popup) exposes the current tab's URL and title.
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => setTab(t ?? null));
  }, []);

  useEffect(() => {
    if (loaded) setSite(checkSite(tab?.url, { allowAnyTab: settings.allowAnyTab, serverUrl: settings.serverUrl }));
  }, [tab, loaded, settings.allowAnyTab, settings.serverUrl]);

  async function start(mode: 'live' | 'simulation') {
    setBusy(true);
    setError(null);
    setWarning(null);
    const t0 = monotonicNow();
    log.info('start_clicked', { mode, platform: site?.platform ?? undefined });
    try {
      let streamId: string | null = null;
      if (mode === 'live') {
        if (!tab?.id || !site?.supported) throw new Error(site?.reason ?? 'This tab cannot be captured.');
        // Requires that the user invoked the extension on this tab (clicking the toolbar icon did that).
        streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
        log.info('stream_id_obtained', { duration_ms: elapsedMs(t0) });
      }
      const res = await send<StartResponse>({
        type: 'copilot.start',
        mode,
        tabId: mode === 'live' ? (tab?.id ?? null) : null,
        tabTitle: mode === 'live' ? (tab?.title ?? null) : 'Simulated transcript',
        streamId,
      });
      if (!res?.ok) throw new Error(res?.error ?? 'Could not start the session.');
      if (res.warning) {
        log.warn('started_with_warning', { warning: res.warning });
        setWarning(res.warning);
      } else log.info('started', { mode, duration_ms: elapsedMs(t0) });
    } catch (err) {
      const message = (err as Error).message;
      log.error('start_failed', { mode, err, duration_ms: elapsedMs(t0) });
      setError(
        /active stream/i.test(message)
          ? 'This tab is already being captured (by this or another extension). Stop that capture first.'
          : /invoked|activeTab|permission/i.test(message)
            ? 'Chrome requires you to click the extension icon on the meeting tab itself before capturing it.'
            : message,
      );
    } finally {
      setBusy(false);
    }
  }

  const stop = async () => {
    log.info('stop_clicked');
    setBusy(true);
    await send({ type: 'copilot.stop' });
    setBusy(false);
  };

  return (
    <div className="popup-body stack">
      <div className="row">
        <h1 className="grow">Meeting Copilot</h1>
        {active ? (
          <span className={`pill ${status.mode === 'simulation' ? 'sim' : 'live'}`}>
            <span className="dot" />
            {status.mode === 'simulation' ? 'SIMULATION' : status.phase === 'reconnecting' ? 'RECONNECTING' : 'LISTENING'}
          </span>
        ) : (
          <span className="pill">Idle</span>
        )}
      </div>

      {active ? (
        <div className="card stack">
          <div>
            {status.mode === 'simulation' ? (
              <>Running a <strong>simulated transcript</strong> (test mode, no audio is captured).</>
            ) : (
              <>
                Capturing audio from: <strong>{status.tabTitle ?? 'meeting tab'}</strong>
                <p className="hint">Capture stays bound to that tab even if you switch tabs or windows.</p>
              </>
            )}
          </div>
          <div className="row">
            <button className="danger grow" onClick={stop} disabled={busy || status.phase === 'stopping'}>
              {status.phase === 'stopping' ? 'Stopping…' : 'Stop listening'}
            </button>
            <button onClick={() => void openAssistant()}>Open assistant</button>
          </div>
        </div>
      ) : (
        <div className="card stack">
          <div>
            <div className="hint">Current tab</div>
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tab?.title ?? '—'}</div>
            {site && (site.supported ? <span className="pill ok">{site.platform}</span> : <p className="hint">{site.reason}</p>)}
          </div>
          <button className="primary" onClick={() => void start('live')} disabled={busy || !site?.supported}>
            {busy ? 'Starting…' : 'Start listening'}
          </button>
          <button onClick={() => void start('simulation')} disabled={busy}>
            Start simulation (test mode)
          </button>
          <button className="link" onClick={() => void openAssistant()}>
            Open assistant window
          </button>
        </div>
      )}

      {(error || (status.phase === 'error' && status.message)) && <div className="banner error">{error ?? status.message}</div>}
      {warning && <div className="banner warn">{warning}</div>}

      <p className="hint">
        Starting shares this tab&apos;s audio with your local server and the speech provider. Inform participants and follow your
        organisation&apos;s recording rules. Suggestions appear in a separate window, never on the meeting page. When presenting,
        share the meeting tab or a window: an &quot;Entire screen&quot; share also shows the assistant window.
      </p>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { newId, send, type UiCommand } from '../lib/messages.js';
import { buildSessionConfig, startNewConversation, STORAGE_KEYS } from '../lib/settings.js';
import { isActive, useConversationId, useCopilotState, useResume, useSessionStatus, useSettings } from '../ui/hooks.js';
import { AnswerCard } from './components/AnswerCard.js';
import { HistoryView } from './components/HistoryView.js';
import { InsightsView } from './components/InsightsView.js';
import { SettingsView } from './components/SettingsView.js';
import { placementText, usePlacementStatus } from './components/SharingCard.js';
import { TranscriptView } from './components/TranscriptView.js';

type Tab = 'live' | 'questions' | 'history' | 'insights' | 'settings';

const command = (c: UiCommand) => send({ target: 'offscreen', type: 'offscreen.command', command: c });

export function App() {
  const status = useSessionStatus();
  const [settings] = useSettings();
  const resume = useResume();
  const [state] = useCopilotState(status);
  const conversationId = useConversationId();
  const placement = usePlacementStatus();
  // One-time reminder about what screen sharing can expose (the extension cannot detect the share choice).
  const [tipDismissed, setTipDismissed] = useState(true);
  useEffect(() => {
    void chrome.storage.local.get(STORAGE_KEYS.sharingTipDismissed).then((r) => setTipDismissed(Boolean(r[STORAGE_KEYS.sharingTipDismissed])));
  }, []);
  const dismissTip = () => {
    setTipDismissed(true);
    void chrome.storage.local.set({ [STORAGE_KEYS.sharingTipDismissed]: true });
  };
  const [tab, setTab] = useState<Tab>('live');
  const [manualQuestion, setManualQuestion] = useState('');
  const active = isActive(status);
  const canAct = status.phase === 'live';

  // Measure when each answer's first text is actually on screen (effects run after the DOM commit),
  // show it on the card and report it to the server's latency tracker. Only live answers are measured.
  const reported = useRef(new Set<string>());
  const [shownMs, setShownMs] = useState<Record<string, number>>({});
  useEffect(() => {
    const now = Date.now();
    const updates: Record<string, number> = {};
    for (const card of state.cards) {
      card.attempts.forEach((a, i) => {
        if (!a.text || reported.current.has(a.requestId)) return;
        reported.current.add(a.requestId);
        if (a.status !== 'generating' || now - a.startedAt > 60_000) return; // restored from history, not live
        updates[a.requestId] = now - (i === 0 ? card.question.textAvailableAt : a.startedAt);
        void command({ type: 'answer.displayed', requestId: a.requestId, displayedAt: now, ts: now });
      });
    }
    if (Object.keys(updates).length) setShownMs((m) => ({ ...m, ...updates }));
  }, [state.cards]);

  // Push settings/resume/conversation changes to a running session.
  const lastConfig = useRef<string | null>(null);
  useEffect(() => {
    const json = JSON.stringify(buildSessionConfig(settings, resume, conversationId));
    if (!canAct) {
      lastConfig.current = null;
      return;
    }
    if (lastConfig.current === null) {
      lastConfig.current = json;
      return;
    }
    if (json !== lastConfig.current) {
      lastConfig.current = json;
      void command({ type: 'config.update', config: buildSessionConfig(settings, resume, conversationId), ts: Date.now() });
    }
  }, [settings, resume, canAct, conversationId]);

  /** New conversation: fresh ID and empty live view; saved conversations stay in History. */
  const newConversation = async () => {
    await startNewConversation();
    if (active) void send({ target: 'offscreen', type: 'offscreen.clearHistory' });
  };

  const answerNow = (questionText?: string) =>
    void command({ type: 'answer.request', requestId: newId('r'), ...(questionText ? { questionText } : {}), ts: Date.now() });
  const retry = (questionId: string) => void command({ type: 'answer.retry', questionId, requestId: newId('r'), ts: Date.now() });
  const cancel = (requestId: string) => void command({ type: 'answer.cancel', requestId, ts: Date.now() });

  const latest = state.cards.at(-1);
  const notice = state.lastNotice;

  return (
    <div className="app">
      <header className="topbar">
        <div className="row">
          <span className="title grow">Meeting Copilot</span>
          {active ? (
            <span className={`pill ${status.mode === 'simulation' ? 'sim' : 'live'}`}>
              <span className="dot" />
              {status.phase === 'reconnecting' ? 'RECONNECTING' : status.phase === 'stopping' ? 'STOPPING' : status.mode === 'simulation' ? 'SIMULATION' : 'LISTENING'}
            </span>
          ) : (
            <span className="pill">Not listening</span>
          )}
          <button className="small" onClick={() => void newConversation()} title="Start a new conversation; saved conversations stay in History">
            New conversation
          </button>
          {active && (
            <button className="danger small" onClick={() => void send({ type: 'copilot.stop' })} disabled={status.phase === 'stopping'}>
              Stop
            </button>
          )}
        </div>
        <div className="hint">
          {active
            ? status.mode === 'simulation'
              ? 'Simulated transcript (test mode). No audio is captured.'
              : `Capturing: ${status.tabTitle ?? 'meeting tab'}`
            : 'Start from the toolbar icon on your Meet/Teams tab (or Alt+Shift+Y).'}
          {state.llmModel && active ? ` · ${state.llmProvider}/${state.llmModel}` : ''}
          {active ? ` · ${settings.answerMode === 'auto' ? 'Auto answers' : 'Manual answers'}` : ''}
          {resume ? ' · Resume loaded' : ''}
        </div>
      </header>

      <nav className="tabs" role="tablist">
        {(['live', 'questions', 'history', 'insights', 'settings'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t === 'live' ? 'Live' : t === 'questions' ? `Questions (${state.cards.length})` : t === 'history' ? 'History' : t === 'insights' ? 'Insights' : 'Settings'}
          </button>
        ))}
      </nav>

      <main className="content">
        {status.phase === 'error' && status.message && <div className="banner error" style={{ marginBottom: 8 }}>{status.message}</div>}
        {status.message && status.phase !== 'error' && <div className="banner warn" style={{ marginBottom: 8 }}>{status.message}</div>}
        {notice && active && (
          <div className={`banner ${notice.fatal ? 'error' : 'warn'}`} style={{ marginBottom: 8 }}>
            {notice.message}
          </div>
        )}

        {tab === 'live' && (
          <div className="live-layout">
            {active && status.mode === 'live' && (!tipDismissed || placement?.kind === 'single-display') && (
              <div className="banner warn">
                Sharing your screen? Pick the <b>meeting tab</b> or <b>a window</b>. &quot;Entire screen&quot; shows this window too
                {placement?.kind === 'single-display' ? ' (only one display found)' : ''}.{' '}
                <button className="link" onClick={() => setTab('settings')}>
                  Options
                </button>
                {!tipDismissed && (
                  <>
                    {' · '}
                    <button className="link" onClick={dismissTip}>
                      Got it
                    </button>
                  </>
                )}
              </div>
            )}
            {active && placement && placement.kind === 'moved' && <div className="hint">{placementText(placement)}</div>}
            <div className="row">
              <input
                type="text"
                className="grow"
                placeholder="Type a question, or leave empty to answer the latest speech"
                value={manualQuestion}
                onChange={(e) => setManualQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canAct) {
                    answerNow(manualQuestion.trim() || undefined);
                    setManualQuestion('');
                  }
                }}
                disabled={!canAct}
              />
              <button
                className="primary"
                disabled={!canAct}
                onClick={() => {
                  answerNow(manualQuestion.trim() || undefined);
                  setManualQuestion('');
                }}
                title="Alt+Shift+U"
              >
                Answer now
              </button>
            </div>
            <div className="answers">
              {latest ? (
                <AnswerCard card={latest} onRetry={retry} onCancel={cancel} canAct={canAct} shownMs={shownMs[latest.attempts.at(-1)?.requestId ?? '']} />
              ) : (
                <div className="card empty">Detected questions and suggested answers will appear here.</div>
              )}
            </div>
            <TranscriptView state={state} keywords={settings.keywords} />
          </div>
        )}

        {tab === 'questions' && (
          <div className="stack">
            {state.cards.length === 0 && <div className="empty">No questions yet.</div>}
            {[...state.cards].reverse().map((card) => (
              <AnswerCard key={card.question.id} card={card} onRetry={retry} onCancel={cancel} canAct={canAct} shownMs={shownMs[card.attempts.at(-1)?.requestId ?? '']} />
            ))}
          </div>
        )}

        {tab === 'history' && <HistoryView serverUrl={settings.serverUrl} currentConversationId={conversationId} onCurrentDeleted={() => void newConversation()} />}

        {tab === 'insights' && <InsightsView state={state} serverUrl={settings.serverUrl} keywords={settings.keywords} />}
        {tab === 'settings' && <SettingsView settings={settings} resume={resume} active={active} />}
      </main>
    </div>
  );
}

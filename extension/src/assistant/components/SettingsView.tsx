import { useEffect, useState } from 'react';
import type { AnswerLength, AnswerMode, AnswerStyle } from '@meeting-copilot/shared';
import { send } from '../../lib/messages.js';
import { fetchServerStatus, type ServerStatus } from '../../lib/serverApi.js';
import { clearAllLocalData, clearHistory, saveSettings, type ExtensionSettings, type StoredResume } from '../../lib/settings.js';
import { getDebugLogging, setDebugLogging } from '../../lib/log.js';
import { ResumeSection } from './ResumeSection.js';
import { SharingCard } from './SharingCard.js';

function ProviderStatus({ serverUrl }: { serverUrl: string }) {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const check = async () => {
    setChecking(true);
    try {
      setStatus(await fetchServerStatus(serverUrl));
      setError(null);
    } catch (err) {
      setStatus(null);
      setError((err as Error).message);
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverUrl]);

  return (
    <div className="card stack">
      <div className="row">
        <strong className="grow">Providers (configured on the server)</strong>
        <button className="small" onClick={() => void check()} disabled={checking}>
          {checking ? 'Checking…' : 'Check'}
        </button>
      </div>
      {error && <div className="banner error">{error}</div>}
      {status && (
        <dl className="kv">
          <dt>Speech-to-text</dt>
          <dd>
            {status.stt.provider} {status.stt.configured ? <span className="pill ok">configured</span> : <span className="pill">DEEPGRAM_API_KEY missing</span>}
          </dd>
          <dt>LLM</dt>
          <dd>
            {status.llm.provider} / {status.llm.model}{' '}
            {status.llm.simulated ? (
              <span className="pill sim">mock (test mode)</span>
            ) : !status.llm.configured ? (
              <span className="pill">GROQ_API_KEY missing</span>
            ) : status.llm.verified === false ? (
              <span className="pill">problem</span>
            ) : status.llm.verified ? (
              <span className="pill ok">verified</span>
            ) : (
              <span className="pill">configured</span>
            )}
            <div className="hint">{status.llm.message}</div>
          </dd>
          <dt>Ambiguity check</dt>
          <dd>{status.detectionModel ?? 'off (heuristics only)'}</dd>
        </dl>
      )}
      <p className="hint">API keys live only in the server&apos;s .env file and are never sent to the extension.</p>
    </div>
  );
}

export function SettingsView({ settings, resume, active }: { settings: ExtensionSettings; resume: StoredResume | null; active: boolean }) {
  const [serverUrl, setServerUrl] = useState(settings.serverUrl);
  const [keywords, setKeywords] = useState(settings.keywords.join(', '));
  const [background, setBackground] = useState(settings.background);
  const [notes, setNotes] = useState(settings.notes);
  const [cleared, setCleared] = useState<string | null>(null);

  useEffect(() => {
    setServerUrl(settings.serverUrl);
    setKeywords(settings.keywords.join(', '));
    setBackground(settings.background);
    setNotes(settings.notes);
  }, [settings.serverUrl, settings.keywords, settings.background, settings.notes]);

  const save = (patch: Partial<ExtensionSettings>) => void saveSettings(patch);
  const flash = (msg: string) => {
    setCleared(msg);
    setTimeout(() => setCleared(null), 2000);
  };

  return (
    <div className="stack">
      <div className="card">
        <strong>Answers</strong>
        <label>Answer mode</label>
        <select value={settings.answerMode} onChange={(e) => save({ answerMode: e.target.value as AnswerMode })}>
          <option value="auto">Automatic: suggest when a question is detected</option>
          <option value="manual">Manual: only when I press “Answer now” or the shortcut</option>
        </select>
        <div className="row">
          <div className="grow">
            <label>Style</label>
            <select value={settings.answerStyle} onChange={(e) => save({ answerStyle: e.target.value as AnswerStyle })}>
              <option value="concise">Concise</option>
              <option value="detailed">Detailed</option>
              <option value="technical">Technical</option>
              <option value="step-by-step">Step-by-step</option>
            </select>
          </div>
          <div className="grow">
            <label>Length</label>
            <select value={settings.answerLength} onChange={(e) => save({ answerLength: e.target.value as AnswerLength })}>
              <option value="short">Short</option>
              <option value="medium">Medium</option>
              <option value="long">Long</option>
            </select>
          </div>
        </div>
        <label>Transcript context per answer (segments)</label>
        <input
          type="number"
          min={0}
          max={60}
          value={settings.contextSegments}
          onChange={(e) => save({ contextSegments: Math.max(0, Math.min(60, Number(e.target.value) || 0)) })}
        />
        <p className="hint">How many recent finalized transcript lines are sent with each question.</p>
        <p className="hint">
          Keyboard shortcuts (Start/stop: Alt+Shift+Y, Answer now: Alt+Shift+U) can be changed or removed at{' '}
          <button className="link" onClick={() => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })}>
            chrome://extensions/shortcuts
          </button>
          .
        </p>
      </div>

      <ResumeSection settings={settings} resume={resume} />

      <div className="card">
        <strong>Personal notes</strong>
        <label>Professional background (optional)</label>
        <textarea
          value={background}
          onChange={(e) => setBackground(e.target.value)}
          onBlur={() => save({ background })}
          placeholder="Facts about you not in your resume, e.g. current role details. Treated like resume content."
        />
        <label>Project notes / knowledge (optional)</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => save({ notes })}
          placeholder="Notes about the project or topic of the meeting. Only matching parts are sent per question."
        />
        <label>Keywords to highlight</label>
        <input
          type="text"
          value={keywords}
          onChange={(e) => setKeywords(e.target.value)}
          onBlur={() => save({ keywords: keywords.split(',').map((k) => k.trim()).filter(Boolean) })}
          placeholder="Kafka, SLA, migration"
        />
        <p className="hint">Also passed to Deepgram as recognition hints (Nova-3). Stored only in this browser.</p>
      </div>

      <SharingCard settings={settings} />

      <ProviderStatus serverUrl={settings.serverUrl} />

      <div className="card">
        <strong>Connection & capture</strong>
        <label>Local server URL</label>
        <input type="url" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} onBlur={() => save({ serverUrl: serverUrl.trim() || 'http://localhost:8787' })} disabled={active} />
        <label className="inline">
          <input type="checkbox" checked={settings.openAssistantOnStart} onChange={(e) => save({ openAssistantOnStart: e.target.checked })} />
          Open this window automatically when listening starts (opens unfocused)
        </label>
        <label className="inline">
          <input type="checkbox" checked={settings.diarize} onChange={(e) => save({ diarize: e.target.checked })} disabled={active} />
          Show estimated speaker labels (Speaker 1, 2, …) from Deepgram diarization. Tab audio is one mixed stream, so labels are
          estimates: in a two-voice test about 9 in 10 words were right, with most errors just after a speaker change. Adds roughly
          0.1–0.2 s to final transcripts.
        </label>
        <label className="inline">
          <input type="checkbox" checked={settings.allowAnyTab} onChange={(e) => save({ allowAnyTab: e.target.checked })} />
          Allow capture on any tab (testing only)
        </label>
        <label>Transcription language</label>
        <input type="text" value={settings.language} onChange={(e) => save({ language: e.target.value.trim() || 'en' })} disabled={active} />
      </div>

      <div className="card stack">
        <strong>Privacy & data</strong>
        <p className="hint">
          Tab audio is streamed to your local server and on to Deepgram for transcription; it is never stored. Question text, recent
          transcript lines, matching resume/notes excerpts and your answer preferences are sent to Groq to draft answers. Review Deepgram&apos;s
          and Groq&apos;s current privacy and data-retention terms before use, and tell meeting participants that you are transcribing.
        </p>
        <div className="row">
          <button
            onClick={() => {
              void clearHistory();
              if (active) void send({ target: 'offscreen', type: 'offscreen.clearHistory' });
              flash('Transcript and answer history cleared.');
            }}
          >
            Clear transcript & history
          </button>
          <button
            onClick={() => {
              if (!confirm('Remove all settings, notes, resume text and history stored by Meeting Copilot in this browser?')) return;
              void clearAllLocalData();
              if (active) void send({ target: 'offscreen', type: 'offscreen.clearHistory' });
              flash('All local data removed.');
            }}
          >
            Clear all local data
          </button>
        </div>
        {cleared && <div className="banner info">{cleared}</div>}
        <DiagnosticsToggle />
      </div>
    </div>
  );
}

/** DEBUG-level diagnostic logs in the extension consoles (never secrets, audio or transcript text). */
function DiagnosticsToggle() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    void getDebugLogging().then(setOn);
  }, []);
  return (
    <label className="inline">
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => {
          setOn(e.target.checked);
          void setDebugLogging(e.target.checked);
        }}
      />
      Verbose diagnostic logs (DEBUG) in the extension consoles. Takes effect for the service worker and this window now, and for
      audio/connection logs from the next listening session. Logs never include API keys, audio, or transcript and answer text.
    </label>
  );
}

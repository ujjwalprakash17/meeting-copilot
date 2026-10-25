import { useState } from 'react';
import { findKeywordHits, type CopilotState } from '@meeting-copilot/shared';
import { generateInsight } from '../../lib/serverApi.js';

type Kind = 'summary' | 'action_items';

export function InsightsView({ state, serverUrl, keywords }: { state: CopilotState; serverUrl: string; keywords: string[] }) {
  const [results, setResults] = useState<Partial<Record<Kind, { text: string; simulated: boolean }>>>({});
  const [busy, setBusy] = useState<Kind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const transcript = state.segments.map((s) => s.text).join('\n');

  const run = async (kind: Kind) => {
    setBusy(kind);
    setError(null);
    try {
      const res = await generateInsight(serverUrl, kind, transcript);
      setResults((r) => ({ ...r, [kind]: { text: res.text, simulated: res.simulated } }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const keywordCounts = new Map<string, number>();
  for (const s of state.segments) for (const h of findKeywordHits(s.text, keywords)) keywordCounts.set(h.keyword, (keywordCounts.get(h.keyword) ?? 0) + 1);

  return (
    <div className="stack">
      <div className="card stack">
        <div className="row">
          <button onClick={() => void run('summary')} disabled={!transcript || busy !== null}>
            {busy === 'summary' ? 'Summarizing…' : 'Summarize meeting'}
          </button>
          <button onClick={() => void run('action_items')} disabled={!transcript || busy !== null}>
            {busy === 'action_items' ? 'Extracting…' : 'Extract action items'}
          </button>
        </div>
        <p className="hint">
          Sends the finalized transcript ({state.segments.length} segments) to Groq on demand. Runs separately from live transcription.
        </p>
        {error && <div className="banner error">{error}</div>}
      </div>
      {(['summary', 'action_items'] as const).map((k) =>
        results[k] ? (
          <div className="card" key={k}>
            <div className="row">
              <div className="section-title grow" style={{ margin: 0 }}>
                {k === 'summary' ? 'Summary' : 'Action items'}
              </div>
              {results[k]?.simulated && <span className="pill sim">TEST OUTPUT (mock LLM)</span>}
            </div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{results[k]?.text}</div>
          </div>
        ) : null,
      )}
      <div className="card">
        <div className="section-title" style={{ marginTop: 0 }}>
          Keyword mentions
        </div>
        {keywords.length === 0 ? (
          <p className="hint">Add keywords in Settings to track mentions.</p>
        ) : (
          <dl className="kv">
            {keywords.map((k) => (
              <div key={k} style={{ display: 'contents' }}>
                <dt>{k}</dt>
                <dd>{keywordCounts.get(k) ?? 0}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  );
}

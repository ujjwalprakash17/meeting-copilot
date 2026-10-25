import { useEffect, useRef, type ReactNode } from 'react';
import { findKeywordHits, type CopilotState } from '@meeting-copilot/shared';

const fmt = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function highlight(text: string, keywords: string[]): ReactNode {
  const hits = findKeywordHits(text, keywords);
  if (!hits.length) return text;
  const out: ReactNode[] = [];
  let pos = 0;
  hits.forEach((h, i) => {
    if (h.index < pos) return;
    out.push(text.slice(pos, h.index), <mark key={i}>{text.slice(h.index, h.index + h.length)}</mark>);
    pos = h.index + h.length;
  });
  out.push(text.slice(pos));
  return out;
}

export function TranscriptView({ state, keywords }: { state: CopilotState; keywords: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [state.segments.length, state.partial?.text]);

  return (
    <div
      className="card transcript"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      <div className="row" style={{ marginBottom: 4 }}>
        <span className="section-title" style={{ margin: 0 }}>
          Transcript
        </span>
        {state.sttSimulated && <span className="pill sim">SIMULATED, not real audio</span>}
        {state.segments.some((s) => s.speaker !== undefined) && (
          <span className="hint">Speaker labels are estimates from mixed tab audio and are least reliable right after someone starts talking.</span>
        )}
      </div>
      {state.segments.length === 0 && !state.partial && <div className="empty">Transcript will appear here once speech is detected.</div>}
      {state.segments.map((s) => (
        <div className="segment" key={s.id}>
          <span className="ts">{fmt(s.startMs)}</span>
          {s.speaker !== undefined && (
            <span className="spk" title="Estimated by the transcription provider from mixed tab audio; not an identification of a person.">
              Speaker {s.speaker + 1}
            </span>
          )}
          {highlight(s.text, keywords)}
        </div>
      ))}
      {state.partial && (
        <div className="segment partial" title="Provisional: may still change">
          <span className="ts">{fmt(state.partial.startMs)}</span>
          {state.partial.text}…
        </div>
      )}
    </div>
  );
}

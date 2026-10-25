import { useCallback, useEffect, useState } from 'react';
import type { CardRecord, ConversationDetailResponse, ConversationSummary } from '@meeting-copilot/shared';
import { deleteAllConversations, deleteConversation, getConversation, listConversations, renameConversation } from '../../lib/serverApi.js';

interface Props {
  serverUrl: string;
  currentConversationId: string | null;
  /** Called after the conversation currently being recorded was deleted (a new one should start). */
  onCurrentDeleted: () => void;
}

const fmtDate = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const titleOf = (c: ConversationSummary) => c.title ?? (c.firstQuestion ? c.firstQuestion.slice(0, 70) : 'Untitled conversation');

function SavedCard({ card }: { card: CardRecord }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={`card answer ${card.status === 'failed' ? 'failed' : ''}`}>
      <div className="row" style={{ marginBottom: 4 }}>
        <span className="pill">{card.source === 'manual' ? 'Manual' : 'Detected'}</span>
        {card.groundingSections.length > 0 && <span className="pill resume">Based on your resume: {card.groundingSections.join(', ')}</span>}
        {card.groundingEvidence === 'none' && <span className="pill">Not found in resume</span>}
        {card.groundingEvidence === 'no_resume' && <span className="pill">No resume uploaded</span>}
        {card.simulated && <span className="pill sim">TEST OUTPUT</span>}
        {card.status !== 'completed' && <span className="pill">{card.status === 'pending' ? 'Not answered' : card.status}</span>}
      </div>
      <div className="question">{card.question}</div>
      {card.answer ? <div className="text">{card.answer}</div> : <div className="hint">No answer was saved.</div>}
      <div className="meta">
        {[fmtDate(card.createdAt), card.model, card.firstTokenMs != null ? `first text ${card.firstTokenMs} ms` : null].filter(Boolean).join(' · ')}
      </div>
      {card.answer && (
        <button
          className="small"
          style={{ marginTop: 6 }}
          onClick={() =>
            void navigator.clipboard.writeText(card.answer ?? '').then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            })
          }
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      )}
    </div>
  );
}

export function HistoryView({ serverUrl, currentConversationId, onCurrentDeleted }: Props) {
  const [list, setList] = useState<ConversationSummary[] | null>(null);
  const [dbPath, setDbPath] = useState<string | null>(null);
  const [open, setOpen] = useState<ConversationDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const res = await listConversations(serverUrl);
      setList(res.conversations);
      setDbPath(res.dbPath);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [serverUrl]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openConversation = async (id: string) => {
    setBusy(true);
    try {
      const res = await getConversation(serverUrl, id);
      setOpen(res);
      setTitle(res.conversation.title ?? '');
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this conversation and all of its saved questions and answers?')) return;
    setBusy(true);
    try {
      await deleteConversation(serverUrl, id);
      if (id === currentConversationId) onCurrentDeleted();
      setOpen(null);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const removeAll = async () => {
    if (!confirm('Delete ALL saved conversations? This cannot be undone.')) return;
    setBusy(true);
    try {
      await deleteAllConversations(serverUrl);
      onCurrentDeleted();
      setOpen(null);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const saveTitle = async () => {
    if (!open) return;
    try {
      await renameConversation(serverUrl, open.conversation.id, title.trim() || null);
      setOpen({ ...open, conversation: { ...open.conversation, title: title.trim() || null } });
      void refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (open) {
    const c = open.conversation;
    return (
      <div className="stack">
        <div className="row">
          <button className="small" onClick={() => setOpen(null)}>
            ← All conversations
          </button>
          <span className="grow" />
          <button className="small" onClick={() => void remove(c.id)} disabled={busy}>
            Delete conversation
          </button>
        </div>
        {error && <div className="banner error">{error}</div>}
        <div className="card">
          <label style={{ marginTop: 0 }}>Title</label>
          <div className="row">
            <input type="text" className="grow" value={title} maxLength={120} placeholder={titleOf(c)} onChange={(e) => setTitle(e.target.value)} />
            <button className="small" onClick={() => void saveTitle()} disabled={(c.title ?? '') === title.trim()}>
              Save
            </button>
          </div>
          <p className="hint">
            Started {fmtDate(c.startedAt)} · {c.cardCount} question{c.cardCount === 1 ? '' : 's'}
            {c.id === currentConversationId ? ' · current conversation' : ''}
            {c.simulated ? ' · simulated session' : ''}
          </p>
        </div>
        {open.cards.length === 0 && <div className="empty">No saved questions in this conversation.</div>}
        {open.cards.map((card) => (
          <SavedCard key={card.id} card={card} />
        ))}
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="row">
        <strong className="grow">Saved conversations</strong>
        <button className="small" onClick={() => void refresh()} disabled={busy}>
          {busy ? 'Loading…' : 'Refresh'}
        </button>
        <button className="small" onClick={() => void removeAll()} disabled={busy || !list?.length}>
          Delete all
        </button>
      </div>
      {error && <div className="banner error">{error}</div>}
      {list && list.length === 0 && <div className="card empty">No saved conversations yet. Questions and answers are saved automatically while you listen.</div>}
      {list?.map((c) => (
        <button key={c.id} className="card history-item" onClick={() => void openConversation(c.id)} disabled={busy}>
          <div className="row">
            <strong className="grow">{titleOf(c)}</strong>
            {c.id === currentConversationId && <span className="pill live">Current</span>}
            {c.simulated && <span className="pill sim">SIM</span>}
          </div>
          <div className="hint">
            {fmtDate(c.updatedAt)} · {c.cardCount} question{c.cardCount === 1 ? '' : 's'}
          </div>
        </button>
      ))}
      <p className="hint">
        Saved on the machine running the local server{dbPath ? ` (${dbPath})` : ''}: questions, suggested answers and small metadata only.
        No audio, transcripts or resume text. Deleting here removes the records from that database; it does not undo what was already
        sent to Deepgram or Groq.
      </p>
    </div>
  );
}

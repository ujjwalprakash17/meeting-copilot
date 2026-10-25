import { useState } from 'react';
import type { AnswerAttempt, QuestionCard } from '@meeting-copilot/shared';

interface Props {
  card: QuestionCard;
  onRetry: (questionId: string) => void;
  onCancel: (requestId: string) => void;
  canAct: boolean;
  /** Measured in this window: first answer text on screen, ms after the complete question text was available. */
  shownMs?: number;
}

function GroundingBadge({ attempt }: { attempt: AnswerAttempt }) {
  const g = attempt.grounding;
  if (!g || g.kind === 'general') return null;
  if (g.evidence === 'strong' || g.evidence === 'weak') {
    return (
      <span className="pill resume" title="Only the matching excerpts (not the whole resume) were sent to the AI provider.">
        Based on your resume{g.sections.length ? `: ${g.sections.join(', ')}` : ''}
        {g.evidence === 'weak' ? ' (partial match)' : ''}
      </span>
    );
  }
  return <span className="pill">{g.evidence === 'no_resume' ? 'No resume uploaded' : 'Not found in resume'}</span>;
}

function describeContext(a: AnswerAttempt): string | null {
  if (!a.context) return null;
  if (a.context.promptChars === 0) return 'Nothing was sent to the AI provider for this answer.';
  const parts = ['question'];
  if (a.context.transcriptSegments) parts.push(`${a.context.transcriptSegments} transcript segments`);
  if (a.grounding?.excerptCount) parts.push(`${a.grounding.excerptCount} resume excerpt${a.grounding.excerptCount > 1 ? 's' : ''}`);
  if (a.context.includesNotes) parts.push('matching notes');
  if (a.context.includesPreviousQa) parts.push('previous answer');
  return `Sent to ${a.simulated ? 'mock LLM' : 'Groq'}: ${parts.join(', ')}.`;
}

export function AnswerCard({ card, onRetry, onCancel, canAct, shownMs }: Props) {
  const [copied, setCopied] = useState(false);
  const attempt = card.attempts.at(-1);
  const insufficient = attempt?.model?.includes('no LLM call');
  const cls = ['card', 'answer', attempt?.status ?? '', insufficient ? 'insufficient' : ''].join(' ');

  const copy = async () => {
    if (!attempt?.text) return;
    await navigator.clipboard.writeText(attempt.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className={cls}>
      <div className="row" style={{ marginBottom: 4 }}>
        <span className="pill">{card.question.source === 'manual' ? 'Manual' : `Detected · ${Math.round(card.question.confidence * 100)}%`}</span>
        {card.question.isFollowUp && <span className="pill">Follow-up</span>}
        {card.question.speculative && (
          <span className="pill tentative" title="Started from the live (interim) transcript. Confirmed or discarded when the final transcript arrives.">
            Tentative · confirming
          </span>
        )}
        {attempt && <GroundingBadge attempt={attempt} />}
        {attempt?.simulated && <span className="pill sim">TEST OUTPUT (mock LLM)</span>}
      </div>
      <div className="question">{card.question.text}</div>

      {!attempt && <div className="hint">Manual mode: press “Answer now” (or the shortcut) to generate a suggestion.</div>}
      {attempt && (
        <>
          {attempt.text && <div className="text">{attempt.text}</div>}
          {attempt.status === 'generating' && !attempt.text && <div className="hint">Generating suggestion…</div>}
          {attempt.status === 'failed' && <div className="banner error">{attempt.errorMessage ?? 'Generation failed.'}</div>}
          {attempt.status === 'cancelled' && <div className="hint">{attempt.errorMessage ?? 'Cancelled.'}</div>}
          <div className="meta">
            {[
              shownMs != null ? `on screen ${shownMs} ms after the question` : null,
              attempt.status === 'completed' && attempt.firstTokenMs != null ? `first token ${attempt.firstTokenMs} ms after dispatch` : null,
              attempt.status === 'completed' && attempt.durationMs != null ? `total ${(attempt.durationMs / 1000).toFixed(1)} s` : null,
              attempt.model,
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
          {describeContext(attempt) && <div className="meta">{describeContext(attempt)}</div>}
        </>
      )}

      <div className="row" style={{ marginTop: 6 }}>
        {attempt?.text && (
          <button className="small" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
        {attempt?.status === 'generating' ? (
          <button className="small" onClick={() => onCancel(attempt.requestId)} disabled={!canAct}>
            Cancel
          </button>
        ) : (
          <button className="small" onClick={() => onRetry(card.question.id)} disabled={!canAct} title={canAct ? '' : 'Start a session to generate answers'}>
            {attempt ? 'Retry' : 'Answer'}
          </button>
        )}
        <span className="hint">Draft for you to review, not spoken automatically.</span>
      </div>
    </div>
  );
}

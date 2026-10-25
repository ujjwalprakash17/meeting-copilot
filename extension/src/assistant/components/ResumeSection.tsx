import { useRef, useState } from 'react';
import { removeResume, saveResume, setRememberResume, type ExtensionSettings, type StoredResume } from '../../lib/settings.js';
import { extractResume, RESUME_ACCEPT, validateResumeFile } from '../../lib/serverApi.js';

type UploadState = { phase: 'idle' } | { phase: 'uploading'; fileName: string } | { phase: 'error'; message: string };

export function ResumeSection({ settings, resume }: { settings: ExtensionSettings; resume: StoredResume | null }) {
  const input = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<UploadState>({ phase: 'idle' });
  const [preview, setPreview] = useState(false);

  async function onFile(file: File | undefined) {
    if (!file) return;
    const invalid = validateResumeFile(file);
    if (invalid) return setUpload({ phase: 'error', message: invalid });
    setUpload({ phase: 'uploading', fileName: file.name });
    try {
      const result = await extractResume(settings.serverUrl, file);
      await saveResume({ ...result, uploadedAt: Date.now() }, settings.rememberResume);
      setUpload({ phase: 'idle' });
    } catch (err) {
      setUpload({ phase: 'error', message: (err as Error).message });
    } finally {
      if (input.current) input.current.value = '';
    }
  }

  return (
    <div className="card stack">
      <div className="row">
        <strong className="grow">Resume / personal knowledge</strong>
        <input ref={input} type="file" accept={RESUME_ACCEPT} hidden onChange={(e) => void onFile(e.target.files?.[0])} />
        <button className="primary small" onClick={() => input.current?.click()} disabled={upload.phase === 'uploading'}>
          {upload.phase === 'uploading' ? 'Processing…' : resume ? 'Replace resume' : 'Upload resume'}
        </button>
        {resume && (
          <button className="small" onClick={() => void removeResume()} disabled={upload.phase === 'uploading'}>
            Remove
          </button>
        )}
      </div>

      {upload.phase === 'uploading' && <div className="banner info">Extracting text from {upload.fileName}…</div>}
      {upload.phase === 'error' && <div className="banner error">{upload.message}</div>}

      {resume ? (
        <>
          <dl className="kv">
            <dt>File</dt>
            <dd>{resume.fileName}</dd>
            <dt>Status</dt>
            <dd>
              <span className="pill ok">Ready</span> {resume.chars.toLocaleString()} characters extracted ({resume.kind.toUpperCase()})
            </dd>
            <dt>Sections</dt>
            <dd>{resume.sections.length ? resume.sections.join(', ') : 'No headings detected (treated as one section)'}</dd>
          </dl>
          {resume.warnings.map((w) => (
            <div className="banner warn" key={w}>
              {w}
            </div>
          ))}
          <label className="inline">
            <input type="checkbox" checked={settings.rememberResume} onChange={(e) => void setRememberResume(e.target.checked)} />
            Remember resume on this device (otherwise it is cleared when Chrome closes)
          </label>
          <button className="link" onClick={() => setPreview(!preview)}>
            {preview ? 'Hide extracted text' : 'Review extracted text'}
          </button>
          {preview && (
            <textarea readOnly value={resume.text} style={{ minHeight: 160, fontSize: 12 }} aria-label="Extracted resume text" />
          )}
        </>
      ) : (
        <p className="hint">
          Upload a PDF, DOCX or TXT resume (max 5 MB). Scanned/image-only PDFs and password-protected files are not supported.
        </p>
      )}
      <p className="hint">
        Your local server extracts the text in memory and discards the file. Only the extracted text is kept, in this browser
        {settings.rememberResume ? ' (saved on this device)' : ' (memory only, this browser session)'}. For questions about your background, only the few
        matching excerpts (contact details removed) are sent to Groq; the full resume is never sent. Answers about your history use only
        what the resume states.
      </p>
    </div>
  );
}

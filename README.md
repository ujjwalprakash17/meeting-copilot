# Meeting Copilot

A learning project that shows how browser tab-audio capture, streaming speech recognition, WebSockets and LLM inference fit together. It is a Chrome extension (Manifest V3) plus a small local Node server. You start it explicitly on a Google Meet or Microsoft Teams (web) tab. It then:

- transcribes the meeting audio in real time (Deepgram streaming STT),
- detects questions, including ones split across segments and indirect ones,
- streams suggested answers from **Groq**, grounded in your uploaded **resume** when a question is about your own background.

Suggestions are drafts for you to review. Nothing is spoken or typed into the meeting.

> **Consent and rules.** Transcribing a meeting sends other people's voices to third-party services. Tell participants, get consent where the law or your organisation requires it, and follow your employer's and the platform's recording policies. The extension shows a visible indicator while capturing and never hides or suppresses any platform recording or sharing indicator.

---

## Contents

1. [Architecture](#architecture)
2. [Prerequisites](#prerequisites)
3. [Install and run](#install-and-run)
4. [Environment variables](#environment-variables)
5. [Load the extension](#load-the-extension)
6. [Using it](#using-it)
7. [Resume and personal knowledge](#resume-and-personal-knowledge)
8. [Question and request detection](#question-and-request-detection)
9. [How Groq is used](#how-groq-is-used)
10. [Latency](#latency)
11. [Conversation history (SQLite)](#conversation-history-sqlite)
12. [Transcription and speaker labels](#transcription-and-speaker-labels)
13. [Screen sharing: what others can see](#screen-sharing-what-others-can-see)
14. [Testing](#testing)
15. [Known limitations](#known-limitations)
16. [Privacy and security](#privacy-and-security)
17. [Troubleshooting](#troubleshooting)

---

## Architecture

```
meeting-copilot/
  shared/      Typed event contract (zod), session-state reducer, text helpers, history record types
  server/      Express + ws: STT, question detection, resume retrieval, Groq answers, insights, SQLite history
    bench/     latency.ts (mock, repeatable), network.ts (real network, no key), groq.ts (real Groq, opt-in)
  extension/   MV3 extension: popup, assistant window, service worker, offscreen audio pipeline
  docs/latency Saved benchmark results (baseline vs. after)
  .env.example
```

### Data flow

```
Meet/Teams tab audio
  │  chrome.tabCapture.getMediaStreamId (requires the user to click the extension on that tab)
  ▼
Offscreen document (extension-owned, invisible)
  getUserMedia(tab stream) ─► AudioWorklet (512-sample mono batches) ─► windowed-sinc resampler 48/44.1 kHz → 16 kHz
  ─► PCM16 ─► 40 ms frames ─► WebSocket binary frames                     (captured audio is also played back to you)
  ▼
Local server (127.0.0.1:8787)
  Session ─► Deepgram live STT (linear16 @16 kHz) ─► transcript.partial / transcript.final
          ├► interim text already a clear, complete question? ─► TENTATIVE answer starts now (speculative)
          ─► QuestionDetector (finals: utterance assembly, "?" fast path, debounce, dedupe, turn boundaries)
               ─► heuristics: question / instruction / polite request / fragment / scenario / follow-up, or ignore
               ─► ambiguous only: small Groq classifier with recent context
               ─► confirms the tentative answer (question.updated) or retracts it and answers the final question
          ─► intent (general / personal / mixed) ─► resume retrieval (only matching excerpts, in memory)
          ─► Groq chat completions (stream, warm keep-alive connection) ─► answer.start / answer.delta / answer.completed
          └► (after events are sent) ConversationRecorder ─► in-memory queue ─► batched SQLite write
  ▼
Offscreen document (authoritative state via the shared reducer) ─► chrome.runtime messages
  ▼
Assistant window (extension page in its own popup window): live view, questions, saved history, insights, settings
```

Each stage is its own module behind an interface:

| Concern | Module |
| --- | --- |
| Audio capture and resampling | `extension/src/audio/*`, `extension/src/offscreen/capture-worklet.ts` |
| Transport (WS, reconnect) | `extension/src/offscreen/ServerConnection.ts`, `server/src/app.ts` |
| Speech-to-text (provider interface) | `server/src/transcription/{types,deepgram,simulated}.ts` |
| Question detection | `server/src/detection/{scoring,QuestionDetector,classifier,intent}.ts` |
| Resume extraction and retrieval | `server/src/resume/{extract,sections,retrieval}.ts` |
| Speculative answers | `server/src/detection/speculation.ts`, `server/src/session/Session.ts` |
| LLM (provider interface) | `server/src/llm/{types,groq,mock}.ts` |
| Answer generation | `server/src/answers/{promptBuilder,AnswerService}.ts` |
| Latency instrumentation | `server/src/latency/{LatencyTracker,TextAvailability}.ts` |
| History (repository interface + SQLite) | `server/src/history/*` |
| UI | `extension/src/assistant/*`, `extension/src/popup/*` |

### Event contract (`shared/src/events.ts`)

All JSON messages are validated with zod on receipt; binary frames are audio.

| Direction | Events |
| --- | --- |
| client → server | `audio.start` (sessionId, mode `live`/`simulation`, audio format, config incl. optional `conversationId`), **binary `audio.chunk`** (PCM16LE mono 16 kHz), `audio.stop`, `answer.request`, `answer.retry`, `answer.cancel`, `answer.displayed` (UI render time, for latency metrics), `config.update` |
| server → client | `session.ready`, `session.status`, `session.error`, `session.ended`, `transcript.partial`, `transcript.final`, `question.detected` (with `textAvailableAt` and `speculative`), `question.updated` (`confirmed` / `retracted`), `answer.start` (includes `context` + `grounding`), `answer.delta`, `answer.completed` (first-token and total timings), `answer.error` (code, retryable), `answer.cancelled` (`superseded` / `user` / `session_ended` / `speculation_rejected`) |

The transcript is sent once, as incremental segments. It is never re-sent as a whole. Buffers are bounded on both sides: 500 segments and 50 question cards.

---

## Prerequisites

- Node.js 22.13+ (developed with Node 24.19) and npm. The history database uses Node's built-in `node:sqlite`, so there is no native add-on to compile.
- Google Chrome 116 or newer (needed for the tab capture + offscreen document flow).
- A **Deepgram** API key for live transcription ([console.deepgram.com](https://console.deepgram.com)).
- A **Groq** API key for answers ([console.groq.com](https://console.groq.com/keys)).

Without keys you can still run **Simulation mode**: a clearly labelled scripted transcript, with `LLM_PROVIDER=mock` for labelled placeholder answers.

---

## Install and run

```bash
cd meeting-copilot
npm install

# Server configuration (keys stay on the server, never in the extension)
cp .env.example server/.env          # Windows PowerShell: Copy-Item .env.example server/.env
# edit server/.env: set DEEPGRAM_API_KEY and GROQ_API_KEY

# Start the local server (auto-reload)
npm run dev:server
# ...or production build:
npm run build -w server && npm start

# Build the extension (outputs extension/dist)
npm run build -w extension
# ...or rebuild on change:
npm run dev:extension
```

At startup the server logs whether Deepgram and Groq are configured. If a Groq key is present, it calls Groq's `/models` endpoint to confirm that `GROQ_MODEL` and `GROQ_DETECTION_MODEL` are currently offered.

All checks: `npm run check` (typecheck, lint, tests, builds, manifest validation, and a smoke test of the built server).

Benchmarks:

```bash
npm run bench:latency -w server -- --label after --reps 10   # mock LLM + simulated STT timing; no network
npm run bench:network -w server                              # real network: Groq connection reuse, Deepgram handshake (no key needed)
npm run bench:groq -w server -- --runs 8                     # REAL Groq time-to-first-token per model; needs GROQ_API_KEY (opt-in)
npm run bench:stt -w server -- --label mine                  # REAL Deepgram: WER, speaker attribution, transcript lag (opt-in)
npm run bench:e2e -w server -- --label mine                  # REAL Deepgram + Groq through the whole server pipeline (opt-in)
npm run bench:detection -w server                            # question/request detection: misses, false positives, time per utterance; no network
npm run bench:detection -w server -- --classifier            # also the REAL Groq classifier on the deferred utterances (opt-in)
# bench:stt / bench:e2e need the synthetic audio first: powershell -File server/bench/make-sample-audio.ps1
```

---

## Environment variables

See `.env.example` for the full list with comments. Put them in `server/.env` (the repo-root `.env` is also read).

| Variable | Purpose | Default |
| --- | --- | --- |
| `DEEPGRAM_API_KEY` | Deepgram streaming STT key (required for live mode) | none |
| `DEEPGRAM_MODEL` | Deepgram model | `nova-3` |
| `DEEPGRAM_ENDPOINTING_MS`, `DEEPGRAM_UTTERANCE_END_MS` | End-of-speech tuning | `300`, `1000` |
| `LLM_PROVIDER` | `groq` or `mock` (labelled offline test output) | `groq` |
| `GROQ_API_KEY` | Groq key (required for real answers) | none |
| `GROQ_MODEL` | Answer model; must be in [Groq's current model list](https://console.groq.com/docs/models) | `openai/gpt-oss-120b` |
| `GROQ_DETECTION_MODEL` | Small model used only to confirm *ambiguous* question candidates; empty disables it | `openai/gpt-oss-20b` |
| `GROQ_REASONING_EFFORT` | `reasoning_effort` for reasoning models (gpt-oss defaults to `low`) | empty |
| `LLM_TIMEOUT_MS`, `LLM_MAX_ANSWER_TOKENS` | Answer deadline and upper size cap (each answer is also capped by its length: 220/400/700 tokens) | `30000`, `700` |
| `QUESTION_DEBOUNCE_MS`, `QUESTION_DEDUPE_WINDOW_MS` | Detection timing | `1200`, `120000` |
| `SPECULATIVE_ANSWERS`, `SPECULATION_MIN_SCORE` | Tentative answers from interim transcripts ([Latency](#latency)) | `true`, `2` |
| `CLASSIFIER_TIMEOUT_MS` | Deadline for the ambiguous-question classifier | `1500` |
| `CONTINUATION_WINDOW_MS` | Merge a short follow-on fragment into a question still being answered | `2000` |
| `HISTORY_ENABLED`, `HISTORY_DB_PATH` | Conversation history database ([details](#conversation-history-sqlite)) | `true`, `server/data/history.sqlite` |
| `HOST`, `PORT` | Bind address | `127.0.0.1`, `8787` |
| `ALLOWED_EXTENSION_IDS` | Restrict connections to your extension ID(s) | empty = any extension origin |
| `LOG_LEVEL`, `LOG_TRANSCRIPTS` | Logging; transcripts are not logged unless enabled | `info`, `false` |
| `SIMULATION_SPEED` | Speed of the scripted transcript | `1` |

Model choice: Groq retired `llama-3.3-70b-versatile` and `llama-3.1-8b-instant` for free and developer accounts on 2026-08-16 ([deprecations](https://console.groq.com/docs/deprecations)) and recommends `openai/gpt-oss-120b` and `openai/gpt-oss-20b` instead, so those are now the defaults. They are reasoning models: the server sends `reasoning_effort: low` without streaming the reasoning, and adds 512 tokens of headroom to `max_completion_tokens` (reasoning tokens count against it), so the answer-length caps and the 60-token classifier budget still apply to the visible output. The server warns at startup if a configured model is unavailable.

`npm run check:keys -w server` checks both keys against the live APIs through the server's own provider code: the Groq key and model list (printing the models your key can use if one is missing), a streamed answer, a classifier call, and a Deepgram streaming connection. Run `npm run bench:groq` to compare time to first token and answer quality before changing `GROQ_MODEL`.

---

## Load the extension

1. Run `npm run build -w extension`.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, choose `meeting-copilot/extension/dist`.
3. Optional: copy the extension ID shown there into `ALLOWED_EXTENSION_IDS` in `server/.env` and restart the server.
4. Pin the extension so its toolbar icon stays visible. The icon is grey when not listening, soft blue while listening (live or simulation), and shows a small **ERR** badge after an error.

   To change the icons, edit the colours in `extension/scripts/generate-icons.mjs` and run `npm run icons -w extension`, or replace the PNGs in `extension/public/icons/` directly, keeping the same file names:
   - `icon*.png` — the extensions page and store icon
   - `idle*.png` — toolbar, not listening
   - `active*.png` — toolbar, listening

   Then run `npm run build -w extension` and click reload on the extension in `chrome://extensions`.

Permissions requested: `tabCapture`, `offscreen`, `storage` and `activeTab`. There are no host permissions and **no content scripts**. The extension never injects anything into Meet or Teams pages, and `npm run validate:manifest` fails if a content script is ever added.

---

## Using it

### Start and stop

1. Open your Meet or Teams meeting tab, or the [local audio test page](#local-audio-test-page).
2. Click the Meeting Copilot toolbar icon **on that tab** and press **Start listening**. Chrome only allows capturing a tab the user has invoked the extension on.
   - Shortcut: **Alt+Shift+Y** toggles listening on the current tab.
3. The assistant window opens unfocused (keyboard focus stays in the meeting). The toolbar icon turns from grey to blue.
4. **Stop**: use the popup, the assistant's Stop button, or Alt+Shift+Y. Stopping stops the media tracks, closes the AudioContext and WebSocket, flushes the transcriber and closes the offscreen document. Closing the captured tab also stops the session.

Capture is bound to the tab you started on, not "whatever tab is active". Switching tabs or windows does not change or stop the capture.

### Answer modes

- **Automatic** (default): an answer streams as soon as a question is detected. When the live (interim) transcript already contains a clear, complete question, the answer starts immediately and is labelled **Tentative · confirming**. The label disappears when the final transcript confirms the question. If the final transcript differs, the tentative card is discarded and the final question is answered instead.
- **Manual**: questions are listed. Press **Answer now** or **Alt+Shift+U** to answer the latest speech, or type a question and press Enter. Manual mode never starts tentative answers.

Each answer card shows:

- the detected question and its status (generating / completed / failed / cancelled),
- **Copy**, **Retry** and **Cancel** actions,
- timings: when the first text appeared on screen relative to the question text ("on screen 16 ms after the question"), and the provider's first-token and total time,
- exactly what was sent ("Sent to Groq: question, 12 transcript segments, 2 resume excerpts"),
- a badge when the answer is based on your resume.

Styles: concise, detailed, technical, step-by-step. Lengths: short, medium, long.

### Conversations

Questions and answers are saved automatically under the **current conversation**. See [Conversation history](#conversation-history-sqlite) for details.

- **New conversation** (top of the assistant window) starts a fresh conversation and empties the live view. Earlier conversations stay saved.
- **History** lists saved conversations newest first. Open one to read its cards, rename it, or delete it. **Delete all** asks for confirmation first.
- A new browser session also starts a new conversation.

### Keyboard shortcuts

Registered through `chrome.commands`:

- **Alt+Shift+Y**: start or stop listening.
- **Alt+Shift+U**: answer now.

They were picked to avoid Meet's (Ctrl+D, Ctrl+E, …) and Teams' (mostly Ctrl+Shift+…) shortcuts, but they have not been checked against every keyboard layout or platform shortcut. Change or remove them at `chrome://extensions/shortcuts`.

### Insights

The **Insights** tab offers **Summarize meeting** and **Extract action items** on demand. These go over HTTP, separate from the live WebSocket, so they never block transcription. It also shows keyword mention counts. Keywords are highlighted in the transcript and passed to Deepgram as keyterm hints on Nova-3.

### Simulation mode (no credentials needed)

Press **Start simulation (test mode)** in the popup. The server replays a scripted interview covering an audio-check filler, a question split across two segments, an imperative "walk me through…", a follow-up, a resume question, a duplicated STT final and a tag question. Everything is labelled **SIMULATED** or **TEST OUTPUT** and never presented as live transcription. With `LLM_PROVIDER=mock` the answers are labelled placeholders; with a Groq key they are real Groq answers to the scripted questions.

### Local audio test page

With the server running, open <http://localhost:8787/test/>, pick a recording of someone asking questions, start listening on that tab and play it. This tests real tab capture and Deepgram without joining a meeting. Requires `DEEPGRAM_API_KEY`.

### Testing with Google Meet

1. Start a meeting at meet.google.com, ideally with a second device or account that can speak and that you can watch.
2. Click the extension on the Meet tab, then **Start listening**.
3. From the second device, ask "Can you explain the difference between a process and a thread?" and "Tell me about a project where you handled a large transaction volume."
4. Expected: the transcript updates (partial lines in italics, then finalized), the question is detected after the speaker pauses, and an answer streams. You keep hearing the meeting.
5. Your own microphone is not in the tab's audio output, so your own speech is generally not transcribed. That is expected.

### Testing with Microsoft Teams (browser)

Join from Chrome at teams.microsoft.com, teams.live.com or teams.cloud.microsoft (the desktop Teams app cannot be captured). Then follow the same steps as Meet.

---

## Resume and personal knowledge

**Upload:** Assistant window → **Settings** → **Upload resume**. Accepted formats are PDF, DOCX and TXT, up to 5 MB.

1. The extension sends the file to **your local server**. The server checks the real type from magic bytes, extracts the text in memory (pdf.js via `unpdf`, `mammoth` for DOCX) and discards the file.
2. You'll see the file name, character count, detected sections (Experience, Projects, Skills, …) and any warnings. **Review extracted text** shows what was read.
3. Clear errors are shown for unsupported types, legacy `.doc` or password-protected Word files, password-protected PDFs, damaged files, and scanned or image-only PDFs (OCR is not supported).
4. **Replace** or **Remove** at any time.

**Storage:** only the extracted text is kept. By default it lives in `chrome.storage.session`, which is memory-only and cleared when Chrome closes. It is saved to `chrome.storage.local` only if you tick **Remember resume on this device**. During a session the local server holds it in memory.

**How answers use it:**

1. Each detected question is classified as **general**, **personal** (about your background) or **mixed**.
2. For personal and mixed questions, the resume (plus your optional "Professional background" notes) is split into section-labelled chunks. These are ranked with keyword BM25, light stemming, a small synonym table and section boosts.
3. Only the top three or fewer matching excerpts, with contact details redacted, go to Groq. The full resume is never sent.
4. The system prompt allows personal facts (employers, titles, dates, metrics, education, achievements) **only from those excerpts**, tells the model to keep numbers exactly as written, to keep general explanations separate, and to end with a "From your resume:" line listing the facts used.
5. If a personal question has **no matching evidence**, or no resume is loaded, **no LLM call is made**. You get: *"I couldn't find enough information about this in your resume. Add the relevant project or experience details…"*
6. The card shows **Based on your resume: Experience, Projects**, **partial match**, **Not found in resume** or **No resume uploaded**. Section names are shown, but excerpt contents are not displayed.

Retrieval sits behind a `Retriever` interface (`server/src/resume/retrieval.ts`), so embedding-based semantic search can replace it later. Embeddings are **not** implemented.

---

## Question and request detection

Interviewers often ask for an answer without asking a grammatical question: "Give the name of your dog." The detector recognizes what the speaker wants, not just question marks and question words.

| Form | Examples | Result |
| --- | --- | --- |
| Direct question | "What is your role?", "why did you leave your last job" (no "?") | Answered |
| Instruction | "Give the name of your dog.", "List the steps you would take…", "Briefly introduce yourself.", "On a scale of one to ten, rate your SQL." | Answered |
| Polite or indirect request | "Could you walk me through…", "I'd like you to explain…", "It would help to hear…", "Let's discuss your experience with…", "Feel free to share…" | Answered |
| Fragment | "Your biggest weakness?", "And the reason for choosing that architecture?", "What about scalability?" | Answered when it ends in "?". Without "?" ("Your biggest weakness."), the classifier decides. |
| Scenario | "Suppose we have a million records. How would you handle them?" | Answered as one question, scenario included. A scenario with no question ("Assume the cache is unavailable.") goes to the classifier. |
| Follow-up | "Can you elaborate?", "Give me another example.", "Why did you do that?" | Answered with the previous question and answer in the prompt |
| Statements and everything else | "I gave the name of my dog yesterday.", "Let me explain what happened.", "Thanks for explaining that.", "Tell me about it later.", "So what does that tell us? It tells us…", cut-off fragments ("Tell me about the") | Ignored, with no classifier call |
| Meeting logistics | "Can you see my screen?", "Is my microphone working?", "Are we starting now?", "What time is the next meeting?", "How much time do we have left?" | Ignored, unless addressed to you ("When could you start?" is answered) |
| Addressed to someone else | "Rahul, do you want to add anything?" | **Answered: known limitation**. The detector doesn't know your name or the other participants'. |

**How it works**

1. **Local heuristics** (`server/src/detection/scoring.ts`) score every finished utterance in about 7 µs. Each sentence is checked for:
   - a request verb in the base form at the start, after fillers such as "Okay, first, briefly…";
   - indirect phrasings, question word order, fragments and scenarios;
   - negative signals: the speaker narrating or offering to explain, logistics, small talk, rhetorical tags, deferrals, abandoned questions and incomplete endings.

   Every point has a reason, and the reasons are logged.
2. **The classifier** sees only the utterances the heuristics cannot decide (see [How Groq is used](#how-groq-is-used)). It also gets the last few transcript lines and the previous question, so it can interpret "that" or "What about…". It is never called for interim text or for every sentence.
3. **Answer:** clear requests answer exactly as before, including tentative answers started from the interim transcript and confirmed by the final one. The original wording is answered, since the prompt already includes the recent transcript. No rewording step is added.

**Transcript boundaries**

- A request is complete whether or not the recognizer punctuated it.
- A different speaker after a complete request (punctuated, or followed by a pause of at least 250 ms) ends that speaker's turn. A label change inside continuous speech does not.
- After a bare scenario, the detector waits up to 2 s for the question before evaluating the scenario alone. During testing, Deepgram ended the utterance right after the scenario sentence. Complete requests are not delayed by this.
- Deepgram sometimes finalizes text without marking the end of speech (`speech_final`) and sends UtteranceEnd about a second later. If that final already ends with a complete, punctuated request, the request is evaluated after 400 ms. If interim results show the speaker is still talking, it keeps waiting.
- A short clarification right after a request ("…that system. Especially the caching layer.") stays part of the question, so the answer sees it.
- Re-emitted finals, replays after a reconnect and repeated questions are answered once.

**Measured accuracy.** Scored at the utterance level with `npm run bench:detection -w server`. "Missed" means a request got no answer. "Answered by mistake" means a statement got one. Both counts are after the classifier.

| Set | Original detector | New detector |
| --- | --- | --- |
| Final held-out set: 120 utterances written by a separate agent, scored once before any tuning on it | 15/60 missed, 12/50 statements answered | 7/60 missed, 4/50 statements answered |
| Held-out set E: 160 utterances in separate categories, scored in aggregate only and never inspected (before → after the latest fixes) | n/a | requests 67/70 → 67/70 answered; statements 4/45 → 4/45; logistics 8/20 → 5/20; addressed to others 12/15 → 12/15 |
| Independent sets used during development (440 utterances) | 64/235 missed, 28/175 answered by the heuristics alone | 0 missed, 2 answered by the heuristics. Tuned on these, so not an independent measure. |
| Real Deepgram on synthesized speech (24 spoken lines: your examples and statements) | 13 of 16 requests ignored | 16/16 requests answered or classified, 0/8 statements answered |

These sets are written text and synthetic speech, not recordings of real meetings. Accuracy on live meeting audio hasn't been measured. To measure it, follow the [real-meeting test plan](docs/testing/real-meeting-detection-test.md) and record the results in its [results sheet](docs/testing/results-template.csv).

The classifier is measured with `npm run bench:detection -w server -- --classifier [--compare-legacy]`. This is opt-in, and it sends only the benchmark sentences to Groq.
- On the same 22 deferred utterances, the first version of the new prompt was correct on 16, the old prompt on 11.
- The final prompt was correct on 24 of 31 deferred utterances across all sets, with a median latency of about 550 ms. Its remaining errors are mostly statements that end in "?".

**Try it.** Start listening (or Simulation mode) and turn on **Settings → Verbose diagnostic logs**, or set `LOG_LEVEL=debug` on the server. Have someone say "Give the name of your dog." (an answer should appear) and then "I gave the name of my dog yesterday." (nothing should appear). The server terminal shows `[session] utterance_evaluated … decision=accepted intent=imperative_request` and then `decision=rejected`.

---

## How Groq is used

Groq does the LLM work only. Transcription is a separate provider (Deepgram); Groq is not used for speech-to-text here.

1. **Detection** uses local heuristics only, with no LLM call:
   - Interim results are scored as they arrive. A clear, complete question (terminal punctuation, at least 4 words, not ambiguous) starts a **tentative** answer right away.
   - Finalized segments are joined into an utterance until the STT signals end of speech. A strong question ending in "?" is evaluated immediately. Otherwise evaluation waits 1.2 s with no new final while partials are inactive.
   - The final utterance then confirms or retracts the tentative answer.
2. **Ambiguous candidates only** (a fragment without "?" such as "Your biggest weakness", a bare scenario, "Let's talk about deployment."): if `GROQ_DETECTION_MODEL` is set, one short JSON-mode classification runs on the small model. It gets the utterance, up to 600 characters of the preceding transcript and the previous question, and returns whether an answer is expected, the form of the request and whether it depends on context. It has a 1.5 s timeout (`CLASSIFIER_TIMEOUT_MS`) and at most one in flight. Clear questions and requests never trigger it. See [Question and request detection](#question-and-request-detection).
3. **Dedupe:** duplicate STT finals are dropped. Near-identical questions within 2 minutes are answered once. One answer per question unless you press Retry. A newer question **supersedes** (aborts) an in-flight answer.
4. **Answer:** `groq.chat.completions.create({ model: GROQ_MODEL, stream: true, max_completion_tokens, messages })`. Messages carry:
   - a short system prompt (about 1.1k characters),
   - up to 8 recent finalized transcript lines (at most 2,500 characters, excluding the question's own segments),
   - the previous Q&A for follow-ups,
   - matching resume and notes excerpts,
   - the question, style and length.

   The token cap depends on the length setting (220, 400 or 700). For `openai/gpt-oss-*` models, `reasoning_effort: low` is sent and reasoning is not streamed. Text deltas are forwarded as `answer.delta` events the moment they arrive.
   - **Connection reuse:** requests go through a keep-alive pool (60 s idle timeout), and the server warms the connection at session start and when an utterance starts like a question. The warm-up is a throttled `GET /models` that carries no meeting content. See [Latency](#latency) for the measured effect.
5. **Errors:**
   - 401/403 → "Groq rejected the API key" (not retryable).
   - 429 → rate limited, with the `retry-after` hint.
   - 404 → model not found.
   - Timeouts: a first-token deadline (15 s) and an overall deadline (`LLM_TIMEOUT_MS`).
   - Network and 5xx errors → retryable.

   All of these appear on the card with a Retry button. The SDK retries once at most, because a suggestion that arrives 20 s late isn't useful.

The key exists only in `server/.env`. The extension bundle contains no provider URLs or keys, and `validate:manifest` checks for them.

---

## Latency

**Goal (not a guarantee):** first useful answer text on screen within about 1–2 s after the question's text is available in the transcript. What this project controls (detection, dispatch, transport, rendering) is now a few milliseconds. The rest depends on external services and the network:

- Deepgram's processing and endpointing,
- the network round trip to Groq,
- Groq's time to first token for the chosen model, plus queueing and rate limits.

### Milestones

Every answer is traced (timestamps only, never text) in `server/src/latency/LatencyTracker.ts`. The reference point is `textAvailableAt`: when the transcript, interim or final, first contained the complete question text.

| Milestone | Measures |
| --- | --- |
| dispatch | `textAvailableAt` → request sent to Groq |
| ttft | dispatch → first token from Groq |
| first text | `textAvailableAt` → first token leaves the server |
| displayed | `textAvailableAt` → first text rendered in the assistant window (reported by the UI via `answer.displayed`) |
| complete | `textAvailableAt` → answer finished |

`GET /api/metrics/latency` returns p50/p95 for real-provider and simulated answers separately, plus history write timings.

### What changed, and why

1. **Tentative answers from interim transcripts.** Previously the answer waited for the final transcript, which arrives after Deepgram's endpointing silence (300 ms) or, without `speech_final`, after UtteranceEnd (about 1 s). Now a clear, complete question in an interim result starts the request immediately.
   - The UI labels it **Tentative** until the final transcript confirms it.
   - If the final text differs (added or changed words), the request is aborted, its card is removed, late tokens are ignored, and the final question is answered.
   - It never starts while another confirmed answer is still streaming.
   - At most 2 tentative attempts per utterance.
2. **"?" fast path:** a final segment ending in a strong question is evaluated without waiting for UtteranceEnd.
3. **Connection keep-alive and warm-up for Groq.** This was measured, see below.
4. **Smaller audio frames:** 40 ms frames instead of 100 ms, and 512-sample worklet batches instead of 2048. Worst-case buffering before audio leaves the browser drops from about 143 ms to about 51 ms. This is computed from the frame sizes, not measured.
5. **Smaller prompts:**
   - system prompt 1,584 → 1,120 characters,
   - transcript context 20 segments / 6,000 characters → 8 segments / 2,500 characters,
   - the question's own segments are no longer duplicated,
   - token caps per answer length.
6. **The classifier stays off the common path.** It only runs for ambiguous candidates and now has a 1.5 s deadline instead of 4 s.
7. **No I/O before dispatch:** retrieval and prompt building are in-memory. History writes are queued *after* events are sent and flushed in batches.

### Measurements

All numbers are in ms, relative to `textAvailableAt`, given as p50 / p95.

**A. Repeatable mock benchmark** (`npm run bench:latency`; files `docs/latency/{baseline,after}-mock.json`).

- Simulated STT timing model: one interim per word (220 ms), the final 300 ms after the last word, UtteranceEnd at 1,000 ms.
- **Mock LLM with 0 ms time to first token**, so these numbers are this project's pipeline plus the modeled STT waits only.
- 5 scenarios × 10 questions on concurrent sessions.

| Scenario | Dispatch, before | Dispatch, after | First text, before | First text, after | Confirmed, after |
| --- | --- | --- | --- | --- | --- |
| endpointed (interim, then final at +300 ms) | 304 / 321 | 1 / 2 | 305 / 322 | 2 / 3 | 309 / 315 |
| no speech_final (UtteranceEnd at +1 s) | 1010 / 1016 | 1 / 10 | 1011 / 1017 | 1 / 13 | 1012 / 1088 |
| final only (no complete interim) | 1 / 2 | 1 / 3 | 2 / 3 | 2 / 3 | 2 / 3 |
| split across two finals | 303 / 317 | 1 / 2 | 304 / 317 | 1 / 2 | 309 / 316 |
| revised (final adds words) | 1 / 32 | 1 / 8 | 2 / 35 | 2 / 9 | 2 / 9 |
| **all 50 questions** | 303 / 1015 | 1 / 3 | **303 / 1015** | **2 / 4** | — |

Notes on the table:
- All 50 questions were accepted in both runs, with no false positives.
- Cost of speculation: the "revised" scenario used 20 LLM requests instead of 10, and the 10 tentative ones were retracted. In real speech the retraction rate depends on how often Deepgram's interim text ends a question that the speaker then continues. That rate has not been measured.
- Completion times vary from run to run with the mock's token pacing and Windows timer resolution. They aren't a meaningful comparison here.

**B. Real Chrome UI path** (`docs/latency/{baseline,after}-chrome-ui.json`).

- Chrome for Testing 156, headless, extension loaded unpacked, simulation mode + mock LLM.
- n = 10 (2 runs of the 5-question script), so p95 is close to the maximum.
- "Rendered" is the moment answer text appeared in the assistant window's DOM.

| | First delta received by the UI | First text rendered | Confirmed |
| --- | --- | --- | --- |
| before | 322 / 355 | 325 / 371 | — |
| after | 12 / 46 | **16 / 60** | 313 / 340 |

The server → offscreen → assistant relay and React render add roughly 3–15 ms. The largest sample was the first question of a session.

**C. Real network, no API key** (`npm run bench:network`, `docs/latency/network-real.txt`). These are HTTPS requests from the development machine to `api.groq.com` returning 401 with an invalid key, so this is connection and round-trip cost only, not model latency. Two runs:

| Request | Node default pool | Keep-alive agent |
| --- | --- | --- |
| cold (new connection) | 500, 559 | 512, 450 |
| repeat (reused connection) | 288–457 | 296–328 |
| after 6 s idle | 489, 529 (reconnected) | 323, 308 (reused) |
| after 30 s idle | 673, 413 (reconnected) | 334, 300 (reused) |

Node's default pool drops idle sockets after about 4 s, so questions more than a few seconds apart paid about 100–350 ms for a new TLS connection. The keep-alive agent avoids that. The warm-up covers the first question of a session.

The Deepgram WebSocket handshake took 915–1,185 ms. That cost is paid once per session at start, not per question.

**D. Real providers, end to end** (`npm run bench:e2e`, `docs/latency/e2e-real-*.json`).
- The synthetic two-voice interview (62 s) was streamed into the server pipeline exactly as the extension does: `audio.start` live, then 40 ms PCM frames in real time.
- Real Deepgram `nova-3` with diarization on, real Groq `openai/gpt-oss-120b`.
- Each run has 4 questions, so p95 is close to the maximum.
- "First text" is measured from when the complete question text first appeared in the transcript to when the first answer token reached the client. It excludes Chrome's tab capture and the UI hop, which table B puts at about 3–15 ms.

| Run | First text p50 / p95 | Our dispatch p50 / p95 | Groq time to first token p50 / p95 |
| --- | --- | --- | --- |
| before the speaker/transcript fixes | 364 / 580 ms | 5 / 19 ms | 359 / 557 ms |
| after (run 1) | 573 / 584 ms | 4 / 21 ms | 562 / 574 ms |
| after (run 2) | 388 / 563 ms | 6 / 17 ms | 382 / 561 ms |

Nearly all of the time is Groq's time to first token, which varied by about 200 ms between runs. This project's part (dispatch) stayed at single-digit milliseconds, so the fixes caused no regression. Deepgram itself delivered the final transcript about 100–300 ms after each line ended (section above). So from the end of a spoken question to the first answer text is typically about 0.4–0.9 s here, within the 1–2 s goal for this machine and network. Live meetings add tab-capture buffering (up to about 50 ms) and real-world network variation.

After a live session, `/api/metrics/latency` (`real.displayed`) shows your own numbers.

### Not changed

- **Deepgram stays the transcriber.** No alternative was measured, so there's no evidence to justify switching.
- **Audio never goes to Groq.**
- **Answers are not cached.** Every question is personalized (resume, transcript), and no measured benefit justified caching.

---

## Conversation history (SQLite)

**Where it lives:** a single SQLite file on the machine running the server, by default `server/data/history.sqlite` (with `-wal` and `-shm` side files). Set `HISTORY_DB_PATH` to move it.
- It's excluded from version control (`.gitignore`).
- The History tab shows the full path.
- The database uses Node's built-in `node:sqlite` with no separate database service, so it adds no network hop.
- **Back up:** stop the server and copy the `.sqlite` file.
- **Remove:** stop the server and delete the `.sqlite`, `-wal` and `-shm` files, or use **History → Delete all**.

**What is stored:** one row per conversation (ID, optional title, start and last-update time, simulated flag) and one row per question card.

A card holds:
- question text and source (auto/manual),
- status (pending, completed, failed, cancelled),
- answer text, model and simulated flag,
- resume *section names* used (e.g. "Experience"),
- first-token and duration timings,
- an error code.

**What is never stored:**
- audio,
- transcripts,
- resume files or resume text or excerpts,
- prompts,
- API keys or headers.

Tentative answers that were retracted are not stored. Answers to background questions may contain facts from your resume, because they are the answers you saw. The privacy tests scan the database file to confirm that resume-only content, the file name and audio bytes are absent.

**Schema and migrations:** `server/src/history/migrations.ts`, versioned with SQLite's `PRAGMA user_version`.
- Each migration runs in a transaction with the version bump.
- A database from a newer server version is refused with a clear error, not modified.
- To change the schema, append a migration. Released ones are never edited.
- Tables use `STRICT` typing, a foreign key from cards to conversations with `ON DELETE CASCADE`, and indexes on `conversations(updated_at)` and `cards(conversation_id, created_at)`.

**How writes stay off the answer path:**
1. The `ConversationRecorder` watches events *after* they were sent to the UI and pushes upserts onto an in-memory queue.
2. The `HistoryWriter` flushes the queue debounced (400 ms, at most 2 s) in **one transaction**. Measured flush time is reported at `/api/metrics/latency`.
3. Cards are written when a question is accepted and when its answer completes, fails or is cancelled. Never once per token.

Duplicates and races are handled as follows:
- Repeated writes of a card are collapsed, keyed by card ID.
- An older version can never overwrite a newer one (`updated_at` guard).
- A card cannot move to another conversation.
- Deleting a conversation, or everything, first drops its queued writes and tombstones its ID, so a late write from a live session cannot bring it back.

If a write fails, it is retried once. Then the UI shows "Conversation history could not be saved … Live answers are unaffected." If the database can't be opened at startup (for example a corrupt file or a newer schema), history is disabled with that reason and the copilot keeps working.

**Deletion scope:**
- **Delete conversation** removes that conversation and its cards in one transaction.
- **Delete all** removes every conversation and card. It requires a confirmation dialog, and the API requires `X-Confirm-Delete-All: yes`.
- `secure_delete` is on and the WAL is checkpointed after deletions, so deleted text is overwritten in the database file instead of lingering in free pages or the `-wal` file.
- Deleting history does **not** delete:
  - your saved resume (Settings → Remove),
  - browser-side settings and notes (Settings → Clear all local data),
  - copies of the database file you made yourself,
  - data already sent to Deepgram or Groq, which is governed by their retention policies.
- Server logs never contain question or answer text unless you set `LOG_TRANSCRIPTS=true`.

**API:** all routes keep the same extension-origin restriction as the rest of `/api`. IDs must be UUIDs and bodies are validated with zod. All SQL uses bound parameters.

| Method | Path | Does |
| --- | --- | --- |
| `GET` | `/api/history?limit=&before=` | List conversations, newest first |
| `GET` | `/api/history/:id` | Get one conversation with its cards |
| `PATCH` | `/api/history/:id` | Rename: `{ "title": "…" }` (`null` clears) |
| `DELETE` | `/api/history/:id` | Delete one conversation |
| `DELETE` | `/api/history` + `X-Confirm-Delete-All: yes` | Delete everything |

The persistence layer is the `HistoryRepository` interface in `server/src/history/types.ts`. A hosted backend such as Supabase could implement it without changing the session pipeline or the extension. None is added, and nothing syncs to the cloud.

---

## Transcription and speaker labels

**What the audio is:** tab capture gives **one mixed stream** of everything the meeting tab plays (all remote participants, never your microphone).
- It is downmixed to mono, resampled with a windowed-sinc filter to 16 kHz PCM, and streamed in 40 ms frames to Deepgram `nova-3` (`interim_results`, `endpointing=300`, `utterance_end_ms=1000`).
- There are no per-participant tracks, so who said what can only be **estimated**.

**Speaker labels** (Settings → *Show estimated speaker labels*, off by default):
- They use Deepgram streaming diarization (`diarize_model=latest`, which currently resolves to Deepgram's "v1" diarizer; the older `diarize=true` is deprecated).
- For live streams Deepgram returns only a per-word `speaker` number, with no confidence score.
- The UI shows neutral labels (Speaker 1, Speaker 2, …) only when the provider actually returned one. It never shows names; nothing maps voices to people.

What changed (and why):

| Problem found | Fix |
| --- | --- |
| Each final transcript got its **majority** speaker, so words from a second speaker inside the same result were mislabelled | Results are split into one segment per run of words with the same provider label. Unlabelled words stay unlabelled. |
| After a Deepgram reconnect, speaker numbers restart at 0, so "Speaker 1" could silently become a different person | Labels are tracked per connection (`SpeakerRegistry`): new connections get new numbers, and the UI says once that numbering restarted |
| After an extension ↔ server reconnect, timestamps restarted at 0:00 and labels were reused | The extension sends a `continuation` (elapsed timeline, next free speaker number) with the new `audio.start` |
| Question detection could merge one person's statement into another person's question within one utterance | A labelled speaker change after a finished sentence is a turn boundary. A label flip mid-sentence is ignored, so a question isn't split. |
| Deprecated `diarize=true` parameter | `diarize_model=latest` (documented form; verified against the live API) |

Transcript segments are kept in time order. Interim text is shown in italics and replaced, never stored as final. Questions are answered once, even though both interim and final results are processed: tentative answers are confirmed or retracted.

**Measured against the real Deepgram API**, using a synthetic two-voice interview (62 s; Windows text-to-speech voices, so no real person's voice; `server/bench/sample-dialogue.json`). Results are in `docs/latency/stt-real-*.json`.

| | Transcription errors (WER) | Speaker attribution (words) | Final transcript after line end (p50 / p95) |
| --- | --- | --- | --- |
| Diarization **off** (2 runs) | 0 / 125 words | — | 85 / 168 ms and 4 / 85 ms |
| Diarization **on**, before the changes (2 runs) | 0 / 125 | 89.5% | 176 / 224 ms and 184 / 313 ms |
| Diarization **on**, after the changes | 0 / 125 | 89.5% | 105 / 170 ms |
| *For comparison:* Deepgram **batch** (non-streaming) diarization on the same audio, run once | — | v1: 99.2%, v2: 96.8% | — |

How to read these numbers:
- **Transcription accuracy** was perfect on this clean synthetic audio. Real meetings (compression, accents, overlap, noise) will be worse; this sample can't tell you by how much.
- **Speaker attribution** errors all come from Deepgram's streaming diarizer, which labels in real time with only past audio. In this sample it put the second voice's first reply ("Yes, I can hear you fine.") under Speaker 1, and in one run the first half of another reply too.
  - No result mixed two labels, so the splitting fix didn't change this sample's score. It prevents a real failure mode that appears when a result spans a speaker change.
  - Batch diarization, which sees the whole recording, does much better. Getting there would need a second, delayed pass that re-sends buffered audio. That isn't implemented, because it doubles the audio sent to Deepgram and requires keeping meeting audio in memory.
- **Latency cost of diarization:** about +100–180 ms on final transcripts. Tentative answers start from interim results, which are barely affected. That's why labels stay off by default.

Re-run these yourself (uses your Deepgram and Groq credit):

```powershell
powershell -File server/bench/make-sample-audio.ps1   # generate the synthetic audio (Windows voices)
npm run bench:stt -w server -- --label mine           # transcription + speaker attribution + lag (Deepgram)
npm run bench:e2e -w server -- --label mine           # full pipeline: Deepgram + Groq, time to first answer
```

---

## Screen sharing: what others can see

The assistant UI never renders inside the Meet or Teams page:

- no content scripts, overlays, injected CSS or DOM changes,
- nothing that touches meeting controls or sharing,
- it lives in the toolbar popup and in a **separate extension-owned popup window** (`chrome.windows.create({ type: 'popup' })`).

Whether a participant can see it depends on **what you share**.

**Why an "Entire screen" share shows the answers (root cause):** the answers live in an ordinary top-level window. An entire-screen capture records everything drawn on that display, including other applications' windows.
- Chrome extensions have **no API** to exclude a window from capture.
- The extension also **cannot see** which option you picked in Meet's or Teams' share picker. That happens inside the meeting page, and the extension deliberately doesn't run code in that page.
- Operating systems have native-app flags that hide a window from capture. They aren't available to extensions, and this project doesn't use a native helper to apply them, because that would hide on-screen content from the people you're presenting to.
- What remains is the workflow below.

| What you share | Can participants see the assistant? | Verified? |
| --- | --- | --- |
| **The meeting tab** (Chrome tab picker) | No. A tab share contains only that tab's page, never other windows. | **Yes:** in Chrome for Testing 156, with the assistant open and showing an answer, a `getDisplayMedia` tab capture of the meeting tab contained only that tab's pixels (frame matched the tab: 25% red test block as expected, 99.5% of pixels from the page). |
| **A window** (a specific application window) | Not if you share the meeting's Chrome window or any other window. The assistant is a separate window. The toolbar **popup** belongs to the browser window it opens from and may be visible *while open*. | Not verified with a second participant |
| **Entire screen**, single display | **Yes, everything on the screen is visible, including the assistant.** | — (by design of screen capture) |
| **Entire screen**, two or more displays | Not if the assistant is on a display you don't share. Use **Settings → Screen sharing → Keep this window on a different display than the meeting**. | Window placement **verified** on this machine's two real displays (see below). What a viewer sees: not verified |

**Keep this window on a different display than the meeting** (opt-in, Settings → Screen sharing):
- It asks for the optional `system.display` permission. That permission has no install-time warning and is only requested when you turn the option on.
- It moves the assistant window to the display that does **not** contain the meeting's window, at session start or when you press **Move to another display now**.
- It never focuses or reopens the window, and it leaves the window alone if you already put it on another display.
- With one display, it says so: "Only one display was found. An 'Entire screen' share will include this window."
- Verified in real Chrome on two displays: with the meeting window on the 1280×800 display, the assistant moved to the other display (x = −456 on a display spanning −1920…0), and the status showed "Moved to …".
- Then share only the meeting's display, or better, just the meeting tab.
- (In headless Chrome for Testing, `chrome.system.display.getInfo()` crashes the extension page, so this option only works in normal, windowed Chrome, which is how it's used.)

A reminder banner appears in the live view during live sessions. It can be dismissed, and it stays visible when only one display was found. The popup also notes before you start that entire-screen sharing shows the assistant.

Recommendation: share **the meeting tab**, or a window. Capture continues when you switch tabs or windows, because it's bound to the tab you started on.

> Apart from the tab-share frame test and window placement above, what a second participant actually sees has **not** been verified for this project. Use the procedure below.

### Manual verification procedure

1. Join the meeting from a second device or browser profile as "Observer" and leave its view visible to you.
2. On the main machine, start Meeting Copilot so the assistant window is showing text, and open the toolbar popup.
3. Share, in turn: (a) a specific Chrome tab (a tab other than the assistant), (b) the Chrome window hosting the meeting, (c) a different application window, (d) the entire screen. If you have two monitors, also test the entire-screen share of the monitor *without* the assistant.
4. For each mode, note on the Observer device whether the assistant window and the toolbar popup appear. Repeat on each OS and platform you use (Meet, Teams web), because behaviour differs.
5. Confirm that Meet and Teams' own "you are presenting" indicators and any recording or transcription notices behave normally.

---

## Testing

```bash
npm run check   # = typecheck + lint + tests + builds + manifest validation + built-server smoke test
npm test        # vitest across shared, server, extension (no API keys needed)
```

The automated tests cover:

- **Question detection**:
  - direct, technical, imperative, indirect, follow-ups; split across segments; debounce and partial-activity postponement; duplicate finals; repeated questions; fillers ("can you hear me?", "…, right?"); ambiguous embedded clauses;
  - `requestDetection.test.ts`: a table of 163 labelled utterances (`test/fixtures/questionCorpus.ts`), each checked for answer/classifier/ignore, request form and context need; 560 independently written utterances (`test/fixtures/independentUtterances.json`) with an explicit list of the known errors;
  - interim to final with one answer, speaker changes and label flicker, scenarios split from their question, duplicates and replays, the classifier's inputs and outputs, and the diagnostic log lines (no transcript text).
- **Resume**: heading detection and sectioning, contact redaction, intent classification, retrieval with evidence that is present (transaction volume, Kafka, "tell me about yourself"), absent (education, Elixir) and ambiguous (leadership ↔ "mentored", "led the migration"). Also real PDF, DOCX and TXT extraction from generated files, and rejection of empty, oversized, unsupported, legacy `.doc`, malformed and text-less files.
- **Providers**: Deepgram message parsing and URL building, Groq error mapping (401/429/404/5xx/timeout/network, `retry-after`), and prompt building, including neutralisation of injected tags.
- **AnswerService**: streaming, dedupe, supersede, user cancel, first-token timeout, fixed no-LLM answers.
- **Integration (real WebSocket)**: simulated transcript → detection → retrieval → streamed mock answers, with event ordering; manual, retry and cancel; missing STT credentials; malformed messages; rejected web origins; oversized frames; resume upload over HTTP with CORS; insights; provider status without secrets.
- **Extension**: resampler (length, in-band tone frequency and amplitude, anti-aliasing of a 12 kHz tone, chunk-boundary invariance), PCM16 conversion and framing, supported-site matching.
- **Speculation and latency**:
  - the speculation policy (complete vs incomplete, fillers, ambiguous, split questions),
  - the "?" fast path,
  - a tentative answer streaming before the final transcript and then being confirmed with no second request,
  - rejection when the final differs, with no late tokens and the final question answered,
  - superseding with late-output suppression,
  - no speculation in manual mode,
  - a mock latency regression bound (dispatch p95 under 100 ms; measured 1–3 ms),
  - `answer.displayed` timing, tracker percentiles and milestones.
- **History**:
  - schema init, idempotent reopen, upgrade migration, refusal of a newer schema, a corrupt file,
  - no BLOB or audio/transcript/resume columns,
  - create, list (newest first, pagination), open, rename and delete with cascade, delete all,
  - persistence across reopen and across a full server restart over HTTP,
  - stale-write and cross-conversation protection, write collapsing,
  - a deleted conversation not coming back from queued or late writes, delete-all racing a flush,
  - retry and recovery and dropped batches,
  - answers streaming on time while a write hangs or fails, with a `history_write_failed` notice,
  - a session saving confirmed cards but not retracted tentative ones,
  - a privacy scan of the database files,
  - the HTTP API's validation, origin checks, CORS preflight for DELETE, the delete-all confirmation guard, and history disabled.
- **UI rendering**: AnswerCard rendered at each streaming step (generating state, partial text before completion, Cancel and Retry, on-screen timing, Tentative label, removal on retraction).
- **Speakers and transcript reliability**:
  - parser splitting results at speaker changes, never inventing labels (missing or invalid labels stay unlabelled), the documented `diarize_model` parameter,
  - the speaker registry (first-appearance numbering, no merging across connections, offset),
  - a **real Deepgram reconnect** against a local fake endpoint (timestamps keep increasing, results tagged per connection),
  - session labels and the one-time "numbering restarted" notice, continuation after an extension reconnect (timeline offset, speaker offset, invalid values rejected),
  - turn boundaries in question detection (no merging across speakers; mid-sentence label flicker doesn't split a question),
  - time-ordered transcript in the UI state,
  - a **replay of recorded real Deepgram responses** (`server/test/fixtures/deepgram-two-speakers.json`) through the full session: segment order, labels equal to the provider's metadata, each question detected and answered once.
- **Display placement** (screen sharing): single display, moving to the non-meeting display, respecting a window already on another display, an unknown meeting window, small work areas.

Also run manually during development, outside the test suite, in real Chrome for Testing 156 with simulation mode and the mock LLM. The scripts live outside the repo:
- the latency harness behind table B,
- a history end-to-end run:
  1. record a conversation, open it and rename it,
  2. start a new conversation and record a second,
  3. reload the window and restart the server process (history is still there),
  4. delete one conversation, then delete all through the real confirm dialogs,
  5. check that the database is empty.

**Not covered by automated tests:**

- live tab capture,
- real Deepgram transcription and real Groq answers with valid keys, including real time to first token (`bench:groq` exists but was not run),
- how often real Deepgram interim results end a question that later changes (the speculation retraction rate),
- Google Meet and Teams themselves,
- screen-sharing visibility.

Use the manual procedures above for these.

---

## Known limitations

- **Mixed audio.** Tab capture yields one mixed stream of everyone except you. Optional diarization labels (Speaker 1, Speaker 2) are estimates, not speaker identification.
  - In a clean two-voice test, the live diarizer labelled about 9 in 10 words correctly. Most errors came right after a new person started talking.
  - Overlapping speech gets one label per word, so overlaps are often wrong.
  - Labels restart (as new numbers) after any reconnection.
  - See [Transcription and speaker labels](#transcription-and-speaker-labels).
- **Entire-screen sharing** shows the assistant window if it's on the shared display. There is no extension API to prevent that, and the extension can't detect which share option you picked. Share the meeting tab or a window, or keep the assistant on another display.
- **Your microphone is not captured.** The pipeline is designed so a mic source would get its own `AudioCapture` and its own STT stream, but this is not implemented.
- **Teams:** browser only; the desktop app cannot be captured by an extension.
- **Detection** is English-oriented heuristics plus an optional small-LLM check for ambiguous cases (see [measured accuracy](#question-and-request-detection)). Known gaps:
  - Questions addressed by name to someone else ("Rahul, do you want to add anything?") are answered, because the detector doesn't know your name. Telling a name from a fronted topic ("Kafka, have you used it?") would be guesswork without the participants' names, so it isn't attempted. On a held-out set, 12 of 15 such questions were answered.
  - Off-topic questions that address you, or aren't phrased like logistics ("How's the weather over there?", "Is it just me or is there an echo?"), are answered.
  - Unpunctuated rhetorical run-ons can be answered.
  - Long unpunctuated speech that contains a request in the middle can be missed.
  - Without `GROQ_DETECTION_MODEL`, fragments without "?" and bare scenarios are not answered.

  Use Manual mode or "Answer now" when needed. Accuracy on real meeting audio hasn't been measured.
- **Reconnects:** if the server connection drops, the extension reconnects (up to 5 attempts) and starts a fresh server session. Audio during the gap is dropped and server-side context (recent transcript, previous answer) resets. The UI keeps the history. Deepgram reconnects are also bounded, with about 3 s of audio buffered.
- **Resume retrieval** is keyword-based with a small synonym list. Paraphrases with no shared terms ("cloud-native" vs "Kubernetes") may be missed. OCR, embeddings and semantic search are not implemented.
- **Window focus:** `focused: false` for the assistant window is honoured by Chrome on common desktops, but window managers may differ.
- **Tentative answers** depend on Deepgram adding terminal punctuation to interim results. When it doesn't, the answer starts at the final transcript (the earlier behavior).
  - Each retracted tentative answer is a wasted Groq request: at most 2 per utterance, and never while another answer is streaming.
  - A tentative answer for a question that is then extended (e.g. "...UDP?" followed by "on mobile networks?") is shown briefly and then replaced.
- **Dedupe** treats near-identical questions within 2 minutes as one. Two genuinely different questions that differ in a single word (e.g. only a number) may be merged.
- **History** stores one card per question with the latest attempt (retries overwrite the earlier answer). Conversation titles default to the first question. There's no search or export yet.
- **Local server trust:** only `chrome-extension://` origins are accepted, and `ALLOWED_EXTENSION_IDS` can restrict this further. Other local programs could still connect if they fake the header, so keep the server bound to `127.0.0.1`.

---

## Privacy and security

- **Keys:** provider API keys live only in the server's environment and are never sent to or bundled in the extension.
- **Explicit start:** capture starts only on an explicit user action on that tab. While it is active, the toolbar icon turns blue, Chrome shows its own capture indicator on the tab, and the assistant header shows the state. Stop releases every resource.
- **No persistent audio:** audio is streamed, never written to disk. Deepgram receives the audio. Groq receives the question, the configured number of recent transcript lines, matching resume and notes excerpts, the previous Q&A for follow-ups, and your style settings. Every card shows what was sent.
- **Third parties:** review Deepgram's and Groq's current privacy policies and data-retention terms on their websites. Text sent to Groq is processed by an external provider.
- **Local data:**
  - Settings and notes are stored in `chrome.storage.local`.
  - Resume text is stored in `chrome.storage.session` unless you opt in to keeping it.
  - The live view (current transcript and answers) is kept in `chrome.storage.session` only (memory-only, gone when Chrome closes).
  - **Settings → Clear transcript & history** and **Clear all local data** remove these browser-side copies.
  - **Saved conversation history** (questions and answers only) lives in the local server's SQLite file. It is managed in the **History** tab; see [Conversation history](#conversation-history-sqlite) for exactly what deletion covers.
- **Untrusted content:** resume text and transcripts are treated as data. They are wrapped in tagged blocks, embedded closing tags are stripped, and the system prompt tells the model to ignore instructions inside them. Nothing from documents is executed.
- **Server hardening:**
  - origin checks on WebSocket and HTTP,
  - 256 KB WebSocket message limit, 64 KB audio frames, an audio rate limiter,
  - zod validation of every message, disconnect after repeated invalid messages,
  - 5 MB upload limit, magic-byte file checks,
  - no transcript, resume or key logging by default.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Cannot reach the Meeting Copilot server" | Run `npm run dev:server`, and check the server URL in Settings (default `http://localhost:8787`). |
| "Speech-to-text is not configured" | Set `DEEPGRAM_API_KEY` in `server/.env` and restart. Or use Simulation mode. |
| "Deepgram rejected the API key" / "Groq rejected the API key" | Check the key and restart the server. |
| "Groq model not found" or a startup warning about models | Set `GROQ_MODEL` to a model from console.groq.com/docs/models. |
| "Extension has not been invoked for the current page" | Click the toolbar icon **on the meeting tab itself** (or use Alt+Shift+Y there), then Start. |
| "Invalid value for bounds. Bounds must be at least 50% within visible screen space." | Fixed: the assistant window's remembered position was on a display that is no longer available (disconnected, rearranged, or a different resolution). The window now opens at Chrome's default position, the remembered position is forgotten, and listening is not affected. If you still see it, rebuild and reload the extension; the service worker console shows `[assistant-window] saved_position_rejected`. |
| Popup: "Listening started, but the assistant window could not be opened" | Listening is running. Click **Open assistant window**. The service worker console has `[assistant-window] open_failed` with the reason. |
| "This tab is already being captured" | Another capture (this or another extension) is active on the tab. Stop it, or reload the tab. |
| No transcript although LIVE | Make sure the meeting audio is actually playing in that tab (not muted in Meet or Teams). Check the server log for Deepgram status. |
| Meeting audio becomes silent while capturing | Shouldn't happen: the offscreen document plays captured audio back. Stop and start again. If it persists, report the Chrome version. |
| Resume error "appears to be scanned images" | Export a text-based PDF, or use DOCX/TXT. |
| Answers always "Not found in resume" | Use **Review extracted text** to check the text, and add missing details to your resume or the "Professional background" box. |
| History tab: "History database unavailable" | The server couldn't open `HISTORY_DB_PATH`: check permissions and free space. "Schema is newer" means a newer server created the file; update the server or point `HISTORY_DB_PATH` elsewhere. Live answers still work. |
| "Conversation history could not be saved" | A write failed twice (disk full, file locked by another program). Answers are unaffected. Check the server log and the database file location. |
| Tentative answers appear and disappear | The interim transcript looked like a complete question, but the final one differed. Set `SPECULATIVE_ANSWERS=false` to always wait for the final transcript (slower). |
| `Cannot find package 'sqlite'` when starting the server | Node is too old, or a custom build stripped the `node:` prefix. Use Node 22.13+ and the provided `tsup` config. |

### Diagnostic logs

Both the extension and the server write one structured line per event:

```
2026-10-23T07:12:03.418Z [WARN] [assistant-window] saved_position_rejected requested=-1189,228,440x780 err.name=Error err.message="Invalid value for bounds. …" recovery=forget_position_and_retry
```

The format is `timestamp [LEVEL] [component] event key=value …`. To find a problem, search for `[ERROR]`, a component such as `[ws]`, or an event name. Errors include `err.name`, `err.code`, `err.message` and the first stack frames. Where it applies, a line also has `duration_ms` and a `recovery` field that says what happened next (for example `retry_once`, `session_stopped` or `session_continues_without_window`).

**Where to look**

| Context | How to open it | Components |
| --- | --- | --- |
| Service worker | `chrome://extensions` → Meeting Copilot → **service worker** (the "Inspect views" link) → Console | `sw`, `session`, `assistant-window`, `display`, `capture` |
| Offscreen document (audio and server connection) | `chrome://extensions` → Meeting Copilot → **Inspect views: offscreen.html**. It is listed only while listening. | `session`, `ws`, `audio-capture`, `messaging` |
| Assistant window, Settings, History | Right-click inside the window → **Inspect** → Console | `assistant`, `server-api`, `messaging` |
| Popup | Right-click inside the popup → **Inspect** (the popup stays open while DevTools is open) | `popup`, `messaging` |
| Server | The terminal running `npm run dev:server` | `server`, `config`, `ws`, `session`, `deepgram`, `groq`/`mock`, `history-db`, `history-api`, `resume`, `http`, `process` |

**More detail**

- Extension: **Settings → Privacy & data → Verbose diagnostic logs (DEBUG)**. The setting applies immediately in every extension context. The offscreen document picks it up at the next start.
- Server: set `LOG_LEVEL=debug` in `server/.env` and restart the server.
- To avoid floods, per-frame and per-token activity is never logged one line at a time. You get counters instead: `[session] traffic` every 30 s (extension, DEBUG), `[session] audio_summary` every 60 s (server, DEBUG), and totals in `stopped`.

**Following one session across the extension and the server**

- `sid`: the session id. It appears in the offscreen console and on the server.
- `cid`: one server WebSocket connection.
- `rid` / `qid`: one answer request and one question, on both sides.

These are random ids and identify nobody.

**What is never logged, at any level**

- API keys, `Authorization` headers and URL query strings. Values under secret-looking names are replaced with `[REDACTED]`, as are `gsk_…`-style and other long opaque tokens in error messages.
- Audio.
- Transcript, question, answer, prompt, notes and resume text. Only lengths are logged, for example `answer_chars=229`.

The one opt-in exception is `LOG_TRANSCRIPTS=true` on the server, which logs final transcript lines for local debugging.

**Event names to search for**

| Component | Events |
| --- | --- |
| `sw` / `session` (service worker) | `startup`, `start_requested`, `started`, `start_failed` (with `stage`), `start_rejected`, `stop_requested`, `stop_message_failed`, `stopped`, `message_handler_failed`, `unhandled_rejection` |
| `assistant-window` / `display` | `created` (`outcome=created`, `created_after_position_reset`), `reused`, `saved_position_rejected`, `open_failed`, `position_saved`, `placed`, `place_failed` |
| `popup` | `start_clicked`, `stream_id_obtained`, `started`, `started_with_warning`, `start_failed`, `open_assistant_failed` |
| `session` (offscreen) | `start`, `ready`, `start_failed`, `server_error`, `transcriber_status`, `answer_completed`, `answer_failed`, `command_not_sent`, `traffic`, `stopping`, `stopped` |
| `ws` (offscreen) | `connected` (`reconnect=true` after a drop), `connect_failed`, `reconnecting`, `reconnect_gave_up`, `closed_by_server`, `invalid_server_event`, `audio_frames_dropping`, `closed` |
| `audio-capture` | `started` (input sample rate, channels), `start_failed`, `track_ended`, `stopped` |
| `server-api` | `request_failed` (`kind=network` or `kind=timeout`, or an HTTP `status` and `code`) |
| `server` / `config` / `process` | `listening`, `config`, `listen_failed` (for example `EADDRINUSE`), `invalid`, `stt_not_configured`, `llm_not_configured`, `uncaught_exception`, `unhandled_rejection`, `shutting_down` |
| `ws` / `session` (server) | `connected`, `origin_rejected`, `invalid_message`, `disconnected`, `started`, `audio_frame_invalid`, `audio_rate_exceeded`, `stopped`, `closed` |
| `session` (server, question detection, DEBUG) | `utterance_evaluated` (`source=final`, `decision=accepted\|ambiguous\|rejected\|duplicate`, `intent`, `requires_context`, `score`, `reasons`, `detect_ms`), `speculation_started` (`source=interim`, `qid`, `rid`), `speculation_confirmed` (`recovery=final_deduplicated`), `tentative_retracted`, `classifier_decision` (`is_question`, `intent`, `duration_ms`), `classifier_skipped`, `classifier_failed`, `duplicate_suppressed`, `question_detected` (`source=heuristics\|classifier`, `intent`, `answer_triggered`, `rid`) |
| `deepgram` | `connecting`, `connected`, `http_error` (`status`, `auth`, `provider_request_id`), `provider_error`, `closed`, `websocket_reconnecting`, `reconnect_gave_up` |
| `groq` / `mock` | `models_verified`, `models_unavailable`, `generation_completed` (`ttft_ms`, `duration_ms`), `generation_failed` (`code`, `status`, `retryable`, `retry_after_ms`, `provider_request_id`) |
| `history-db` / `history-api` | `opened`, `open_failed`, `flushed`, `write_failed` (`recovery=retry_once` then `batch_dropped_ui_notified`), `request_failed`, `conversation_deleted`, `all_deleted` |

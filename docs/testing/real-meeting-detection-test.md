# Real-meeting test: question and request detection

This is a 30–40 minute Google Meet test with two people:

- **You** run Meeting Copilot.
- **The reader** is a second person who reads the script aloud.

Both of you must know this is a test.

The extension doesn't record or store meeting audio. Transcripts stay in the live session. Questions and answers are saved to your local history.

Record every line, including the misses. Don't fill in results you didn't observe.

## Before the call

1. Start the server with `npm run dev:server`. Confirm in the terminal that the `stt` and `llm` entries in the `server config` line both say `configured=true`.
2. In the assistant window, open **Settings**:
   - Answer mode: **Automatic**
   - **Verbose diagnostic logs**: on
3. To see the server's detection decisions, set `LOG_LEVEL=debug` in `server/.env`. The dev server restarts on its own. The decision lines contain no transcript text.
4. Join the Meet call on one tab. Click the Meeting Copilot icon **on that tab**, then **Start listening**.
5. Put the assistant window where you can see it, on another display if you have one.
6. Open `results-template.csv` (in this folder) in a spreadsheet.

## How to read the script

The script has 48 lines: 24 requests and 24 that should get no answer.

**Reading style.** The script is in two passes:
- **Pass 1 (lines 1–24):** read each line exactly as written, then pause about 3 seconds.
- **Pass 2 (lines 25–48):** say each line naturally. Paraphrase, add "um", "so", "like", restart a sentence, run two sentences together.

**Timing.**
- Pause **about 5 seconds** after each line, so each answer can be judged on its own.
- Where a line says *(pause 1 s)*, pause briefly mid-line.
- Where a line says the reader stops abruptly, the reader breaks off mid-thought. Your own voice is not in the captured tab audio, so it does not matter whether you talk over them.

## Script

| # | Category | Expected | Line |
|---|---|---|---|
| 1 | request: instruction | answer | Give the name of your dog. |
| 2 | request: instruction | answer | Briefly introduce yourself. |
| 3 | request: instruction | answer | List your biggest technical strengths. |
| 4 | request: instruction | answer | Compare SQL and NoSQL databases. |
| 5 | request: polite | answer | I'd like you to explain your role in your last project. |
| 6 | request: polite | answer | Could you walk me through the architecture of something you built? |
| 7 | request: rating | answer | On a scale of one to ten, rate your SQL skills. |
| 8 | request: scenario | answer (one answer, scenario included) | Suppose we have a million records. *(pause 1 s)* How would you scale the database? |
| 9 | request: fragment | answer | Your biggest technical weakness? |
| 10 | request: follow-up to 9 | answer, using the previous answer | Why do you think that is? |
| 11 | request: direct, flat intonation | answer | what is your notice period |
| 12 | request: split | answer (one answer, whole sentence) | List the steps you would take *(pause 1 s)* to debug a slow API. |
| 13 | statement | no answer | I gave the name of my dog to the vet yesterday. |
| 14 | statement | no answer | Let me explain how the application works. |
| 15 | statement | no answer | We compared SQL and NoSQL in the last meeting. |
| 16 | statement | no answer | I'll explain the design later. |
| 17 | statement | no answer | The interviewer asked me to introduce myself. |
| 18 | statement: scenario only | no answer, or a classifier call | Suppose we have a million records. That was yesterday's example. |
| 19 | logistics | no answer | Can everyone hear me? |
| 20 | logistics | no answer | Are we starting now? |
| 21 | logistics | no answer | What time is the next meeting? |
| 22 | logistics | no answer | Share your screen when you're ready. |
| 23 | addressed to someone else | no answer (**known limitation: will be answered**) | Rahul, do you want to add anything? |
| 24 | addressed to someone else | no answer (**known limitation: will be answered**) | Priya, could you explain the next slide? |
| 25 | request: instruction | answer | So, um, tell me about a time you disagreed with your manager. |
| 26 | request: instruction | answer | Name three tools you use every day. |
| 27 | request: run-on | answer | yeah so like how would you design a URL shortener for, you know, millions of users |
| 28 | request: follow-up to 27 | answer, using the previous answer | And what happens when the cache goes down? |
| 29 | request: indirect | answer | I'm curious how you handle code reviews on your team. |
| 30 | request: elliptical | answer | Expected salary? |
| 31 | request: elliptical | answer | What about testing? |
| 32 | request: scenario, long pause | answer (one answer, scenario included) | Imagine your service suddenly gets ten times the traffic. *(pause 2 s)* What breaks first? |
| 33 | request: restart | answer | Can you — actually, explain how you would roll back a bad deployment. |
| 34 | request: cut short | answer | Walk me through your last project… *(the reader stops abruptly, as if interrupted)* |
| 35 | request: let's | answer | Let's talk about your experience with Kubernetes. |
| 36 | request: mumbled | answer | describe your ideal team |
| 37 | statement | no answer | I was going to list my responsibilities, but never mind. |
| 38 | statement | no answer | Thanks, that was really helpful. |
| 39 | statement | no answer | So what does that tell us? It tells us the cache hit rate is too low. |
| 40 | statement | no answer | My colleague will join in a few minutes. |
| 41 | statement | no answer | We used Kafka for the event pipeline. |
| 42 | statement | no answer | Tell me about it next time. |
| 43 | logistics | no answer | Is my microphone working? |
| 44 | logistics | no answer | Should we take a five minute break? |
| 45 | logistics | no answer | How much time do we have left? |
| 46 | statement | no answer | Okay, let's move on. |
| 47 | addressed to someone else | no answer (**known limitation**) | John, what do you think about this approach? |
| 48 | statement: cut off | no answer | So if we look at the |

## What to record for every line (`results-template.csv`)

| Column | How |
|---|---|
| `actual` | `answered`, `ignored`, or `tentative_retracted` (a card appeared, then disappeared) |
| `relevant` | For answers: `yes`, `partly` or `no`. Did it answer what was asked? |
| `duplicated` | `yes` if one spoken line produced more than one answer card |
| `context_ok` | For follow-ups (10, 28) and scenarios (8, 32): `yes` if the answer used the previous answer or the scenario |
| `seconds_to_text` | Optional stopwatch reading from the end of the spoken line to the first answer words. Use it only if you can time it consistently. The server measures this more precisely (next section). |
| `notes` | What the transcript showed (punctuation, split lines, speaker labels) and anything unexpected |

## Latency from the server (no stopwatch needed)

The latency endpoint returns timestamps only, no text. While the session is still running, or right after, open this in a terminal:

```bash
curl -s -H "Origin: chrome-extension://<your extension id>" http://127.0.0.1:8787/api/metrics/latency
```

Your extension ID is shown at `chrome://extensions`.

- `real.displayed` is the time from the transcript first containing the complete request to the answer text appearing in your assistant window. It reports p50, p95 and n.
- `real.detect`, `real.dispatch` and `real.ttft` split that time into detection, request dispatch and Groq.

One part is not included: the gap between the end of speech and the transcript. With synthetic speech that gap was about 0.8–0.9 s. A rough end-of-speech-to-visible figure is `displayed` plus that gap.

Restart the server before the call if you want the numbers to cover only this test. The figures are kept in memory only.

## Diagnostics to check while testing

These all appear with verbose logs or `LOG_LEVEL=debug`.

**Server terminal:** one `[session] utterance_evaluated` line per finished utterance. It shows `decision=accepted|ambiguous|rejected|duplicate`, `intent=…` and `detect_ms=…`.
- `classifier_decision` appears for ambiguous lines.
- `speculation_started` and `speculation_confirmed` appear for tentative answers.

**Offscreen console** (`chrome://extensions` → Inspect views: offscreen.html): `[session] answer_completed … first_token_ms=…`.

## Summarize

Count each of these:

- requests answered, out of 24;
- non-requests answered: statements, logistics and other-addressee, **each separately**;
- duplicates;
- irrelevant answers;
- follow-ups and scenarios with broken context.

Then note `real.displayed` p50 and p95 with n.

With only 20–24 examples per category, treat the rates as preliminary. One miss is a 4 percentage-point change.

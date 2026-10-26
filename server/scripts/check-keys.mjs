// Live check of server/.env against the real Deepgram and Groq APIs, using the same provider code the
// server runs (GroqProvider, DeepgramProvider, prompt builder, classifier prompt).
// No meeting content is sent: Groq gets one synthetic interview question and one synthetic utterance to
// classify; Deepgram gets 1 s of silence.
// Usage (from the repo root): npm run check:keys -w server   (runs through tsx so it can import src/*.ts)
import { performance } from 'node:perf_hooks';
import { buildAnswerMessages, MAX_TOKENS_BY_LENGTH } from '../src/answers/promptBuilder.js';
import { loadConfig } from '../src/config.js';
import { GroqProvider } from '../src/llm/groq.js';
import { classifierMessages } from '../src/detection/classifier.js';
import { DeepgramProvider } from '../src/transcription/deepgram.js';

const config = loadConfig();
const mask = (v) => (v.length > 8 ? `${v.slice(0, 4)}...${v.slice(-4)}` : '****');
let failures = 0;
const ok = (msg) => console.log(`  OK    ${msg}`);
const warn = (msg) => console.log(`  WARN  ${msg}`);
const fail = (msg) => {
  failures++;
  console.log(`  FAIL  ${msg}`);
};

async function checkGroq() {
  console.log('\nGroq (answers)');
  const { groqApiKey: key, groqModel: model, groqDetectionModel: detection } = config.llm;
  if (!key) return fail('GROQ_API_KEY is not set in server/.env');
  console.log(`  key   ${mask(key)}`);
  const res = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
  if (res.status === 401 || res.status === 403) return fail(`Groq rejected the key (HTTP ${res.status}). Create a new one at console.groq.com/keys.`);
  if (!res.ok) return fail(`GET /models returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  ok('key accepted');
  const ids = new Set((await res.json()).data.map((m) => m.id));
  let missing = false;
  for (const [label, id] of [['GROQ_MODEL', model], ['GROQ_DETECTION_MODEL', detection]]) {
    if (!id) continue;
    if (ids.has(id)) ok(`${label} ${id} is available`);
    else {
      missing = true;
      fail(`${label} ${id} is not offered to this account.`);
    }
  }
  if (missing) console.log(`        Models this key can use: ${[...ids].sort().join(', ')}`);

  const provider = new GroqProvider({ apiKey: key, model, detectionModel: detection, timeoutMs: config.llm.timeoutMs, reasoningEffort: config.llm.reasoningEffort ?? null });
  if (ids.has(model)) {
    const { messages } = buildAnswerMessages({
      question: 'What is the difference between a process and a thread?',
      kind: 'general',
      evidence: 'not_needed',
      style: 'concise',
      length: 'short',
      transcript: [],
      resumeExcerpts: [],
      noteExcerpts: [],
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.llm.timeoutMs);
    const t0 = performance.now();
    let firstMs = null;
    let text = '';
    try {
      for await (const delta of provider.stream({ messages, maxTokens: MAX_TOKENS_BY_LENGTH.short, signal: controller.signal })) {
        firstMs ??= performance.now() - t0;
        text += delta;
      }
      const words = text.trim().split(/\s+/).filter(Boolean).length;
      if (words < 5) fail(`streamed answer was empty or cut off: "${text.trim()}"`);
      else {
        ok(`streamed a ${words}-word answer: first text after ${Math.round(firstMs)} ms, done in ${Math.round(performance.now() - t0)} ms`);
        console.log(`        "${text.trim().replace(/\s+/g, ' ').slice(0, 160)}${text.length > 160 ? '...' : ''}"`);
      }
    } catch (err) {
      fail(`answer request failed: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  if (detection && ids.has(detection)) {
    const deadline = config.latency?.classifierTimeoutMs ?? 1_500;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const t0 = performance.now();
    try {
      const result = await provider.classifyJson({
        // Same request shape and budget as a live session (Session.confirmAmbiguous).
        messages: classifierMessages({ utterance: "I'd love to hear how you would approach caching for the product catalog", recent: [] }),
        maxTokens: 60,
        signal: controller.signal,
      });
      const ms = Math.round(performance.now() - t0);
      if (typeof result?.is_question !== 'boolean') fail(`question classifier returned no usable JSON: ${JSON.stringify(result)}`);
      else if (ms > deadline) warn(`question classifier works but took ${ms} ms (> CLASSIFIER_TIMEOUT_MS ${deadline}); in a session it would be skipped`);
      else ok(`question classifier answered ${JSON.stringify(result)} in ${ms} ms`);
    } catch (err) {
      fail(`question classifier failed: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

async function checkDeepgram() {
  console.log('\nDeepgram (live transcription)');
  const { deepgramApiKey: key, deepgramModel: model, endpointingMs, utteranceEndMs } = config.stt;
  if (!key) return fail('DEEPGRAM_API_KEY is not set in server/.env');
  console.log(`  key   ${mask(key)}`);
  const provider = new DeepgramProvider({ apiKey: key, model, endpointingMs, utteranceEndMs });
  const t0 = performance.now();
  await new Promise((resolve) => {
    let connected = false;
    let stream = null;
    const timer = setTimeout(() => {
      if (!connected) fail('no connection to Deepgram within 15 s (network or firewall?)');
      stream?.close();
      resolve();
    }, 15_000);
    stream = provider.start(
      { language: 'en', keywords: ['Kafka'], diarize: false },
      {
        onPartial() {},
        onFinal() {},
        onUtteranceEnd() {},
        onStatus(state) {
          if (state !== 'transcriber_connected' || connected) return;
          connected = true;
          ok(`streaming connection opened (model ${model}, same URL parameters as live sessions) in ${Math.round(performance.now() - t0)} ms`);
          stream.sendAudio(Buffer.alloc(32_000)); // 1 s of silence, 16 kHz 16-bit mono
          void stream.finish().then(() => {
            clearTimeout(timer);
            ok('audio sent and stream closed cleanly');
            resolve();
          });
        },
        onError(e) {
          fail(e.message);
          if (e.fatal) {
            clearTimeout(timer);
            stream?.close();
            resolve();
          }
        },
      },
    );
  });
}

console.log('Meeting Copilot: live check of server/.env (Groq + Deepgram)');
for (const check of [checkGroq, checkDeepgram]) {
  try {
    await check();
  } catch (err) {
    const cause = err.cause?.code ?? err.cause?.message;
    fail(err.name === 'TimeoutError' ? 'request timed out (network or firewall?)' : `${err.message}${cause ? ` (${cause})` : ''}`);
  }
}
console.log(failures ? `\n${failures} problem(s) found.` : '\nAll keys and models work.');
// Exit explicitly: the Groq keep-alive connection pool would otherwise hold the process open for a minute.
process.exit(failures ? 1 : 0);

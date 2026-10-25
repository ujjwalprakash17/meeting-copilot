/**
 * Opt-in REAL network measurement of connection setup to Groq (and Deepgram's WebSocket handshake).
 * No valid API key is needed: an invalid key gets a fast 401, which still exercises DNS, TCP, TLS
 * and HTTP round trips. With GROQ_API_KEY set, the same requests succeed instead.
 *
 *   npm run bench:network -w server
 *
 * It compares Node's default fetch connection pool with the keep-alive agent the Groq provider uses,
 * after different idle gaps (meeting questions are often seconds to minutes apart).
 */
import { performance } from 'node:perf_hooks';
import { Agent, fetch as undiciFetch } from 'undici';
import WebSocket from 'ws';

const GROQ_URL = 'https://api.groq.com/openai/v1/models';
const key = process.env.GROQ_API_KEY?.startsWith('gsk_') ? process.env.GROQ_API_KEY : 'gsk_invalid_key_for_network_benchmark';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function timeRequest(dispatcher?: Agent): Promise<{ ms: number; status: number }> {
  const t0 = performance.now();
  const init = { headers: { Authorization: `Bearer ${key}` } };
  // Node's global fetch vs undici's fetch with an explicit keep-alive agent (what GroqProvider uses).
  const res = dispatcher ? await undiciFetch(GROQ_URL, { ...init, dispatcher }) : await fetch(GROQ_URL, init);
  await res.arrayBuffer();
  return { ms: Math.round(performance.now() - t0), status: res.status };
}

async function series(label: string, dispatcher?: Agent) {
  const rows: Array<{ step: string; ms: number; status: number }> = [];
  rows.push({ step: 'first request (cold)', ...(await timeRequest(dispatcher)) });
  for (let i = 0; i < 3; i++) rows.push({ step: `immediate repeat ${i + 1}`, ...(await timeRequest(dispatcher)) });
  for (const idle of [6_000, 30_000]) {
    await sleep(idle);
    rows.push({ step: `after ${idle / 1000} s idle`, ...(await timeRequest(dispatcher)) });
  }
  console.log(`\n${label}`);
  for (const r of rows) console.log(`  ${r.step.padEnd(24)} ${String(r.ms).padStart(5)} ms  (HTTP ${r.status})`);
  return rows;
}

async function deepgramHandshake(): Promise<number> {
  const t0 = performance.now();
  await new Promise<void>((resolve) => {
    const ws = new WebSocket('wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000', {
      headers: { Authorization: 'Token invalid_key_for_network_benchmark' },
    });
    ws.on('unexpected-response', () => {
      ws.terminate();
      resolve();
    });
    ws.on('open', () => {
      ws.close();
      resolve();
    });
    ws.on('error', () => resolve());
  });
  return Math.round(performance.now() - t0);
}

async function main() {
  console.log(`Real network measurement from this machine (${new Date().toISOString()}), key: ${key.includes('invalid') ? 'invalid (401 responses)' : 'configured'}`);
  const defaultRows = await series('Node default fetch pool');
  const agent = new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 120_000, connections: 4 });
  const agentRows = await series('Keep-alive agent (keepAliveTimeout 60 s)', agent);
  const dg: number[] = [];
  for (let i = 0; i < 3; i++) dg.push(await deepgramHandshake());
  console.log(`\nDeepgram WebSocket handshake (401 with invalid key): ${dg.join(', ')} ms`);
  console.log(JSON.stringify({ defaultRows, agentRows, deepgramHandshakeMs: dg }));
  await agent.close();
}

void main();

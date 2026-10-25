import { createApp } from './app.js';
import { loadConfig, type ServerConfig } from './config.js';
import { HistoryWriter } from './history/HistoryWriter.js';
import { SqliteHistoryRepository } from './history/SqliteHistoryRepository.js';
import { GroqProvider } from './llm/groq.js';
import { MockLlmProvider } from './llm/mock.js';
import type { LlmProvider } from './llm/types.js';
import { configureLogger, log } from './logger.js';
import { DeepgramProvider } from './transcription/deepgram.js';
import { SimulatedSttProvider } from './transcription/simulated.js';

const serverLog = log.child('server');
const processLog = log.child('process');

// Process boundaries: report anything that escaped the normal error handling.
process.on('unhandledRejection', (reason) => {
  // A stray rejected promise must not take down a live meeting session; it is a bug to fix, so ERROR.
  processLog.error('unhandled_rejection', { err: reason, recovery: 'process_continues' });
});
process.on('uncaughtException', (err) => {
  // State may be inconsistent after an uncaught exception: report and exit (restart the server).
  processLog.error('uncaught_exception', { err, recovery: 'process_exit' });
  process.exit(1);
});

let config: ServerConfig;
try {
  config = loadConfig();
} catch (err) {
  log.child('config').error('invalid', { err, recovery: 'fix server/.env and restart' });
  process.exit(1);
}
configureLogger(config.logLevel, config.logTranscripts);

const liveStt = new DeepgramProvider({
  apiKey: config.stt.deepgramApiKey,
  model: config.stt.deepgramModel,
  endpointingMs: config.stt.endpointingMs,
  utteranceEndMs: config.stt.utteranceEndMs,
});
const simulatedStt = new SimulatedSttProvider(config.simulationSpeed);

let llm: LlmProvider;
if (config.llm.provider === 'mock') {
  llm = new MockLlmProvider();
} else {
  const groq = new GroqProvider({
    apiKey: config.llm.groqApiKey,
    model: config.llm.groqModel,
    detectionModel: config.llm.groqDetectionModel,
    timeoutMs: config.llm.timeoutMs,
    reasoningEffort: config.llm.reasoningEffort ?? null,
  });
  void groq.verify();
  llm = groq;
}

// Conversation history (local SQLite). A failure to open it disables history but never the copilot.
const dbLog = log.child('history-db');
let history: HistoryWriter | null = null;
let historyError: string | null = null;
const historyConfig = config.history ?? { enabled: true, dbPath: '' };
if (historyConfig.enabled) {
  try {
    const repo = new SqliteHistoryRepository(historyConfig.dbPath);
    history = new HistoryWriter(repo);
    dbLog.info('opened', { path: historyConfig.dbPath, schema_version: repo.schemaVersion() });
  } catch (err) {
    historyError = `History database unavailable: ${(err as Error).message}`;
    dbLog.error('open_failed', { path: historyConfig.dbPath, err, recovery: 'history_disabled_copilot_continues' });
  }
} else {
  historyError = 'Conversation history is disabled (HISTORY_ENABLED=false).';
  dbLog.info('disabled', { reason: 'HISTORY_ENABLED=false' });
}

const { server, wss } = createApp({ config, liveStt, simulatedStt, llm, history, historyError, historyDbPath: history ? historyConfig.dbPath : null });

const onListenError = (err: NodeJS.ErrnoException) => {
  serverLog.error('listen_failed', {
    host: config.host,
    port: config.port,
    err,
    hint: err.code === 'EADDRINUSE' ? 'another process (perhaps another Meeting Copilot server) is using this port' : undefined,
    recovery: 'process_exit',
  });
  process.exit(1);
};
server.on('error', onListenError);
wss.on('error', () => undefined); // the same listen error is re-emitted here; already handled above

server.listen(config.port, config.host, () => {
  serverLog.info('listening', { url: `http://${config.host}:${config.port}`, websocket: '/ws', log_level: config.logLevel });
  serverLog.info('config', {
    stt: `${liveStt.name}/${config.stt.deepgramModel}`,
    stt_configured: liveStt.isConfigured(),
    llm: `${llm.name}/${llm.model}`,
    llm_configured: llm.isConfigured(),
    detection_model: config.llm.groqDetectionModel ?? 'off',
    history: history ? 'on' : 'off',
    allowed_extensions: config.allowedExtensionIds.length || 'any',
  });
  if (!liveStt.isConfigured()) serverLog.warn('stt_not_configured', { hint: 'set DEEPGRAM_API_KEY in server/.env (Simulation mode still works)' });
  if (!llm.isConfigured()) serverLog.warn('llm_not_configured', { hint: 'set GROQ_API_KEY in server/.env' });
  if (config.allowedExtensionIds.length === 0) serverLog.warn('any_extension_origin_allowed', { hint: 'set ALLOWED_EXTENSION_IDS for anything beyond local development' });
});

const shutdown = (signal: string) => {
  serverLog.info('shutting_down', { signal });
  setTimeout(() => process.exit(0), 3_000).unref();
  // Write any queued history before exiting.
  void (history?.close() ?? Promise.resolve())
    .catch((err: unknown) => dbLog.error('flush_on_shutdown_failed', { err }))
    .finally(() => server.close(() => process.exit(0)));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

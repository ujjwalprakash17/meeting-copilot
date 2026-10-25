/**
 * Server logging: the shared structured format (`<time> [LEVEL] [component] event key=value ...`) with the
 * shared privacy rules (secrets redacted, transcript/answer/resume text reduced to lengths).
 * LOG_LEVEL=debug for DEBUG lines. Transcript text is only logged with LOG_TRANSCRIPTS=true (opt-in).
 */
import { createLogger, type Logger, type LogLevel, type LogSink } from '@meeting-copilot/shared';

let level: LogLevel = 'info';
let transcriptsEnabled = false;
const consoleSink: LogSink = (l, line) => {
  if (l === 'error' || l === 'warn') console.error(line);
  else console.log(line);
};
let sink: LogSink = consoleSink;

export function configureLogger(next: LogLevel, logTranscripts: boolean): void {
  level = next;
  transcriptsEnabled = logTranscripts;
}

/** Root server logger; use `log.child('<component>')`. */
export const log: Logger = createLogger('server', { level: () => level, sink: (l, line) => sink(l, line) });

/** Transcript text only when LOG_TRANSCRIPTS=true (DEBUG level). */
export function logTranscript(logger: Logger, event: string, text: string): void {
  if (transcriptsEnabled) logger.debug(event, { utterance_opt_in: text });
}

/** Test hook: capture log lines (and silence the console) until `restore()` is called. */
export function captureLogs(min: LogLevel = 'debug'): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const prevSink = sink;
  const prevLevel = level;
  sink = (_l, line) => lines.push(line);
  level = min;
  return {
    lines,
    restore: () => {
      sink = prevSink;
      level = prevLevel;
    },
  };
}

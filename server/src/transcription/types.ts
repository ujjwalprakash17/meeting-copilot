import type { ErrorCode, Logger, TranscriptSegment } from '@meeting-copilot/shared';

export interface SttStartOptions {
  language: string;
  keywords: string[];
  diarize: boolean;
  /** Session-scoped logger (carries the correlation id); providers log under their own component. */
  log?: Logger;
}

export interface SttPartial {
  text: string;
  startMs: number;
  endMs: number;
}

/**
 * A finalized transcript segment from a provider. `speaker` is the provider's raw label and only meaningful
 * together with `speakerScope` (e.g. the connection it came from): providers restart numbering on reconnect.
 */
export type SttFinal = Omit<TranscriptSegment, 'id'> & { speakerScope?: number };

export interface SttError {
  code: ErrorCode;
  message: string;
  fatal: boolean;
}

export interface SttCallbacks {
  onPartial(partial: SttPartial): void;
  onFinal(segment: SttFinal): void;
  /** Provider detected the end of an utterance (silence) after finals were emitted. */
  onUtteranceEnd(): void;
  onStatus(state: 'transcriber_connected' | 'transcriber_reconnecting' | 'transcriber_closed', message: string): void;
  onError(error: SttError): void;
}

export interface SttStream {
  /** PCM16LE mono 16 kHz. */
  sendAudio(pcm: Buffer): void;
  /** Flush pending audio and close gracefully. */
  finish(): Promise<void>;
  /** Close immediately. */
  close(): void;
}

/** Streaming speech-to-text provider. Implementations must not persist audio. */
export interface SttProvider {
  readonly name: string;
  readonly simulated: boolean;
  isConfigured(): boolean;
  start(options: SttStartOptions, callbacks: SttCallbacks): SttStream;
}

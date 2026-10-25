/**
 * Test-only STT provider that replays recorded Deepgram streaming responses (real provider output,
 * recorded by `bench:stt --save-fixture`) through the same parser and callback sequence as DeepgramStream.
 */
import { parseDeepgramMessage } from '../src/transcription/deepgramParser.js';
import type { SttCallbacks, SttProvider, SttStream } from '../src/transcription/types.js';

export interface RecordedMessage {
  at: number;
  raw: unknown;
}

export class ReplaySttProvider implements SttProvider {
  readonly name = 'deepgram-replay';
  readonly simulated = false;

  constructor(
    private readonly messages: RecordedMessage[],
    private readonly speed = 10,
  ) {}

  isConfigured(): boolean {
    return true;
  }

  start(_opts: unknown, cb: SttCallbacks): SttStream {
    const timers: NodeJS.Timeout[] = [];
    cb.onStatus('transcriber_connected', 'replay');
    for (const m of this.messages) {
      timers.push(
        setTimeout(() => {
          const p = parseDeepgramMessage(JSON.stringify(m.raw));
          if (p.kind === 'partial') cb.onPartial(p.partial);
          else if (p.kind === 'finals') {
            for (const s of p.segments) cb.onFinal({ ...s, speakerScope: 1 });
            if (p.speechFinal) cb.onUtteranceEnd();
          } else if (p.kind === 'utterance_end') cb.onUtteranceEnd();
        }, m.at / this.speed),
      );
    }
    const close = () => timers.forEach(clearTimeout);
    return { sendAudio: () => undefined, finish: async () => close(), close };
  }
}

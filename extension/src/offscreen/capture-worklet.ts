/**
 * AudioWorklet processor: downmixes the captured tab audio to mono and posts it to the
 * offscreen document in 512-sample batches. Resampling/encoding happen on the main thread
 * (StreamingResampler), keeping this file import-free as AudioWorklet modules must be standalone.
 */

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: new () => unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

// ~10.7 ms at 48 kHz: small batches keep capture-to-send latency low (2048 would add ~43 ms).
const BATCH = 512;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  private buffer = new Float32Array(BATCH);
  private filled = 0;

  constructor() {
    super();
    this.port.postMessage({ type: 'format', sampleRate });
  }

  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    const frames = channels[0]?.length ?? 0;
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (const ch of channels) sum += ch[i] ?? 0;
      this.buffer[this.filled++] = sum / channels.length;
      if (this.filled === BATCH) {
        this.port.postMessage({ type: 'audio', samples: this.buffer }, [this.buffer.buffer]);
        this.buffer = new Float32Array(BATCH);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);

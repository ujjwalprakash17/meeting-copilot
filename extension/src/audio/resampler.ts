/**
 * Streaming band-limited resampler (windowed-sinc interpolation).
 *
 * Tab audio arrives at the AudioContext rate (typically 48 kHz or 44.1 kHz); the STT provider
 * expects 16 kHz. Simply relabelling or dropping samples would alias everything above 8 kHz
 * into the speech band, so each output sample is computed with a low-pass windowed-sinc kernel
 * whose cutoff sits just below the output Nyquist frequency. State is carried across calls so
 * chunk boundaries do not produce clicks: processing a signal in pieces gives the same result as
 * processing it in one go.
 */
export class StreamingResampler {
  /** Input samples advanced per output sample. */
  private readonly step: number;
  /** Cutoff as a fraction of the input sample rate's Nyquist (<= 1). */
  private readonly cutoff: number;
  /** Kernel half-width in input samples. */
  private readonly halfWidth: number;
  private buffer: Float32Array;
  /** Position of the next output sample, in input-sample units relative to `buffer[0]`. */
  private pos: number;

  constructor(
    readonly inputRate: number,
    readonly outputRate: number,
    zeroCrossings = 16,
  ) {
    if (inputRate <= 0 || outputRate <= 0) throw new Error('Sample rates must be positive');
    this.step = inputRate / outputRate;
    this.cutoff = Math.min(1, outputRate / inputRate) * 0.92;
    this.halfWidth = Math.ceil(zeroCrossings / this.cutoff);
    // Pre-roll of silence so the first output samples have full left context.
    this.buffer = new Float32Array(this.halfWidth);
    this.pos = this.halfWidth;
  }

  private kernel(x: number): number {
    // Hann-windowed sinc low-pass, normalised for unity DC gain.
    const ax = Math.abs(x);
    if (ax >= this.halfWidth) return 0;
    const window = 0.5 * (1 + Math.cos((Math.PI * x) / this.halfWidth));
    const t = Math.PI * this.cutoff * x;
    const sinc = t === 0 ? 1 : Math.sin(t) / t;
    return this.cutoff * sinc * window;
  }

  /**
   * Normalised kernel weights for a given fractional position. The fractional offsets repeat
   * (1 distinct value for 48k->16k, 160 for 44.1k->16k), so weights are cached instead of
   * recomputing ~100 sin/cos evaluations per output sample.
   */
  private readonly weightCache = new Map<number, Float32Array>();

  private weightsFor(frac: number): Float32Array {
    const key = Math.round(frac * 1e6);
    let weights = this.weightCache.get(key);
    if (!weights) {
      weights = new Float32Array(2 * this.halfWidth);
      let norm = 0;
      for (let j = 0; j < weights.length; j++) {
        const w = this.kernel(frac + this.halfWidth - 1 - j);
        weights[j] = w;
        norm += w;
      }
      if (norm > 0) for (let j = 0; j < weights.length; j++) weights[j] = (weights[j] ?? 0) / norm;
      if (this.weightCache.size < 4096) this.weightCache.set(key, weights);
    }
    return weights;
  }

  process(input: Float32Array): Float32Array {
    if (this.step === 1) return input.slice();
    const merged = new Float32Array(this.buffer.length + input.length);
    merged.set(this.buffer);
    merged.set(input, this.buffer.length);

    const out: number[] = [];
    // Need halfWidth samples of right context for each output sample.
    while (this.pos + this.halfWidth < merged.length) {
      const center = Math.floor(this.pos);
      const weights = this.weightsFor(this.pos - center);
      let acc = 0;
      const first = center - this.halfWidth + 1;
      for (let j = 0; j < weights.length; j++) acc += (merged[first + j] ?? 0) * (weights[j] ?? 0);
      out.push(acc);
      this.pos += this.step;
    }

    // Keep only what future outputs still need (left context of the next position).
    const keepFrom = Math.max(0, Math.floor(this.pos) - this.halfWidth);
    this.buffer = merged.slice(keepFrom);
    this.pos -= keepFrom;
    return Float32Array.from(out);
  }
}

/** Float [-1, 1] -> little-endian signed 16-bit PCM, with clipping. */
export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/** Accumulates PCM16 samples and emits fixed-size frames (e.g. 100 ms) to bound latency and message rate. */
export class Pcm16Framer {
  private pending = new Int16Array(0);

  constructor(
    private readonly frameSamples: number,
    private readonly onFrame: (frame: ArrayBuffer) => void,
  ) {}

  push(samples: Int16Array): void {
    const merged = new Int16Array(this.pending.length + samples.length);
    merged.set(this.pending);
    merged.set(samples, this.pending.length);
    let offset = 0;
    while (merged.length - offset >= this.frameSamples) {
      this.onFrame(merged.slice(offset, offset + this.frameSamples).buffer);
      offset += this.frameSamples;
    }
    this.pending = merged.slice(offset);
  }

  /** Emits any remaining samples (used on stop). */
  flush(): void {
    if (this.pending.length) this.onFrame(this.pending.slice().buffer);
    this.pending = new Int16Array(0);
  }
}

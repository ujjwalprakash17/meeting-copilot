import { describe, expect, it } from 'vitest';
import { floatToPcm16, Pcm16Framer, StreamingResampler } from './resampler.js';

const sine = (freq: number, rate: number, seconds: number, amp = 0.8) =>
  Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / rate));

const rms = (x: Float32Array, skip = 200) => {
  let s = 0;
  let n = 0;
  for (let i = skip; i < x.length - skip; i++) {
    s += (x[i] ?? 0) ** 2;
    n++;
  }
  return Math.sqrt(s / n);
};

/** Dominant frequency estimate from zero crossings. */
const zeroCrossingFreq = (x: Float32Array, rate: number, skip = 200) => {
  let crossings = 0;
  for (let i = skip + 1; i < x.length - skip; i++) if ((x[i - 1] ?? 0) < 0 !== (x[i] ?? 0) < 0) crossings++;
  return (crossings / 2) * (rate / (x.length - 2 * skip));
};

describe('StreamingResampler', () => {
  it.each([48_000, 44_100])('converts %i Hz to 16 kHz with the right length', (rate) => {
    const out = new StreamingResampler(rate, 16_000).process(sine(440, rate, 1));
    // Up to one kernel half-width of output is held back as look-ahead.
    expect(out.length).toBeGreaterThan(16_000 - 40);
    expect(out.length).toBeLessThanOrEqual(16_000);
  });

  it('preserves in-band tones (frequency and amplitude)', () => {
    for (const freq of [300, 1_000, 3_400, 6_000]) {
      const out = new StreamingResampler(48_000, 16_000).process(sine(freq, 48_000, 0.5));
      expect(zeroCrossingFreq(out, 16_000)).toBeCloseTo(freq, -1);
      expect(rms(out)).toBeCloseTo(0.8 / Math.SQRT2, 1);
    }
  });

  it('attenuates content above the output Nyquist instead of aliasing it', () => {
    // 12 kHz would alias to 4 kHz if samples were simply decimated.
    const out = new StreamingResampler(48_000, 16_000).process(sine(12_000, 48_000, 0.5));
    expect(rms(out)).toBeLessThan(0.02);
    const naive = sine(12_000, 48_000, 0.5).filter((_, i) => i % 3 === 0);
    expect(rms(naive)).toBeGreaterThan(0.3);
  });

  it('gives identical output whether processed in chunks or at once', () => {
    const input = sine(700, 44_100, 0.3);
    const whole = new StreamingResampler(44_100, 16_000).process(input);
    const r = new StreamingResampler(44_100, 16_000);
    const parts: number[] = [];
    for (let i = 0; i < input.length; i += 128) parts.push(...r.process(input.subarray(i, i + 128)));
    expect(parts.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) expect(parts[i]).toBeCloseTo(whole[i] ?? 0, 5);
  });
});

describe('PCM16 conversion and framing', () => {
  it('clips and scales floats', () => {
    expect(Array.from(floatToPcm16(Float32Array.from([0, 1, -1, 2, -2, 0.5])))).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
  });

  it('emits fixed-size frames and flushes the remainder', () => {
    const frames: number[] = [];
    const framer = new Pcm16Framer(1600, (f) => frames.push(f.byteLength));
    framer.push(new Int16Array(1000));
    framer.push(new Int16Array(2500));
    expect(frames).toEqual([3200, 3200]);
    framer.flush();
    expect(frames).toEqual([3200, 3200, 600]);
  });
});

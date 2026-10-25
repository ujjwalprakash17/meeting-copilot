import type { TranscriptSegment } from '@meeting-copilot/shared';

/**
 * Bounded rolling buffer of finalized transcript segments for one session.
 * Bounded by segment count and total characters so long meetings cannot grow memory without limit.
 */
export class TranscriptBuffer {
  private segments: TranscriptSegment[] = [];
  private chars = 0;

  constructor(
    private readonly maxSegments: number,
    private readonly maxChars = 200_000,
  ) {}

  add(segment: TranscriptSegment): boolean {
    if (this.segments.some((s) => s.id === segment.id)) return false;
    this.segments.push(segment);
    this.chars += segment.text.length;
    while (this.segments.length > this.maxSegments || this.chars > this.maxChars) {
      const removed = this.segments.shift();
      if (!removed) break;
      this.chars -= removed.text.length;
    }
    return true;
  }

  /** Most recent `count` segments, oldest first, limited to `maxChars` characters total. */
  recent(count: number, maxChars = 6_000): TranscriptSegment[] {
    const out: TranscriptSegment[] = [];
    let total = 0;
    for (let i = this.segments.length - 1; i >= 0 && out.length < count; i--) {
      const seg = this.segments[i];
      if (!seg) continue;
      if (total + seg.text.length > maxChars && out.length > 0) break;
      out.unshift(seg);
      total += seg.text.length;
    }
    return out;
  }

  get size(): number {
    return this.segments.length;
  }

  clear(): void {
    this.segments = [];
    this.chars = 0;
  }
}

import { describe, expect, it } from 'vitest';
import { LatencyTracker, milestoneValue, percentile, summarize } from '../src/latency/LatencyTracker.js';
import { TextAvailability } from '../src/latency/TextAvailability.js';

describe('percentiles', () => {
  it('uses nearest-rank percentiles', () => {
    const v = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(v, 50)).toBe(10);
    expect(percentile(v, 95)).toBe(19);
    expect(percentile([], 50)).toBeNull();
    expect(summarize([5, 1, 3])).toEqual({ n: 3, p50: 3, p95: 5, min: 1, max: 5 });
  });
});

describe('LatencyTracker', () => {
  it('derives milestones relative to text availability and bounds memory', () => {
    const tracker = new LatencyTracker(2);
    tracker.start({ requestId: 'r1', questionId: 'q1', kind: 'auto', provider: 'mock', simulated: true, textAvailableAt: 1000, detectedAt: 1300 });
    tracker.update('r1', { dispatchedAt: 1310, firstTokenAt: 1510, completedAt: 2000, displayedAt: 1530, outcome: 'completed' });
    const t = tracker.get('r1');
    if (!t) throw new Error('missing trace');
    expect(milestoneValue(t, 'detect')).toBe(300);
    expect(milestoneValue(t, 'dispatch')).toBe(310);
    expect(milestoneValue(t, 'ttft')).toBe(200);
    expect(milestoneValue(t, 'firstText')).toBe(510);
    expect(milestoneValue(t, 'displayed')).toBe(530);
    expect(milestoneValue(t, 'complete')).toBe(1000);
    tracker.start({ requestId: 'r2', questionId: 'q2', kind: 'auto', provider: 'mock', simulated: true, textAvailableAt: 0, detectedAt: 0 });
    tracker.start({ requestId: 'r3', questionId: 'q3', kind: 'auto', provider: 'mock', simulated: true, textAvailableAt: 0, detectedAt: 0 });
    expect(tracker.get('r1')).toBeUndefined();
    expect(tracker.summary().detect.n).toBe(2);
  });

  it('excludes unfinished answers from completion stats', () => {
    const tracker = new LatencyTracker();
    tracker.start({ requestId: 'r1', questionId: 'q1', kind: 'auto', provider: 'mock', simulated: true, textAvailableAt: 0, detectedAt: 10, outcome: 'cancelled', completedAt: 50 });
    expect(tracker.summary().complete.n).toBe(0);
  });
});

describe('TextAvailability', () => {
  it('finds the first transcript state that contained the complete question', () => {
    const ta = new TextAvailability();
    ta.observe('Can you explain', 100);
    ta.observe('Can you explain the difference between a process and a thread', 400);
    ta.observe('Can you explain the difference between a process and a thread?', 700);
    expect(ta.availableAt('Can you explain the difference between a process and a thread?', 900)).toBe(400);
    expect(ta.availableAt('Something never said?', 900)).toBe(900);
  });
});

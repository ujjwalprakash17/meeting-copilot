import { describe, expect, it } from 'vitest';
import { chooseAssistantPlacement, displayOf, type DisplayLike } from './displayPlacement.js';

const display = (id: string, left: number, width: number, isPrimary = false): DisplayLike => ({
  id,
  name: `Display ${id}`,
  isPrimary,
  bounds: { left, top: 0, width, height: 1080 },
  workArea: { left, top: 0, width, height: 1040 },
});
const laptop = display('1', 0, 1920, true);
const monitor = display('2', 1920, 2560);
const size = { width: 440, height: 780 };

describe('assistant display placement', () => {
  it('reports a single display (nothing can keep the window out of an entire-screen share)', () => {
    expect(chooseAssistantPlacement([laptop], { left: 0, top: 0, width: 1200, height: 800 }, null, size)).toEqual({ kind: 'single-display' });
  });

  it('moves the assistant to the display that does not show the meeting', () => {
    const p = chooseAssistantPlacement([laptop, monitor], { left: 100, top: 100, width: 1200, height: 800 }, { left: 300, top: 50, width: 440, height: 780 }, size);
    expect(p.kind).toBe('move');
    if (p.kind !== 'move') return;
    expect(p.display.id).toBe('2');
    expect(displayOf([laptop, monitor], p.bounds)?.id).toBe('2');
    expect(p.bounds).toEqual({ left: 1920 + 2560 - 440 - 16, top: 16, width: 440, height: 780 });
  });

  it('works when the meeting is on the secondary display', () => {
    const p = chooseAssistantPlacement([laptop, monitor], { left: 2000, top: 0, width: 1800, height: 1000 }, null, size);
    expect(p.kind === 'move' && p.display.id).toBe('1');
  });

  it('leaves the window alone when the user already placed it on another display', () => {
    const p = chooseAssistantPlacement([laptop, monitor], { left: 0, top: 0, width: 1920, height: 1040 }, { left: 3000, top: 200, width: 440, height: 780 }, size);
    expect(p).toMatchObject({ kind: 'already-separate', display: { id: '2' } });
  });

  it('assumes the primary display when the meeting window is unknown, and fits small work areas', () => {
    const small = display('3', -1280, 1280);
    const p = chooseAssistantPlacement([laptop, small], null, null, { width: 2000, height: 2000 });
    expect(p.kind === 'move' && p.display.id).toBe('3');
    if (p.kind === 'move') {
      expect(p.bounds.width).toBe(1280 - 32);
      expect(p.bounds.height).toBe(1040 - 32);
    }
  });
});

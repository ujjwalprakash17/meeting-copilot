/**
 * Where to put the assistant window so it is NOT on the same display as the meeting window.
 *
 * Why: an "Entire screen" share captures every window on the shared display, and neither Chrome nor
 * the web platform lets an extension exclude a window from that capture. What does work: keep the
 * assistant on another physical display and share only the meeting's display (or, better, just the
 * meeting tab or window). This module only does geometry; it does not detect what is being shared.
 */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DisplayLike {
  id: string;
  name: string;
  isPrimary: boolean;
  bounds: Rect;
  workArea: Rect;
}

export type Placement =
  | { kind: 'single-display' }
  | { kind: 'already-separate'; display: DisplayLike }
  | { kind: 'move'; display: DisplayLike; bounds: Rect };

const intersection = (a: Rect, b: Rect) => {
  const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
};

/** The display showing most of a window (null when it overlaps none, e.g. minimized off-screen). */
export function displayOf(displays: DisplayLike[], rect: Rect): DisplayLike | null {
  let best: DisplayLike | null = null;
  let bestArea = 0;
  for (const d of displays) {
    const area = intersection(d.bounds, rect);
    if (area > bestArea) {
      best = d;
      bestArea = area;
    }
  }
  return best;
}

/**
 * @param meeting  bounds of the window containing the meeting tab (null if unknown: assume the primary display)
 * @param assistant current bounds of the assistant window (null if not open yet)
 * @param size     preferred assistant size
 */
export function chooseAssistantPlacement(
  displays: DisplayLike[],
  meeting: Rect | null,
  assistant: Rect | null,
  size: { width: number; height: number },
): Placement {
  if (displays.length < 2) return { kind: 'single-display' };
  const meetingDisplay = (meeting && displayOf(displays, meeting)) ?? displays.find((d) => d.isPrimary) ?? displays[0] ?? null;
  const current = assistant ? displayOf(displays, assistant) : null;
  // Respect where the user already put it, as long as it is not on the meeting's display.
  if (current && current.id !== meetingDisplay?.id) return { kind: 'already-separate', display: current };
  const others = displays.filter((d) => d.id !== meetingDisplay?.id);
  const target = others.sort((a, b) => b.workArea.width * b.workArea.height - a.workArea.width * a.workArea.height)[0];
  if (!target) return { kind: 'single-display' };
  const margin = 16;
  const width = Math.max(320, Math.min(size.width, target.workArea.width - 2 * margin));
  const height = Math.max(400, Math.min(size.height, target.workArea.height - 2 * margin));
  return {
    kind: 'move',
    display: target,
    bounds: { left: target.workArea.left + target.workArea.width - width - margin, top: target.workArea.top + margin, width, height },
  };
}

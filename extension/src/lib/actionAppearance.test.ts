import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { actionAppearance, actionIconPaths } from './actionAppearance';
import { IDLE_STATUS, type SessionStatus } from './settings';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const status = (over: Partial<SessionStatus>): SessionStatus => ({ ...IDLE_STATUS, ...over });

describe('toolbar icon appearance', () => {
  it('is grey with no badge when not listening', () => {
    expect(actionAppearance(IDLE_STATUS)).toMatchObject({ icon: 'idle', badgeText: '', title: 'Meeting Copilot' });
    expect(actionAppearance(status({ phase: 'stopping', mode: 'live' }))).toMatchObject({ icon: 'idle', badgeText: '' });
  });

  it('is blue with no REC/SIM badge while listening, live or simulation', () => {
    for (const phase of ['starting', 'live', 'reconnecting'] as const) {
      expect(actionAppearance(status({ phase, mode: 'live', tabTitle: 'Standup' }))).toEqual({
        icon: 'active',
        badgeText: '',
        badgeColor: expect.any(String),
        title: 'Meeting Copilot: listening to "Standup"',
      });
    }
    expect(actionAppearance(status({ phase: 'live', mode: 'simulation' }))).toMatchObject({ icon: 'active', badgeText: '', title: 'Meeting Copilot: simulation (test mode)' });
  });

  it('keeps a small ERR badge on errors so a failure is noticed', () => {
    expect(actionAppearance(status({ phase: 'error', message: 'Cannot reach the server' }))).toMatchObject({
      icon: 'idle',
      badgeText: 'ERR',
      title: 'Meeting Copilot: Cannot reach the server',
    });
  });

  it('points at icon files that exist, and the manifest starts with the grey icon', () => {
    for (const set of ['idle', 'active'] as const) {
      for (const file of Object.values(actionIconPaths(set))) expect(existsSync(path.join(publicDir, file)), file).toBe(true);
    }
    const manifest = JSON.parse(readFileSync(path.join(publicDir, 'manifest.json'), 'utf8')) as { action: { default_icon: Record<string, string> } };
    expect(manifest.action.default_icon).toEqual(actionIconPaths('idle'));
  });
});

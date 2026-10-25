import { describe, expect, it } from 'vitest';
import { checkSite } from './sites.js';

const opts = { allowAnyTab: false, serverUrl: 'http://localhost:8787' };

describe('checkSite', () => {
  it.each([
    ['https://meet.google.com/abc-defg-hij', 'Google Meet'],
    ['https://teams.microsoft.com/v2/', 'Microsoft Teams'],
    ['https://teams.live.com/v2/', 'Microsoft Teams'],
    ['https://teams.cloud.microsoft/', 'Microsoft Teams'],
    ['http://localhost:8787/test/', 'Local audio test page'],
  ])('supports %s', (url, platform) => {
    expect(checkSite(url, opts)).toMatchObject({ supported: true, platform });
  });

  it('rejects other pages unless testing mode is enabled', () => {
    expect(checkSite('https://example.com', opts).supported).toBe(false);
    expect(checkSite('https://meet.google.com.evil.example/', opts).supported).toBe(false);
    expect(checkSite('chrome://settings', { ...opts, allowAnyTab: true }).supported).toBe(false);
    expect(checkSite(undefined, opts).supported).toBe(false);
    expect(checkSite('https://example.com', { ...opts, allowAnyTab: true }).supported).toBe(true);
  });
});

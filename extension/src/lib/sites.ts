/** Pages where audio capture is offered by default. */
const MEETING_HOSTS: Array<{ host: RegExp; platform: string }> = [
  { host: /^meet\.google\.com$/, platform: 'Google Meet' },
  { host: /^teams\.microsoft\.com$/, platform: 'Microsoft Teams' },
  { host: /^teams\.live\.com$/, platform: 'Microsoft Teams' },
  { host: /^teams\.cloud\.microsoft$/, platform: 'Microsoft Teams' },
];

export interface SiteCheck {
  supported: boolean;
  platform: string | null;
  reason?: string;
}

export function checkSite(url: string | undefined, opts: { allowAnyTab: boolean; serverUrl: string }): SiteCheck {
  if (!url) return { supported: false, platform: null, reason: 'Open a Google Meet or Microsoft Teams tab, then click the extension icon on that tab.' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { supported: false, platform: null, reason: 'This page cannot be captured.' };
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return { supported: false, platform: null, reason: 'Browser and extension pages cannot be captured.' };
  }
  const meeting = MEETING_HOSTS.find((m) => m.host.test(parsed.hostname));
  if (meeting) return { supported: true, platform: meeting.platform };
  try {
    const server = new URL(opts.serverUrl);
    if (parsed.host === server.host && parsed.pathname.startsWith('/test')) return { supported: true, platform: 'Local audio test page' };
  } catch {
    // ignore invalid server URL
  }
  if (opts.allowAnyTab) return { supported: true, platform: 'Other tab (testing)' };
  return {
    supported: false,
    platform: null,
    reason: 'This tab is not Google Meet or Microsoft Teams. (Enable "Allow capture on any tab" in Settings for testing.)',
  };
}

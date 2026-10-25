import type { ServerConfig } from '../config.js';

const EXTENSION_ORIGIN = /^chrome-extension:\/\/([a-p]{32})$/;
/** Test/dev ids used by the integration tests. */
const TEST_ORIGIN = /^chrome-extension:\/\/([a-z0-9-]{1,64})$/;

/**
 * Only the Chrome extension may talk to this server. Web pages (including the meeting page)
 * cannot spoof the Origin header from a browser, so rejecting http(s) origins prevents arbitrary
 * websites from driving the local server or reading its responses.
 */
export function isAllowedOrigin(origin: string | undefined, config: Pick<ServerConfig, 'allowedExtensionIds' | 'allowNoOrigin'>): boolean {
  if (!origin) return config.allowNoOrigin;
  const match = EXTENSION_ORIGIN.exec(origin) ?? (config.allowNoOrigin ? TEST_ORIGIN.exec(origin) : null);
  if (!match) return false;
  if (config.allowedExtensionIds.length === 0) return true;
  return config.allowedExtensionIds.includes(match[1] ?? '');
}

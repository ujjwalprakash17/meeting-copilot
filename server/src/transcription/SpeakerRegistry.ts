/**
 * Turns provider diarization labels into session speaker numbers that never collide.
 *
 * Deepgram's streaming speaker numbers are only meaningful within one connection: after a reconnect it
 * starts again at 0, so "speaker 0" may now be a different person. Each (scope, provider label) pair
 * therefore gets its own session number, allocated in order of first appearance. Labels from a new
 * scope are never merged with earlier ones (we cannot know who is who across connections), and the
 * caller is told once so the UI can say the numbering restarted. No identities are inferred.
 */
export class SpeakerRegistry {
  private readonly map = new Map<string, number>();
  private next: number;
  private scopesSeen = new Set<number>();

  /** @param offset first session number to allocate (continuing after an extension reconnect) */
  constructor(offset = 0) {
    this.next = offset;
  }

  /**
   * Session speaker number for a provider label, or undefined when the provider gave none.
   * `onNewScope` fires the first time a scope after the first one produces a label.
   */
  resolve(providerSpeaker: number | undefined, scope = 1, onNewScope?: () => void): number | undefined {
    if (providerSpeaker === undefined) return undefined;
    if (!this.scopesSeen.has(scope)) {
      if (this.scopesSeen.size > 0) onNewScope?.();
      this.scopesSeen.add(scope);
    }
    const key = `${scope}:${providerSpeaker}`;
    let n = this.map.get(key);
    if (n === undefined) {
      n = this.next++;
      this.map.set(key, n);
    }
    return n;
  }

  /** Number of session speaker labels allocated so far (including the starting offset). */
  get count(): number {
    return this.next;
  }
}

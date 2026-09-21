// In-memory replay-protection store for one-shot signed URLs.
//
// Trade-off: persistence across container restarts is intentionally NOT
// implemented. A leaked URL replayed across a restart of the sidecar is
// the residual risk we accept — restarts are rare, the TTL is short
// (default 10 min), and the alternative (Supabase round-trip from sidecar
// for every verify) trades durability for added attack surface and latency
// on the hot path.

import type { Logger } from "../logger.js";

interface ConsumedEntry {
  expiresAt: number;
}

export class NonceStore {
  private readonly entries = new Map<string, ConsumedEntry>();
  private pruneTimer: NodeJS.Timeout | null = null;

  constructor(private readonly logger: Logger) {}

  /**
   * Returns true if this nonce was NOT seen before (and records it).
   * Returns false if the nonce was already consumed within its TTL.
   * Discards stale entries on the way through (lazy pruning).
   */
  consume(key: string, expiresAtMs: number): boolean {
    const now = Date.now();
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > now) {
      // Already consumed and still within TTL → replay
      return false;
    }
    this.entries.set(key, { expiresAt: expiresAtMs });
    return true;
  }

  /**
   * Periodic prune so the map doesn't grow unbounded across long uptimes.
   * Runs every 5 minutes; idempotent — safe to call multiple times.
   */
  startPruner(): void {
    if (this.pruneTimer) return;
    this.pruneTimer = setInterval(() => {
      const now = Date.now();
      let removed = 0;
      for (const [key, value] of this.entries) {
        if (value.expiresAt <= now) {
          this.entries.delete(key);
          removed++;
        }
      }
      if (removed > 0) {
        this.logger.debug({ removed, remaining: this.entries.size }, "nonce-store pruned");
      }
    }, 5 * 60 * 1000);
    // Don't block process shutdown waiting for the timer.
    this.pruneTimer.unref?.();
  }

  stopPruner(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  /** Test-only: inspect store size. */
  size(): number {
    return this.entries.size;
  }
}

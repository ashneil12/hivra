// Replay-protection store for one-shot signed URLs, persisted to a small
// JSON file on the sidecar's state volume.
//
// The in-memory-only design accepted a real hole: a signed noVNC URL is a
// bearer credential, and a restart wiped the consumed set, so any URL still
// inside its TTL became replayable. Persisting consumed nonces to disk
// closes that without adding network surface — writes are atomic
// (tmp+rename), best-effort (a failed persist keeps the in-memory record
// and logs a warning; replay protection must not depend on disk health),
// and bounded (entries expire with their URL's TTL).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Logger } from "../logger.js";

interface ConsumedEntry {
  expiresAt: number;
}

export class NonceStore {
  private readonly entries = new Map<string, ConsumedEntry>();
  private pruneTimer: NodeJS.Timeout | null = null;
  private readonly filePath: string | null;

  constructor(private readonly logger: Logger, stateDir?: string) {
    this.filePath = stateDir ? join(stateDir, "consumed-nonces.json") : null;
    if (this.filePath) this.load();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath as string, "utf8");
      const parsed = JSON.parse(raw) as Record<string, { expiresAt: number }>;
      const now = Date.now();
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value?.expiresAt === "number" && value.expiresAt > now) {
          this.entries.set(key, { expiresAt: value.expiresAt });
        }
      }
    } catch {
      // Missing/corrupt file just means an empty store — never block boot.
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.entries)), {
        mode: 0o600,
      });
      renameSync(tmp, this.filePath);
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message },
        "nonce-store persist failed; replay protection is memory-only until next write",
      );
    }
  }

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
    this.persist();
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
        this.persist();
        this.logger.debug({ removed, remaining: this.entries.size }, "nonce-store pruned");
      }
    }, 5 * 60 * 1000);
    // Don't block process shutdown waiting for the timer.
    this.pruneTimer.unref?.();
  }

  /** Test-only: inspect store size. */
  size(): number {
    return this.entries.size;
  }
}

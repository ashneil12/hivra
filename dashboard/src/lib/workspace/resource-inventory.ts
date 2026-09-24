/**
 * One browser-side copy of the two lists every switcher reads: Hermes agents
 * (`/api/instances?summary=true`) and Hivra agents and computers
 * (`/api/hivra/agents`).
 *
 * The sidebar re-read both on every page change, and Home read the same pair
 * again for its own list, so opening Home fetched each list twice and moving
 * between pages kept re-fetching lists that had not changed. Now a read is
 * shared: callers that ask while one is in flight join it, and a read younger
 * than the freshness window is reused. An explicit refresh (Retry, Refresh,
 * opening ⌘K) always reads again, and returning to the tab re-reads anything
 * that has gone stale.
 *
 * A held list can be out of date inside that window. A change made in this
 * browser (a delete, a stop, a rename) calls `invalidate`, so nothing reuses
 * the list from before it. A view that acts on the list by itself, such as
 * Home offering to continue in an agent, does not trust a held list at all: it
 * waits for a read made since it opened (see `readMark`).
 *
 * It holds the response bodies as they came, and each caller parses them into
 * its own shape. A body that is not the envelope its route promises counts as
 * a failed read, so the last good one is kept. The owner records which account
 * the lists belong to; every reader compares it with its own account before
 * showing anything, so one account's list is never shown to another after a
 * switch.
 */

export type InventorySource = "hermes" | "hivra";

export const INVENTORY_SOURCES = ["hermes", "hivra"] as const satisfies readonly InventorySource[];

export const INVENTORY_PATHS: Record<InventorySource, string> = {
  hermes: "/api/instances?summary=true",
  hivra: "/api/hivra/agents",
};

/** How long a read is reused before the next caller reads again. */
export const INVENTORY_FRESH_MS = 15_000;

export interface InventorySourceState {
  /** The last accepted response body; undefined until one arrives. */
  readonly body: unknown;
  readonly hasBody: boolean;
  /** A read is in flight. */
  readonly pending: boolean;
  /** The latest settled read failed; `body`, if any, is the last known one. */
  readonly failed: boolean;
  /** When the latest read settled (ms), or 0 before the first. */
  readonly settledAt: number;
  /**
   * Which read the state settled from. Reads are numbered in the order they
   * start, so a view can tell a read made since it opened from an older one
   * (see `readMark`). 0 before the first.
   */
  readonly read: number;
}

export interface InventorySnapshot {
  /** The account these lists belong to, or null before any caller said. */
  readonly owner: string | null;
  readonly hermes: InventorySourceState;
  readonly hivra: InventorySourceState;
}

type SourceFetcher = (signal: AbortSignal) => Promise<unknown>;

export interface ResourceInventory {
  subscribe(listener: () => void): () => void;
  getSnapshot(): InventorySnapshot;
  getServerSnapshot(): InventorySnapshot;
  /**
   * Reads `source` unless a usable read exists: one in flight, or a settled one
   * younger than the freshness window that no change has made out of date.
   * `revalidate` reuses only a read in flight, which answers as of now;
   * `force` always reads, replacing one in flight. Never rejects.
   */
  load(source: InventorySource, options?: { force?: boolean; revalidate?: boolean }): Promise<void>;
  /**
   * For a view opening now: a state whose `read` is above this mark came from
   * a read made, or still in flight, since this moment. A read already in
   * flight counts, since it has not answered yet.
   */
  readMark(source: InventorySource): number;
  /**
   * The held list predates a change made in this browser. It is not reused
   * again, a read in flight is replaced (it may predate the change too), and a
   * list someone is showing is read again now.
   */
  invalidate(source: InventorySource): void;
  /**
   * Scopes the lists to an account. The first owner adopts whatever is held;
   * a different one drops it and cancels reads in flight.
   */
  setOwner(owner: string): void;
  reset(): void;
}

const INITIAL_SOURCE: InventorySourceState = Object.freeze({
  body: undefined,
  hasBody: false,
  pending: false,
  failed: false,
  settledAt: 0,
  read: 0,
});

const INITIAL_SNAPSHOT: InventorySnapshot = Object.freeze({
  owner: null,
  hermes: INITIAL_SOURCE,
  hivra: INITIAL_SOURCE,
});

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The envelope each route promises; row-level checks stay with each reader. */
export function isInventoryEnvelope(source: InventorySource, body: unknown): boolean {
  const envelope = asRecord(body);
  if (!envelope || envelope.success !== true) return false;
  if (source === "hermes") return Array.isArray(envelope.data);
  return Array.isArray(asRecord(envelope.data)?.agents);
}

function defaultFetcher(source: InventorySource): SourceFetcher {
  return async (signal) => {
    const response = await fetch(INVENTORY_PATHS[source], { cache: "no-store", signal });
    if (!response.ok) throw new Error("Resource list unavailable");
    return response.json();
  };
}

export function createResourceInventory(options: {
  fetchers?: Partial<Record<InventorySource, SourceFetcher>>;
  now?: () => number;
  freshMs?: number;
} = {}): ResourceInventory {
  const now = options.now ?? (() => Date.now());
  const freshMs = options.freshMs ?? INVENTORY_FRESH_MS;
  const fetchers: Record<InventorySource, SourceFetcher> = {
    hermes: options.fetchers?.hermes ?? defaultFetcher("hermes"),
    hivra: options.fetchers?.hivra ?? defaultFetcher("hivra"),
  };
  const listeners = new Set<() => void>();
  const inflight: Partial<Record<InventorySource, { controller: AbortController; done: Promise<void>; read: number }>> = {};
  let snapshot = INITIAL_SNAPSHOT;
  // Bumped whenever held data stops being trustworthy (owner change, reset),
  // so a read that started before cannot land after.
  let epoch = 0;
  // Reads started so far. Never reset, so marks handed out stay comparable.
  let started = 0;
  // Reads numbered at or below this predate a change, and are not reused.
  const outdated: Record<InventorySource, number> = { hermes: 0, hivra: 0 };

  const emit = () => {
    for (const listener of [...listeners]) listener();
  };

  const update = (source: InventorySource, next: Partial<InventorySourceState>) => {
    snapshot = { ...snapshot, [source]: { ...snapshot[source], ...next } };
    emit();
  };

  const abortAll = () => {
    for (const source of INVENTORY_SOURCES) {
      inflight[source]?.controller.abort();
      delete inflight[source];
    }
  };

  const load = (
    source: InventorySource,
    loadOptions: { force?: boolean; revalidate?: boolean } = {},
  ): Promise<void> => {
    const running = inflight[source];
    const state = snapshot[source];
    if (!loadOptions.force) {
      if (running) return running.done;
      const reusable = !loadOptions.revalidate && state.hasBody && !state.failed
        && state.read > outdated[source] && now() - state.settledAt < freshMs;
      if (reusable) return Promise.resolve();
    }
    // A forced read replaces one in flight: it may predate the change being refreshed.
    running?.controller.abort();
    const controller = new AbortController();
    const startedIn = epoch;
    const read = ++started;
    const current = () => startedIn === epoch && inflight[source]?.controller === controller;
    let request: Promise<unknown>;
    try {
      request = Promise.resolve(fetchers[source](controller.signal));
    } catch (error) {
      request = Promise.reject(error);
    }
    const settle = (next: Partial<InventorySourceState>) => {
      if (!current()) return;
      delete inflight[source];
      update(source, { ...next, pending: false, settledAt: now(), read });
    };
    const done = request.then(
      (body) => settle(isInventoryEnvelope(source, body) ? { body, hasBody: true, failed: false } : { failed: true }),
      () => settle({ failed: true }),
    );
    inflight[source] = { controller, done, read };
    if (!state.pending) update(source, { pending: true });
    return done;
  };

  // Returning to the tab re-reads anything already read and now stale. A list
  // nobody has asked for (Hivra where it is off) is never read this way.
  const revalidate = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    for (const source of INVENTORY_SOURCES) {
      if (snapshot[source].settledAt > 0) void load(source);
    }
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1 && typeof window !== "undefined") {
        window.addEventListener("focus", revalidate);
        document.addEventListener("visibilitychange", revalidate);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && typeof window !== "undefined") {
          window.removeEventListener("focus", revalidate);
          document.removeEventListener("visibilitychange", revalidate);
        }
      };
    },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => INITIAL_SNAPSHOT,
    load,
    readMark(source) {
      const running = inflight[source];
      return running ? running.read - 1 : started;
    },
    invalidate(source) {
      outdated[source] = started;
      // A list nobody has asked for (Hivra where it is off) is not read this way.
      const shown = listeners.size > 0 && snapshot[source].settledAt > 0;
      if (inflight[source] || shown) void load(source, { force: true });
    },
    setOwner(owner) {
      if (snapshot.owner === owner) return;
      if (snapshot.owner !== null) {
        epoch += 1;
        abortAll();
        snapshot = { ...INITIAL_SNAPSHOT, owner };
      } else {
        snapshot = { ...snapshot, owner };
      }
      emit();
    },
    reset() {
      epoch += 1;
      abortAll();
      snapshot = INITIAL_SNAPSHOT;
      emit();
    },
  };
}

/** The one copy the dashboard shares. */
export const resourceInventory = createResourceInventory();

/** Drops the shared copy, for tests that need a cold start. */
export function resetResourceInventory(): void {
  resourceInventory.reset();
}

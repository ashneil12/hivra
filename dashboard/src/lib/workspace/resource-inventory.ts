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
 * It holds the response bodies as they came, and each caller parses them into
 * its own shape. A body that is not the envelope its route promises counts as
 * a failed read, so the last good one is kept. The owner key keeps one
 * account's list from being shown to another after a switch.
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
  /** Reads `source` unless a fresh read exists; `force` always reads. Never rejects. */
  load(source: InventorySource, options?: { force?: boolean }): Promise<void>;
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
  const inflight: Partial<Record<InventorySource, { controller: AbortController; done: Promise<void> }>> = {};
  let snapshot = INITIAL_SNAPSHOT;
  // Bumped whenever held data stops being trustworthy (owner change, reset),
  // so a read that started before cannot land after.
  let epoch = 0;

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

  const load = (source: InventorySource, loadOptions: { force?: boolean } = {}): Promise<void> => {
    const running = inflight[source];
    const state = snapshot[source];
    if (!loadOptions.force) {
      if (running) return running.done;
      if (state.hasBody && !state.failed && now() - state.settledAt < freshMs) return Promise.resolve();
    }
    // A forced read replaces one in flight: it may predate the change being refreshed.
    running?.controller.abort();
    const controller = new AbortController();
    const startedIn = epoch;
    const current = () => startedIn === epoch && inflight[source]?.controller === controller;
    let request: Promise<unknown>;
    try {
      request = Promise.resolve(fetchers[source](controller.signal));
    } catch (error) {
      request = Promise.reject(error);
    }
    const done = request.then(
      (body) => {
        if (!current()) return;
        delete inflight[source];
        if (isInventoryEnvelope(source, body)) {
          update(source, { body, hasBody: true, pending: false, failed: false, settledAt: now() });
        } else {
          update(source, { pending: false, failed: true, settledAt: now() });
        }
      },
      () => {
        if (!current()) return;
        delete inflight[source];
        update(source, { pending: false, failed: true, settledAt: now() });
      },
    );
    inflight[source] = { controller, done };
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

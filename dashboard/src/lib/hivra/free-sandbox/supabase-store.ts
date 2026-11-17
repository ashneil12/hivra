/**
 * The bridge's own records over Supabase, as the `BridgeStore` port: the `free_sandbox_*` tables (see the migration
 * `20261117210000_free_sandbox_bridge.sql`). Service role only: the client is injected, and those tables have RLS on
 * with no policies, so only the service role reads or writes them.
 *
 * Nothing here logs. A failed query throws an Error that names the table and the operation and nothing else: never the
 * database's own message, which can carry values, and never a row. Inputs that become keys or filters (org, server,
 * sandbox and computer ids, the day, an archive location) are checked first, and a bad one throws without echoing it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { archiveLocation } from "./archive-store";
import type { ArchiveCopy, BridgeStore, Placement, PlacementState, PoolServer } from "./ports";

/** The paid side's capacity on one pool server, read from the paid side's own records. */
export interface PaidCapacity {
  paidReserveIntact: boolean;
  paidWaiting: boolean;
}

/** Reads one pool server's paid capacity. It may throw; the store then closes that server to Free. */
export type PaidCapacityReader = (serverId: string) => Promise<PaidCapacity>;

type AiKind = "answered" | "refused" | "failed";

const TABLES = {
  servers: "free_sandbox_pool_servers",
  placements: "free_sandbox_placements",
  wakes: "free_sandbox_wakes",
  waitlist: "free_sandbox_waitlist",
  aiDays: "free_sandbox_ai_days",
  state: "free_sandbox_state",
  pendingErasures: "free_sandbox_pending_erasures",
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const AI_KINDS: readonly AiKind[] = ["answered", "refused", "failed"];
const PLACEMENT_STATES: ReadonlySet<PlacementState> = new Set<PlacementState>([
  "placing",
  "awake",
  "stopped",
  "packing",
  "packed",
  "restoring",
  "flagged",
]);

/**
 * The location shape archive-store.ts writes (its LOCATION constant is not exported, so the shape is mirrored here).
 * A location passes only if it matches this AND `archiveLocation`, the archive store's own writer, produces it again
 * from the ids it names. That second check applies the same sandbox-id and digest rules the archive store applies.
 */
const ARCHIVE_LOCATION = /^free-sandbox\/([^/]+)\/([^/]+)\.tar\.zst$/;

/**
 * How many times one AI count retries its compare-and-set before it gives up. Passes do not overlap, so a retry is
 * rare; the bound only stops a runaway loop if something keeps writing the same day's counter.
 */
const COUNT_ATTEMPTS = 5;

/** A row of `free_sandbox_pool_servers` as the bridge reads it (only the columns it uses). */
interface ServerRow {
  id: string;
  cpus: number | string;
}

/** A row of `free_sandbox_placements`. */
interface PlacementRow {
  org_id: string;
  sandbox_id: string;
  computer_id: string;
  owner_hash: string;
  machine_id: string | null;
  server_id: string | null;
  state: string;
  placed_at: string;
  state_at: string;
  archive_location: string | null;
  archive_sha256: string | null;
  archive_bytes: number | string | null;
  problem: string | null;
}

/** The archive columns of a placement row. */
type ArchiveColumn = "archive_location" | "archive_sha256" | "archive_bytes";

/**
 * The columns a placement save writes. The archive columns are present only when the placement carries a copy (see
 * `save`), so a save without one leaves the stored copy's columns out of the upsert.
 */
type PlacementWrite = Omit<PlacementRow, ArchiveColumn> & Partial<Pick<PlacementRow, ArchiveColumn>>;

/** A row of `free_sandbox_ai_days`. */
interface AiDayRow {
  answered: number | string;
  refused: number | string;
  failed: number | string;
}

/** A row of `free_sandbox_pending_erasures`. */
interface PendingErasureRow {
  location: string;
  sha256: string;
  bytes: number | string;
  added_at: string;
}

/** Fails the store call when the query returned an error. The message names the table and operation only. */
function assertOk(result: { error: unknown }, table: string, op: string): void {
  if (result.error) throw new Error(`free sandbox store: ${op} on ${table} failed`);
}

/** Returns `value` when it matches `pattern`; otherwise throws, naming what was wrong but not echoing the value. */
function requireMatch(value: string, pattern: RegExp, what: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`free sandbox store: invalid ${what}`);
  return value;
}

/**
 * PostgREST's text for a timestamptz: ISO 8601 with a time zone. The shape is checked before parsing because the
 * Date parser accepts loose text (it reads some plain words as dates), and a stored value that is not a timestamp
 * should fail here.
 */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Reads a timestamptz column as a Date; a value that is not a timestamp throws without echoing it. */
function parseTime(value: unknown, table: string, column: string): Date {
  const time = typeof value === "string" && TIMESTAMP.test(value) ? new Date(value) : new Date(Number.NaN);
  if (Number.isNaN(time.getTime())) throw new Error(`free sandbox store: ${table}.${column} is not a timestamp`);
  return time;
}

/** A Date as the ISO text a timestamptz column takes; an invalid Date throws without echoing anything. */
function isoOf(time: Date, what: string): string {
  if (!(time instanceof Date) || Number.isNaN(time.getTime())) throw new Error(`free sandbox store: invalid ${what}`);
  return time.toISOString();
}

/** A numeric or bigint column that PostgREST may send as a string or a number. */
function numberOf(value: number | string | null | undefined): number {
  return Number(value ?? 0);
}

/** Whether a nullable column holds a value (null and missing both mean none). */
function present<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/** Whether `archiveLocation`, the archive store's writer, produces exactly this location for these ids. */
function writtenBy(sandboxId: string, sha256: string, location: string): boolean {
  try {
    return archiveLocation(sandboxId, sha256) === location;
  } catch {
    return false;
  }
}

/** Checks an archive location and returns the sandbox id and digest it names. Anything else throws, unechoed. */
function archiveRefOf(location: unknown): { sandboxId: string; sha256: string } {
  const match = typeof location === "string" ? ARCHIVE_LOCATION.exec(location) : null;
  if (!match || !writtenBy(match[1], match[2], location as string)) {
    throw new Error("free sandbox store: invalid archive location");
  }
  return { sandboxId: match[1], sha256: match[2] };
}

/** An archive size: a safe, non-negative integer. */
function requireBytes(bytes: unknown): number {
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error("free sandbox store: invalid archive size");
  }
  return bytes;
}

/**
 * Checks an archive copy before it is stored or after it is read: a location the archive store writes, a digest that
 * is the location's own, and a safe non-negative size.
 */
function requireArchiveCopy(copy: ArchiveCopy): ArchiveCopy {
  const ref = archiveRefOf(copy.location);
  if (copy.sha256 !== ref.sha256 || !HEX64.test(copy.sha256)) {
    throw new Error("free sandbox store: invalid archive digest");
  }
  return { location: copy.location, sha256: copy.sha256, bytes: requireBytes(copy.bytes) };
}

/**
 * The stored copy a placement row carries, or null. The table's check makes the three columns all set or all null; a
 * row with only some of them is drift, and it throws rather than reading as "no copy".
 */
function archiveOf(row: PlacementRow): ArchiveCopy | null {
  const set = [row.archive_location, row.archive_sha256, row.archive_bytes].filter(present).length;
  if (set === 0) return null;
  if (set !== 3) throw new Error(`free sandbox store: ${TABLES.placements} archive columns are partial`);
  return requireArchiveCopy({
    location: row.archive_location as string,
    sha256: row.archive_sha256 as string,
    bytes: Number(row.archive_bytes),
  });
}

/** Maps a `free_sandbox_placements` row to the bridge's Placement. */
function toPlacement(row: PlacementRow): Placement {
  const table = TABLES.placements;
  if (!PLACEMENT_STATES.has(row.state as PlacementState)) {
    throw new Error(`free sandbox store: ${table}.state is not a known state`);
  }
  return {
    orgId: row.org_id,
    sandbox: { sandboxId: row.sandbox_id, computerId: row.computer_id, ownerHash: row.owner_hash },
    machineId: row.machine_id,
    serverId: row.server_id,
    state: row.state as PlacementState,
    placedAt: parseTime(row.placed_at, table, "placed_at"),
    stateAt: parseTime(row.state_at, table, "state_at"),
    archive: archiveOf(row),
    problem: row.problem,
  };
}

/**
 * Maps a Placement to the columns a save writes, checking every id and digest that becomes a column. The archive
 * columns are included only when the placement carries a copy.
 */
function toPlacementRow(placement: Placement): PlacementWrite {
  const { sandbox, archive } = placement;
  if (!PLACEMENT_STATES.has(placement.state)) throw new Error("free sandbox store: invalid placement state");
  const row: PlacementWrite = {
    org_id: requireMatch(placement.orgId, UUID, "org id"),
    sandbox_id: requireMatch(sandbox.sandboxId, UUID, "sandbox id"),
    computer_id: requireMatch(sandbox.computerId, UUID, "computer id"),
    owner_hash: requireMatch(sandbox.ownerHash, HEX64, "owner digest"),
    machine_id: present(placement.machineId) ? requireMatch(placement.machineId, UUID, "machine id") : null,
    server_id: present(placement.serverId) ? requireMatch(placement.serverId, SLUG, "server id") : null,
    state: placement.state,
    placed_at: isoOf(placement.placedAt, "placed time"),
    state_at: isoOf(placement.stateAt, "state time"),
    problem: placement.problem,
  };
  if (!archive) return row;
  const copy = requireArchiveCopy(archive);
  return { ...row, archive_location: copy.location, archive_sha256: copy.sha256, archive_bytes: copy.bytes };
}

/** Checks a pool-server cpus value from the database; it must be a positive number. */
function cpusOf(value: number | string): number {
  const cpus = Number(value);
  if (!Number.isFinite(cpus) || cpus <= 0)
    throw new Error("free sandbox store: free_sandbox_pool_servers.cpus is invalid");
  return cpus;
}

/** Checks an AI counter name before it becomes a column name. */
function requireKind(kind: string): AiKind {
  if (!AI_KINDS.includes(kind as AiKind)) throw new Error("free sandbox store: invalid AI reply kind");
  return kind as AiKind;
}

/**
 * The `BridgeStore` port over the `free_sandbox_*` tables, through an injected service-role Supabase client.
 *
 * `paidCapacity` supplies the paid side's reserve and waits per server, since those are not stored in these tables.
 */
export class SupabaseBridgeStore implements BridgeStore {
  constructor(
    private readonly client: SupabaseClient,
    private readonly paidCapacity: PaidCapacityReader,
  ) {}

  /** The enabled pool servers, by id, each with the paid side's capacity read for it. */
  async servers(): Promise<PoolServer[]> {
    const { data, error } = await this.client
      .from(TABLES.servers)
      .select("id, cpus")
      .eq("enabled", true)
      .order("id", { ascending: true });
    assertOk({ error }, TABLES.servers, "select");
    const rows = (data ?? []) as ServerRow[];
    return Promise.all(
      rows.map(async (row) => {
        const paid = await this.paidFor(row.id);
        return { id: row.id, cpus: cpusOf(row.cpus), ...paid };
      }),
    );
  }

  /**
   * The paid side's capacity for one server. If that read throws, the server is closed to Free (no reserve intact,
   * paid waiting), so Free takes nothing there. The error is not surfaced: it may carry values.
   */
  private async paidFor(serverId: string): Promise<PaidCapacity> {
    try {
      const paid = await this.paidCapacity(serverId);
      return { paidReserveIntact: paid.paidReserveIntact, paidWaiting: paid.paidWaiting };
    } catch {
      return { paidReserveIntact: false, paidWaiting: true };
    }
  }

  /** The placement for one workspace, or null when it has none. */
  async placement(orgId: string): Promise<Placement | null> {
    requireMatch(orgId, UUID, "org id");
    const { data, error } = await this.client.from(TABLES.placements).select("*").eq("org_id", orgId).maybeSingle();
    assertOk({ error }, TABLES.placements, "select");
    return data ? toPlacement(data as PlacementRow) : null;
  }

  /** Every placement, oldest first. */
  async placements(): Promise<Placement[]> {
    const { data, error } = await this.client
      .from(TABLES.placements)
      .select("*")
      .order("placed_at", { ascending: true });
    assertOk({ error }, TABLES.placements, "select");
    return ((data ?? []) as PlacementRow[]).map(toPlacement);
  }

  /**
   * Inserts or replaces the workspace's placement, keyed on its org id.
   *
   * Archive rule: a stored copy is never cleared by a save. The archive columns are written only when the placement
   * carries a copy. A placement with no copy leaves them out of the upsert, and an upsert updates only the columns it
   * sends, so the stored copy stays. A copy is replaced only by a new one. A new row with no copy takes the columns'
   * null defaults. (The stored copy is read back and not compared first, so this needs no read-then-write race.)
   */
  async save(placement: Placement): Promise<void> {
    const row = toPlacementRow(placement);
    const { error } = await this.client.from(TABLES.placements).upsert(row, { onConflict: "org_id" });
    assertOk({ error }, TABLES.placements, "upsert");
  }

  /** Removes the workspace's placement. Its wake, if any, goes with it by the table's cascade. */
  async remove(orgId: string): Promise<void> {
    requireMatch(orgId, UUID, "org id");
    const { error } = await this.client.from(TABLES.placements).delete().eq("org_id", orgId);
    assertOk({ error }, TABLES.placements, "delete");
  }

  /** The events feed's cursor, or null when none is stored. */
  async cursor(): Promise<string | null> {
    const { data, error } = await this.client.from(TABLES.state).select("events_cursor").eq("id", true).maybeSingle();
    assertOk({ error }, TABLES.state, "select");
    return (data as { events_cursor: string | null } | null)?.events_cursor ?? null;
  }

  /** Stores the events feed's cursor in the bridge's single state row. */
  async setCursor(cursor: string | null): Promise<void> {
    const { error } = await this.client
      .from(TABLES.state)
      .upsert({ id: true, events_cursor: cursor, updated_at: new Date().toISOString() }, { onConflict: "id" });
    assertOk({ error }, TABLES.state, "upsert");
  }

  /** The wakes waiting for room, oldest first. */
  async wakes(): Promise<{ orgId: string; wantedAt: Date }[]> {
    const { data, error } = await this.client
      .from(TABLES.wakes)
      .select("org_id, wanted_at")
      .order("wanted_at", { ascending: true });
    assertOk({ error }, TABLES.wakes, "select");
    return ((data ?? []) as { org_id: string; wanted_at: string }[]).map((row) => ({
      orgId: row.org_id,
      wantedAt: parseTime(row.wanted_at, TABLES.wakes, "wanted_at"),
    }));
  }

  /**
   * Records a wake for the workspace. A wake already recorded keeps its first `wantedAt`: the insert ignores the
   * conflict rather than replacing the row. The workspace must have a placement (the table's foreign key).
   */
  async addWake(orgId: string, wantedAt: Date): Promise<void> {
    requireMatch(orgId, UUID, "org id");
    const row = { org_id: orgId, wanted_at: isoOf(wantedAt, "wake time") };
    const { error } = await this.client
      .from(TABLES.wakes)
      .upsert(row, { onConflict: "org_id", ignoreDuplicates: true });
    assertOk({ error }, TABLES.wakes, "upsert");
  }

  /** Removes the workspace's wake, if it has one. */
  async removeWake(orgId: string): Promise<void> {
    requireMatch(orgId, UUID, "org id");
    const { error } = await this.client.from(TABLES.wakes).delete().eq("org_id", orgId);
    assertOk({ error }, TABLES.wakes, "delete");
  }

  /** A server's free replies on one UTC day: zeros when none were counted. */
  async aiDay(serverId: string, day: string): Promise<{ answered: number; refused: number; failed: number }> {
    const row = await this.readAiDay(serverId, day);
    return row
      ? { answered: numberOf(row.answered), refused: numberOf(row.refused), failed: numberOf(row.failed) }
      : { answered: 0, refused: 0, failed: 0 };
  }

  /**
   * Adds one reply of `kind` to a server's counter for a UTC day.
   *
   * The write is a compare-and-set, not a plain read-then-write. The counter is updated only if its value is still the
   * one read, and a row is created with `ignoreDuplicates` when none exists. A count that lost a race is retried from
   * a fresh read, so concurrent writers cannot drop each other's increments. The retries are bounded; if they run out,
   * the count throws rather than silently losing it.
   */
  async countAi(serverId: string, day: string, kind: AiKind): Promise<void> {
    requireMatch(serverId, SLUG, "server id");
    requireMatch(day, DAY, "day");
    const counter = requireKind(kind);
    for (let attempt = 0; attempt < COUNT_ATTEMPTS; attempt++) {
      const current = await this.readAiDay(serverId, day);
      const won = current
        ? await this.casIncrement(serverId, day, counter, numberOf(current[counter]))
        : await this.insertFirstCount(serverId, day, counter);
      if (won) return;
    }
    throw new Error(`free sandbox store: count on ${TABLES.aiDays} did not settle`);
  }

  /** The day's raw counter row, or null when the server has none that day. */
  private async readAiDay(serverId: string, day: string): Promise<AiDayRow | null> {
    requireMatch(serverId, SLUG, "server id");
    requireMatch(day, DAY, "day");
    const { data, error } = await this.client
      .from(TABLES.aiDays)
      .select("answered, refused, failed")
      .eq("server_id", serverId)
      .eq("day", day)
      .maybeSingle();
    assertOk({ error }, TABLES.aiDays, "select");
    return (data as AiDayRow | null) ?? null;
  }

  /** Creates the day's row with the first count. False when another writer created it first. */
  private async insertFirstCount(serverId: string, day: string, kind: AiKind): Promise<boolean> {
    const row: Record<string, string | number> = { server_id: serverId, day, answered: 0, refused: 0, failed: 0 };
    row[kind] = 1;
    const { data, error } = await this.client
      .from(TABLES.aiDays)
      .upsert(row, { onConflict: "server_id,day", ignoreDuplicates: true })
      .select("server_id");
    assertOk({ error }, TABLES.aiDays, "upsert");
    return (data ?? []).length === 1;
  }

  /** Sets the counter to `expected + 1` only while it still reads `expected`. False when it moved. */
  private async casIncrement(serverId: string, day: string, kind: AiKind, expected: number): Promise<boolean> {
    const { data, error } = await this.client
      .from(TABLES.aiDays)
      .update({ [kind]: expected + 1 })
      .eq("server_id", serverId)
      .eq("day", day)
      .eq(kind, expected)
      .select("server_id");
    assertOk({ error }, TABLES.aiDays, "update");
    return (data ?? []).length === 1;
  }

  /** Until when the server's free AI refuses its address; null when it is not refused. */
  async aiRefusedUntil(serverId: string): Promise<Date | null> {
    requireMatch(serverId, SLUG, "server id");
    const { data, error } = await this.client
      .from(TABLES.servers)
      .select("ai_refused_until")
      .eq("id", serverId)
      .maybeSingle();
    assertOk({ error }, TABLES.servers, "select");
    const until = (data as { ai_refused_until: string | null } | null)?.ai_refused_until;
    return present(until) ? parseTime(until, TABLES.servers, "ai_refused_until") : null;
  }

  /**
   * Sets the server's refusal horizon. It updates an existing server and never creates one: a server that is not in
   * the pool table throws, so a refusal is never recorded against nothing.
   */
  async setAiRefusedUntil(serverId: string, until: Date): Promise<void> {
    requireMatch(serverId, SLUG, "server id");
    const { data, error } = await this.client
      .from(TABLES.servers)
      .update({ ai_refused_until: isoOf(until, "refusal time"), updated_at: new Date().toISOString() })
      .eq("id", serverId)
      .select("id");
    assertOk({ error }, TABLES.servers, "update");
    if ((data ?? []).length !== 1) throw new Error(`free sandbox store: update on ${TABLES.servers} matched no server`);
  }

  /** The org ids told to wait for a place, oldest first. */
  async waitlist(): Promise<string[]> {
    const { data, error } = await this.client
      .from(TABLES.waitlist)
      .select("org_id")
      .order("waiting_at", { ascending: true });
    assertOk({ error }, TABLES.waitlist, "select");
    return ((data ?? []) as { org_id: string }[]).map((row) => row.org_id);
  }

  /**
   * Adds or removes a workspace from the waitlist. Adding keeps the first `waiting_at` when the workspace is already
   * waiting.
   */
  async setWaitlisted(orgId: string, waiting: boolean): Promise<void> {
    requireMatch(orgId, UUID, "org id");
    if (waiting) {
      const { error } = await this.client
        .from(TABLES.waitlist)
        .upsert(
          { org_id: orgId, waiting_at: new Date().toISOString() },
          { onConflict: "org_id", ignoreDuplicates: true },
        );
      assertOk({ error }, TABLES.waitlist, "upsert");
      return;
    }
    const { error } = await this.client.from(TABLES.waitlist).delete().eq("org_id", orgId);
    assertOk({ error }, TABLES.waitlist, "delete");
  }

  /** The archive copies waiting to be erased from storage, oldest first. Each is checked as it is read. */
  async pendingErasures(): Promise<ArchiveCopy[]> {
    const { data, error } = await this.client
      .from(TABLES.pendingErasures)
      .select("location, sha256, bytes")
      .order("added_at", { ascending: true });
    assertOk({ error }, TABLES.pendingErasures, "select");
    return ((data ?? []) as PendingErasureRow[]).map((row) =>
      requireArchiveCopy({ location: row.location, sha256: row.sha256, bytes: Number(row.bytes) }),
    );
  }

  /**
   * Queues an archive copy for erasure. The copy is checked before it is written. A copy already queued keeps its first
   * `added_at`, so a repeat does not move it to the back of the queue.
   */
  async addPendingErasure(copy: ArchiveCopy): Promise<void> {
    const checked = requireArchiveCopy(copy);
    const row = {
      location: checked.location,
      sha256: checked.sha256,
      bytes: checked.bytes,
      added_at: new Date().toISOString(),
    };
    const { error } = await this.client
      .from(TABLES.pendingErasures)
      .upsert(row, { onConflict: "location", ignoreDuplicates: true });
    assertOk({ error }, TABLES.pendingErasures, "upsert");
  }

  /** Removes a queued erasure once the copy is gone. The location is checked before it becomes a filter. */
  async removePendingErasure(location: string): Promise<void> {
    archiveRefOf(location);
    const { error } = await this.client.from(TABLES.pendingErasures).delete().eq("location", location);
    assertOk({ error }, TABLES.pendingErasures, "delete");
  }
}

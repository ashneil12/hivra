/** @jest-environment node */

jest.mock("server-only", () => ({}));

type Row = Record<string, unknown>;
type Filter = [op: "eq" | "in" | "neq", column: string, value: unknown];

/** A tiny in-memory stand-in for the Supabase query builder: enough for
 * select/eq/in/neq/order/limit/maybeSingle and the head count query. Every
 * query records its table and filters, so a test can check that another
 * account is never searched. */
function fakeDatabase(tables: Record<string, Row[]>) {
  const queries: Array<{ table: string; filters: Filter[] }> = [];
  function from(table: string) {
    const filters: Filter[] = [];
    queries.push({ table, filters });
    const rows = () => (tables[table] ?? []).filter((row) => filters.every(([op, column, value]) =>
      op === "eq" ? row[column] === value : op === "neq" ? row[column] !== value : (value as unknown[]).includes(row[column])));
    const query = {
      select: () => query,
      eq: (column: string, value: unknown) => { filters.push(["eq", column, value]); return query; },
      in: (column: string, value: unknown[]) => { filters.push(["in", column, value]); return query; },
      neq: (column: string, value: unknown) => { filters.push(["neq", column, value]); return query; },
      order: () => query,
      limit: () => query,
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (value: { data: Row[]; count: number; error: null }) => unknown) =>
        Promise.resolve(resolve({ data: rows(), count: rows().length, error: null })),
    };
    return query;
  }
  return { from, queries };
}

let database: ReturnType<typeof fakeDatabase> | null = null;
jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return database;
  },
}));

import { generateVerifiedEd25519SshKeyPair } from "../ed25519-ssh-key";
import { findKnownServer } from "../server-enrollment-store";
import { canonicalEd25519HostKey } from "../ssh-host-key";

const OWNER = "user_owner";
const HOST = generateVerifiedEd25519SshKeyPair("host");
const HEX = Buffer.from(canonicalEd25519HostKey(HOST.publicKey).fingerprintSha256.slice(7) + "=", "base64").toString("hex");
const WEB1 = "11111111-1111-4111-8111-111111111111";
const WEB2 = "22222222-2222-4222-8222-222222222222";

function connection(overrides: Row = {}): Row {
  return {
    id: WEB1, user_id: OWNER, name: "web-1", provider: "host", revision: 3, ssh_user: "root", ssh_host: "198.51.100.7",
    ssh_privilege: "login", ssh_host_fingerprint_sha256: HEX, ...overrides,
  };
}

function snapshotWith(proxmox: boolean): Row {
  return {
    user_id: OWNER, connection_id: WEB1,
    snapshot: { engines: [{ id: "proxmox-kvm", availability: proxmox ? "installed" : "absent" }, { id: "gvisor", availability: "installable" }] },
  };
}

async function offer(tables: Record<string, Row[]>, proxmoxSudoAllowed = false) {
  database = fakeDatabase({ infrastructure_first_boot_enrollments: [], hivra_agents: [],
    infrastructure_host_discovery_snapshots: [], ...tables });
  const known = await findKnownServer(OWNER, HOST.publicKey, { proxmoxSudoAllowed });
  return known && { offer: known.offer, reason: known.reason };
}

const agent = { user_id: OWNER, infrastructure_connection_id: WEB1, deployment_mode: "self-managed", status: "running" };

/** The Replace table, one row per kind of matched connection (spec 8.1). */
describe("findKnownServer: what a report matching an existing connection may do (T30, T46)", () => {
  it("offers a key-only Replace for an earlier enrollment, even while agents use it", async () => {
    const enrolled = connection({ ssh_user: "hivra", ssh_privilege: "sudo" });
    expect(await offer({ infrastructure_connections: [enrolled] })).toEqual({ offer: "replace_key", reason: null });
    expect(await offer({ infrastructure_connections: [enrolled], hivra_agents: [agent] })).toEqual({ offer: "replace_key", reason: null });
  });

  it("offers a switch to hivra for a login connection no agent uses", async () => {
    expect(await offer({ infrastructure_connections: [connection()] })).toEqual({ offer: "switch_user", reason: null });
  });

  it("offers nothing for a login connection agents use", async () => {
    expect(await offer({ infrastructure_connections: [connection()], hivra_agents: [agent] }))
      .toEqual({ offer: "none", reason: "login_in_use" });
    // A deleted agent doesn't count.
    expect(await offer({ infrastructure_connections: [connection()], hivra_agents: [{ ...agent, status: "deleted" }] }))
      .toEqual({ offer: "switch_user", reason: null });
  });

  it("offers no switch on a server whose latest inspection found Proxmox VE while the gate is off", async () => {
    expect(await offer({ infrastructure_connections: [connection()], infrastructure_host_discovery_snapshots: [snapshotWith(true)] }))
      .toEqual({ offer: "none", reason: "proxmox_needs_root" });
    expect(await offer({ infrastructure_connections: [connection()], infrastructure_host_discovery_snapshots: [snapshotWith(true)] }, true))
      .toEqual({ offer: "switch_user", reason: null });
    expect(await offer({ infrastructure_connections: [connection()], infrastructure_host_discovery_snapshots: [snapshotWith(false)] }))
      .toEqual({ offer: "switch_user", reason: null });
  });

  // Review finding 3: a Proxmox-lane connection has its own row and copy,
  // not the "another provider / created on Hetzner" one.
  it("offers nothing for a Proxmox connection, with or without agents", async () => {
    const pve = connection({ provider: "proxmox" });
    expect(await offer({ infrastructure_connections: [pve] })).toEqual({ offer: "none", reason: "proxmox_connection" });
    expect(await offer({ infrastructure_connections: [pve], hivra_agents: [agent] }))
      .toEqual({ offer: "none", reason: "proxmox_connection" });
  });

  it("offers nothing for a server Hivra created on Hetzner, matched by its first-boot identity", async () => {
    expect(await offer({
      infrastructure_connections: [connection({ provider: "hetzner-cloud", ssh_host_fingerprint_sha256: null })],
      infrastructure_first_boot_enrollments: [{ user_id: OWNER, phase: "enrolled", host_public_key: HOST.publicKey, connection_id: WEB1 }],
    })).toEqual({ offer: "none", reason: "hetzner" });
  });

  it("offers nothing when more than one connection pins the identity", async () => {
    expect(await offer({ infrastructure_connections: [connection(), connection({ id: WEB2, name: "web-2" })] }))
      .toEqual({ offer: "none", reason: "multiple" });
  });

  it("never matches or searches another account's connections", async () => {
    expect(await offer({ infrastructure_connections: [connection({ user_id: "user_other" })] })).toBeNull();
    for (const query of database!.queries) {
      expect(query.filters).toContainEqual(["eq", "user_id", OWNER]);
    }
  });
});

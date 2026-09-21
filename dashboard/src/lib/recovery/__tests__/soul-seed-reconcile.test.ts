import { after } from "next/server";

import {
  reconcileInstanceSoulSeed,
  reconcileSoulSeedAfterReady,
  resolveIntendedSoul,
  runSoulSeedReconcile,
  scheduleSoulSeedReconcileAfterResponse,
  type SoulReconcileInstanceRow,
} from "../soul-seed-reconcile";
import { ONBOARDING_RITUAL } from "@/lib/onboarding-ritual";
import { resolveInstanceIpv4 } from "@/lib/services/instance-orchestrator";
import { getRuntimeAgentSettings } from "@/lib/instance-settings";
import { resolvePersonaSoulFromSystemPrompt } from "@/lib/persona-souls-accessor";
import {
  readWebUIProfileSystemPrompt,
  writeWebUIProfileSystemPrompt,
} from "@/lib/webui/profile-files";

// The schedule helper defers through next/server's after(); capture the
// callback so tests can run the deferred work synchronously.
jest.mock("next/server", () => ({
  after: jest.fn(),
}));
jest.mock("@/lib/services/instance-orchestrator", () => ({
  resolveInstanceIpv4: jest.fn(),
}));
jest.mock("@/lib/webui/profile-files", () => ({
  readWebUIProfileSystemPrompt: jest.fn(),
  writeWebUIProfileSystemPrompt: jest.fn(),
}));
// Decouple persona resolution from the multi-KB souls file + the settings
// resolver internals: drive it straight off the row's stored systemPrompt.
jest.mock("@/lib/persona-souls-accessor", () => ({
  resolvePersonaSoulFromSystemPrompt: jest.fn(),
}));
jest.mock("@/lib/instance-settings", () => ({
  getRuntimeAgentSettings: jest.fn((config: { agentSettings?: { systemPrompt?: string | null } } | undefined) => ({
    systemPrompt: config?.agentSettings?.systemPrompt ?? null,
  })),
}));

const mockAfter = after as unknown as jest.Mock;
const mockResolveIp = resolveInstanceIpv4 as jest.Mock;
const mockRead = readWebUIProfileSystemPrompt as jest.Mock;
const mockWrite = writeWebUIProfileSystemPrompt as jest.Mock;
const mockResolvePersona = resolvePersonaSoulFromSystemPrompt as jest.Mock;
const mockRuntimeSettings = getRuntimeAgentSettings as jest.Mock;

// A realistic factory default — its head matches FACTORY_OR_RITUAL_SOUL_HEAD_PATTERN.
const FACTORY_DEFAULT =
  "You are Hermes Agent, an intelligent AI assistant created by Nous Research.\n\nBe helpful.";
const BEA_SOUL = "# Bea\n\nYou are Bea, an operator-grade executive assistant.\n" + "x".repeat(600);
const AUTHORED_CUSTOM = "# Atlas\n\nI am Atlas. I chose this name during onboarding.";

const db = {} as never; // reconcileInstanceSoulSeed only forwards db to the mocked resolveInstanceIpv4.

function row(overrides: Partial<SoulReconcileInstanceRow> = {}): SoulReconcileInstanceRow {
  return {
    id: "inst-1",
    user_id: "user-1",
    provider: "anthropic",
    api_key_encrypted: "enc",
    name: "My Agent",
    status: "running",
    lifecycle_state: "active",
    backend: "gateway",
    config: {},
    ...overrides,
  } as SoulReconcileInstanceRow;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveIp.mockResolvedValue("10.250.20.5");
  mockRuntimeSettings.mockImplementation((config: { agentSettings?: { systemPrompt?: string | null } } | undefined) => ({
    systemPrompt: config?.agentSettings?.systemPrompt ?? null,
  }));
  // Default: no persona (custom / no-persona deploy → onboarding ritual intended).
  mockResolvePersona.mockReturnValue(null);
  mockWrite.mockResolvedValue({ status: "written" });
});

describe("resolveIntendedSoul", () => {
  it("returns the hired persona soul when the stored prompt resolves to one", () => {
    mockResolvePersona.mockReturnValue({ id: "bea", soulPrompt: BEA_SOUL });
    const out = resolveIntendedSoul({ agentSettings: { systemPrompt: BEA_SOUL } });
    expect(out).toEqual({ soul: BEA_SOUL, isPersona: true, personaId: "bea" });
  });

  it("falls back to the onboarding ritual for custom / no-persona deploys", () => {
    mockResolvePersona.mockReturnValue(null);
    const out = resolveIntendedSoul({ agentSettings: { systemPrompt: "do stuff" } });
    expect(out).toEqual({ soul: ONBOARDING_RITUAL, isPersona: false, personaId: null });
  });

  it("returns null for an Operator OS box (persisted agentFlavor) even when a persona would resolve", () => {
    // The Bea-leak shape: an operatoros box whose stored prompt still carries a
    // recognizable persona soul must NEVER produce an intended soul to write.
    mockResolvePersona.mockReturnValue({ id: "bea", soulPrompt: BEA_SOUL });
    const out = resolveIntendedSoul({
      agentFlavor: "operatoros",
      agentSettings: { systemPrompt: BEA_SOUL },
    });
    expect(out).toBeNull();
  });

  it("returns null when the stored webuiAgentImage is an operatoros image (rows predating flavor persistence)", () => {
    mockResolvePersona.mockReturnValue({ id: "bea", soulPrompt: BEA_SOUL });
    const out = resolveIntendedSoul({
      webuiAgentImage: "ghcr.io/ashneil12/operatoros-agent:stable",
      agentSettings: { systemPrompt: BEA_SOUL },
    });
    expect(out).toBeNull();
  });
});

describe("reconcileInstanceSoulSeed — gating (no box round-trip)", () => {
  it("skips a non-webfree backend without any SSH", async () => {
    const res = await reconcileInstanceSoulSeed(row({ backend: null }), db);
    expect(res.action).toBe("skipped_not_webfree");
    expect(mockResolveIp).not.toHaveBeenCalled();
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("skips a paused box (powered off) without any SSH", async () => {
    const res = await reconcileInstanceSoulSeed(row({ lifecycle_state: "paused" }), db);
    expect(res.action).toBe("skipped_paused");
    expect(mockResolveIp).not.toHaveBeenCalled();
  });

  it("skips an Operator OS box without any SSH — never writes over the autonomy SOUL", async () => {
    // Even with a leaked persona soul in the stored prompt (the Bea-leak bug),
    // an operatoros-flavored box must be left entirely alone.
    mockResolvePersona.mockReturnValue({ id: "bea", soulPrompt: BEA_SOUL });
    const res = await reconcileInstanceSoulSeed(
      row({ config: { agentFlavor: "operatoros", agentSettings: { systemPrompt: BEA_SOUL } } }),
      db,
    );
    expect(res.action).toBe("skipped_operatoros");
    expect(mockResolveIp).not.toHaveBeenCalled();
    expect(mockRead).not.toHaveBeenCalled();
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("skips when the IP cannot be resolved", async () => {
    mockResolveIp.mockResolvedValue("");
    const res = await reconcileInstanceSoulSeed(row(), db);
    expect(res.action).toBe("skipped_unreachable");
    expect(res.error).toBe("no_reachable_ip");
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("skips when IP resolution throws", async () => {
    mockResolveIp.mockRejectedValue(new Error("hetzner down"));
    const res = await reconcileInstanceSoulSeed(row(), db);
    expect(res.action).toBe("skipped_unreachable");
    expect(res.error).toBe("ip_resolution_failed");
  });

  it("skips when SOUL.md cannot be read (container not up / non-Hermes box)", async () => {
    mockRead.mockResolvedValue(null);
    const res = await reconcileInstanceSoulSeed(row(), db);
    expect(res.action).toBe("skipped_unreachable");
    expect(res.error).toBe("soul_read_failed");
    expect(mockWrite).not.toHaveBeenCalled();
  });
});

describe("reconcileInstanceSoulSeed — the seed decision", () => {
  it("re-seeds the PERSONA soul over a factory default (the core fix)", async () => {
    mockResolvePersona.mockReturnValue({ id: "bea", soulPrompt: BEA_SOUL });
    mockRead.mockResolvedValue(FACTORY_DEFAULT);

    const res = await reconcileInstanceSoulSeed(
      row({ config: { agentSettings: { systemPrompt: BEA_SOUL } } }),
      db,
    );

    expect(res.action).toBe("reseeded_persona");
    expect(res.personaId).toBe("bea");
    expect(mockWrite).toHaveBeenCalledTimes(1);
    const writeArg = mockWrite.mock.calls[0][0];
    expect(writeArg).toMatchObject({
      instanceId: "inst-1",
      hostIp: "10.250.20.5",
      profileName: "default",
      systemPrompt: BEA_SOUL,
      overwriteExistingIdentity: false, // NEVER an unconditional clobber
    });
  });

  it("re-seeds the onboarding RITUAL over a factory default on a no-persona box", async () => {
    mockResolvePersona.mockReturnValue(null);
    mockRead.mockResolvedValue(FACTORY_DEFAULT);

    const res = await reconcileInstanceSoulSeed(row(), db);

    expect(res.action).toBe("reseeded_ritual");
    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect(mockWrite.mock.calls[0][0].systemPrompt).toBe(ONBOARDING_RITUAL);
  });

  it("re-seeds the PERSONA over a stale un-run ritual (heals the #475 redrive gap)", async () => {
    mockResolvePersona.mockReturnValue({ id: "bea", soulPrompt: BEA_SOUL });
    mockRead.mockResolvedValue(ONBOARDING_RITUAL); // ritual leaked onto a persona box

    const res = await reconcileInstanceSoulSeed(
      row({ config: { agentSettings: { systemPrompt: BEA_SOUL } } }),
      db,
    );

    expect(res.action).toBe("reseeded_persona");
    expect(mockWrite).toHaveBeenCalledTimes(1);
  });

  it("re-seeds over an EMPTY SOUL.md", async () => {
    mockRead.mockResolvedValue("");
    const res = await reconcileInstanceSoulSeed(row(), db);
    expect(res.action).toBe("reseeded_ritual");
    expect(mockWrite).toHaveBeenCalledTimes(1);
  });

  it("leaves an authored persona identity untouched (no write)", async () => {
    mockRead.mockResolvedValue(BEA_SOUL);
    const res = await reconcileInstanceSoulSeed(row(), db);
    expect(res.action).toBe("skipped_authored");
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("leaves an agent-authored custom identity untouched (no write)", async () => {
    mockRead.mockResolvedValue(AUTHORED_CUSTOM);
    const res = await reconcileInstanceSoulSeed(row(), db);
    expect(res.action).toBe("skipped_authored");
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("does NOT rewrite an un-run ritual that already matches the intended soul", async () => {
    mockResolvePersona.mockReturnValue(null);
    mockRead.mockResolvedValue(ONBOARDING_RITUAL);
    const res = await reconcileInstanceSoulSeed(row(), db);
    expect(res.action).toBe("skipped_already_seeded");
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("preserves an identity authored between our read and our write (concurrent redrive)", async () => {
    mockRead.mockResolvedValue(FACTORY_DEFAULT); // looked factory when we read
    mockWrite.mockResolvedValue({ status: "skipped_existing_identity" }); // but the box guard refused
    const res = await reconcileInstanceSoulSeed(row(), db);
    expect(res.action).toBe("skipped_authored");
  });

  it("reports error (not a crash) when the read throws", async () => {
    mockRead.mockRejectedValue(new Error("ssh boom"));
    const res = await reconcileInstanceSoulSeed(row(), db);
    expect(res.action).toBe("error");
    expect(res.error).toContain("ssh boom");
  });

  it("reports error (not a crash) when the write throws", async () => {
    mockRead.mockResolvedValue(FACTORY_DEFAULT);
    mockWrite.mockRejectedValue(new Error("write failed"));
    const res = await reconcileInstanceSoulSeed(row(), db);
    expect(res.action).toBe("error");
  });
});

describe("runSoulSeedReconcile — fleet enumeration + tally", () => {
  function makeDb(rows: SoulReconcileInstanceRow[], error: unknown = null) {
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    builder.select = jest.fn(chain);
    builder.in = jest.fn(chain);
    builder.eq = jest.fn(chain);
    builder.order = jest.fn(chain);
    builder.limit = jest.fn(async () => ({ data: rows, error }));
    const from = jest.fn(() => builder);
    return { from, builder } as unknown as {
      from: jest.Mock;
      builder: Record<string, jest.Mock>;
    };
  }

  it("scans running webfree boxes and tallies per-action outcomes", async () => {
    mockResolvePersona.mockImplementation((sp: string | null | undefined) =>
      sp === BEA_SOUL ? { id: "bea", soulPrompt: BEA_SOUL } : null,
    );
    // inst-1: factory default + persona → reseeded_persona
    // inst-2: authored → skipped_authored
    mockRead.mockImplementation(async ({ instanceId }: { instanceId: string }) =>
      instanceId === "inst-1" ? FACTORY_DEFAULT : BEA_SOUL,
    );

    const rows = [
      row({ id: "inst-1", config: { agentSettings: { systemPrompt: BEA_SOUL } } }),
      row({ id: "inst-2", config: { agentSettings: { systemPrompt: BEA_SOUL } } }),
    ];
    const fakeDb = makeDb(rows);

    const summary = await runSoulSeedReconcile({ db: fakeDb as never });

    expect(fakeDb.from).toHaveBeenCalledWith("hermes_instances");
    // Selection: webfree backends + status running.
    expect(fakeDb.builder.in).toHaveBeenCalledWith("backend", expect.arrayContaining(["gateway", "webui"]));
    expect(fakeDb.builder.eq).toHaveBeenCalledWith("status", "running");

    expect(summary.scanned).toBe(2);
    expect(summary.reseededPersona).toBe(1);
    expect(summary.skippedAuthored).toBe(1);
    expect(summary.capped).toBe(false);
  });

  it("flags capped=true when the fleet exceeds the per-run limit", async () => {
    mockRead.mockResolvedValue(BEA_SOUL); // all skip-authored; irrelevant to cap logic
    const rows = [row({ id: "a" }), row({ id: "b" }), row({ id: "c" })];
    const fakeDb = makeDb(rows);

    const summary = await runSoulSeedReconcile({ db: fakeDb as never, limit: 2 });

    expect(summary.capped).toBe(true);
    expect(summary.scanned).toBe(2); // only the first `limit` rows are processed
  });

  it("narrows to the targeted ids on the POST path", async () => {
    mockRead.mockResolvedValue(BEA_SOUL);
    const fakeDb = makeDb([row({ id: "inst-9" })]);

    await runSoulSeedReconcile({ db: fakeDb as never, instanceIds: ["inst-9"] });

    expect(fakeDb.builder.in).toHaveBeenCalledWith("id", ["inst-9"]);
  });

  it("throws when the instance query errors", async () => {
    const fakeDb = makeDb([], { message: "db exploded" });
    await expect(runSoulSeedReconcile({ db: fakeDb as never })).rejects.toThrow("db exploded");
  });
});

// Fake db for the targeted single-row fetch used by the post-ready hook:
// from("hermes_instances").select(...).eq("id", ...).eq("status", "running").maybeSingle()
function makeReadyFetchDb(
  data: SoulReconcileInstanceRow | null,
  error: { message: string } | null = null,
  opts: { rejectWith?: Error } = {},
) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder.select = jest.fn(chain);
  builder.eq = jest.fn(chain);
  builder.maybeSingle = opts.rejectWith
    ? jest.fn(async () => {
        throw opts.rejectWith;
      })
    : jest.fn(async () => ({ data, error }));
  const from = jest.fn(() => builder);
  return { from, builder } as unknown as {
    from: jest.Mock;
    builder: Record<string, jest.Mock>;
  };
}

describe("reconcileSoulSeedAfterReady — the post-ready promotion hook (deterministic race close)", () => {
  it("REGRESSION: container wrote its factory default AFTER the in-band seed → post-ready hook re-seeds the persona", async () => {
    // The exact live-verified losing sequence (box fixturecase25, 2026-07-07):
    //   t0 provisioning bootstrap fires the in-band seed inside the health-wait
    //      (the agent container hasn't initialized yet — nothing sticks),
    //   t1 the agent container initializes and writes its FACTORY default,
    //   t2 the dashboard finally observes readiness and promotes the row to
    //      'running' → this hook fires.
    // At t2 the box must end up carrying the authored persona soul.
    mockResolvePersona.mockReturnValue({ id: "bea", soulPrompt: BEA_SOUL });
    mockRead.mockResolvedValue(FACTORY_DEFAULT); // what the agent left at t1
    const promoted = row({ config: { agentSettings: { systemPrompt: BEA_SOUL } } });
    const fakeDb = makeReadyFetchDb(promoted);

    const res = await reconcileSoulSeedAfterReady({
      instanceId: "inst-1",
      trigger: "poll_provision_promote",
      db: fakeDb as never,
    });

    // Fresh row fetched, re-asserting the box is still running.
    expect(fakeDb.from).toHaveBeenCalledWith("hermes_instances");
    expect(fakeDb.builder.eq).toHaveBeenCalledWith("id", "inst-1");
    expect(fakeDb.builder.eq).toHaveBeenCalledWith("status", "running");

    expect(res?.action).toBe("reseeded_persona");
    expect(res?.personaId).toBe("bea");
    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect(mockWrite.mock.calls[0][0]).toMatchObject({
      instanceId: "inst-1",
      systemPrompt: BEA_SOUL,
      overwriteExistingIdentity: false, // guard stays authoritative on-box
    });
  });

  it("re-seeds the who-am-I ritual on a no-persona box that lost the same race", async () => {
    mockResolvePersona.mockReturnValue(null);
    mockRead.mockResolvedValue(FACTORY_DEFAULT);
    const fakeDb = makeReadyFetchDb(row());

    const res = await reconcileSoulSeedAfterReady({
      instanceId: "inst-1",
      trigger: "recover_stuck_promote",
      db: fakeDb as never,
    });

    expect(res?.action).toBe("reseeded_ritual");
    expect(mockWrite.mock.calls[0][0].systemPrompt).toBe(ONBOARDING_RITUAL);
  });

  it("never clobbers an identity the agent authored before the hook ran", async () => {
    mockRead.mockResolvedValue(AUTHORED_CUSTOM);
    const fakeDb = makeReadyFetchDb(row());

    const res = await reconcileSoulSeedAfterReady({
      instanceId: "inst-1",
      trigger: "poll_provision_promote",
      db: fakeDb as never,
    });

    expect(res?.action).toBe("skipped_authored");
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("no-ops without SSH when the row is gone or no longer running", async () => {
    const fakeDb = makeReadyFetchDb(null);

    const res = await reconcileSoulSeedAfterReady({
      instanceId: "inst-1",
      trigger: "recover_orphan_adopt",
      db: fakeDb as never,
    });

    expect(res).toBeNull();
    expect(mockResolveIp).not.toHaveBeenCalled();
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("swallows a row-fetch error — a promotion must never be failable by seeding", async () => {
    const fakeDb = makeReadyFetchDb(null, { message: "db exploded" });
    const res = await reconcileSoulSeedAfterReady({
      instanceId: "inst-1",
      trigger: "poll_provision_promote",
      db: fakeDb as never,
    });
    expect(res).toBeNull();
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("swallows a crash anywhere in the pipeline (never throws)", async () => {
    const fakeDb = makeReadyFetchDb(null, null, { rejectWith: new Error("postgrest down") });
    await expect(
      reconcileSoulSeedAfterReady({
        instanceId: "inst-1",
        trigger: "poll_provision_promote",
        db: fakeDb as never,
      }),
    ).resolves.toBeNull();
  });

  it("surfaces a box-write failure as the reconcile's error result, still without throwing", async () => {
    mockRead.mockResolvedValue(FACTORY_DEFAULT);
    mockWrite.mockRejectedValue(new Error("ssh write failed"));
    const fakeDb = makeReadyFetchDb(row());

    const res = await reconcileSoulSeedAfterReady({
      instanceId: "inst-1",
      trigger: "poll_provision_promote",
      db: fakeDb as never,
    });

    expect(res?.action).toBe("error");
  });
});

describe("scheduleSoulSeedReconcileAfterResponse — deferred route-handler variant", () => {
  it("defers via after() and the deferred callback performs the guarded re-seed", async () => {
    mockResolvePersona.mockReturnValue({ id: "bea", soulPrompt: BEA_SOUL });
    mockRead.mockResolvedValue(FACTORY_DEFAULT);
    const fakeDb = makeReadyFetchDb(
      row({ config: { agentSettings: { systemPrompt: BEA_SOUL } } }),
    );

    scheduleSoulSeedReconcileAfterResponse({
      instanceId: "inst-1",
      trigger: "poll_provision_promote",
      db: fakeDb as never,
    });

    // Nothing happens before the response is sent…
    expect(mockAfter).toHaveBeenCalledTimes(1);
    expect(mockRead).not.toHaveBeenCalled();

    // …then the deferred callback runs the full reconcile.
    await mockAfter.mock.calls[0][0]();
    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect(mockWrite.mock.calls[0][0].systemPrompt).toBe(BEA_SOUL);
  });

  it("swallows after() being unavailable outside a request scope (unit tests, crons)", () => {
    mockAfter.mockImplementationOnce(() => {
      throw new Error("after() was called outside a request scope");
    });
    expect(() =>
      scheduleSoulSeedReconcileAfterResponse({
        instanceId: "inst-1",
        trigger: "poll_provision_promote",
      }),
    ).not.toThrow();
  });
});

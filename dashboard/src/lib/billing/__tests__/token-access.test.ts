/**
 * Token access with $HIVRA ACTIVATED at a test address: who may hold and pay
 * in which token, the grandfather cohort, the conversion grace, and the
 * activation record. The launch block is mocked; nothing here is live.
 */
const TEST_HIVRA_ADDRESS = "0x1111111111111111111111111111111111111111";
const ACTIVATES_AT = "2026-10-01T16:00:00Z";

jest.mock("@/lib/billing/hivra-token-launch", () => ({
  HIVRA_TOKEN_LAUNCH: {
    contractAddress: "0x1111111111111111111111111111111111111111",
    decimals: 18,
    poolId: `0x${"ab".repeat(32)}`,
    activatesAt: "2026-10-01T16:00:00Z",
  },
}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/ops-events", () => ({ reportOpsEvent: jest.fn(async () => undefined) }));
jest.mock("@/lib/billing/live-thresholds", () => ({
  getLiveActiveThresholds: jest.fn(),
}));

jest.mock("@/lib/billing/token-holdings", () => ({
  ...jest.requireActual("@/lib/billing/token-holdings"),
  fetchTokenBalance: jest.fn(),
  getTokenVerificationWallet: jest.fn(),
}));
import { fetchTokenBalance, getTokenVerificationWallet } from "@/lib/billing/token-holdings";
import { reportOpsEvent } from "@/lib/ops-events";
import { getLiveActiveThresholds } from "@/lib/billing/live-thresholds";
import {
  HivraActivationConflictError,
  TokenConversionError,
  TokenNotAllowedError,
  _resetTokenAccessStateForTests,
  assertTokenAllowedForUser,
  computeUserTokenAccess,
  convertGrandfatheredUserToHivra,
  ensureHivraActivationRecorded,
  readHolderTierCarryover,
  resolveTokenAccessForUsers,
  resolveUserTokenAccess,
  tierRowTokenCounts,
} from "@/lib/billing/token-access";

const BEFORE = new Date("2026-10-01T15:00:00Z");
const NOW = new Date("2026-10-02T12:00:00Z");
const HOUR_MS = 60 * 60 * 1000;
const ONE_TOKEN = 10n ** 18n;

interface CohortRow {
  user_id: string;
  converted_at: string | null;
  conversion_grace_ends_at: string | null;
  metadata: Record<string, unknown> | null;
}

/** In-memory stand-in for the three RPCs and the cohort table. */
class FakeAccessDb {
  cohort = new Map<string, CohortRow>();
  evidence = new Set<string>();
  tiers: Record<string, unknown>[] = [];
  activation: { address: string; activatedAt: string } | null = null;
  rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];

  async rpc(name: string, params: Record<string, unknown>) {
    this.rpcCalls.push({ name, params });
    if (name === "record_platform_token_activation") {
      if (this.activation && this.activation.address !== params.p_token_address) {
        return { data: { status: "address_conflict" }, error: null };
      }
      const first = !this.activation;
      this.activation = { address: String(params.p_token_address), activatedAt: String(params.p_activated_at) };
      for (const userId of this.evidence) this.addMember(userId);
      return { data: { status: first ? "activated" : "already_active", cohort_size: this.cohort.size }, error: null };
    }
    if (name === "ensure_token_grandfather_membership") {
      const userId = String(params.p_user_id);
      if (this.cohort.has(userId)) return { data: true, error: null };
      if (this.evidence.has(userId)) {
        this.addMember(userId);
        return { data: true, error: null };
      }
      return { data: false, error: null };
    }
    if (name === "switch_grandfathered_holder") {
      const member = this.cohort.get(String(params.p_user_id))!;
      return {data: {status: "converted", cohort: {...member, converted_at: params.p_now,
        conversion_grace_ends_at: params.p_grace_ends_at, metadata: {conversion: {
          source: "earned_holder_1_to_1", hivraThresholds: params.p_expected_tiers,
        }},
      }}, error: null};
    }
    throw new Error(`unexpected rpc ${name}`);
  }

  addMember(userId: string) {
    if (!this.cohort.has(userId)) {
      this.cohort.set(userId, { user_id: userId, converted_at: null, conversion_grace_ends_at: null, metadata: {} });
    }
  }

  from(name: string) {
    if (name === "token_tier_qualifications") return {select: () => ({eq: async () => ({data: this.tiers, error: null})})};
    if (name === "platform_token_activations") {
      const activation = this.activation;
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({
          data: activation
            ? {
                token_address: activation.address,
                activated_at: activation.activatedAt,
                cohort_recorded_at: activation.activatedAt,
              }
            : null,
          error: null,
        }),
      };
      return builder;
    }
    if (name !== "token_grandfather_cohort") throw new Error(`unexpected table ${name}`);
    const filters: Array<(row: CohortRow) => boolean> = [];
    let update: Partial<CohortRow> | null = null;
    const run = () => {
      const rows = [...this.cohort.values()].filter((row) => filters.every((keep) => keep(row)));
      if (update) for (const row of rows) Object.assign(row, update);
      return rows.map((row) => ({ ...row }));
    };
    const builder = {
      select: () => builder,
      update: (payload: Partial<CohortRow>) => {
        update = payload;
        return builder;
      },
      eq: (column: keyof CohortRow, value: unknown) => {
        filters.push((row) => row[column] === value);
        return builder;
      },
      in: (column: keyof CohortRow, values: unknown[]) => {
        filters.push((row) => values.includes(row[column]));
        return builder;
      },
      is: (column: keyof CohortRow, value: unknown) => {
        filters.push((row) => row[column] === value);
        return builder;
      },
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (value: { data: CohortRow[]; error: null }) => unknown) =>
        Promise.resolve({ data: run(), error: null }).then(resolve),
    };
    return builder;
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetTokenAccessStateForTests();
  (getLiveActiveThresholds as jest.Mock).mockResolvedValue({
    epoch: "standard",
    pro: { tier: "pro", epoch: "standard", code: "PRO_STANDARD", amount: 1_000n * ONE_TOKEN },
    power: { tier: "power", epoch: "standard", code: "POWER_STANDARD", amount: 2_000n * ONE_TOKEN },
    priceUsd: "0.149",
    priceFetchedAt: NOW,
  });
});

describe("computeUserTokenAccess", () => {
  it("before activation everyone is on $HermesOS", () => {
    for (const phase of ["dormant", "scheduled"] as const) {
      const access = computeUserTokenAccess({ phase, cohort: null, now: NOW });
      expect(access).toMatchObject({ allowedTokens: ["hermesos"], qualifyTokens: ["hermesos"], paymentToken: "hermesos" });
    }
  });

  it("after activation a new user holds and pays in $HIVRA only", () => {
    const access = computeUserTokenAccess({ phase: "active", cohort: null, now: NOW });
    expect(access).toMatchObject({
      grandfathered: false,
      allowedTokens: ["hivra"],
      qualifyTokens: ["hivra"],
      paymentToken: "hivra",
    });
    expect(tierRowTokenCounts(access, "hermesos")).toBe(false);
  });

  it("a grandfathered user keeps $HermesOS (first) and may also use $HIVRA, with no deadline", () => {
    const access = computeUserTokenAccess({
      phase: "active",
      cohort: { user_id: "u", converted_at: null, conversion_grace_ends_at: null, metadata: {} },
      now: new Date("2031-01-01T00:00:00Z"),
    });
    expect(access).toMatchObject({
      grandfathered: true,
      allowedTokens: ["hermesos", "hivra"],
      qualifyTokens: ["hermesos", "hivra"],
      paymentToken: "hermesos",
    });
  });

  it("a converted member may use either token during the grace, then $HIVRA only, and keeps its $HermesOS rows until they move", () => {
    const cohort = {
      user_id: "u",
      converted_at: NOW.toISOString(),
      conversion_grace_ends_at: new Date(NOW.getTime() + 72 * HOUR_MS).toISOString(),
      metadata: { conversion: { hivraThresholds: { pro: { amount: "5", code: "PRO_STANDARD" } } } },
    };
    const during = computeUserTokenAccess({ phase: "active", cohort, now: new Date(NOW.getTime() + 71 * HOUR_MS) });
    expect(during.allowedTokens).toEqual(["hermesos", "hivra"]);
    expect(during.qualifyTokens).toEqual(["hivra"]);
    expect(during.conversionThresholds.pro).toEqual({ amount: 5n, code: "PRO_STANDARD" });
    const after = computeUserTokenAccess({ phase: "active", cohort, now: new Date(NOW.getTime() + 72 * HOUR_MS) });
    expect(after.allowedTokens).toEqual(["hivra"]);
    expect(tierRowTokenCounts(after, "hermesos")).toBe(true);
  });
});

describe("activation record and cohort", () => {
  it("does nothing before the activation instant", async () => {
    const db = new FakeAccessDb();
    expect(await ensureHivraActivationRecorded({ db, now: BEFORE })).toBe("dormant");
    const access = await resolveUserTokenAccess("u", { db, now: BEFORE });
    expect(access.allowedTokens).toEqual(["hermesos"]);
    expect(db.rpcCalls).toEqual([]);
  });

  it("records the activation once with the registry's address and instant", async () => {
    const db = new FakeAccessDb();
    await ensureHivraActivationRecorded({ db, now: NOW });
    await ensureHivraActivationRecorded({ db, now: NOW });
    const calls = db.rpcCalls.filter((call) => call.name === "record_platform_token_activation");
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toMatchObject({
      p_token_key: "hivra",
      p_chain_id: 8453,
      p_token_address: TEST_HIVRA_ADDRESS,
      p_token_symbol: "HIVRA",
      p_token_decimals: 18,
      p_activated_at: new Date(ACTIVATES_AT).toISOString(),
    });
  });

  it("skips the activation RPC when the activation is already recorded (cold starts stay cheap)", async () => {
    const db = new FakeAccessDb();
    db.activation = { address: TEST_HIVRA_ADDRESS, activatedAt: new Date(ACTIVATES_AT).toISOString() };
    expect(await ensureHivraActivationRecorded({ db, now: NOW })).toBe("recorded");
    expect(db.rpcCalls.filter((call) => call.name === "record_platform_token_activation")).toHaveLength(0);
  });

  it("read-only lookups do not record cohort members", async () => {
    const db = new FakeAccessDb();
    db.activation = { address: TEST_HIVRA_ADDRESS, activatedAt: new Date(ACTIVATES_AT).toISOString() };
    db.addMember("old_holder");
    const access = await resolveUserTokenAccess("old_holder", { db, now: NOW, recordMembership: false });
    expect(access.grandfathered).toBe(true);
    expect(db.rpcCalls).toEqual([]);
  });

  it("fails closed and alerts when the recorded activation names a different address", async () => {
    const db = new FakeAccessDb();
    db.activation = { address: "0x2222222222222222222222222222222222222222", activatedAt: ACTIVATES_AT };
    await expect(ensureHivraActivationRecorded({ db, now: NOW })).rejects.toBeInstanceOf(HivraActivationConflictError);
    await expect(resolveUserTokenAccess("u", { db, now: NOW })).rejects.toBeInstanceOf(HivraActivationConflictError);
    expect(reportOpsEvent).toHaveBeenCalledWith(expect.objectContaining({ severity: "fatal" }));
  });

  it("grandfathers users with pre-activation evidence and nobody else", async () => {
    const db = new FakeAccessDb();
    db.evidence.add("old_holder");
    const holder = await resolveUserTokenAccess("old_holder", { db, now: NOW });
    const stranger = await resolveUserTokenAccess("new_user", { db, now: NOW });
    expect(holder.grandfathered).toBe(true);
    expect(holder.paymentToken).toBe("hermesos");
    expect(stranger.grandfathered).toBe(false);
    expect(stranger.allowedTokens).toEqual(["hivra"]);

    const batch = await resolveTokenAccessForUsers(["old_holder", "new_user"], { db, now: NOW });
    expect(batch.get("old_holder")?.grandfathered).toBe(true);
    expect(batch.get("new_user")?.grandfathered).toBe(false);
  });

  it("refuses $HermesOS server-side for a new user and allows it for a grandfathered one", async () => {
    const db = new FakeAccessDb();
    db.evidence.add("old_holder");
    await expect(assertTokenAllowedForUser("new_user", "hermesos", { db, now: NOW })).rejects.toBeInstanceOf(
      TokenNotAllowedError
    );
    await expect(assertTokenAllowedForUser("new_user", "hivra", { db, now: NOW })).resolves.toBeDefined();
    await expect(assertTokenAllowedForUser("old_holder", "hermesos", { db, now: NOW })).resolves.toBeDefined();
  });
});

describe("convertGrandfatheredUserToHivra", () => {
  it("starts the 72h grace and locks the $HIVRA thresholds at conversion", async () => {
    const db = new FakeAccessDb();
    db.evidence.add("old_holder");
    const access = await convertGrandfatheredUserToHivra("old_holder", { db, now: NOW });
    expect(access.convertedAt).toEqual(NOW);
    expect(access.conversionGraceEndsAt).toEqual(new Date(NOW.getTime() + 72 * HOUR_MS));
    expect(access.allowedTokens).toEqual(["hermesos", "hivra"]);
    expect(access.conversionThresholds).toEqual({
      pro: { amount: 1_000n * ONE_TOKEN, code: "PRO_STANDARD" },
      power: { amount: 2_000n * ONE_TOKEN, code: "POWER_STANDARD" },
    });
    expect(getLiveActiveThresholds).toHaveBeenCalledWith(
      expect.objectContaining({ token: expect.objectContaining({ key: "hivra" }) })
    );
  });

  it("refuses a user outside the cohort, a second conversion, and a conversion without a live price", async () => {
    const db = new FakeAccessDb();
    db.evidence.add("old_holder");
    await expect(convertGrandfatheredUserToHivra("new_user", { db, now: NOW })).rejects.toMatchObject({
      code: "not_grandfathered",
    });
    (getLiveActiveThresholds as jest.Mock).mockRejectedValueOnce(new Error("feed down"));
    await expect(convertGrandfatheredUserToHivra("old_holder", { db, now: NOW })).rejects.toMatchObject({
      code: "price_unavailable",
    });
    expect(db.cohort.get("old_holder")?.converted_at).toBeNull();
    await convertGrandfatheredUserToHivra("old_holder", { db, now: NOW });
    await expect(convertGrandfatheredUserToHivra("old_holder", { db, now: NOW })).rejects.toBeInstanceOf(
      TokenConversionError
    );
  });
});

describe("optional holder switch", () => {
  const wallet = "0x2222222222222222222222222222222222222222";
  const amount = (123_456n * ONE_TOKEN + 1n).toString();
  const holderConsent = { tiers: [{ tier: "pro", amountRaw: amount }] };
  let db: FakeAccessDb;
  const previous = process.env.HIVRA_HOLDER_TIER_CARRYOVER;
  beforeEach(() => {
    process.env.HIVRA_HOLDER_TIER_CARRYOVER = "1";
    db = new FakeAccessDb();
    db.addMember("holder");
    db.tiers = [{tier: "pro", token_key: "hermesos", qualifying_quantity: amount,
      qualifying_threshold_tier: "PRO_LAUNCH", currently_eligible: true, last_suspend_at: null, last_breach_at: null}];
    (getTokenVerificationWallet as jest.Mock).mockResolvedValue({id:"wallet-id", normalizedAddress: wallet});
    (fetchTokenBalance as jest.Mock).mockResolvedValue({balanceRaw: amount, balanceDisplay:"123456.000000000000000001", blockNumber:11});
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.HIVRA_HOLDER_TIER_CARRYOVER;
    else process.env.HIVRA_HOLDER_TIER_CARRYOVER = previous;
  });
  it("preserves exact 18-decimal amounts and reads the configured HIVRA contract on Base", async () => {
    const preview = await readHolderTierCarryover("holder", await resolveUserTokenAccess("holder", {db, now: NOW}), db);
    expect(preview?.tiers[0]).toMatchObject({tier:"pro", amountRaw:amount});
    expect(fetchTokenBalance).not.toHaveBeenCalled();
    const access = await convertGrandfatheredUserToHivra("holder", {db, now: NOW, holderConsent});
    expect(fetchTokenBalance).toHaveBeenCalledWith({walletAddress:wallet, token:expect.objectContaining({
      chainId:8453, tokenAddress:TEST_HIVRA_ADDRESS, tokenDecimals:18,
    })});
    expect(access.conversionThresholds).toEqual({pro:{amount: BigInt(amount),code:"PRO_LAUNCH"}});
    expect(getLiveActiveThresholds).not.toHaveBeenCalled();
  });
  it.each(["missing_wallet","low_balance","rpc_failure","tier_breached"])("refuses %s before committing", async failure => {
    const errors: Record<string, string> = {missing_wallet:"verified_wallet_required",low_balance:"insufficient_hivra",
      rpc_failure:"wallet_unavailable",tier_breached:"tier_changed"};
    if (failure === "missing_wallet") (getTokenVerificationWallet as jest.Mock).mockResolvedValue(null);
    if (failure === "low_balance") (fetchTokenBalance as jest.Mock).mockResolvedValue({balanceRaw:(BigInt(amount)-1n).toString()});
    if (failure === "rpc_failure") (fetchTokenBalance as jest.Mock).mockRejectedValue(new Error("RPC offline"));
    if (failure === "tier_breached") db.tiers[0].last_breach_at = NOW.toISOString();
    await expect(convertGrandfatheredUserToHivra("holder", {db, now:NOW, holderConsent})).rejects.toMatchObject({code:errors[failure]});
    expect(db.rpcCalls.map(call => call.name)).not.toContain("switch_grandfathered_holder");
    expect(db.rpcCalls.map(call => call.name)).not.toContain("ensure_token_grandfather_membership");
    expect(getLiveActiveThresholds).not.toHaveBeenCalled();
  });
  it("switches an account without earned tiers without consulting a wallet or price", async () => {
    db.tiers = [];
    const access = await convertGrandfatheredUserToHivra("holder", {db, now: NOW, holderConsent: {tiers: []}});
    expect(access.conversionThresholds).toEqual({});
    expect(getTokenVerificationWallet).not.toHaveBeenCalled();
    expect(fetchTokenBalance).not.toHaveBeenCalled();
    expect(getLiveActiveThresholds).not.toHaveBeenCalled();
  });
  it("rejects stale consent across both flag rotations before reading or writing the account", async () => {
    await expect(convertGrandfatheredUserToHivra("holder", {db, now: NOW})).rejects.toMatchObject({code:"tier_changed"});
    delete process.env.HIVRA_HOLDER_TIER_CARRYOVER;
    await expect(convertGrandfatheredUserToHivra("holder", {db, now: NOW, holderConsent})).rejects.toMatchObject({code:"tier_changed"});
    expect(db.rpcCalls).toEqual([]);
  });

  it.each([
    { tiers: [] },
    { tiers: [{ tier: "pro", amountRaw: "1" }] },
    { tiers: [{ tier: "power", amountRaw: amount }] },
  ])(
    "rejects stale reviewed amounts without looking up a wallet", async ({ tiers }) => {
      await expect(convertGrandfatheredUserToHivra("holder", {db, now: NOW, holderConsent: { tiers }}))
        .rejects.toMatchObject({code:"tier_changed"});
      expect(getTokenVerificationWallet).not.toHaveBeenCalled();
      expect(db.rpcCalls.map(call => call.name)).not.toContain("switch_grandfathered_holder");
    }
  );
});

import {
  buildWalletVerificationMessage,
  createWalletVerificationChallenge,
  revokeDisplacedTokenEntitlements,
  verifyWalletChallenge,
} from "@/lib/billing/wallet-verification";
import { BASE_CHAIN_ID, getTokenVerificationWallet } from "@/lib/billing/token-holdings";

jest.mock("@/lib/billing/token-holdings", () => ({
  ...jest.requireActual("@/lib/billing/token-holdings"),
  getTokenVerificationWallet: jest.fn(),
}));

jest.mock("@/lib/ops-events", () => ({
  reportOpsEvent: jest.fn().mockResolvedValue(null),
}));

function buildInsertTable(data: unknown, error: unknown = null) {
  const query: {
    insert: jest.Mock;
    select: jest.Mock;
    single: jest.Mock;
  } = {} as {
    insert: jest.Mock;
    select: jest.Mock;
    single: jest.Mock;
  };
  query.insert = jest.fn(() => query);
  query.select = jest.fn(() => query);
  query.single = jest.fn().mockResolvedValue({ data, error });
  return query;
}

function buildSelectTable(data: unknown, error: unknown = null) {
  const query: {
    select: jest.Mock;
    eq: jest.Mock;
    maybeSingle: jest.Mock;
  } = {} as {
    select: jest.Mock;
    eq: jest.Mock;
    maybeSingle: jest.Mock;
  };
  query.select = jest.fn(() => query);
  query.eq = jest.fn(() => query);
  query.maybeSingle = jest.fn().mockResolvedValue({ data, error });
  return query;
}

function buildThenableUpdateTable(error: unknown = null) {
  const filter: {
    eq: jest.Mock;
    then: Promise<{ data: unknown; error: unknown }>["then"];
  } = {} as {
    eq: jest.Mock;
    then: Promise<{ data: unknown; error: unknown }>["then"];
  };
  filter.eq = jest.fn(() => filter);
  filter.then = (resolve, reject) => Promise.resolve({ data: null, error }).then(resolve, reject);
  return {
    update: jest.fn(() => filter),
    filter,
  };
}

function buildUpdateSingleTable(data: unknown, error: unknown = null) {
  const filter: {
    eq: jest.Mock;
    select: jest.Mock;
    single: jest.Mock;
  } = {} as {
    eq: jest.Mock;
    select: jest.Mock;
    single: jest.Mock;
  };
  filter.eq = jest.fn(() => filter);
  filter.select = jest.fn(() => filter);
  filter.single = jest.fn().mockResolvedValue({ data, error });
  return {
    update: jest.fn(() => filter),
    filter,
  };
}

function buildListTable(rows: unknown[], error: unknown = null) {
  const query: {
    select: jest.Mock;
    eq: jest.Mock;
    neq: jest.Mock;
    then: Promise<{ data: unknown; error: unknown }>["then"];
  } = {} as {
    select: jest.Mock;
    eq: jest.Mock;
    neq: jest.Mock;
    then: Promise<{ data: unknown; error: unknown }>["then"];
  };
  query.select = jest.fn(() => query);
  query.eq = jest.fn(() => query);
  query.neq = jest.fn(() => query);
  query.then = (resolve, reject) => Promise.resolve({ data: rows, error }).then(resolve, reject);
  return query;
}

function buildUpsertTable(data: unknown, error: unknown = null) {
  const query: {
    upsert: jest.Mock;
    select: jest.Mock;
    single: jest.Mock;
  } = {} as {
    upsert: jest.Mock;
    select: jest.Mock;
    single: jest.Mock;
  };
  query.upsert = jest.fn(() => query);
  query.select = jest.fn(() => query);
  query.single = jest.fn().mockResolvedValue({ data, error });
  return query;
}

const now = new Date("2026-04-24T12:00:00.000Z");
const future = "2026-04-24T12:10:00.000Z";
const expired = "2026-04-24T11:59:59.000Z";
const address = "0x000000000000000000000000000000000000dEaD";
const normalizedAddress = "0x000000000000000000000000000000000000dead";

function challengeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "challenge_1",
    user_id: "user_1",
    chain_type: "evm",
    chain_id: BASE_CHAIN_ID,
    address: normalizedAddress,
    normalized_address: normalizedAddress,
    nonce: "nonce-1",
    message: buildWalletVerificationMessage({
      address,
      chainId: BASE_CHAIN_ID,
      nonce: "nonce-1",
      issuedAt: now.toISOString(),
      expiresAt: future,
    }),
    status: "pending",
    expires_at: future,
    verified_at: null,
    consumed_at: null,
    failure_reason: null,
    created_at: now.toISOString(),
    ...overrides,
  };
}

describe("wallet verification", () => {
  it("builds a signable wallet ownership message", () => {
    const message = buildWalletVerificationMessage({
      address,
      chainId: BASE_CHAIN_ID,
      nonce: "nonce-1",
      issuedAt: now.toISOString(),
      expiresAt: future,
    });

    expect(message).toContain("Hivra wallet verification");
    expect(message).toContain(`Wallet: ${normalizedAddress}`);
    expect(message).toContain(`Network: Base (${BASE_CHAIN_ID})`);
    expect(message).toContain("Nonce: nonce-1");
    expect(message).toContain("does not authorize a transaction or move funds");
  });

  it("creates a pending challenge for a normalized Base wallet", async () => {
    const row = challengeRow();
    const table = buildInsertTable(row);
    const db = { from: jest.fn(() => table) };

    const challenge = await createWalletVerificationChallenge({
      userId: "user_1",
      address,
      nonce: "nonce-1",
      now,
      db,
    });

    expect(db.from).toHaveBeenCalledWith("wallet_verification_challenges");
    expect(table.insert).toHaveBeenCalledWith(expect.objectContaining({
      user_id: "user_1",
      chain_id: BASE_CHAIN_ID,
      address: normalizedAddress,
      normalized_address: normalizedAddress,
      nonce: "nonce-1",
      status: "pending",
    }));
    expect(challenge).toMatchObject({
      id: "challenge_1",
      normalizedAddress,
      status: "pending",
      expiresAt: future,
    });
  });

  it("verifies a valid signature and stores the primary wallet", async () => {
    const selectChallenge = buildSelectTable(challengeRow());
    const claimsScan = buildListTable([]);
    const clearPrimary = buildThenableUpdateTable();
    const walletUpsert = buildUpsertTable({
      id: "wallet_1",
      user_id: "user_1",
      address: normalizedAddress,
      normalized_address: normalizedAddress,
      chain_type: "evm",
      chain_id: BASE_CHAIN_ID,
      is_primary: true,
      verified_at: now.toISOString(),
    });
    const updateChallenge = buildUpdateSingleTable(challengeRow({
      status: "verified",
      verified_at: now.toISOString(),
      consumed_at: now.toISOString(),
    }));
    const db = {
      from: jest.fn()
        .mockReturnValueOnce(selectChallenge)
        .mockReturnValueOnce(claimsScan)
        .mockReturnValueOnce(clearPrimary)
        .mockReturnValueOnce(walletUpsert)
        .mockReturnValueOnce(updateChallenge),
    };
    const verifier = jest.fn().mockResolvedValue(true);

    const result = await verifyWalletChallenge({
      userId: "user_1",
      challengeId: "challenge_1",
      signature: "0xsig",
      now,
      db,
      verifyMessageImpl: verifier,
    });

    expect(result.status).toBe("verified");
    if (result.status === "verified") {
      expect(result.takeover).toBeNull();
    }
    expect(verifier).toHaveBeenCalledWith(expect.objectContaining({
      address: normalizedAddress,
      signature: "0xsig",
    }));
    expect(claimsScan.neq).toHaveBeenCalledWith("user_id", "user_1");
    expect(clearPrimary.update).toHaveBeenCalledWith({ is_primary: false });
    expect(walletUpsert.upsert).toHaveBeenCalledWith(expect.objectContaining({
      user_id: "user_1",
      normalized_address: normalizedAddress,
      is_primary: true,
      verification_method: "signature",
      verification_reference: "challenge_1",
    }), { onConflict: "user_id,chain_type,normalized_address" });
    expect(updateChallenge.update).toHaveBeenCalledWith(expect.objectContaining({
      status: "verified",
      verified_at: now.toISOString(),
      consumed_at: now.toISOString(),
    }));
  });

  // Regression: the sybil gap — the SAME self-custody wallet could be
  // signature-verified as primary by multiple accounts, each independently
  // qualifying for token tiers off the same on-chain balance. A successful
  // verification must now take the wallet over: demote every other account's
  // claim and revoke their displaced token entitlements.
  it("takes the wallet over when a second account verifies the same address", async () => {
    const selectChallenge = buildSelectTable(
      challengeRow({ id: "challenge_2", user_id: "user_2" })
    );
    const claimsScan = buildListTable([
      {
        id: "wallet_user1",
        user_id: "user_1",
        is_primary: true,
        verified_at: "2026-04-20T00:00:00.000Z",
        metadata: { existing: "kept" },
      },
    ]);
    const demoteClaim = buildThenableUpdateTable();
    const clearPrimary = buildThenableUpdateTable();
    const walletUpsert = buildUpsertTable({
      id: "wallet_user2",
      user_id: "user_2",
      address: normalizedAddress,
      normalized_address: normalizedAddress,
      chain_type: "evm",
      chain_id: BASE_CHAIN_ID,
      is_primary: true,
      verified_at: now.toISOString(),
    });
    const updateChallenge = buildUpdateSingleTable(challengeRow({
      id: "challenge_2",
      user_id: "user_2",
      status: "verified",
      verified_at: now.toISOString(),
      consumed_at: now.toISOString(),
    }));
    const db = {
      from: jest.fn()
        .mockReturnValueOnce(selectChallenge)
        .mockReturnValueOnce(claimsScan)
        .mockReturnValueOnce(demoteClaim)
        .mockReturnValueOnce(clearPrimary)
        .mockReturnValueOnce(walletUpsert)
        .mockReturnValueOnce(updateChallenge),
    };
    const verifier = jest.fn().mockResolvedValue(true);
    const revoke = jest.fn().mockResolvedValue(undefined);

    const result = await verifyWalletChallenge({
      userId: "user_2",
      challengeId: "challenge_2",
      signature: "0xsig",
      now,
      db,
      verifyMessageImpl: verifier,
      revokeDisplacedEntitlementsImpl: revoke,
    });

    expect(result.status).toBe("verified");
    if (result.status === "verified") {
      expect(result.takeover).toEqual({ displacedUserIds: ["user_1"] });
      expect(result.wallet.userId).toBe("user_2");
    }
    // The first account's claim is demoted AND unverified, with a breadcrumb
    // merged into (not clobbering) its metadata.
    expect(demoteClaim.update).toHaveBeenCalledWith({
      is_primary: false,
      verified_at: null,
      metadata: {
        existing: "kept",
        wallet_takeover: expect.objectContaining({
          reason: "reverified_by_another_account",
          challenge_id: "challenge_2",
          was_primary: true,
          demoted_at: now.toISOString(),
        }),
      },
    });
    expect(demoteClaim.filter.eq).toHaveBeenCalledWith("id", "wallet_user1");
    expect(walletUpsert.upsert).toHaveBeenCalledWith(expect.objectContaining({
      user_id: "user_2",
      normalized_address: normalizedAddress,
      is_primary: true,
    }), { onConflict: "user_id,chain_type,normalized_address" });
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user_1",
      normalizedAddress,
      challengeId: "challenge_2",
      now,
    }));
  });

  it("ignores stale unverified rows on other accounts (no takeover)", async () => {
    const selectChallenge = buildSelectTable(
      challengeRow({ id: "challenge_2", user_id: "user_2" })
    );
    const claimsScan = buildListTable([
      {
        id: "wallet_user1",
        user_id: "user_1",
        is_primary: false,
        verified_at: null,
        metadata: {},
      },
    ]);
    const clearPrimary = buildThenableUpdateTable();
    const walletUpsert = buildUpsertTable({
      id: "wallet_user2",
      user_id: "user_2",
      address: normalizedAddress,
      normalized_address: normalizedAddress,
      chain_type: "evm",
      chain_id: BASE_CHAIN_ID,
      is_primary: true,
      verified_at: now.toISOString(),
    });
    const updateChallenge = buildUpdateSingleTable(challengeRow({
      id: "challenge_2",
      user_id: "user_2",
      status: "verified",
    }));
    const db = {
      from: jest.fn()
        .mockReturnValueOnce(selectChallenge)
        .mockReturnValueOnce(claimsScan)
        .mockReturnValueOnce(clearPrimary)
        .mockReturnValueOnce(walletUpsert)
        .mockReturnValueOnce(updateChallenge),
    };
    const revoke = jest.fn();

    const result = await verifyWalletChallenge({
      userId: "user_2",
      challengeId: "challenge_2",
      signature: "0xsig",
      now,
      db,
      verifyMessageImpl: jest.fn().mockResolvedValue(true),
      revokeDisplacedEntitlementsImpl: revoke,
    });

    expect(result.status).toBe("verified");
    if (result.status === "verified") {
      expect(result.takeover).toBeNull();
    }
    expect(revoke).not.toHaveBeenCalled();
  });

  it("keeps the verification result when displaced-entitlement revocation fails", async () => {
    const selectChallenge = buildSelectTable(
      challengeRow({ id: "challenge_2", user_id: "user_2" })
    );
    const claimsScan = buildListTable([
      {
        id: "wallet_user1",
        user_id: "user_1",
        is_primary: true,
        verified_at: "2026-04-20T00:00:00.000Z",
        metadata: {},
      },
    ]);
    const demoteClaim = buildThenableUpdateTable();
    const clearPrimary = buildThenableUpdateTable();
    const walletUpsert = buildUpsertTable({
      id: "wallet_user2",
      user_id: "user_2",
      address: normalizedAddress,
      normalized_address: normalizedAddress,
      chain_type: "evm",
      chain_id: BASE_CHAIN_ID,
      is_primary: true,
      verified_at: now.toISOString(),
    });
    const updateChallenge = buildUpdateSingleTable(challengeRow({
      id: "challenge_2",
      user_id: "user_2",
      status: "verified",
    }));
    const db = {
      from: jest.fn()
        .mockReturnValueOnce(selectChallenge)
        .mockReturnValueOnce(claimsScan)
        .mockReturnValueOnce(demoteClaim)
        .mockReturnValueOnce(clearPrimary)
        .mockReturnValueOnce(walletUpsert)
        .mockReturnValueOnce(updateChallenge),
    };
    const revoke = jest.fn().mockRejectedValue(new Error("db down"));

    const result = await verifyWalletChallenge({
      userId: "user_2",
      challengeId: "challenge_2",
      signature: "0xsig",
      now,
      db,
      verifyMessageImpl: jest.fn().mockResolvedValue(true),
      revokeDisplacedEntitlementsImpl: revoke,
    });

    expect(result.status).toBe("verified");
    if (result.status === "verified") {
      expect(result.takeover).toEqual({ displacedUserIds: ["user_1"] });
    }
  });

  describe("revokeDisplacedTokenEntitlements", () => {
    it("skips accounts that still qualify through a different wallet", async () => {
      (getTokenVerificationWallet as jest.Mock).mockResolvedValueOnce({ id: "wallet_other" });
      const db = { from: jest.fn() };

      await revokeDisplacedTokenEntitlements({
        userId: "user_1",
        normalizedAddress,
        challengeId: "challenge_2",
        db,
        now,
      });

      expect(db.from).not.toHaveBeenCalled();
    });

    it("writes a zero snapshot and suspends qualifications when no wallet remains", async () => {
      (getTokenVerificationWallet as jest.Mock).mockResolvedValueOnce(null);
      const snapshotInsert = buildInsertTable({ id: "snap_1" });
      const qualUpdate = buildThenableUpdateTable();
      const boostUpdate = buildThenableUpdateTable();
      const db = {
        from: jest.fn()
          .mockReturnValueOnce(snapshotInsert)
          .mockReturnValueOnce(qualUpdate)
          .mockReturnValueOnce(boostUpdate),
      };

      await revokeDisplacedTokenEntitlements({
        userId: "user_1",
        normalizedAddress,
        challengeId: "challenge_2",
        db,
        now,
      });

      expect(db.from).toHaveBeenNthCalledWith(1, "token_holding_snapshots");
      expect(db.from).toHaveBeenNthCalledWith(2, "token_tier_qualifications");
      expect(db.from).toHaveBeenNthCalledWith(3, "venice_compute_boost_qualifications");
      expect(snapshotInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
        user_id: "user_1",
        normalized_wallet_address: normalizedAddress,
        balance_raw: "0",
        qualifies_base_tier: false,
        source: "admin",
        metadata: { reason: "wallet_takeover", challenge_id: "challenge_2" },
      }));
      expect(qualUpdate.update).toHaveBeenCalledWith({
        currently_eligible: false,
        last_breach_at: now.toISOString(),
      });
      expect(qualUpdate.filter.eq).toHaveBeenCalledWith("user_id", "user_1");
      expect(qualUpdate.filter.eq).toHaveBeenCalledWith("currently_eligible", true);
      expect(boostUpdate.update).toHaveBeenCalledWith({
        currently_eligible: false,
        last_breach_at: null,
      });
    });
  });

  it("marks an invalid signature as failed", async () => {
    const selectChallenge = buildSelectTable(challengeRow());
    const updateChallenge = buildUpdateSingleTable(challengeRow({
      status: "failed",
      consumed_at: now.toISOString(),
      failure_reason: "invalid_signature",
    }));
    const db = {
      from: jest.fn()
        .mockReturnValueOnce(selectChallenge)
        .mockReturnValueOnce(updateChallenge),
    };
    const verifier = jest.fn().mockResolvedValue(false);

    const result = await verifyWalletChallenge({
      userId: "user_1",
      challengeId: "challenge_1",
      signature: "0xbad",
      now,
      db,
      verifyMessageImpl: verifier,
    });

    expect(result.status).toBe("invalid_signature");
    expect(updateChallenge.update).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      failure_reason: "invalid_signature",
    }));
  });

  it("expires old challenges without checking a signature", async () => {
    const selectChallenge = buildSelectTable(challengeRow({ expires_at: expired }));
    const updateChallenge = buildUpdateSingleTable(challengeRow({
      status: "expired",
      expires_at: expired,
      consumed_at: now.toISOString(),
      failure_reason: "expired",
    }));
    const db = {
      from: jest.fn()
        .mockReturnValueOnce(selectChallenge)
        .mockReturnValueOnce(updateChallenge),
    };
    const verifier = jest.fn().mockResolvedValue(true);

    const result = await verifyWalletChallenge({
      userId: "user_1",
      challengeId: "challenge_1",
      signature: "0xsig",
      now,
      db,
      verifyMessageImpl: verifier,
    });

    expect(result.status).toBe("expired");
    expect(verifier).not.toHaveBeenCalled();
    expect(updateChallenge.update).toHaveBeenCalledWith(expect.objectContaining({
      status: "expired",
      failure_reason: "expired",
    }));
  });
});

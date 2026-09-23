import { readFileSync } from "fs";
import path from "path";

import {
  ACCOUNT_DELETION_TABLES,
  assertClerkDeletionPolicy,
  assertConfirmedAccountDeletion,
  assertNoLiveHivraComputers,
  buildDeletionTableSummary,
  extractStorageObjectPath,
  isMissingOptionalAccountDeletionTableError,
  requireClerkSecretKey,
  resolveOpsSecretEnvPath,
} from "@/lib/ops/account-deletion";

describe("account deletion safeguards", () => {
  it("requires an exact Clerk user id confirmation before destructive deletion", () => {
    expect(() =>
      assertConfirmedAccountDeletion({
        userId: "user_fixtureaccount",
        confirmationUserId: "user_someoneElse",
      })
    ).toThrow(/confirmation/i);

    expect(() =>
      assertConfirmedAccountDeletion({
        userId: "not-a-clerk-id",
        confirmationUserId: "not-a-clerk-id",
      })
    ).toThrow(/Clerk user id/i);

    expect(() =>
      assertConfirmedAccountDeletion({
        userId: "user_fixtureaccount",
        confirmationUserId: "user_fixtureaccount",
      })
    ).not.toThrow();
  });

  it("covers user-owned tables that the old purge script missed", () => {
    const tableNames = ACCOUNT_DELETION_TABLES.map((entry) => entry.table);

    expect(tableNames).toEqual(
      expect.arrayContaining([
        "hermes_conversations",
        "hermes_chat_stream_jobs",
        "llm_usage_events",
        "credit_accounts",
        "payment_transactions",
        "signup_risk_assessments",
        "stripe_checkout_session_activations",
        "instance_bankr_wallet_recipients",
        "instance_bankr_wallets",
        "user_wallets",
        "wallet_verification_challenges",
        "yearly_token_subscriptions",
      ])
    );

    expect(tableNames.indexOf("credit_ledger_entries")).toBeLessThan(
      tableNames.indexOf("credit_accounts")
    );
    expect(tableNames.indexOf("credit_reservations")).toBeLessThan(
      tableNames.indexOf("credit_accounts")
    );
    expect(tableNames.indexOf("hermes_chat_stream_jobs")).toBeLessThan(
      tableNames.indexOf("hermes_conversations")
    );
    expect(tableNames.indexOf("instance_bankr_wallet_recipients")).toBeLessThan(
      tableNames.indexOf("instance_bankr_wallets")
    );
    expect(tableNames.indexOf("instance_bankr_wallets")).toBeLessThan(
      tableNames.indexOf("hermes_instances")
    );
  });

  it("deletes yearly token rows before the quotes they reference", () => {
    const tableNames = ACCOUNT_DELETION_TABLES.map((entry) => entry.table);

    expect(tableNames.indexOf("yearly_token_reconciliation_items")).toBeGreaterThanOrEqual(0);
    expect(tableNames.indexOf("yearly_token_reconciliation_items")).toBeLessThan(
      tableNames.indexOf("yearly_token_subscriptions")
    );
    // yearly_token_subscriptions.yearly_quote_id references yearly_token_quotes.
    expect(tableNames.indexOf("yearly_token_subscriptions")).toBeLessThan(
      tableNames.indexOf("yearly_token_quotes")
    );
  });

  it("covers managed Venice account data in deletion-safe dependency order", () => {
    const tableNames = ACCOUNT_DELETION_TABLES.map((entry) => entry.table);

    expect(tableNames).toEqual(
      expect.arrayContaining([
        "managed_venice_reservations",
        "managed_venice_usage_events",
        "managed_venice_reconciliation_items",
        "managed_venice_proxy_keys",
        "managed_venice_token_quotes",
        "managed_venice_token_lots",
        "managed_venice_card_ledger_entries",
        "managed_venice_wallet_accounts",
      ])
    );

    expect(tableNames.indexOf("managed_venice_reservations")).toBeLessThan(
      tableNames.indexOf("managed_venice_usage_events")
    );
    expect(tableNames.indexOf("managed_venice_usage_events")).toBeLessThan(
      tableNames.indexOf("managed_venice_proxy_keys")
    );
    expect(tableNames.indexOf("managed_venice_reconciliation_items")).toBeLessThan(
      tableNames.indexOf("managed_venice_proxy_keys")
    );
    expect(tableNames.indexOf("managed_venice_token_quotes")).toBeLessThan(
      tableNames.indexOf("managed_venice_wallet_accounts")
    );
    expect(tableNames.indexOf("managed_venice_token_lots")).toBeLessThan(
      tableNames.indexOf("managed_venice_wallet_accounts")
    );
    expect(tableNames.indexOf("managed_venice_card_ledger_entries")).toBeLessThan(
      tableNames.indexOf("managed_venice_wallet_accounts")
    );
    expect(tableNames).not.toContain("managed_venice_financial_events");
  });

  it("extracts Supabase storage object paths without accepting unrelated URLs", () => {
    expect(
      extractStorageObjectPath(
        "https://example.supabase.co/storage/v1/object/public/avatars/profile%20one.png",
        "avatars"
      )
    ).toBe("profile one.png");

    expect(
      extractStorageObjectPath(
        "https://example.supabase.co/storage/v1/object/sign/hermes-attachments/migrations/user_123/import.zip?token=abc",
        "hermes-attachments"
      )
    ).toBe("migrations/user_123/import.zip");

    expect(
      extractStorageObjectPath("https://example.com/storage/v1/object/public/other/file.png", "avatars")
    ).toBeNull();
  });

  it("summarizes deletion coverage for operator review", () => {
    expect(
      buildDeletionTableSummary([
        { table: "hermes_instances", filterColumn: "user_id", count: 1 },
        { table: "hermes_conversations", filterColumn: "user_id", count: 4 },
      ])
    ).toEqual("hermes_instances(user_id)=1, hermes_conversations(user_id)=4");
  });

  it("uses a shared per-machine ops secret file outside the repository", () => {
    expect(resolveOpsSecretEnvPath({}, "/Users/example")).toBe(
      "/Users/example/.config/hermesdeploy/ops-secrets.env"
    );

    expect(
      resolveOpsSecretEnvPath(
        { HERMES_OPS_SECRET_ENV_PATH: "/tmp/hermes-ops.env" },
        "/Users/example"
      )
    ).toBe("/tmp/hermes-ops.env");
  });

  // Regressions for the Fixture Customer A / Fixture Customer B incident (2026-05-07):
  // delete-user-account.ts destroyed Fixture Customer B's instance + DB rows but left her
  // Clerk login alive, because (a) Clerk deletion was the LAST step and
  // silently no-op'd when CLERK_SECRET_KEY was missing, and (b) `--skip-clerk`
  // could be combined with `--apply` without any acknowledgement that the
  // resulting account would be orphaned.
  describe("Clerk deletion policy", () => {
    it("allows dry runs regardless of skip-clerk flags", () => {
      expect(() =>
        assertClerkDeletionPolicy({ apply: false, skipClerk: false, acceptOrphanRisk: false })
      ).not.toThrow();
      expect(() =>
        assertClerkDeletionPolicy({ apply: false, skipClerk: true, acceptOrphanRisk: false })
      ).not.toThrow();
    });

    it("allows apply when Clerk deletion will run", () => {
      expect(() =>
        assertClerkDeletionPolicy({ apply: true, skipClerk: false, acceptOrphanRisk: false })
      ).not.toThrow();
    });

    it("rejects apply + skip-clerk without an explicit orphan-risk ack", () => {
      expect(() =>
        assertClerkDeletionPolicy({ apply: true, skipClerk: true, acceptOrphanRisk: false })
      ).toThrow(/orphan/i);
      expect(() =>
        assertClerkDeletionPolicy({ apply: true, skipClerk: true, acceptOrphanRisk: false })
      ).toThrow(/--accept-orphan-risk/);
    });

    it("allows apply + skip-clerk + accept-orphan-risk (operator opted in)", () => {
      expect(() =>
        assertClerkDeletionPolicy({ apply: true, skipClerk: true, acceptOrphanRisk: true })
      ).not.toThrow();
    });
  });

  describe("requireClerkSecretKey", () => {
    it("throws with a recovery hint when CLERK_SECRET_KEY is missing", () => {
      expect(() => requireClerkSecretKey({})).toThrow(/CLERK_SECRET_KEY missing/);
      expect(() => requireClerkSecretKey({})).toThrow(/--skip-clerk --accept-orphan-risk/);
    });

    it("treats whitespace-only values as missing", () => {
      expect(() => requireClerkSecretKey({ CLERK_SECRET_KEY: "   " })).toThrow(/missing/i);
    });

    it("returns a trimmed value when present", () => {
      expect(requireClerkSecretKey({ CLERK_SECRET_KEY: "  sk_test_abc  " })).toBe("sk_test_abc");
    });
  });

  // Static-source guard against regressing the Clerk-first ordering. main()
  // must invoke deleteClerkUser BEFORE teardownInstanceProviders / DB
  // teardown / deleteOwnedHostsWhenUnshared — otherwise a Clerk failure
  // mid-run (network, rate-limit, missing key) leaves an orphaned account
  // exactly the way Fixture Customer A's row was orphaned.
  it("delete-user-account script keeps Clerk deletion before provider teardown", () => {
    const scriptPath = path.resolve(__dirname, "../../../../scripts/delete-user-account.ts");
    const source = readFileSync(scriptPath, "utf8");

    const idx = (needle: string) => source.indexOf(needle);
    const clerkCall = idx("await deleteClerkUser(args.userId)");
    const providerTeardown = idx("await teardownInstanceProviders(");
    const stripeTeardown = idx("await deleteStripeCustomers(");
    const storageTeardown = idx("await removeStoragePaths(");
    const hostsTeardown = idx("await deleteOwnedHostsWhenUnshared(");

    expect(clerkCall).toBeGreaterThan(0);
    expect(providerTeardown).toBeGreaterThan(0);
    expect(stripeTeardown).toBeGreaterThan(0);
    expect(storageTeardown).toBeGreaterThan(0);
    expect(hostsTeardown).toBeGreaterThan(0);

    // The literal call site for Clerk must precede every other
    // destructive step in main(). If you reorder these, you almost
    // certainly want to add a new safety net first — see the
    // 2026-05-07 Fixture Customer A / Fixture Customer B incident for context.
    expect(clerkCall).toBeLessThan(providerTeardown);
    expect(clerkCall).toBeLessThan(stripeTeardown);
    expect(clerkCall).toBeLessThan(storageTeardown);
    expect(clerkCall).toBeLessThan(hostsTeardown);
  });

  it("does not skip provider teardown solely because an instance row is marked deleted", () => {
    const scriptPath = path.resolve(__dirname, "../../../../scripts/delete-user-account.ts");
    const source = readFileSync(scriptPath, "utf8");

    expect(source).not.toContain("provider teardown skipped");
    expect(source).not.toMatch(/if \(isDeletedInstance\(instance\)\)[\s\S]{0,200}continue;/);
  });

  it("treats missing optional legacy tables as skippable", () => {
    expect(
      ACCOUNT_DELETION_TABLES.find((entry) => entry.table === "user_vault_profiles")
        ?.optionalIfMissing
    ).toBe(true);

    expect(
      isMissingOptionalAccountDeletionTableError(
        {
          table: "user_vault_profiles",
          filterColumn: "user_id",
          source: "userId",
          reason: "legacy vault profile rows",
          optionalIfMissing: true,
        },
        { message: "Could not find the table 'public.user_vault_profiles' in the schema cache" }
      )
    ).toBe(true);

    expect(
      isMissingOptionalAccountDeletionTableError(
        {
          table: "hermes_instances",
          filterColumn: "user_id",
          source: "userId",
          reason: "instance rows",
        },
        { message: "Could not find the table 'public.hermes_instances' in the schema cache" }
      )
    ).toBe(false);
  });

  it("deletes the user's Hivra agent activity records by user id", () => {
    for (const table of ["hivra_agent_events", "hivra_activity_collectors"]) {
      const spec = ACCOUNT_DELETION_TABLES.find((entry) => entry.table === table);
      expect(spec).toEqual(
        expect.objectContaining({ filterColumn: "user_id", source: "userId" })
      );
    }
    // The events table is required; only the newer collectors table may be absent.
    expect(
      ACCOUNT_DELETION_TABLES.find((entry) => entry.table === "hivra_agent_events")?.optionalIfMissing
    ).toBeUndefined();
  });

  it("refuses an apply while the user still has Hivra computers that are not deleted", () => {
    expect(() =>
      assertNoLiveHivraComputers({ apply: true, liveComputerIds: ["agent-1"] })
    ).toThrow(/Hivra computer\(s\) that are not deleted/);
    expect(() =>
      assertNoLiveHivraComputers({ apply: false, liveComputerIds: ["agent-1"] })
    ).not.toThrow();
    expect(() =>
      assertNoLiveHivraComputers({ apply: true, liveComputerIds: [] })
    ).not.toThrow();
  });

  it("checks for live Hivra computers before the delete-user script revokes the login", () => {
    const script = readFileSync(
      path.resolve(__dirname, "../../../../scripts/delete-user-account.ts"),
      "utf8"
    );
    const guard = script.indexOf("assertNoLiveHivraComputers({ apply: args.apply");
    const clerk = script.indexOf("await deleteClerkUser(args.userId)");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(clerk);
  });
});

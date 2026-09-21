import { readFileSync } from "fs";
import { join } from "path";

describe("apple IAP lane migration", () => {
  const sql = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260716120000_apple_iap_lane.sql",
    ),
    "utf8",
  );

  it("creates the subscriptions table with the identity uniques the lane depends on", () => {
    expect(sql).toMatch(/create table if not exists public\.apple_iap_subscriptions/i);
    expect(sql).toMatch(/user_id text not null unique/i);
    expect(sql).toMatch(/apple_original_transaction_id text not null unique/i);
  });

  it("constrains status to the lane's full lifecycle vocabulary", () => {
    expect(sql).toMatch(
      /status in \('active', 'trialing', 'grace_period', 'past_due', 'expired', 'revoked'\)/i,
    );
  });

  it("keeps sandbox rows distinguishable from production rows", () => {
    expect(sql).toMatch(/environment in \('Sandbox', 'Production'\)/);
  });

  it("creates the appAccountToken mapping table", () => {
    expect(sql).toMatch(/create table if not exists public\.apple_iap_account_tokens/i);
    expect(sql).toMatch(/token uuid not null unique/i);
  });

  it("creates the idempotency ledger mirroring stripe_webhook_events semantics", () => {
    expect(sql).toMatch(/create table if not exists public\.apple_webhook_events/i);
    expect(sql).toMatch(/notification_uuid text primary key/i);
    expect(sql).toMatch(/status in \('processing', 'processed', 'failed'\)/i);
  });

  it("enables RLS on every lane table", () => {
    expect(sql).toMatch(/alter table public\.apple_iap_subscriptions enable row level security/i);
    expect(sql).toMatch(/alter table public\.apple_iap_account_tokens enable row level security/i);
    expect(sql).toMatch(/alter table public\.apple_webhook_events enable row level security/i);
  });

  it("indexes the reconciler scan", () => {
    expect(sql).toMatch(/apple_iap_subscriptions_status_period_end_idx/i);
  });
});

describe("credit ledger apple source migration", () => {
  const sql = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260716120100_credit_ledger_source_apple.sql",
    ),
    "utf8",
  );

  it("re-adds the source CHECK with every existing source plus apple", () => {
    expect(sql).toMatch(/credit_ledger_entries_source_check/);
    for (const source of ["stripe", "bankr", "admin", "system", "apple"]) {
      expect(sql).toMatch(new RegExp(`'${source}'`));
    }
  });

  it("only ever drops a CHECK constraint (never the ledger uniques)", () => {
    expect(sql).toMatch(/c\.contype = 'c'/);
  });
});

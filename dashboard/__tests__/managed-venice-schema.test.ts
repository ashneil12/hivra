import fs from "node:fs";
import path from "node:path";

const MIGRATION = path.resolve(
  __dirname,
  "../supabase/migrations/20260512180000_managed_venice_wallets.sql"
);
const TOKEN_QUOTES_MIGRATION = path.resolve(
  __dirname,
  "../supabase/migrations/20260512181000_managed_venice_token_quotes.sql"
);
const TOKEN_SWEEPS_MIGRATION = path.resolve(
  __dirname,
  "../supabase/migrations/20260516120000_managed_venice_token_treasury_sweeps.sql"
);

const TABLES = [
  "managed_venice_wallet_accounts",
  "managed_venice_token_lots",
  "managed_venice_card_ledger_entries",
  "managed_venice_proxy_keys",
  "managed_venice_reservations",
  "managed_venice_usage_events",
  "managed_venice_financial_events",
  "managed_venice_reconciliation_items",
  "managed_venice_platform_state",
];

function readMigration() {
  return fs.readFileSync(MIGRATION, "utf8").toLowerCase();
}

function readTokenQuoteMigration() {
  return fs.readFileSync(TOKEN_QUOTES_MIGRATION, "utf8").toLowerCase();
}

function readTokenSweepMigration() {
  return fs.readFileSync(TOKEN_SWEEPS_MIGRATION, "utf8").toLowerCase();
}

describe("managed Venice wallet schema", () => {
  it("creates every managed Venice accounting table", () => {
    const sql = readMigration();

    for (const table of TABLES) {
      expect(sql).toContain(`create table if not exists public.${table}`);
    }
  });

  it("enables RLS and grants service-role access for every managed table", () => {
    const sql = readMigration();

    for (const table of TABLES) {
      expect(sql).toContain(`alter table public.${table} enable row level security`);
      expect(sql).toContain(`service role full access ${table}`);
    }
  });

  it("keeps user-visible wallet rows readable without exposing financial internals", () => {
    const sql = readMigration();

    for (const table of [
      "managed_venice_wallet_accounts",
      "managed_venice_token_lots",
      "managed_venice_proxy_keys",
      "managed_venice_usage_events",
    ]) {
      expect(sql).toContain(`users can read own ${table}`);
    }

    expect(sql).not.toContain("users can read own managed_venice_financial_events");
  });

  it("uses microdollar balances and append-only financial events", () => {
    const sql = readMigration();

    expect(sql).toContain(
      "remaining_value_micro_usd bigint not null check (remaining_value_micro_usd >= 0)"
    );
    expect(sql).toContain(
      "create unique index if not exists managed_venice_financial_events_idempotency_idx"
    );
    expect(sql).toContain("prevent_managed_venice_financial_event_mutation");
    expect(sql).toContain("'managed_venice_financial_events is append-only'");
  });

  it("adds managed Venice token quote storage and a separate Bankr wallet purpose", () => {
    const sql = readTokenQuoteMigration();

    expect(sql).toContain(
      "create table if not exists public.managed_venice_token_quotes"
    );
    expect(sql).toContain("'managed_venice_inference'");
    expect(sql).toContain(
      "locked_value_micro_usd bigint not null check (locked_value_micro_usd > 0)"
    );
    expect(sql).toContain("check (expires_at > quoted_at)");
    expect(sql).toContain(
      "alter table public.managed_venice_token_quotes enable row level security"
    );
    expect(sql).toContain("users can read own managed_venice_token_quotes");
    expect(sql).toContain("service role full access managed_venice_token_quotes");
    expect(sql).toContain("managed_venice_token_quotes_tx_hash_idx");
  });

  it("tracks managed Venice token treasury sweep state on settled quotes", () => {
    const sql = readTokenSweepMigration();

    expect(sql).toContain("add column if not exists sweep_status");
    expect(sql).toContain("'pending'");
    expect(sql).toContain("'swept'");
    expect(sql).toContain("'failed'");
    expect(sql).toContain("'skipped'");
    expect(sql).toContain("add column if not exists sweep_tx_hash");
    expect(sql).toContain("add column if not exists sweep_attempted_at");
    expect(sql).toContain("add column if not exists sweep_error");
    expect(sql).toContain("add column if not exists sweep_destination_address");
    expect(sql).toContain("managed_venice_token_quotes_sweep_retry_idx");
    expect(sql).toContain("'treasury_sweep'");
  });
});

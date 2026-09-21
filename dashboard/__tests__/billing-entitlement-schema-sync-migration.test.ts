import { readFileSync } from "fs";
import { join } from "path";

describe("billing entitlement schema sync migration", () => {
  const sql = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260608150000_sync_billing_entitlement_schema.sql",
    ),
    "utf8",
  );

  it("adds the subscription excess-resource bookkeeping column idempotently", () => {
    expect(sql).toMatch(/alter table public\.hermes_subscriptions/i);
    expect(sql).toMatch(/add column if not exists excess_resources boolean not null default false/i);
  });

  it("keeps canary instance schema aligned with prod entitlement fields", () => {
    expect(sql).toMatch(/add column if not exists webfree boolean not null default false/i);
    expect(sql).toMatch(/alter column disk_size_gb set default 40/i);
    expect(sql).toMatch(/alter column disk_size_gb set not null/i);
    expect(sql).toMatch(/alter column disk_upgraded set default false/i);
    expect(sql).toMatch(/alter column disk_upgraded set not null/i);
  });
});

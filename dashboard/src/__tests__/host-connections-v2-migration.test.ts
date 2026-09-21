import { readFileSync } from "node:fs";
import path from "node:path";

const migration = readFileSync(
  path.resolve(
    __dirname,
    "../../supabase/migrations/20260826140000_host_connections_v2.sql",
  ),
  "utf8",
);
const normalizedMigration = migration.replace(/\s+/g, " ").toLowerCase();

describe("host-first infrastructure connection migration", () => {
  it("widens the provider check without removing legacy Proxmox compatibility", () => {
    expect(normalizedMigration).toContain(
      "check (provider in ('proxmox', 'host')) not valid",
    );
    expect(normalizedMigration).toContain(
      "validate constraint infrastructure_connections_provider_check",
    );
    expect(normalizedMigration).not.toContain("update public.infrastructure_connections set provider");
  });

  it("creates generic hosts in Simple mode without inferred configuration or targets", () => {
    expect(normalizedMigration).toContain(
      "create or replace function public.create_host_infrastructure_connection(",
    );
    expect(normalizedMigration).toContain(
      "'host', 'self-managed', 'simple', 'pending'",
    );
    expect(normalizedMigration).toContain("'{}'::jsonb");
    expect(normalizedMigration).not.toContain("insert into public.deployment_targets");
  });

  it("keeps the host creation RPC service-role only", () => {
    expect(normalizedMigration).toContain(
      "revoke all on function public.create_host_infrastructure_connection(",
    );
    expect(normalizedMigration).toContain("from public, anon, authenticated");
    expect(normalizedMigration).toContain(
      "grant execute on function public.create_host_infrastructure_connection(",
    );
    expect(normalizedMigration).toContain("to service_role");
  });
});

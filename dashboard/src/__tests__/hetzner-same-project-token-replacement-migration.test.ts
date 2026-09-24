import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const MIGRATIONS = path.resolve(__dirname, "../../supabase/migrations");
const FILE = "20260924171100_hetzner_same_project_token_replacement.sql";
const migration = readFileSync(path.join(MIGRATIONS, FILE), "utf8");
const normalized = migration.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").toLowerCase();

function functionBody(name: string): string {
  const start = normalized.indexOf(`create or replace function public.${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = normalized.indexOf("$$;", start);
  expect(end).toBeGreaterThan(start);
  return normalized.slice(start, end);
}

describe("Hetzner same-project token replacement migration", () => {
  it("is not reverted by a later migration", () => {
    const files = readdirSync(MIGRATIONS).filter((file) => file.endsWith(".sql")).sort();
    const later = files.filter((file) => file > FILE);
    for (const file of later) {
      const text = readFileSync(path.join(MIGRATIONS, file), "utf8").toLowerCase();
      // A later migration must not silently revert either trigger function.
      expect(text).not.toContain("function public.revoke_first_boot_on_secret_change");
      expect(text).not.toContain("function public.guard_first_boot_operation_secret");
    }
  });

  it("swaps only the exact envelope, at the same revision, for the owner's Hetzner connection", () => {
    const body = functionBody("replace_hetzner_cloud_connection_token");
    expect(body).toContain("security invoker");
    expect(body).toContain("and user_id = p_user_id and provider = 'hetzner-cloud' for update");
    expect(body).toContain("if v_connection.revision <> p_expected_revision then return 'connection_changed'");
    expect(body).toContain("and encrypted_bundle = p_expected_encrypted_bundle");
    expect(body).toContain("set encrypted_bundle = p_encrypted_bundle, key_version = 2");
    // The revision never moves, so every revision-bound record carries forward.
    expect(body).not.toMatch(/update public\.infrastructure_connections\b/);
    expect(body).not.toContain("revision = revision + 1");
    expect(body).not.toContain("infrastructure_capacity_orders set");
    expect(body).not.toContain("delete from");
  });

  it("refuses while cleanup, a leased setup step or a server request in flight holds the credential", () => {
    const body = functionBody("replace_hetzner_cloud_connection_token");
    expect(body).toContain("status = 'cleaning' ) then return 'cleanup_in_progress'");
    expect(body).toContain("lease_expires_at > clock_timestamp() ) then return 'setup_step_running'");
    expect(body).toContain(
      "and user_id = p_user_id and status = 'creating' and updated_at > clock_timestamp() - interval '2 minutes' ) then return 'server_request_in_progress'",
    );
  });

  it("uses the same in-flight window as the application's pre-check", () => {
    const service = readFileSync(path.resolve(__dirname, "../lib/infrastructure/hetzner-cloud.ts"), "utf8");
    expect(service).toContain("export const HETZNER_SERVER_REQUEST_IN_FLIGHT_MS = 2 * 60_000;");
    expect(normalized).toContain("interval '2 minutes'");
  });

  it("scopes the trigger bypass to one transaction and one connection", () => {
    const body = functionBody("replace_hetzner_cloud_connection_token");
    expect(body).toContain("set_config('hivra.same_project_token_replacement', p_connection_id::text, true)");
    expect(body.match(/set_config\('hivra\.same_project_token_replacement', '', true\)/g)).toHaveLength(2);
  });

  it("keeps enrollments only for the marked same-project swap and still revokes on any other secret change", () => {
    const body = functionBody("revoke_first_boot_on_secret_change");
    expect(body).toContain("tg_op = 'update' and coalesce(current_setting('hivra.same_project_token_replacement', true), '') = old.connection_id::text then return new");
    expect(body).toContain("update public.infrastructure_first_boot_enrollments set phase = 'revoked',encrypted_token = null");
  });

  it("still blocks a marked swap during a leased setup step and keeps the original guard otherwise", () => {
    const body = functionBody("guard_first_boot_operation_secret");
    expect(body).toContain("current_setting('hivra.same_project_token_replacement', true)");
    expect(body).toContain("lease_expires_at>clock_timestamp()");
    expect(body).toContain("if public.first_boot_retains_connection(old.connection_id) then raise exception");
  });

  it("is service-role only", () => {
    expect(normalized).toContain(
      "revoke all on function public.replace_hetzner_cloud_connection_token( text, uuid, bigint, text, text ) from public, anon, authenticated",
    );
    expect(normalized).toContain(
      "grant execute on function public.replace_hetzner_cloud_connection_token( text, uuid, bigint, text, text ) to service_role",
    );
    expect(normalized).not.toContain("security definer");
  });
});

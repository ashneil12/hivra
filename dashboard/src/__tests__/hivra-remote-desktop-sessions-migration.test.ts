import { readFileSync } from "node:fs";
import path from "node:path";

const migration = readFileSync(path.resolve(
  __dirname,
  "../../supabase/migrations/20260901020000_hivra_remote_desktop_sessions.sql",
), "utf8").replace(/\s+/g, " ").toLowerCase();

describe("Hivra remote desktop session migration", () => {
  it("keeps capability and session state service-role-only", () => {
    for (const table of ["hivra_remote_desktop_capabilities", "hivra_remote_desktop_sessions"]) {
      expect(migration).toContain(`alter table public.${table} enable row level security`);
      expect(migration).toContain(`revoke all on table public.${table} from public,anon,authenticated`);
      expect(migration).toContain(`grant select on table public.${table} to service_role`);
    }
  });

  it("stores hashes, enforces five-minute grants, and forbids URL handoffs", () => {
    expect(migration).toContain("exchange_code_hash text not null unique");
    expect(migration).toContain("session_token_hash text unique");
    expect(migration).toContain("expires_at <= issued_at + interval '5 minutes'");
    expect(migration).toContain("handoff text not null check (handoff in ('cookie','message'))");
    expect(migration).not.toContain("handoff in ('cookie','message','url')");
  });

  it("serializes one controller and requires guest input transition receipts", () => {
    const issue = migration.slice(
      migration.indexOf("create or replace function public.issue_hivra_remote_desktop_session("),
      migration.indexOf("create or replace function public.exchange_hivra_remote_desktop_session("),
    );
    expect(issue).toContain("pg_advisory_xact_lock");
    expect(issue).toContain("controller_conflict");
    expect(issue).toContain("s.input_state='release-pending'");
    expect(issue).not.toContain("s.capability_generation=c.generation and s.input_state='release-pending'");
    expect(issue).toContain("input_takeover_unavailable");
    expect(issue).toContain("revoke_reason='session_expired'");
    expect(migration).toContain("create or replace function public.confirm_hivra_remote_desktop_takeover(");
    expect(migration).toContain("agent-input-suspended");
    expect(migration).toContain("create or replace function public.confirm_hivra_remote_desktop_release(");
    expect(migration).toContain("agent-input-resumed");
  });

  it("keeps a generation's runtime binding immutable", () => {
    const record = migration.slice(
      migration.indexOf("create or replace function public.record_hivra_remote_desktop_capability("),
      migration.indexOf("create or replace function public.issue_hivra_remote_desktop_session("),
    );
    expect(record).toContain("v_existing.generation=p_generation");
    expect(record).toContain("v_existing.revoked_at is not null");
    expect(record).toContain("v_existing.observed_revision<>p_receipt->>'observedrevision'");
    expect(record).toContain("v_existing.installed_transports is distinct from v_transports");
    expect(record).toContain("generation_conflict");
  });

  it("rechecks ownership, generation, expiry, and revocation during exchange and authorization", () => {
    const exchange = migration.slice(
      migration.indexOf("create or replace function public.exchange_hivra_remote_desktop_session("),
      migration.indexOf("create or replace function public.confirm_hivra_remote_desktop_takeover("),
    );
    const authorize = migration.slice(
      migration.indexOf("create or replace function public.authorize_hivra_remote_desktop_session("),
      migration.indexOf("create or replace function public.revoke_hivra_remote_desktop_session("),
    );
    for (const body of [exchange, authorize]) {
      expect(body).toContain("capability_generation");
      expect(body).toContain("revoked_at");
      expect(body).toContain("expires_at>clock_timestamp()");
      expect(body).toContain("hermes_instances");
      expect(body).toContain("hivra_agents");
      expect(body).toContain("s.transport=any(c.installed_transports)");
      expect(body).toContain("c.compositor<>'x11'");
    }
    expect(exchange).toContain("s.issued_at>clock_timestamp()");
    expect(authorize).toContain("s.issued_at>clock_timestamp()");
  });

  it("caps wall-clock validity and rejects a null revocation reason", () => {
    const issue = migration.slice(
      migration.indexOf("create or replace function public.issue_hivra_remote_desktop_session("),
      migration.indexOf("create or replace function public.exchange_hivra_remote_desktop_session("),
    );
    const revoke = migration.slice(
      migration.indexOf("create or replace function public.revoke_hivra_remote_desktop_session("),
      migration.indexOf("create or replace function public.confirm_hivra_remote_desktop_release("),
    );
    expect(issue).toContain("p_issued_at > clock_timestamp()");
    expect(issue).toContain("p_expires_at > clock_timestamp()+interval '5 minutes'");
    expect(revoke).toContain("p_reason is null");
  });

  it("locks every RPC away from public browser roles", () => {
    for (const name of [
      "record_hivra_remote_desktop_capability",
      "issue_hivra_remote_desktop_session",
      "exchange_hivra_remote_desktop_session",
      "confirm_hivra_remote_desktop_takeover",
      "authorize_hivra_remote_desktop_session",
      "revoke_hivra_remote_desktop_session",
      "confirm_hivra_remote_desktop_release",
      "revoke_hivra_remote_desktop_capability",
    ]) {
      expect(migration).toContain(`revoke all on function public.${name}(`);
      expect(migration).toContain(`grant execute on function public.${name}(`);
    }
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";

const sql = readFileSync(path.resolve(
  __dirname,
  "../../supabase/migrations/20260904130000_hivra_provider_resize_operations.sql",
), "utf8").replace(/\s+/g, " ").toLowerCase();

function functionDefinition(name: string): string {
  const start = sql.indexOf(`create function public.${name}(`);
  const bodyStart = sql.indexOf("as $$", start);
  const end = sql.indexOf("$$;", bodyStart);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(bodyStart).toBeGreaterThan(start);
  expect(end).toBeGreaterThan(bodyStart);
  return sql.slice(start, end + 3);
}

describe("allocated-provider resize migration", () => {
  it("corrects the provider receipt command without changing the other SQL guards or rewriting evidence", () => {
    const repair = readFileSync(path.resolve(__dirname,
      "../../supabase/migrations/20260905070000_hivra_provider_resize_action_command.sql"), "utf8")
      .replace(/\s+/g, " ").toLowerCase();
    const corrected = functionDefinition("hivra_provider_resize_action_valid")
      .replace("create function", "create or replace function")
      .replace("'change_type'", "'change_server_type'");
    expect(repair).toContain(corrected);
    expect(repair).toContain("where provider_action is not null and provider_action->>'command' is distinct from 'change_server_type'");
    expect(repair).toContain("raise exception 'existing resize action evidence requires explicit inspection'");
    expect(repair).not.toContain("update public.hivra_provider_resize_operations");
  });

  it("fails closed when required catalog, billing, action, or observation fields are missing", () => {
    expect(functionDefinition("hivra_provider_resize_size_valid")).toContain(
      "coalesce(p_size->>'architecture','') not in ('x86','arm')",
    );
    expect(functionDefinition("hivra_provider_resize_size_valid")).toContain(
      "coalesce(p_size#>>'{price,currency}','') not in ('eur','usd')",
    );
    expect(functionDefinition("hivra_provider_resize_action_valid")).toContain(
      "coalesce(p_action->>'status','') not in ('running','success','error')",
    );
    const observation = functionDefinition("record_hivra_provider_resize_observation");
    expect(observation).toContain("coalesce(p_server_type_id,0) not between 1 and 9007199254740991");
    expect(observation).toContain("coalesce(p_architecture,'') not in ('x86','arm')");
    expect(observation).toContain("coalesce(p_cpu_type,'') not in ('shared','dedicated')");
  });

  it("chains the exact terminal provider shape to the prior verified shape", () => {
    expect(sql).toContain("source_shape_fingerprint_sha256 text not null");
    expect(sql).toContain("current_server_shape is not null and current_server_shape_fingerprint_sha256 is not null");
    expect(sql).toContain("current_server_shape_fingerprint_sha256 = encode(sha256(convert_to(current_server_shape::text,'utf8')),'hex')");
    const guard = functionDefinition("guard_hivra_provider_current_shape");
    expect(guard).toContain("and provider_server_id=old.provider_resource_id and status='succeeded'");
    expect(guard).toContain("q.source_shape_fingerprint_sha256 is distinct from v_previous_fingerprint");
    expect(guard).toContain("new.current_server_shape->>'previousshapefingerprintsha256' is distinct from v_previous_fingerprint");
    expect(guard).toContain("current provider shape requires exact terminal resize evidence");
    const complete = functionDefinition("complete_hivra_provider_resize_operation");
    expect(complete).toContain("'previousshapefingerprintsha256',q.source_shape_fingerprint_sha256");
    expect(complete).toContain("'id',q.provider_observed_server_type_id");
    expect(complete).toContain("'advertiseddiskgb',q.provider_observed_advertised_disk_gb");
    expect(complete).toContain("'primarydiskgb',q.provider_observed_disk_gb");
    expect(complete).toContain("coalesce(current_server_shape_fingerprint_sha256,quote_fingerprint_sha256) =q.source_shape_fingerprint_sha256");
    expect(complete.indexOf("set status='succeeded'")).toBeLessThan(complete.indexOf("set current_server_shape=v_shape"));
  });

  it("does not fabricate a new guest capacity or preflight observation on completion", () => {
    const complete = functionDefinition("complete_hivra_provider_resize_operation");
    expect(complete).not.toContain("update public.deployment_targets set capacity");
    expect(complete).not.toContain("last_preflight_at=");
    expect(complete).not.toContain("least((capacity");
    expect(complete).toContain("update public.hivra_agents set status='stopped'");
  });

  it("permits cancellation only before the provider POST marker exists", () => {
    const cancel = functionDefinition("cancel_hivra_provider_resize_operation");
    expect(cancel).toContain("q.status<>'dispatch_pending' or q.provider_post_attempted_at is not null");
    expect(cancel).toContain("a.desired_state not in ('stopped','deleted')");
    expect(cancel).not.toContain("change_type");
  });
});

import fs from "node:fs";
import path from "node:path";

const sql = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260915150000_hivra_resource_envelopes.sql"), "utf8");

describe("Hivra resource envelope migration", () => {
  it("is partial-rerun safe and does not impose cloud product caps on owned hosts", () => {
    expect(sql).toContain("drop constraint if exists hivra_agents_cpu_max_valid");
    expect(sql).toContain("drop constraint if exists hivra_agents_ram_max_valid");
    expect(sql).not.toMatch(/cpu_max\s*<=\s*8|ram_max\s*<=\s*16/);
  });

  it("atomically commits guarantee and maximum under the exact resize operation", () => {
    const body = sql.slice(sql.indexOf("create or replace function public.continue_hivra_agent_resize_operation"));
    expect(body).toContain("cpu = p_cpu");
    expect(body).toContain("ram = p_ram");
    expect(body).toContain("cpu_max = p_cpu_max");
    expect(body).toContain("ram_max = p_ram_max");
    expect(body).toContain("operation_id = p_operation_id and operation_kind = 'resize'");
    expect(body).toContain("coalesce(operation_payload ->> 'maximumCpu', operation_payload ->> 'cpu')::numeric = p_cpu_max");
    expect(body).toContain("coalesce(operation_payload ->> 'maximumRam', operation_payload ->> 'ram')::integer = p_ram_max");
  });

  it("wraps model reservation so maxima persist in the same transaction", () => {
    expect(sql).toContain("reserve_hivra_launch_model_request_v2");
    expect(sql).toContain("p_agent - 'cpu_max' - 'ram_max'");
    expect(sql).toContain("set cpu_max=v_cpu_max, ram_max=v_ram_max");
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("hermes_instances CPU limit schema", () => {
  it("keeps cpu_limit fractional so Free can insert its 0.5 vCPU cap", () => {
    const migration = readFileSync(
      join(
        process.cwd(),
        "supabase/migrations/20260506012500_allow_fractional_instance_cpu_limit.sql"
      ),
      "utf8"
    );

    expect(migration).toContain("alter column cpu_limit type numeric(6, 2)");
    expect(migration).toContain("Free uses 0.5 vCPU");
  });
});

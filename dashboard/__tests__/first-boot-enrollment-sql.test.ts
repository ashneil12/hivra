import { execFileSync } from "node:child_process";
import { join } from "node:path";

it("enforces first-boot consent, binding, consumption and revocation in actual SQL",()=>{
  const result = execFileSync(process.execPath,[join(process.cwd(),"scripts/test-first-boot-enrollment.cjs")],
    {encoding:"utf8",timeout:30_000});
  expect(result).toContain("PASS first-boot actual SQL:");
},35_000);

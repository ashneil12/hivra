/** @jest-environment node */

// A failed sleep or wake must never push an agent into an error state. The
// only code that writes hivra_agents.status is the lifecycle machinery; none of
// the sleep, wake, reconcile or sweep code may. This reads their source.

import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../../..");
const FILES = [
  "lib/hivra/agent-sleep.ts",
  "lib/hivra/agent-wake.ts",
  "lib/hivra/agent-sleep-store.ts",
  "lib/hivra/agent-sleep-scripts.ts",
  "lib/hivra/agent-sleep-policy.ts",
  "lib/hivra/sleep-reconcile.ts",
  "lib/hivra/sleep-idle-sweep.ts",
  "lib/hivra/sleep-aware.ts",
  "app/api/hivra/agents/[id]/wake/route.ts",
  "app/api/hivra/agents/[id]/sleep/route.ts",
  "app/api/hivra/agents/[id]/sleep-settings/route.ts",
  "app/api/cron/sleep-idle-agents/route.ts",
];

describe("sleep and wake code never sets an agent's status", () => {
  it.each(FILES)("%s writes no status, no error text, and never asks a release to mark an error", (file) => {
    const source = readFileSync(path.join(root, file), "utf8");
    expect(source).not.toMatch(/\bstatus:\s*["'](error|stopped|failed)["']/);
    expect(source).not.toMatch(/markError:\s*true/);
    expect(source).not.toMatch(/\brecordHivraAgentOperationFailure\b|\breleaseHivraAgentOperation\b/);
    // An update that names status or error as a column.
    expect(source).not.toMatch(/\.update\(\{[^}]*\b(status|error)\b\s*[:,}]/);
  });

  it("the migration's lease functions never assign status", () => {
    const sql = readFileSync(path.resolve(root, "../supabase/migrations/20261113060000_hivra_agent_sleep_wake.sql"), "utf8");
    const code = sql.replace(/--.*$/gm, "");
    expect(code).not.toMatch(/\bset\b[^;]*\bstatus\s*=/i);
    expect(code).not.toMatch(/,\s*status\s*=/i);
  });
});

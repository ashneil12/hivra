import { serverEnrollmentAgentPrompt } from "../server-enrollment-agent-prompt";
import { serverEnrollmentCommands } from "../server-enrollment-script";

const ORIGIN = "https://hivra.cloud";

function issued() {
  // Built at run time so no real-looking code sits in the source.
  const code = ["hse1", "a".repeat(16) + "2".repeat(16)].join("_");
  return { code, ...serverEnrollmentCommands(ORIGIN, code) };
}

describe("serverEnrollmentAgentPrompt", () => {
  it("previews with the code on stdin, then leaves the real run to the owner", () => {
    const base = issued();
    const prompt = serverEnrollmentAgentPrompt({ ...base, accountCode: "ABCD-EFGH", expiresAt: "2026-11-12T15:00:00.000Z" });
    expect(prompt).toContain(`printf '%s\\n' '${base.code}' | ${base.dryRunCommand}`);
    expect(prompt).toContain(`   ${base.command}\n`);
    expect(prompt).toContain("| sudo bash -s -- --yes");
    expect(prompt).toContain("Only if I tell you to run it for me");
    expect(prompt).toContain("ABCD-EFGH");
    expect(prompt).toContain("2026-11-12T15:00:00Z");
    expect(prompt).toContain(base.uninstallCommand);
    expect(prompt).toMatch(/macOS, Windows, ARM and Proxmox VE are not supported/);
  });
});

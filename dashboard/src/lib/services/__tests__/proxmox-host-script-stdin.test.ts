import { runProxmoxHostScriptWithStdin } from "@/lib/services/proxmox-instance-service";

describe("runProxmoxHostScriptWithStdin", () => {
  it("keeps sensitive input separate from fixed source and returns only its derived result", async () => {
    const secret = "fixture-sensitive-input-that-must-not-enter-the-script";
    const script = `#!/usr/bin/env bash
set -euo pipefail
IFS= read -r value
printf '%s' "$value" | /usr/bin/wc -c
`;
    expect(script).not.toContain(secret);
    const result = await runProxmoxHostScriptWithStdin(
      script,
      `${secret}\n`,
      { PROXMOX_EXEC_MODE: "local" },
      { timeoutMs: 5_000, maxOutputBytes: 1_024 },
    );
    expect(result.ok).toBe(true);
    expect(Number(result.stdout.trim())).toBe(secret.length);
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
  });

  it("rejects empty or oversized source and oversized stdin before dispatch", async () => {
    const env = { PROXMOX_EXEC_MODE: "local" };
    await expect(runProxmoxHostScriptWithStdin("", "secret", env)).resolves.toMatchObject({ ok: false });
    await expect(runProxmoxHostScriptWithStdin("x".repeat(96 * 1024 + 1), "secret", env))
      .resolves.toMatchObject({ ok: false });
    await expect(runProxmoxHostScriptWithStdin("true", "x".repeat(1024 * 1024 + 1), env))
      .resolves.toMatchObject({ ok: false });
  });
});

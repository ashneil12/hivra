import { spawnSync } from "node:child_process";
import { buildIngressStatusScript } from "../cutover-scripts";

const mockWithStdin = jest.fn(async () => ({ ok: true, stdout: "", stderr: "" }));
const mockViaStdin = jest.fn(async () => ({ ok: true, stdout: "", stderr: "" }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  ...jest.requireActual("@/lib/services/proxmox-instance-service"),
  runProxmoxHostScript: (...args: unknown[]) => mockViaStdin(...(args as [])),
  runProxmoxHostScriptWithStdin: (...args: unknown[]) => mockWithStdin(...(args as [])),
}));

describe("how the cutover scripts reach the host", () => {
  const script = buildIngressStatusScript({ vmid: 4321, metricsPort: null });

  it("stops at its own `exec </dev/null` when fed on stdin, which is why it never is", () => {
    const fed = spawnSync("bash", ["-s"], { input: script, encoding: "utf8", timeout: 20_000 });
    expect(fed.status).toBe(0);
    expect(fed.stdout).not.toContain("HIVRA_INGRESS_STEP");
  });

  it("answers when run as an argument with empty stdin", () => {
    const run = spawnSync("bash", ["-c", script], { input: "", encoding: "utf8", timeout: 20_000 });
    expect(run.stdout).toContain('HIVRA_INGRESS_STEP {"step":"status"');
  });

  it("runs every ingress host script through the stdin-free path", async () => {
    const { DEFAULT_INGRESS_DEPS } = await import("../enable");
    await DEFAULT_INGRESS_DEPS.runHostScript(script, {}, { timeoutMs: 1_000, maxOutputBytes: 1_024 });
    expect(mockViaStdin).not.toHaveBeenCalled();
    expect(mockWithStdin).toHaveBeenCalledWith(script, "", {}, { timeoutMs: 1_000, maxOutputBytes: 1_024 });
  });
});

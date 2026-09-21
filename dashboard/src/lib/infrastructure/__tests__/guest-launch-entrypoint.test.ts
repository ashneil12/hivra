/** @jest-environment node */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES } from "../portable-provisioner-contract";

it("executes strict launch decoding, real atomic filesystem writes and service failure handling", () => {
  const result = spawnSync("/usr/bin/python3", ["-I", "-B", "scripts/test-guest-install.py"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 20_000,
  });
  expect({ status: result.status, stdout: result.stdout, stderr: result.stderr.replace(/Ran \d+ tests in [\d.]+s/, "TESTS") })
    .toMatchObject({ status: 0, stdout: "" });
  expect(result.stderr).toContain("OK");
});

it("ships the shared guest entrypoint without treating it as a Proxmox-only helper", () => {
  expect(PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES).toContain("hivra-install-agent.py");
  const source = readFileSync(path.join(process.cwd(), "provisioner/hivra-provision-on-host.sh"), "utf8");
  expect(source).toContain("guest_launch_document |");
  expect(source).toContain("sudo -n /usr/bin/python3 -I -B ${GUEST_PROVISIONER}/hivra-install-agent.py");
  expect(source).toContain("GUEST_PROVISIONER=/opt/hivra/provider-bundle");
  expect(source).toContain("tar --no-same-owner --no-same-permissions -xf -");
  expect(source).toContain("native provisioner source is not root-owned");
  expect(source).not.toContain("GUEST_MODEL_SECRET");
  expect(source).not.toContain("GUEST_TUNNEL_SECRET");
  expect(source.indexOf("hivra-install-agent.py")).toBeLessThan(source.indexOf('qm create "$VMID"'));
  expect(source).toContain('curl -fsS -m 8 "${HIVRA_TUNNEL_URL%/}/healthz"');
});

function document(env: Record<string, string>) {
  const source = readFileSync(path.join(process.cwd(), "provisioner/hivra-provision-on-host.sh"), "utf8");
  const start = source.indexOf("guest_launch_document() {");
  const end = source.indexOf("\nguest_launch_document |", start);
  return spawnSync("/bin/bash", ["--noprofile", "--norc", "-s"], {
    input: `set -euo pipefail\n${source.slice(start, end)}\nguest_launch_document\n`,
    env: { NODE_ENV: "test", PATH: "/usr/bin:/bin", HOME: "/tmp", TMPDIR: "/tmp",
      AGENT_KIND: "codex", HIVRA_MODEL_KEY: "fixture-only",
      HIVRA_MODEL_BASE_URL: "", HIVRA_HERMES_MODEL: "", HIVRA_TUNNEL_URL: "", HIVRA_COMPUTER_ID: "",
      HIVRA_CONTROL_ORIGIN: "", ...env }, encoding: "utf8", timeout: 3_000,
  });
}

it.each(["claude", "codex", "aeon", "openclaw", "agent-zero"])("passes %s and literal secret bytes through stdin JSON", kind => {
  const result = document({ AGENT_KIND: kind, HIVRA_WANT_BROWSER: "1", HIVRA_MODEL_KEY: "literal-'\"$(not-executed)", HIVRA_TUNNEL_TOKEN: "fixture-tunnel" });
  expect(result.status).toBe(0); expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({ version: 1, agentKind: kind, computerSubstrate: "proxmox-kvm", wantBrowser: true,
    modelKey: "literal-'\"$(not-executed)", modelBaseUrl: "", model: "", tunnelToken: "fixture-tunnel", accessHostname: null });
});
it("emits the native v2 Proxmox document only with its fixed named HTTPS origin", () => {
  const result = document({ AGENT_KIND: "deepseek-harness", HIVRA_MODEL_KEY: "", HIVRA_TUNNEL_TOKEN: "fixture-tunnel",
    HIVRA_TUNNEL_URL: "https://native.example.test" });
  expect(result.status).toBe(0); expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({ version: 2, agentKind: "deepseek-harness", computerSubstrate: "proxmox-kvm",
    wantBrowser: null, modelKey: "", modelBaseUrl: "", model: "", tunnelToken: "fixture-tunnel",
    accessHostname: null, publicOrigin: "https://native.example.test" });
  expect(document({ AGENT_KIND: "deepseek-harness", HIVRA_MODEL_KEY: "", HIVRA_TUNNEL_TOKEN: "fixture-tunnel" }).status).toBe(1);
  expect(document({ AGENT_KIND: "deepseek-harness", HIVRA_MODEL_KEY: "synthetic", HIVRA_TUNNEL_TOKEN: "fixture-tunnel",
    HIVRA_TUNNEL_URL: "https://native.example.test" }).status).toBe(1);
});
it("emits Linux Desktop only as a strict v3 computer launch", () => {
  const result = document({ AGENT_KIND: "linux-desktop", HIVRA_MODEL_KEY: "", HIVRA_TUNNEL_TOKEN: "fixture-tunnel",
    HIVRA_TUNNEL_URL: "https://computer.example.test", HIVRA_COMPUTER_ID: "11111111-1111-4111-8111-111111111111",
    HIVRA_CONTROL_ORIGIN: "https://canary.example.test" });
  expect(result.status).toBe(0); expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({ version: 3, agentKind: "linux-desktop", computerSubstrate: "proxmox-kvm",
    wantBrowser: null, modelKey: "", modelBaseUrl: "", model: "", tunnelToken: "fixture-tunnel",
    accessHostname: null, publicOrigin: "https://computer.example.test",
    computerId: "11111111-1111-4111-8111-111111111111", controlOrigin: "https://canary.example.test" });
  expect(document({ AGENT_KIND: "linux-desktop", HIVRA_MODEL_KEY: "", HIVRA_TUNNEL_TOKEN: "fixture-tunnel",
    HIVRA_TUNNEL_URL: "", HIVRA_COMPUTER_ID: "11111111-1111-4111-8111-111111111111",
    HIVRA_CONTROL_ORIGIN: "https://canary.example.test" }).status).toBe(1);
  expect(document({ AGENT_KIND: "linux-desktop", HIVRA_MODEL_KEY: "synthetic", HIVRA_TUNNEL_TOKEN: "fixture-tunnel",
    HIVRA_TUNNEL_URL: "https://computer.example.test", HIVRA_COMPUTER_ID: "11111111-1111-4111-8111-111111111111",
    HIVRA_CONTROL_ORIGIN: "https://canary.example.test" }).status).toBe(1);
});
it("preserves the legacy default browser/quick-tunnel input but rejects malformed browser flags", () => {
  expect(JSON.parse(document({}).stdout)).toMatchObject({ wantBrowser: null, tunnelToken: null });
  expect(JSON.parse(document({ HIVRA_WANT_BROWSER: "0" }).stdout)).toMatchObject({ wantBrowser: false });
  const bad = document({ HIVRA_WANT_BROWSER: "maybe" });
  expect(bad.status).toBe(1); expect(bad.stdout).toBe(""); expect(bad.stderr).toBe("invalid guest launch input\n");
});

it("validates the loaded named-tunnel intent before allocation, including either missing half", () => {
  const source = readFileSync(path.join(process.cwd(), "provisioner/hivra-provision-on-host.sh"), "utf8");
  const start = source.indexOf("validate_named_tunnel_input() {");
  const end = source.indexOf("\nvalidate_named_tunnel_input\n", start);
  expect(start).toBeGreaterThan(source.indexOf('HIVRA_TUNNEL_TOKEN="$(read_secret_b64'));
  expect(end).toBeLessThan(source.indexOf('qm create "$VMID"'));
  for (const [token, url, status] of [["", "", 0], ["fixture", "https://agent.example.invalid", 0],
    ["fixture", "", 1], ["", "https://agent.example.invalid", 1], ["fixture", "http://agent.example.invalid", 1]]) {
    const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-s"], {
      input: `set -euo pipefail\nfail() { exit 1; }\n${source.slice(start, end)}\nvalidate_named_tunnel_input\n`,
      env: { NODE_ENV: "test", PATH: "/usr/bin:/bin", HIVRA_TUNNEL_TOKEN: String(token), HIVRA_TUNNEL_URL: String(url) }, encoding: "utf8", timeout: 3000,
    });
    expect(result.status).toBe(status);
  }
});

/** @jest-environment node */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
const REPORTER_TOKEN = "hvra_otlp_v1.eyJmaXh0dXJlIjp0cnVlfQ.Zml4dHVyZS1zaWduYXR1cmU";
const REPORTER_CREDENTIAL = {
  endpoint: "https://canary.example.test/api/activity/ingest",
  resourceId: "11111111-2222-4333-8444-555555555555",
  token: REPORTER_TOKEN,
  expiresAt: "2026-09-29T12:00:00.000Z",
};

it.each(["claude", "codex"])("emits %s with a reporter credential only as a strict v4 document", kind => {
  const result = document({ AGENT_KIND: kind, HIVRA_TUNNEL_TOKEN: "fixture-tunnel",
    HIVRA_ACTIVITY_TELEMETRY: JSON.stringify(REPORTER_CREDENTIAL) });
  expect(result.status).toBe(0); expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({ version: 4, agentKind: kind, computerSubstrate: "proxmox-kvm",
    wantBrowser: null, modelKey: "fixture-only", modelBaseUrl: "", model: "", tunnelToken: "fixture-tunnel",
    accessHostname: null, activityTelemetry: REPORTER_CREDENTIAL });
  // An empty credential is exactly today's v1 document, for older dashboards too.
  expect(JSON.parse(document({ AGENT_KIND: kind, HIVRA_ACTIVITY_TELEMETRY: "" }).stdout)).toMatchObject({ version: 1 });
  expect(JSON.parse(document({ AGENT_KIND: kind }).stdout)).not.toHaveProperty("activityTelemetry");
});

it("rejects a reporter credential for other runtimes or in any malformed shape without echoing it", () => {
  const rejected: Array<[string, string]> = ["aeon", "openclaw", "agent-zero"].map(kind => [kind, JSON.stringify(REPORTER_CREDENTIAL)]);
  const malformed: Array<Record<string, unknown> | string> = [
    "not json",
    `{"endpoint":"${REPORTER_CREDENTIAL.endpoint}","endpoint":"${REPORTER_CREDENTIAL.endpoint}"}`,
    [REPORTER_CREDENTIAL] as unknown as Record<string, unknown>,
    { ...REPORTER_CREDENTIAL, renewUrl: "https://canary.example.test/api/activity/collector/renew" },
    Object.fromEntries(Object.entries(REPORTER_CREDENTIAL).filter(([key]) => key !== "resourceId")),
    { ...REPORTER_CREDENTIAL, endpoint: "http://canary.example.test/api/activity/ingest" },
    { ...REPORTER_CREDENTIAL, endpoint: "https://canary.example.test/api/activity/collector/renew" },
    { ...REPORTER_CREDENTIAL, endpoint: "https://canary.example.test/api/activity/ingest/" },
    { ...REPORTER_CREDENTIAL, endpoint: "https://canary.example.test/api/activity/ingest?next=1" },
    { ...REPORTER_CREDENTIAL, endpoint: "https://canary.example.test/api/activity/ingest#fragment" },
    { ...REPORTER_CREDENTIAL, endpoint: "https://user:pass@canary.example.test/api/activity/ingest" },
    { ...REPORTER_CREDENTIAL, resourceId: "not-a-uuid" },
    { ...REPORTER_CREDENTIAL, resourceId: "AAAAAAAA-2222-4333-8444-555555555555" },
    { ...REPORTER_CREDENTIAL, token: "hvra_otlp_v2.eyJmaXh0dXJlIjp0cnVlfQ.c2ln" },
    { ...REPORTER_CREDENTIAL, token: "hvra_otlp_v1.only-claims" },
    { ...REPORTER_CREDENTIAL, token: `${REPORTER_TOKEN}.extra` },
    { ...REPORTER_CREDENTIAL, token: `hvra_otlp_v1.${"a".repeat(4096)}.c` },
    { ...REPORTER_CREDENTIAL, expiresAt: "2026-09-29T12:00:00.000" },
    { ...REPORTER_CREDENTIAL, expiresAt: 1790000000 },
  ];
  for (const value of malformed) rejected.push(["codex", typeof value === "string" ? value : JSON.stringify(value)]);
  for (const [kind, credential] of rejected) {
    const result = document({ AGENT_KIND: kind, HIVRA_ACTIVITY_TELEMETRY: credential });
    expect({ kind, credential, status: result.status, stdout: result.stdout, stderr: result.stderr })
      .toEqual({ kind, credential, status: 1, stdout: "", stderr: "invalid guest launch input\n" });
  }
  for (const kind of ["deepseek-harness", "linux-desktop"]) {
    expect(document({ AGENT_KIND: kind, HIVRA_MODEL_KEY: "", HIVRA_TUNNEL_TOKEN: "fixture-tunnel",
      HIVRA_TUNNEL_URL: "https://computer.example.test", HIVRA_COMPUTER_ID: "11111111-1111-4111-8111-111111111111",
      HIVRA_CONTROL_ORIGIN: "https://canary.example.test", HIVRA_ACTIVITY_TELEMETRY: JSON.stringify(REPORTER_CREDENTIAL) }).status).toBe(1);
  }
});

it("reads the reporter credential from the host handoff optionally, so older dashboards still launch", () => {
  const source = readFileSync(path.join(process.cwd(), "provisioner/hivra-provision-on-host.sh"), "utf8");
  const start = source.indexOf("  read_secret_b64() {");
  const end = source.indexOf('  HIVRA_TUNNEL_TOKEN="$(read_secret_b64', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  expect(source).toContain('HIVRA_ACTIVITY_TELEMETRY="$(read_optional_secret_b64 HIVRA_ACTIVITY_TELEMETRY_B64)"');
  expect(source).toContain('HIVRA_ACTIVITY_TELEMETRY="${HIVRA_ACTIVITY_TELEMETRY:-}"');
  expect(source).toContain("export -n HIVRA_ACTIVITY_TELEMETRY");
  const directory = mkdtempSync(path.join(tmpdir(), "hivra-secret-handoff-"));
  try {
    const read = (contents: string) => {
      const file = path.join(directory, "secret.env");
      writeFileSync(file, contents, { mode: 0o600 });
      return spawnSync("/bin/bash", ["--noprofile", "--norc", "-s"], {
        input: `set -euo pipefail\nfail() { echo "$*" >&2; exit 1; }\n${source.slice(start, end)}\n`
          + 'value="$(read_optional_secret_b64 HIVRA_ACTIVITY_TELEMETRY_B64)"\nprintf "%s" "$value"\n',
        env: { NODE_ENV: "test", PATH: "/usr/bin:/bin", SECRET_ENV_FILE: file }, encoding: "utf8", timeout: 3_000,
      });
    };
    const encoded = Buffer.from(JSON.stringify(REPORTER_CREDENTIAL)).toString("base64");
    expect(read("HIVRA_TUNNEL_TOKEN_B64=\n")).toMatchObject({ status: 0, stdout: "", stderr: "" });
    expect(read("HIVRA_ACTIVITY_TELEMETRY_B64=\n")).toMatchObject({ status: 0, stdout: "", stderr: "" });
    expect(read(`HIVRA_ACTIVITY_TELEMETRY_B64=${encoded}\n`)).toMatchObject({
      status: 0, stdout: JSON.stringify(REPORTER_CREDENTIAL), stderr: "",
    });
    const invalid = read("HIVRA_ACTIVITY_TELEMETRY_B64=not*base64\n");
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toBe("secret input contains invalid base64\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

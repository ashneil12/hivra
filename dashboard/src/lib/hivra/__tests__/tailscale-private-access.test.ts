/** @jest-environment node */
jest.mock("server-only", () => ({}));

import { spawnSync } from "node:child_process";

import {
  connectHivraTailscale,
  buildHivraTailscaleGuestInvocation,
  buildHivraTailscaleConnectProgram,
  buildHivraNetbirdConnectProgram,
  connectHivraNetbird,
  parseHivraNetbirdReceipt,
  DEFAULT_TAILSCALE_LOGIN_SERVER,
  disconnectHivraTailscale,
  normalizeTailscaleLoginServer,
  observeHivraTailscale,
  parseHivraTailscaleReceipt,
  prepareHivraTailscaleForDelete,
  type HivraPrivateAccessAgentRow,
} from "../tailscale-private-access";

it("preserves the Python command argument across OpenSSH-style argument joining", () => {
  const invocation = buildHivraTailscaleGuestInvocation("printf 'HIVRA_REMOTE_OK\\n'");
  const harness = `set -euo pipefail
sudo() {
  [ "\${1:-}" != -n ] || shift
  if [ "\${1:-}" = /usr/bin/python3 ]; then shift; command python3 "$@"; else "$@"; fi
}
export -f sudo
ssh_like() {
  shift
  local joined="$*"
  /bin/bash -c "$joined"
}
ssh_like guest ${invocation}`;
  const result = spawnSync("/bin/bash", ["-c", harness], { encoding: "utf8" });
  expect(result).toEqual(expect.objectContaining({ status: 0, stdout: "HIVRA_REMOTE_OK\n" }));
  expect(result.stderr).toBe("");
});

const agent: HivraPrivateAccessAgentRow = {
  id: "11111111-1111-4111-8111-111111111111", user_id: "owner", type: "linux-desktop",
  computer_profile: "ubuntu-desktop", status: "running", desired_state: "running",
  operation_id: null, operation_kind: null, vmid: 1113, ip: "10.250.20.63",
  computer_substrate: "proxmox-kvm", deployment_mode: "hivra-managed", proxmox_host: "node-b",
  infrastructure_binding_token_hash: "a".repeat(64), infrastructure_binding_token_enforced: true,
  managed_provisioner_channel: "canary",
};
const context = {
  kind: "managed" as const, host: "node-b", env: {},
  paths: { provisionerDirectory: "/root/hivra-provisioner", logDirectory: "/var/log",
    provisionLogPrefix: "hivra-prov-" as const, startLogPrefix: "hivra-start-" as const,
    storage: "local-lvm", vmSshKeyPath: "/root/.ssh/hivra_vm" },
  provisionerChannel: "canary" as const,
  infrastructureBindingTag: `hivra-bind-${"a".repeat(32)}`, infrastructureBindingTagEnforced: true,
};
const disconnected = 'HIVRA_TAILSCALE_STATUS {"BackendState":"NeedsLogin"}\n';
const connectedDocument = { BackendState: "Running", Self: { Online: true, HostName: "box",
  DNSName: "box.example.ts.net.", TailscaleIPs: ["100.64.0.7", "fd7a:115c:a1e0::7"], SSHEnabled: false },
CurrentTailnet: { Name: "example" }, HivraPrefs: { RunSSH: false,
  ControlURL: DEFAULT_TAILSCALE_LOGIN_SERVER, RouteAll: false, AdvertiseRoutes: [], ExitNodeID: "", ExitNodeIP: null } };
const connected = `HIVRA_TAILSCALE_STATUS ${JSON.stringify(connectedDocument)}\n`;

it("accepts only bounded HTTPS coordination origins and resets the default explicitly", () => {
  expect(normalizeTailscaleLoginServer(undefined)).toBe(DEFAULT_TAILSCALE_LOGIN_SERVER);
  expect(normalizeTailscaleLoginServer("https://headscale.example.test:8443/")).toBe("https://headscale.example.test:8443");
  expect(normalizeTailscaleLoginServer("http://headscale.example.test")).toBeNull();
  expect(normalizeTailscaleLoginServer("https://user@headscale.example.test")).toBeNull();
  expect(normalizeTailscaleLoginServer("https://headscale.example.test/path?q=1#x")).toBeNull();
});

it("parses one fresh sanitized connected observation with SSH disabled", () => {
  expect(parseHivraTailscaleReceipt(connected, DEFAULT_TAILSCALE_LOGIN_SERVER, new Date("2026-09-15T12:00:00Z")))
    .toEqual(expect.objectContaining({ state: "connected", ipv4: "100.64.0.7",
      magicDnsName: "box.example.ts.net", sshEnabled: false, observedAt: "2026-09-15T12:00:00.000Z" }));
  expect(parseHivraTailscaleReceipt(`${connected}${connected}`, DEFAULT_TAILSCALE_LOGIN_SERVER)).toBeNull();
});

it("accepts Tailscale 1.102's explicit null no-route form but rejects a missing field", () => {
  const nullRoutes = { ...connectedDocument, HivraPrefs: { ...connectedDocument.HivraPrefs, AdvertiseRoutes: null } };
  expect(parseHivraTailscaleReceipt(`HIVRA_TAILSCALE_STATUS ${JSON.stringify(nullRoutes)}\n`, DEFAULT_TAILSCALE_LOGIN_SERVER))
    .toEqual(expect.objectContaining({ state: "connected" }));
  const missingRoutes = { ...connectedDocument.HivraPrefs } as Record<string, unknown>;
  delete missingRoutes.AdvertiseRoutes;
  expect(parseHivraTailscaleReceipt(`HIVRA_TAILSCALE_STATUS ${JSON.stringify({ ...connectedDocument, HivraPrefs: missingRoutes })}\n`, DEFAULT_TAILSCALE_LOGIN_SERVER))
    .toBeNull();
});

it("rejects a connected observation when Tailscale SSH is enabled", () => {
  const sshEnabled = connected.replace('"SSHEnabled":false', '"SSHEnabled":true');
  expect(parseHivraTailscaleReceipt(sshEnabled, DEFAULT_TAILSCALE_LOGIN_SERVER)).toBeNull();
});

it("rejects a raw pretty multiline CLI status and accepts its compact verified framing", () => {
  const pretty = `HIVRA_TAILSCALE_STATUS ${JSON.stringify(connectedDocument, null, 2)}\n`;
  expect(parseHivraTailscaleReceipt(pretty, DEFAULT_TAILSCALE_LOGIN_SERVER)).toBeNull();
  expect(parseHivraTailscaleReceipt(connected, DEFAULT_TAILSCALE_LOGIN_SERVER))
    .toEqual(expect.objectContaining({ state: "connected", sshEnabled: false }));
});

it.each([
  ["RunSSH", true], ["RouteAll", true], ["AdvertiseRoutes", ["0.0.0.0/0"]],
  ["ExitNodeID", "node-id"], ["ExitNodeIP", "100.64.0.1"], ["ControlURL", "https://other.example.test"],
])("rejects a connected receipt whose live %s preference violates the private-access boundary", (key, value) => {
  const document = { ...connectedDocument, HivraPrefs: { ...connectedDocument.HivraPrefs, [key]: value } };
  expect(parseHivraTailscaleReceipt(`HIVRA_TAILSCALE_STATUS ${JSON.stringify(document)}\n`, DEFAULT_TAILSCALE_LOGIN_SERVER)).toBeNull();
});

it("keeps the opaque enrollment key only on separate stdin and uses an auth-key file", async () => {
  const secret = "opaque-headscale-preauth-key";
  const headscaleConnected = `HIVRA_TAILSCALE_STATUS ${JSON.stringify({ ...connectedDocument,
    HivraPrefs: { ...connectedDocument.HivraPrefs, ControlURL: "https://headscale.example.test" } })}\n`;
  const runHostScript = jest.fn().mockResolvedValue({ ok: true, stdout: disconnected, stderr: "" });
  const runHostScriptWithStdin = jest.fn().mockResolvedValue({ ok: true, stdout: headscaleConnected, stderr: "" });
  const result = await connectHivraTailscale(agent, secret, "https://headscale.example.test", {
    resolveContext: jest.fn().mockResolvedValue(context), runHostScript, runHostScriptWithStdin,
    now: () => new Date("2026-09-15T12:00:00Z"),
  });
  expect(result.ok).toBe(true);
  const [script, stdin] = runHostScriptWithStdin.mock.calls[0];
  expect(stdin).toBe(`${secret}\n`);
  expect(script).not.toContain(secret);
  expect(script).toContain("qm status");
  expect(script).toContain(context.infrastructureBindingTag);
  expect(script).toContain("qm guest exec");
  const guest = buildHivraTailscaleConnectProgram("https://headscale.example.test");
  expect(guest).toContain('--auth-key="file:$AUTH_FILE"');
  expect(guest).toContain("tailscale up --reset");
  expect(guest).toContain("--ssh=false");
  expect(guest).toContain("--accept-routes=false");
  expect(guest).toContain('"tailscale","debug","prefs"');
  expect(guest).toContain("json.dumps(status, separators=(',',':'))");
  expect(guest).toContain("https://headscale.example.test");
});

it("refuses to replace an unmanaged existing tailnet connection", async () => {
  const runHostScriptWithStdin = jest.fn();
  await expect(connectHivraTailscale(agent, "secret", DEFAULT_TAILSCALE_LOGIN_SERVER, {
    resolveContext: jest.fn().mockResolvedValue(context),
    runHostScript: jest.fn().mockResolvedValue({ ok: true, stdout: connected, stderr: "" }),
    runHostScriptWithStdin,
  })).rejects.toThrow("existing_connection");
  expect(runHostScriptWithStdin).not.toHaveBeenCalled();
});

it("refuses a running tailnet even when its preferences do not prove Hivra ownership", async () => {
  const unmanaged = `HIVRA_TAILSCALE_STATUS ${JSON.stringify({ ...connectedDocument,
    HivraPrefs: { ...connectedDocument.HivraPrefs, ControlURL: "https://other.example.test", RunSSH: true } })}\n`;
  const runHostScriptWithStdin = jest.fn();
  await expect(connectHivraTailscale(agent, "secret", DEFAULT_TAILSCALE_LOGIN_SERVER, {
    resolveContext: jest.fn().mockResolvedValue(context),
    runHostScript: jest.fn().mockResolvedValue({ ok: true, stdout: unmanaged, stderr: "" }),
    runHostScriptWithStdin,
  })).rejects.toThrow("existing_connection");
  expect(runHostScriptWithStdin).not.toHaveBeenCalled();
});

it("keeps logout observable so disconnect, refresh, and reconnect work in sequence", async () => {
  const runHostScript = jest.fn()
    .mockResolvedValue({ ok: true, stdout: disconnected, stderr: "" });
  const runHostScriptWithStdin = jest.fn()
    .mockResolvedValue({ ok: true, stdout: connected, stderr: "" });
  const dependencies = { resolveContext: jest.fn().mockResolvedValue(context), runHostScript, runHostScriptWithStdin };

  await expect(disconnectHivraTailscale(agent, DEFAULT_TAILSCALE_LOGIN_SERVER, dependencies))
    .resolves.toEqual(expect.objectContaining({ ok: true, receipt: expect.objectContaining({ state: "disconnected" }) }));
  await expect(observeHivraTailscale(agent, DEFAULT_TAILSCALE_LOGIN_SERVER, dependencies))
    .resolves.toEqual(expect.objectContaining({ ok: true, connectionPresent: false }));
  await expect(connectHivraTailscale(agent, "secret", DEFAULT_TAILSCALE_LOGIN_SERVER, dependencies))
    .resolves.toEqual(expect.objectContaining({ ok: true, receipt: expect.objectContaining({ state: "connected" }) }));

  const disconnectScript = runHostScript.mock.calls[0][0] as string;
  expect(Buffer.from(disconnectScript.match(/[A-Za-z0-9+/]{100,}={0,2}/g)?.at(-1) ?? "", "base64").toString("utf8"))
    .not.toMatch(/systemctl disable[^\n]*tailscaled|pkill -x tailscaled/);
});

it("returns unknown after a timed-out enrollment and an unreachable fresh observation", async () => {
  const runHostScript = jest.fn()
    .mockResolvedValueOnce({ ok: true, stdout: disconnected, stderr: "" })
    .mockResolvedValueOnce({ ok: false, stdout: "", stderr: "", error: "SSH connection failed" });
  const result = await connectHivraTailscale(agent, "secret", DEFAULT_TAILSCALE_LOGIN_SERVER, {
    resolveContext: jest.fn().mockResolvedValue(context), runHostScript,
    runHostScriptWithStdin: jest.fn().mockResolvedValue({ ok: false, stdout: "", stderr: "", error: "timed out" }),
  });
  expect(result).toEqual(expect.objectContaining({ ok: false,
    receipt: expect.objectContaining({ state: "unknown", failureCode: "host_timeout" }) }));
});

it.each([
  ["HIVRA_TAILSCALE_DELETE guest_stopped\n", "guest_stopped"],
  ["HIVRA_TAILSCALE_DELETE provider_absent\n", "provider_absent"],
  [disconnected, "guest_logged_out"],
] as const)("prepares an exact delete-bound VM without booting it: %s", async (stdout, disposition) => {
  const deleting = { ...agent, desired_state: "deleted", operation_kind: "delete",
    operation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
  const runHostScript = jest.fn().mockResolvedValue({ ok: true, stdout, stderr: "" });
  await expect(prepareHivraTailscaleForDelete(deleting, context, { runHostScript }))
    .resolves.toEqual({ ok: true, disposition });
  const script = runHostScript.mock.calls[0][0] as string;
  expect(script).toContain(context.infrastructureBindingTag);
  expect(script).toContain('!= running');
  const encodedPrograms = script.match(/[A-Za-z0-9+/]{100,}={0,2}/g) ?? [];
  expect(encodedPrograms.some(value => Buffer.from(value, "base64").toString("utf8").includes("tailscale logout"))).toBe(true);
});

it("blocks VM destruction when an owned guest logout is unconfirmed", async () => {
  const deleting = { ...agent, desired_state: "deleted", operation_kind: "delete",
    operation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
  await expect(prepareHivraTailscaleForDelete(deleting, context, {
    runHostScript: jest.fn().mockResolvedValue({ ok: false, stdout: "", stderr: "", error: "timed out" }),
  })).resolves.toEqual({ ok: false, disposition: "unconfirmed", failureCode: "host_timeout" });
});

it("requires a successful provider inventory before treating a failed VM query as absence", async () => {
  const deleting = { ...agent, desired_state: "deleted", operation_kind: "delete",
    operation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
  const runHostScript = jest.fn().mockResolvedValue({ ok: false, stdout: "", stderr: "", error: "query failed" });
  await expect(prepareHivraTailscaleForDelete(deleting, context, { runHostScript }))
    .resolves.toEqual({ ok: false, disposition: "unconfirmed", failureCode: "guest_command_failed" });
  expect(runHostScript.mock.calls[0][0]).toContain("qm list");
  expect(runHostScript.mock.calls[0][0]).toContain("could not verify provider absence");
});

describe("hardening: version floor, outbound block, peer visibility", () => {
  it("checks the client version and installs the outbound block after install and before joining", () => {
    const guest = buildHivraTailscaleConnectProgram(DEFAULT_TAILSCALE_LOGIN_SERVER);
    const install = guest.indexOf("tailscale.com/install.sh");
    const floor = guest.indexOf("HIVRA_TS_MIN='1.104.4'");
    const block = guest.indexOf("table inet hivra_private_access {");
    const up = guest.indexOf("tailscale up --reset");
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(floor);
    expect(floor).toBeLessThan(block);
    expect(block).toBeLessThan(up);
    expect(guest).toContain("client_too_old");
    expect(spawnSync("/bin/bash", ["-n"], { input: guest, encoding: "utf8" }).status).toBe(0);
  });

  it("removes the outbound block when the computer disconnects", async () => {
    const runHostScript = jest.fn().mockResolvedValue({ ok: true, stdout: disconnected, stderr: "" });
    await disconnectHivraTailscale(agent, DEFAULT_TAILSCALE_LOGIN_SERVER, {
      resolveContext: jest.fn().mockResolvedValue(context), runHostScript, runHostScriptWithStdin: jest.fn(),
    });
    const script = runHostScript.mock.calls[0][0] as string;
    const decoded = (script.match(/[A-Za-z0-9+/]{100,}={0,2}/g) ?? []).map(value => Buffer.from(value, "base64").toString("utf8"));
    expect(decoded.some(text => text.includes("nft delete table inet hivra_private_access"))).toBe(true);
  });

  it("surfaces a printed client_too_old failure instead of a generic one", async () => {
    const runHostScript = jest.fn()
      .mockResolvedValueOnce({ ok: true, stdout: disconnected, stderr: "" })
      .mockResolvedValueOnce({ ok: true, stdout: disconnected, stderr: "" });
    const result = await connectHivraTailscale(agent, "secret", DEFAULT_TAILSCALE_LOGIN_SERVER, {
      resolveContext: jest.fn().mockResolvedValue(context), runHostScript,
      runHostScriptWithStdin: jest.fn().mockResolvedValue({ ok: false, stdout: "HIVRA_PRIVATE_ACCESS_FAILURE client_too_old\n",
        stderr: "", error: "Proxmox host script exited with code 1" }),
    });
    expect(result.ok).toBe(false);
    expect(result.receipt.failureCode).toBe("client_too_old");
  });

  it("reports what the computer can see on the network, not a proof", () => {
    const withPeers = { ...connectedDocument, HivraVisiblePeers: 2, HivraTagged: true };
    const alone = { ...connectedDocument, HivraVisiblePeers: 0, HivraTagged: false };
    expect(parseHivraTailscaleReceipt(`HIVRA_TAILSCALE_STATUS ${JSON.stringify(withPeers)}\n`, DEFAULT_TAILSCALE_LOGIN_SERVER))
      .toEqual(expect.objectContaining({ provider: "tailscale", visiblePeerCount: 2, canSeeOtherDevices: true, taggedHivra: true }));
    expect(parseHivraTailscaleReceipt(`HIVRA_TAILSCALE_STATUS ${JSON.stringify(alone)}\n`, DEFAULT_TAILSCALE_LOGIN_SERVER))
      .toEqual(expect.objectContaining({ visiblePeerCount: 0, canSeeOtherDevices: false, taggedHivra: false }));
    expect(parseHivraTailscaleReceipt(connected, DEFAULT_TAILSCALE_LOGIN_SERVER)).not.toHaveProperty("canSeeOtherDevices");
  });

  it("keeps the status small by counting peers in the guest instead of sending them", () => {
    expect(buildHivraTailscaleConnectProgram(DEFAULT_TAILSCALE_LOGIN_SERVER)).toContain('status.pop("Peer",None)');
  });
});

describe("NetBird", () => {
  const nbConnected = (extra: Record<string, unknown> = {}) => `HIVRA_NETBIRD_STATUS ${JSON.stringify({
    Connected: true, Ip: "100.92.1.2/16", Fqdn: "box.netbird.cloud", PeerCount: 1, SshServer: false, ...extra })}\n`;

  it("joins with the key on stdin only, leaves NetBird's SSH server off, and blocks outbound on wt0", () => {
    const guest = buildHivraNetbirdConnectProgram("https://api.netbird.io");
    expect(guest).toContain("pkgs.netbird.io/install.sh");
    expect(guest).toContain("IFS= read -r NB_KEY");
    expect(guest).toContain("--allow-server-ssh=false");
    expect(guest).toContain('oifname "wt0" drop');
    expect(guest).toContain("--management-url 'https://api.netbird.io'");
    expect(guest).not.toMatch(/--allow-server-ssh(=true| )/);
    expect(guest).not.toContain("--setup-key");
    expect(spawnSync("/bin/bash", ["-n"], { input: guest, encoding: "utf8" }).status).toBe(0);
    expect(() => buildHivraNetbirdConnectProgram("http://x.example")).toThrow();
  });

  it("parses a connected, disconnected and SSH-enabled status", () => {
    const url = "https://api.netbird.io";
    expect(parseHivraNetbirdReceipt(nbConnected(), url, new Date("2026-11-11T00:00:00Z")))
      .toEqual(expect.objectContaining({ state: "connected", provider: "netbird", ipv4: "100.92.1.2",
        sshEnabled: false, canSeeOtherDevices: true, visiblePeerCount: 1 }));
    expect(parseHivraNetbirdReceipt('HIVRA_NETBIRD_STATUS {"Connected":false}\n', url))
      .toEqual(expect.objectContaining({ state: "disconnected" }));
    expect(parseHivraNetbirdReceipt(nbConnected({ SshServer: true }), url)).toBeNull();
    expect(parseHivraNetbirdReceipt(`${nbConnected()}${nbConnected()}`, url)).toBeNull();
  });

  it("refuses to join over an existing connection and never puts the key in the script", async () => {
    const runHostScriptWithStdin = jest.fn();
    await expect(connectHivraNetbird(agent, "setup-key", "https://api.netbird.io", {
      resolveContext: jest.fn().mockResolvedValue(context),
      runHostScript: jest.fn().mockResolvedValue({ ok: true, stdout: connected, stderr: "" }), runHostScriptWithStdin,
    })).rejects.toThrow("existing_connection");
    expect(runHostScriptWithStdin).not.toHaveBeenCalled();

    const run = jest.fn()
      .mockResolvedValueOnce({ ok: true, stdout: disconnected, stderr: "" })
      .mockResolvedValueOnce({ ok: true, stdout: 'HIVRA_NETBIRD_STATUS {"Connected":false}\n', stderr: "" });
    const withStdin = jest.fn().mockResolvedValue({ ok: true, stdout: nbConnected(), stderr: "" });
    const result = await connectHivraNetbird(agent, "setup-key", "https://api.netbird.io", {
      resolveContext: jest.fn().mockResolvedValue(context), runHostScript: run, runHostScriptWithStdin: withStdin,
    });
    expect(result.ok).toBe(true);
    expect(withStdin.mock.calls[0][1]).toBe("setup-key\n");
    expect(withStdin.mock.calls[0][0]).not.toContain("setup-key");
  });
});

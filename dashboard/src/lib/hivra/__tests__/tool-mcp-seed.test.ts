import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  MCP_NODE_PROGRAM,
  buildToolMcpSpec,
  buildToolMcpGuestScript,
  applyToolMcpOnBox,
  buildToolMcpHostScript,
  toolMcpKindForType,
  type ToolMcpServerSpec,
} from "@/lib/hivra/tool-mcp-seed";
import {
  GENUINE_GUEST_HOST_KEY,
  SPOOFED_GUEST_HOST_KEY,
  createStubProxmoxGuestHost,
} from "@/test-utils/stub-proxmox-guest-host";

// Run the EXACT node program the box executes, against a throwaway HOME. This is
// the load-bearing box mutation — proving it here means the SSH round-trip only
// has to deliver bytes, not logic.
function runProgram(
  kind: "claude" | "codex",
  op: "add" | "remove",
  home: string,
  servers: ToolMcpServerSpec[],
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-mcp-prog-"));
  const progFile = path.join(dir, "prog.js");
  fs.writeFileSync(progFile, MCP_NODE_PROGRAM);
  const spec = Buffer.from(JSON.stringify({ kind, op, home, servers }), "utf8").toString("base64");
  try {
    // The program reads the base64 spec from STDIN (fd 0) — never argv/env — so the
    // secret is never in the box process table. Mirror that here.
    // No custom env needed — the program reads the spec from stdin and uses only
    // node built-ins; inherit the parent env so ProcessEnv's required fields hold.
    const out = execFileSync(process.execPath, [progFile], { input: spec });
    return out.toString("utf8");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tool-mcp-home-"));
}

const searxng: ToolMcpServerSpec = {
  name: "searxng",
  command: "npx",
  args: ["-y", "mcp-searxng"],
  env: { SEARXNG_URL: "https://searx.be" },
};
const fetchSrv: ToolMcpServerSpec = { name: "fetch", command: "npx", args: ["-y", "@kazuph/mcp-fetch"], env: {} };

describe("box program — claude (~/.claude.json)", () => {
  it("adds an mcpServers entry with type/command/args/env", () => {
    const home = tmpHome();
    const out = runProgram("claude", "add", home, [searxng]);
    expect(out).toMatch(/HIVRA_TOOLS_OK/);
    const j = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
    expect(j.mcpServers.searxng).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "mcp-searxng"],
      env: { SEARXNG_URL: "https://searx.be" },
    });
  });

  it("omits the env block for a keyless server", () => {
    const home = tmpHome();
    runProgram("claude", "add", home, [fetchSrv]);
    const j = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
    expect(j.mcpServers.fetch.env).toBeUndefined();
    expect(j.mcpServers.fetch.command).toBe("npx");
  });

  it("preserves unrelated keys and other servers", () => {
    const home = tmpHome();
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ numStartups: 7, projects: { "/x": {} }, mcpServers: { existing: { command: "keep" } } }),
    );
    runProgram("claude", "add", home, [searxng]);
    const j = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
    expect(j.numStartups).toBe(7);
    expect(j.projects).toEqual({ "/x": {} });
    expect(j.mcpServers.existing).toEqual({ command: "keep" });
    expect(j.mcpServers.searxng).toBeDefined();
  });

  it("is idempotent — re-adding overwrites in place (no duplicate)", () => {
    const home = tmpHome();
    runProgram("claude", "add", home, [{ ...searxng, args: ["-y", "old"] }]);
    runProgram("claude", "add", home, [{ ...searxng, args: ["-y", "new"] }]);
    const j = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
    expect(j.mcpServers.searxng.args).toEqual(["-y", "new"]);
    expect(Object.keys(j.mcpServers)).toEqual(["searxng"]);
  });

  it("removes only the named server", () => {
    const home = tmpHome();
    runProgram("claude", "add", home, [searxng, fetchSrv]);
    runProgram("claude", "remove", home, [{ name: "searxng", command: "", args: [], env: {} }]);
    const j = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
    expect(j.mcpServers.searxng).toBeUndefined();
    expect(j.mcpServers.fetch).toBeDefined();
  });

  it("writes a HOSTED (http) server as {type:http,url,headers}", () => {
    const home = tmpHome();
    runProgram("claude", "add", home, [
      { name: "nansen", transport: "http", url: "https://mcp.nansen.ai/ra/mcp", headers: { "NANSEN-API-KEY": "nsk-1" } },
    ]);
    const j = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
    expect(j.mcpServers.nansen).toEqual({
      type: "http",
      url: "https://mcp.nansen.ai/ra/mcp",
      headers: { "NANSEN-API-KEY": "nsk-1" },
    });
    // no stdio leftovers on a hosted entry
    expect(j.mcpServers.nansen.command).toBeUndefined();
  });

  it("removes a hosted server like any other", () => {
    const home = tmpHome();
    runProgram("claude", "add", home, [
      { name: "nansen", transport: "http", url: "https://x/mcp", headers: { A: "b" } },
      searxng,
    ]);
    runProgram("claude", "remove", home, [{ name: "nansen" }]);
    const j = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
    expect(j.mcpServers.nansen).toBeUndefined();
    expect(j.mcpServers.searxng).toBeDefined();
  });

  it("REFUSES to overwrite a present-but-unparseable ~/.claude.json (no data loss)", () => {
    const home = tmpHome();
    const corrupt = '{ "oauthAccount": {"t":"secret"}, not valid json ';
    fs.writeFileSync(path.join(home, ".claude.json"), corrupt);
    // Non-zero exit => execFileSync throws.
    expect(() => runProgram("claude", "add", home, [searxng])).toThrow();
    // The original file is untouched — oauth/history preserved.
    expect(fs.readFileSync(path.join(home, ".claude.json"), "utf8")).toBe(corrupt);
  });
});

describe("box program — codex (~/.codex/config.toml)", () => {
  it("writes a [mcp_servers.<name>] section with command, args, and an env sub-table", () => {
    const home = tmpHome();
    const out = runProgram("codex", "add", home, [searxng]);
    expect(out).toMatch(/HIVRA_TOOLS_OK/);
    const toml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    expect(toml).toContain("[mcp_servers.searxng]");
    expect(toml).toContain('command = "npx"');
    expect(toml).toContain('args = ["-y", "mcp-searxng"]');
    expect(toml).toContain("[mcp_servers.searxng.env]");
    expect(toml).toContain('SEARXNG_URL = "https://searx.be"');
  });

  it("omits the .env sub-table for a keyless server", () => {
    const home = tmpHome();
    runProgram("codex", "add", home, [fetchSrv]);
    const toml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    expect(toml).toContain("[mcp_servers.fetch]");
    expect(toml).not.toContain("[mcp_servers.fetch.env]");
  });

  it("is idempotent — re-adding yields exactly one section", () => {
    const home = tmpHome();
    runProgram("codex", "add", home, [searxng]);
    runProgram("codex", "add", home, [searxng]);
    const toml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    expect(toml.match(/\[mcp_servers\.searxng\]/g)?.length).toBe(1);
    expect(toml.match(/\[mcp_servers\.searxng\.env\]/g)?.length).toBe(1);
  });

  it("remove strips the section, its env sub-table, AND leaves no orphan lines", () => {
    const home = tmpHome();
    runProgram("codex", "add", home, [searxng, fetchSrv]);
    runProgram("codex", "remove", home, [{ name: "searxng", command: "", args: [], env: {} }]);
    const toml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    expect(toml).not.toContain("[mcp_servers.searxng]");
    expect(toml).not.toContain("[mcp_servers.searxng.env]");
    // No leftover fragments of the removed server: its package + url + key are gone.
    // (Regression: `[^\[]*` used to stop at the "[" inside `args = [..]`, orphaning
    // the array literal and the whole env sub-table.)
    expect(toml).not.toContain("mcp-searxng");
    expect(toml).not.toContain("searx.be");
    expect(toml).toContain("[mcp_servers.fetch]"); // untouched
    expect(toml).toContain("@kazuph/mcp-fetch");
  });

  it("remove leaves a preserved server fully intact (args + env survive)", () => {
    const home = tmpHome();
    const keyed = { name: "keep", command: "npx", args: ["-y", "keep-pkg"], env: { KEEP_KEY: "kv" } };
    runProgram("codex", "add", home, [searxng, keyed]);
    runProgram("codex", "remove", home, [{ name: "searxng", command: "", args: [], env: {} }]);
    const toml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    expect(toml).toContain("[mcp_servers.keep]");
    expect(toml).toContain('args = ["-y", "keep-pkg"]');
    expect(toml).toContain("[mcp_servers.keep.env]");
    expect(toml).toContain('KEEP_KEY = "kv"');
  });
});

describe("spec + scripts", () => {
  it("buildToolMcpSpec encodes the box home + op + servers", () => {
    const b64 = buildToolMcpSpec("claude", "add", [searxng]);
    const decoded = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    expect(decoded).toEqual({ kind: "claude", op: "add", home: "/home/bux", servers: [searxng] });
  });

  it("guest script pipes the spec to stdin (not argv/env) and never exposes the secret", () => {
    const secret = "sk-SUPERSECRET-abc123";
    const b64 = buildToolMcpSpec("claude", "add", [
      { name: "x", command: "npx", args: ["-y", "p"], env: { API_KEY: secret } },
    ]);
    const guest = buildToolMcpGuestScript(b64);
    expect(guest).toContain("sudo -u bux");
    // Spec goes in via STDIN — NOT an `env VAR=` argv token (which would be
    // world-readable in /proc/<pid>/cmdline|environ).
    expect(guest).toContain(`printf '%s' '${b64}' | sudo -u bux`);
    expect(guest).not.toContain("HIVRA_TOOL_SPEC="); // no env-var delivery
    expect(guest).not.toContain(secret); // raw secret never in the clear
    // The program itself reads fd 0.
    expect(MCP_NODE_PROGRAM).toContain("readFileSync(0");
  });

  const TARGET = {
    vmid: 1161,
    ip: "203.0.113.4",
    bindingTag: "hivra-bind-0123456789abcdef0123456789abcdef",
    vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
  };

  it("host script streams over VMID-pinned ssh, with no secret in the clear", () => {
    const secret = "sk-SUPERSECRET-abc123";
    const b64 = buildToolMcpSpec("codex", "add", [
      { name: "x", command: "npx", args: [], env: { API_KEY: secret } },
    ]);
    const host = buildToolMcpHostScript(TARGET, buildToolMcpGuestScript(b64));
    expect(host).toContain("VM_KEY='/etc/hivra/keys/vm-orchestrator'");
    expect(host).toContain("GUEST_IP='203.0.113.4'");
    // The guest is the one QEMU Guest Agent attests for this VMID, owner tag
    // and configured IP checked first; host-key checking is never off.
    expect(host).toContain("EXPECTED_BINDING_TAG='hivra-bind-0123456789abcdef0123456789abcdef'");
    expect(host).toContain('qm guest exec "$VMID"');
    expect(host).toContain("StrictHostKeyChecking=yes");
    expect(host).not.toContain("StrictHostKeyChecking=no");
    expect(host).not.toContain("UserKnownHostsFile=/dev/null");
    expect(host).toContain("base64 -d | sudo -n bash");
    expect(host).not.toContain(secret);
  });

  it("refuses to send credentials to a box it cannot pin to its VMID", async () => {
    const authority = {
      env: {},
      infrastructureBindingTag: TARGET.bindingTag,
      infrastructureBindingTagEnforced: false,
      paths: { vmSshKeyPath: TARGET.vmSshKeyPath },
    };
    const servers = [{ name: "x", command: "npx", args: [], env: { API_KEY: "k" } }];
    const unenforced = await applyToolMcpOnBox("codex", "add", { ip: TARGET.ip, vmid: TARGET.vmid }, servers, authority);
    expect(unenforced.ok).toBe(false);
    expect(unenforced.error).toContain("no enforced owner binding tag");
    const noVmid = await applyToolMcpOnBox(
      "codex",
      "add",
      { ip: TARGET.ip, vmid: null },
      servers,
      { ...authority, infrastructureBindingTagEnforced: true },
    );
    expect(noVmid.ok).toBe(false);
    expect(noVmid.error).toContain("missing or invalid vmid");
  });
});

describe("toolMcpKindForType", () => {
  it("maps CLI box types to a config flavor and rejects the rest", () => {
    expect(toolMcpKindForType("claude-code")).toBe("claude");
    expect(toolMcpKindForType("codex")).toBe("codex");
    expect(toolMcpKindForType("hermes")).toBeNull();
    expect(toolMcpKindForType("aeon")).toBeNull();
    expect(toolMcpKindForType(null)).toBeNull();
    expect(toolMcpKindForType(undefined)).toBeNull();
  });
});

describe("host script against a stub Proxmox host", () => {
  const host = createStubProxmoxGuestHost();
  const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-mcp-key-"));
  const vmKey = path.join(keyDir, "vm-orchestrator");
  fs.writeFileSync(vmKey, "not a real key\n");
  afterAll(() => {
    host.cleanup();
    fs.rmSync(keyDir, { recursive: true, force: true });
  });

  const tag = "hivra-bind-0123456789abcdef0123456789abcdef";
  const target = { vmid: 1161, ip: "10.251.20.61", bindingTag: tag, vmSshKeyPath: vmKey };
  const secret = "sk-SUPERSECRET-abc123";
  const script = buildToolMcpHostScript(
    target,
    buildToolMcpGuestScript(buildToolMcpSpec("codex", "add", [
      { name: "x", command: "npx", args: [], env: { API_KEY: secret } },
    ])),
  );
  const vm = { vmid: 1161, ip: "10.251.20.61", tags: tag };

  it("delivers to the guest whose host key the guest agent attests", () => {
    const result = host.run(script, { vms: [vm], serverHostKey: GENUINE_GUEST_HOST_KEY });
    expect(result.status).toBe(0);
    expect(result.sshCalls).toHaveLength(1);
    expect(Buffer.from(result.delivered.trim(), "base64").toString("utf8")).toContain("sudo -u bux");
  });

  it("sends nothing to a neighbour answering at the same IP with another host key", () => {
    const result = host.run(script, { vms: [vm], serverHostKey: SPOOFED_GUEST_HOST_KEY });
    expect(result.status).not.toBe(0);
    expect(result.delivered).toBe("");
  });

  it("sends nothing when the VM does not carry the agent's owner binding tag", () => {
    const result = host.run(script, {
      vms: [{ ...vm, tags: "hivra-bind-ffffffffffffffffffffffffffffffff" }],
      serverHostKey: GENUINE_GUEST_HOST_KEY,
    });
    expect(result.status).not.toBe(0);
    expect(result.sshArgs).toEqual([]);
  });
});

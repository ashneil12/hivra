import {
  agentSoftwareBadge,
  agentSoftwareSubject,
  deriveAgentSoftware,
  isAgentSoftwareTarget,
  isAgentSoftwareVersion,
  parseAgentAppReport,
  parseAgentCliMeta,
  parseAgentCliReport,
  summarizeAgentSoftware,
  type AgentSoftwareRecord,
  type AgentSoftwareSubject,
} from "../agent-cli-status";

// Hivra pins no agent version: a launch installs upstream's newest release, and
// after that the owner updates (target `latest`). Nothing here is ever "behind".

const NOW = Date.parse("2026-09-25T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const codex = agentSoftwareSubject({ type: "codex", computer_substrate: "proxmox-kvm" }) as AgentSoftwareSubject;
const IMAGE = `sha256:${"a".repeat(64)}`;

function view(record: AgentSoftwareRecord | null, status = "running", subject: AgentSoftwareSubject = codex) {
  return deriveAgentSoftware({ subject, status, record, now: NOW });
}
const reported = (installed: string | null, extra: AgentSoftwareRecord = {}): AgentSoftwareRecord => ({
  observation: installed === null ? "version_unreadable" : "reported",
  installed_version: installed,
  observed_at: ago(MIN),
  ...extra,
});

describe("parseAgentCliReport", () => {
  it.each([
    ["HIVRA_AGENT_CLI name=codex version=0.149.1 target=latest state=scheduled", { name: "codex", version: "0.149.1", target: "latest", state: "scheduled" }],
    ["HIVRA_AGENT_CLI name=claude-code version=unknown target=latest state=failed", { name: "claude-code", version: null, target: "latest", state: "failed" }],
  ])("reads %s", (line, expected) => {
    expect(parseAgentCliReport(`noise\n${line}\nHIVRA_GUEST_RUNTIME_UPDATED vmid=1\n`)).toEqual(expected);
  });
  it("ignores any other shape, including a pinned target", () => {
    expect(parseAgentCliReport("HIVRA_AGENT_CLI name=codex version=0.149.1 target=0.156.1 state=scheduled")).toBeNull();
    expect(parseAgentCliReport("HIVRA_AGENT_CLI name=gemini version=1.0.0 target=latest state=scheduled")).toBeNull();
  });
});

describe("parseAgentCliMeta", () => {
  it("reads the gateway's agentCli with its update progress", () => {
    expect(parseAgentCliMeta({ name: "codex", version: "0.149.0", update: { state: "waiting", target: "latest", updatedAt: "2026-09-25T00:30:00Z" } }, "codex"))
      .toEqual({ name: "codex", version: "0.149.0", update: { state: "waiting", target: "latest", updatedAt: "2026-09-25T00:30:00Z", reason: null } });
    expect(parseAgentCliMeta({ name: "codex", version: null }, "codex")).toEqual({ name: "codex", version: null, update: null });
  });
  it.each([
    ["another CLI's name", { name: "claude-code", version: "2.1.246" }],
    ["an unknown name", { name: "gemini", version: "1.0.0" }],
    ["a version that isn't x.y.z", { name: "codex", version: "latest" }],
    ["an unknown update state", { name: "codex", version: "0.149.0", update: { state: "exploded", target: "latest" } }],
    ["a pinned target", { name: "codex", version: "0.149.0", update: { state: "done", target: "0.149.1" } }],
    ["a malformed reason", { name: "codex", version: "0.149.0", update: { state: "failed", target: "latest", reason: "Rm -rf" } }],
    ["no object", "codex 0.149.0"],
  ])("refuses %s", (_case, value) => {
    expect(parseAgentCliMeta(value, "codex")).toBeNull();
  });
});

describe("versions and targets", () => {
  it("names each version in its software's own form, and only `latest` as a target", () => {
    expect(isAgentSoftwareVersion("openclaw", "2026.11.4")).toBe(true);
    expect(isAgentSoftwareVersion("aeon", "e".repeat(40))).toBe(true);
    expect(isAgentSoftwareVersion("agent-zero", IMAGE)).toBe(true);
    expect(isAgentSoftwareVersion("agent-zero", "v2.15")).toBe(false);
    for (const name of ["claude-code", "codex", "aeon", "openclaw", "agent-zero", "hermes", "openbot", "nuphos"] as const) {
      expect(isAgentSoftwareTarget(name, "latest")).toBe(true);
      expect(isAgentSoftwareTarget(name, "1.2.3")).toBe(false);
    }
  });

  it("reads the runtime updater's app line for every app, with `latest` as the target", () => {
    expect(parseAgentAppReport(`noise\nHIVRA_AGENT_APP name=agent-zero version=${IMAGE} target=latest state=scheduled\n`))
      .toEqual({ name: "agent-zero", version: IMAGE, target: "latest", state: "scheduled" });
    expect(parseAgentAppReport("HIVRA_AGENT_APP name=aeon version=unknown target=latest state=running"))
      .toEqual({ name: "aeon", version: null, target: "latest", state: "running" });
    expect(parseAgentAppReport("HIVRA_AGENT_APP name=openclaw version=2026.6.10 target=latest state=scheduled"))
      .toEqual({ name: "openclaw", version: "2026.6.10", target: "latest", state: "scheduled" });
    expect(parseAgentAppReport(`HIVRA_AGENT_APP name=aeon version=unknown target=${"e".repeat(40)} state=running`)).toBeNull();
    expect(parseAgentAppReport("HIVRA_AGENT_APP name=hermes version=0.23.1 target=stable state=scheduled")).toBeNull();
    expect(parseAgentAppReport(`HIVRA_AGENT_APP name=aeon version=${IMAGE} target=latest state=running`)).toBeNull();
  });
});

describe("agentSoftwareSubject", () => {
  it("covers Claude Code and Codex with their CLI, and the app agents without one", () => {
    expect(agentSoftwareSubject({ type: "claude-code" })).toEqual({ type: "claude-code", cli: "claude-code", app: null, software: "claude-code", gatewayKind: "claude" });
    expect(codex).toEqual({ type: "codex", cli: "codex", app: null, software: "codex", gatewayKind: "codex" });
    expect(agentSoftwareSubject({ type: "aeon", computer_substrate: "proxmox-kvm" })).toEqual({ type: "aeon", cli: null, app: "aeon", software: "aeon", gatewayKind: "aeon" });
    expect(agentSoftwareSubject({ type: "openbot" })).toEqual({ type: "openbot", cli: null, app: "openbot", software: "openbot", gatewayKind: "openbot" });
  });
  it.each(["claude-code", "codex", "aeon", "openclaw", "agent-zero", "openbot", "nuphos", "hermes"])("covers a My cloud %s agent", (type) => {
    expect(agentSoftwareSubject({ type, computer_substrate: "provider-vm" })).toMatchObject({ type });
  });
  it.each([
    ["DeepSeek, whose update is refused", { type: "deepseek-harness" }],
    ["a computer", { type: "linux-desktop", computer_profile: "ubuntu-desktop" }],
    ["a Linux Sandbox", { type: "codex", computer_substrate: "gvisor" }],
    ["an agent on a prepared computer", { type: "codex", computer_profile: "windows" }],
  ])("leaves out %s", (_case, row) => {
    expect(agentSoftwareSubject(row)).toBeNull();
  });
});

describe("deriveAgentSoftware", () => {
  it("passes on what the computer couldn't say", () => {
    expect(view(reported("0.149.0"), "stopped")).toEqual({ kind: "not_running" });
    expect(view(null)).toEqual({ kind: "checking" });
    expect(view({ observation: "unreachable" })).toEqual({ kind: "unreachable" });
    expect(view({ observation: "older_connection_service" })).toEqual({ kind: "older_connection_service" });
    expect(view(reported(null))).toEqual({ kind: "version_unreadable" });
  });

  it("shows any installed version as current: there is no tested version to be behind", () => {
    expect(view(reported("0.100.0"))).toEqual({ kind: "current", installed: "0.100.0" });
    expect(view(reported("9.9.9"))).toEqual({ kind: "current", installed: "9.9.9" });
  });

  it("follows the owner's update and reads why it stopped", () => {
    const at = { update_updated_at: ago(MIN), update_target: "latest" } as const;
    expect(view(reported("0.149.0", { ...at, update_state: "installing" }))).toEqual({ kind: "updating", phase: "installing", target: "latest", installed: "0.149.0" });
    expect(view(reported("0.169.0", { ...at, update_state: "done" }))).toEqual({ kind: "update_done", target: "0.169.0", installed: "0.169.0" });
    expect(view(reported("0.149.0", { ...at, update_state: "rolled_back" }))).toEqual({ kind: "update_rolled_back", target: "latest", installed: "0.149.0" });
    expect(view(reported("0.149.0", { ...at, update_state: "failed", update_reason: "download_failed" }))).toMatchObject({ kind: "update_failed", reason: "download_failed" });
    expect(view(reported("0.149.0", { ...at, update_state: "deferred" }))).toMatchObject({ kind: "update_deferred" });
  });

  it("ignores an update recorded against a pinned target from before", () => {
    expect(view(reported("0.149.0", { update_state: "installing", update_target: "0.156.1", update_updated_at: ago(MIN) }))).toEqual({ kind: "current", installed: "0.149.0" });
  });

  it("stops following a step that ran past its limit, and a failure after a day", () => {
    expect(view(reported("0.149.0", { update_state: "downloading", update_target: "latest", update_updated_at: ago(30 * MIN) }))).toEqual({ kind: "current", installed: "0.149.0" });
    expect(view(reported("0.149.0", { update_state: "failed", update_target: "latest", update_updated_at: ago(25 * 60 * MIN) }))).toEqual({ kind: "current", installed: "0.149.0" });
  });

  it("shows a request the computer hasn't reported yet as starting, and one that couldn't start as failed", () => {
    const requested = { requested_target: "latest", requested_at: ago(MIN / 2) } as const;
    expect(view(reported("0.149.0", { ...requested, request_result: "scheduled" }))).toEqual({ kind: "updating", phase: "starting", target: "latest", installed: "0.149.0" });
    expect(view(reported("0.149.0", { ...requested, request_result: "failed" }))).toEqual({ kind: "update_failed", reason: "could_not_start", target: "latest", installed: "0.149.0" });
  });

  it("works the same for an app, whose version is in the app's own form", () => {
    const zero = agentSoftwareSubject({ type: "agent-zero" }) as AgentSoftwareSubject;
    expect(view(reported(IMAGE), "running", zero)).toEqual({ kind: "current", installed: IMAGE });
    expect(view(reported("2026.11.4"), "running", zero)).toEqual({ kind: "version_unreadable" });
    const hermes = agentSoftwareSubject({ type: "hermes" }) as AgentSoftwareSubject;
    expect(view(reported("0.23.1", { update_state: "failed", update_reason: "local_changes", update_target: "latest", update_updated_at: ago(MIN) }), "running", hermes))
      .toEqual({ kind: "update_failed", reason: "local_changes", target: "latest", installed: "0.23.1" });
  });
});

describe("badges and summaries", () => {
  it("never says an update is available because of a version: only an older connection service or a waiting update", () => {
    expect(agentSoftwareBadge({ kind: "current", installed: "0.1.0" })).toBeNull();
    expect(agentSoftwareBadge({ kind: "older_connection_service" })).toBe("update_available");
    expect(agentSoftwareBadge({ kind: "update_deferred", target: "latest", installed: null })).toBe("update_available");
    expect(agentSoftwareBadge({ kind: "updating", phase: "waiting", target: "latest", installed: null })).toBe("updating");
    expect(agentSoftwareBadge({ kind: "update_failed", reason: "install_failed", target: "latest", installed: null })).toBe("update_failed");
  });

  it("summarizes for the agents list with only the installed version", () => {
    expect(summarizeAgentSoftware({ kind: "current", installed: "0.149.1" }, codex)).toEqual({ badge: null, cli: "codex", app: null, installed: "0.149.1" });
  });
});

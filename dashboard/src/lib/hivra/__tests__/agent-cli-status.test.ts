import {
  agentCliAutoUpdateGate,
  agentCliAutoUpdateMode,
  agentSoftwareBadge,
  agentSoftwareSubject,
  compareCliVersions,
  deriveAgentSoftware,
  effectiveAgentCliAutoUpdate,
  parseAgentCliMeta,
  parseAgentCliReport,
  summarizeAgentSoftware,
  type AgentSoftwareRecord,
  type AgentSoftwareSubject,
} from "../agent-cli-status";

const NOW = Date.parse("2026-09-25T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const codex = agentSoftwareSubject({ type: "codex", computer_substrate: "proxmox-kvm" }) as AgentSoftwareSubject;
const TESTED = "0.149.1";

function view(record: AgentSoftwareRecord | null, status = "running") {
  return deriveAgentSoftware({ subject: codex, status, tested: TESTED, record, now: NOW });
}
const reported = (installed: string | null, extra: AgentSoftwareRecord = {}): AgentSoftwareRecord => ({
  observation: installed === null ? "version_unreadable" : "reported",
  installed_version: installed,
  observed_at: ago(MIN),
  ...extra,
});

describe("parseAgentCliReport (moved from the lifecycle route)", () => {
  it.each([
    ["HIVRA_AGENT_CLI name=codex version=0.149.1 target=0.156.1 state=scheduled", { name: "codex", version: "0.149.1", target: "0.156.1", state: "scheduled" }],
    ["HIVRA_AGENT_CLI name=claude-code version=unknown target=2.1.246 state=failed", { name: "claude-code", version: null, target: "2.1.246", state: "failed" }],
  ])("reads %s", (line, expected) => {
    expect(parseAgentCliReport(`noise\n${line}\nHIVRA_GUEST_RUNTIME_UPDATED vmid=1\n`)).toEqual(expected);
  });
  it("ignores any other shape", () => {
    expect(parseAgentCliReport("HIVRA_AGENT_CLI name=codex version=0.149.1 target=latest state=scheduled")).toBeNull();
    expect(parseAgentCliReport("HIVRA_AGENT_CLI name=gemini version=1.0.0 target=1.0.1 state=scheduled")).toBeNull();
  });
});

describe("parseAgentCliMeta", () => {
  it("reads the gateway's agentCli with its update progress", () => {
    expect(parseAgentCliMeta({ name: "codex", version: "0.149.0", update: { state: "waiting", target: "0.149.1", updatedAt: "2026-09-25T00:30:00Z" } }, "codex"))
      .toEqual({ name: "codex", version: "0.149.0", update: { state: "waiting", target: "0.149.1", updatedAt: "2026-09-25T00:30:00Z", reason: null } });
    expect(parseAgentCliMeta({ name: "codex", version: null }, "codex")).toEqual({ name: "codex", version: null, update: null });
    expect(parseAgentCliMeta({ name: "codex", version: "0.149.0", update: { state: "rolled_back", target: "0.149.1", updatedAt: null, reason: "install_failed" } }, "codex")?.update)
      .toEqual({ state: "rolled_back", target: "0.149.1", updatedAt: null, reason: "install_failed" });
  });
  it.each([
    ["another CLI's name", { name: "claude-code", version: "2.1.246" }],
    ["an unknown name", { name: "gemini", version: "1.0.0" }],
    ["a version that isn't x.y.z", { name: "codex", version: "latest" }],
    ["an unknown update state", { name: "codex", version: "0.149.0", update: { state: "exploded", target: "0.149.1" } }],
    ["a target that isn't x.y.z", { name: "codex", version: "0.149.0", update: { state: "done", target: "next" } }],
    ["a malformed reason", { name: "codex", version: "0.149.0", update: { state: "failed", target: "0.149.1", reason: "Rm -rf" } }],
    ["no object", "codex 0.149.0"],
  ])("refuses %s", (_case, value) => {
    expect(parseAgentCliMeta(value, "codex")).toBeNull();
  });
});

describe("compareCliVersions", () => {
  it("orders numerically, not as text", () => {
    expect(compareCliVersions("0.149.1", "0.149.1")).toBe(0);
    expect(compareCliVersions("0.99.0", "0.149.0")).toBe(-1);
    expect(compareCliVersions("2.1.246", "2.1.99")).toBe(1);
    expect(compareCliVersions("1.0.0", "0.999.999")).toBe(1);
  });
});

describe("agentSoftwareSubject", () => {
  it("covers Claude Code and Codex with their CLI, and the dashboard agents without one", () => {
    expect(agentSoftwareSubject({ type: "claude-code" })).toEqual({ type: "claude-code", cli: "claude-code", gatewayKind: "claude" });
    expect(codex).toEqual({ type: "codex", cli: "codex", gatewayKind: "codex" });
    expect(agentSoftwareSubject({ type: "aeon", computer_substrate: "proxmox-kvm" })).toEqual({ type: "aeon", cli: null, gatewayKind: "aeon" });
    expect(agentSoftwareSubject({ type: "agent-zero" })?.gatewayKind).toBe("agent-zero");
  });
  it.each([
    ["DeepSeek, whose update is refused", { type: "deepseek-harness" }],
    ["a computer", { type: "linux-desktop", computer_profile: "ubuntu-desktop" }],
    ["My cloud", { type: "codex", computer_substrate: "provider-vm" }],
    ["a Linux Sandbox", { type: "codex", computer_substrate: "gvisor" }],
    ["a DigitalOcean session", { type: "codex", computer_substrate: "do-managed-session" }],
    ["an agent on a prepared computer", { type: "codex", computer_profile: "windows" }],
  ])("leaves out %s", (_case, row) => {
    expect(agentSoftwareSubject(row)).toBeNull();
  });
});

describe("deriveAgentSoftware", () => {
  it("says nothing about a computer that isn't running", () => {
    expect(view(reported("0.149.0"), "stopped")).toEqual({ kind: "not_running" });
  });
  it("is still checking before the first reading", () => {
    expect(view(null)).toEqual({ kind: "checking" });
    expect(view({ observation: "checking" })).toEqual({ kind: "checking" });
  });
  it("passes on what the computer couldn't say", () => {
    expect(view({ observation: "unreachable" })).toEqual({ kind: "unreachable" });
    expect(view({ observation: "older_connection_service" })).toEqual({ kind: "older_connection_service" });
    expect(view(reported(null))).toEqual({ kind: "version_unreadable" });
  });
  it("compares against Hivra's tested version, never the newest release", () => {
    expect(view(reported(TESTED))).toEqual({ kind: "current", installed: TESTED });
    expect(view(reported("0.149.0"))).toEqual({ kind: "behind", installed: "0.149.0" });
  });
  it("tells an owner's own newer install from one Hivra put there before lowering its tested version", () => {
    expect(view(reported("0.150.0"))).toEqual({ kind: "ahead_custom", installed: "0.150.0" });
    expect(view(reported("0.150.0", { hivra_installed_version: "0.150.0" }))).toEqual({ kind: "ahead_hivra", installed: "0.150.0" });
  });
  it.each(["downloading", "waiting", "installing"] as const)("follows an update while %s", (state) => {
    expect(view(reported("0.149.0", { update_state: state, update_target: TESTED, update_updated_at: ago(MIN) })))
      .toEqual({ kind: "updating", phase: state, target: TESTED, installed: "0.149.0" });
  });
  it("ignores a stored result for another target", () => {
    expect(view(reported("0.149.0", { update_state: "failed", update_target: "0.140.0", update_reason: "install_failed", update_updated_at: ago(MIN) })))
      .toEqual({ kind: "behind", installed: "0.149.0" });
  });
  it("reads a finished swap whose new version isn't read yet as finishing, then as the version it reports", () => {
    const done = { update_state: "done", update_target: TESTED, update_updated_at: ago(30_000) };
    expect(view(reported("0.149.0", done))).toEqual({ kind: "updating", phase: "finishing", target: TESTED, installed: "0.149.0" });
    expect(view(reported("0.149.0", { ...done, update_updated_at: ago(10 * MIN) }))).toEqual({ kind: "behind", installed: "0.149.0" });
    expect(view(reported(null, { ...done, update_updated_at: ago(10 * MIN) }))).toEqual({ kind: "checking" });
  });
  it("shows a finished update as just finished for a while, then as current", () => {
    const done = { update_state: "done", update_target: TESTED, update_updated_at: ago(5 * MIN) };
    expect(view(reported(TESTED, done))).toEqual({ kind: "update_done", target: TESTED, installed: TESTED });
    expect(view(reported(TESTED, { ...done, update_updated_at: ago(7 * 60 * MIN) }))).toEqual({ kind: "current", installed: TESTED });
  });
  it.each([
    ["deferred", "chat_run_in_flight", { kind: "update_deferred", target: TESTED, installed: "0.149.0" }],
    ["rolled_back", "install_failed", { kind: "update_rolled_back", target: TESTED, installed: "0.149.0" }],
    ["failed", "download_failed", { kind: "update_failed", reason: "download_failed", target: TESTED, installed: "0.149.0" }],
    ["failed", "install_failed", { kind: "update_failed", reason: "install_failed", target: TESTED, installed: "0.149.0" }],
  ])("says how an update ended: %s (%s)", (state, reason, expected) => {
    expect(view(reported("0.149.0", { update_state: state, update_target: TESTED, update_reason: reason, update_updated_at: ago(MIN) }))).toEqual(expected);
  });
  it("shows a request the computer hasn't reported yet as starting, and one that couldn't start as failed", () => {
    const request = { requested_at: ago(MIN), requested_target: TESTED, requested_by: "owner" };
    expect(view(reported("0.149.0", { ...request, request_result: "scheduled" }))).toEqual({ kind: "updating", phase: "starting", target: TESTED, installed: "0.149.0" });
    expect(view(reported("0.149.0", { ...request, request_result: null, requested_by: "auto" }))).toEqual({ kind: "updating", phase: "starting", target: TESTED, installed: "0.149.0" });
    expect(view(reported("0.149.0", { ...request, request_result: "failed" }))).toEqual({ kind: "update_failed", reason: "could_not_start", target: TESTED, installed: "0.149.0" });
    // A stale status file from before the request doesn't hide it.
    expect(view(reported("0.149.0", { ...request, request_result: "scheduled", update_state: "done", update_target: TESTED, update_updated_at: ago(3 * 60 * MIN) })))
      .toEqual({ kind: "updating", phase: "starting", target: TESTED, installed: "0.149.0" });
    // Progress newer than the request wins, and an old request no longer counts.
    expect(view(reported("0.149.0", { ...request, request_result: "scheduled", update_state: "downloading", update_target: TESTED, update_updated_at: ago(0) }))).toMatchObject({ phase: "downloading" });
    expect(view(reported("0.149.0", { ...request, requested_at: ago(20 * MIN), request_result: "scheduled" }))).toEqual({ kind: "behind", installed: "0.149.0" });
  });
});

describe("badges and summaries", () => {
  it("offers an update only when behind Hivra's tested version or the connection service is older", () => {
    expect(agentSoftwareBadge({ kind: "behind", installed: "1.0.0" })).toBe("update_available");
    expect(agentSoftwareBadge({ kind: "older_connection_service" })).toBe("update_available");
    expect(agentSoftwareBadge({ kind: "ahead_custom", installed: "9.0.0" })).toBeNull();
    expect(agentSoftwareBadge({ kind: "current", installed: "1.0.0" })).toBeNull();
    expect(agentSoftwareBadge({ kind: "updating", phase: "waiting", target: "1.0.1", installed: "1.0.0" })).toBe("updating");
    expect(agentSoftwareBadge({ kind: "update_rolled_back", target: "1.0.1", installed: "1.0.0" })).toBe("update_failed");
  });
  it("summarizes for the agents list without anything but versions", () => {
    expect(summarizeAgentSoftware({ kind: "behind", installed: "0.149.0" }, codex, TESTED))
      .toEqual({ badge: "update_available", cli: "codex", installed: "0.149.0", tested: TESTED });
  });
});

describe("automatic updates", () => {
  it("ships dark: only on or preview turn it on", () => {
    expect(agentCliAutoUpdateMode(undefined)).toBe("off");
    expect(agentCliAutoUpdateMode("")).toBe("off");
    expect(agentCliAutoUpdateMode("yes")).toBe("off");
    expect(agentCliAutoUpdateMode(" ON ")).toBe("on");
    expect(agentCliAutoUpdateMode("preview")).toBe("preview");
  });
  it("defaults on for Hivra Cloud and off for My server until the owner chooses", () => {
    expect(effectiveAgentCliAutoUpdate(null, "hivra-managed")).toEqual({ enabled: true, source: "default" });
    expect(effectiveAgentCliAutoUpdate({ auto_update: null }, "self-managed")).toEqual({ enabled: false, source: "default" });
    expect(effectiveAgentCliAutoUpdate({ auto_update: false }, "hivra-managed")).toEqual({ enabled: false, source: "owner" });
    expect(effectiveAgentCliAutoUpdate({ auto_update: true }, "self-managed")).toEqual({ enabled: true, source: "owner" });
  });
  it("updates only a reported version that is behind, or ahead because Hivra lowered its version", () => {
    expect(agentCliAutoUpdateGate({ kind: "behind", installed: "0.149.0" }, null, TESTED)).toEqual({ ok: true });
    expect(agentCliAutoUpdateGate({ kind: "ahead_hivra", installed: "0.150.0" }, null, TESTED)).toEqual({ ok: true });
    expect(agentCliAutoUpdateGate({ kind: "update_deferred", target: TESTED, installed: "0.149.0" }, null, TESTED)).toEqual({ ok: true });
    expect(agentCliAutoUpdateGate({ kind: "ahead_custom", installed: "0.150.0" }, null, TESTED)).toEqual({ ok: false, skip: "owner_version" });
    expect(agentCliAutoUpdateGate({ kind: "older_connection_service" }, null, TESTED)).toEqual({ ok: false, skip: "not_reported" });
    expect(agentCliAutoUpdateGate({ kind: "version_unreadable" }, null, TESTED)).toEqual({ ok: false, skip: "not_reported" });
    expect(agentCliAutoUpdateGate({ kind: "current", installed: TESTED }, null, TESTED)).toEqual({ ok: false, skip: "not_behind" });
    expect(agentCliAutoUpdateGate({ kind: "updating", phase: "waiting", target: TESTED, installed: "0.149.0" }, null, TESTED)).toEqual({ ok: false, skip: "updating" });
  });
  it("stays paused after a failed update to this target", () => {
    expect(agentCliAutoUpdateGate({ kind: "behind", installed: "0.149.0" }, { auto_paused_target: TESTED, auto_paused_reason: "rolled_back" }, TESTED)).toEqual({ ok: false, skip: "paused" });
    expect(agentCliAutoUpdateGate({ kind: "update_rolled_back", target: TESTED, installed: "0.149.0" }, null, TESTED)).toEqual({ ok: false, skip: "paused" });
    // A pause for an older target doesn't hold a newer one.
    expect(agentCliAutoUpdateGate({ kind: "behind", installed: "0.149.0" }, { auto_paused_target: "0.148.0", auto_paused_reason: "failed" }, TESTED)).toEqual({ ok: true });
  });
});

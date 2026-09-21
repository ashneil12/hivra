import { AGENTS, BASE_FLOOR, canLaunchAgent, getAgent, hostingDisclaimer, isPoolExempt, resizeFloor } from "../agent-catalog";
import { WELCOME_AGENT_TYPES } from "@/lib/welcome-agent-catalog";

describe("Hivra agent catalog", () => {
  it.each(AGENTS)("discloses managed infrastructure access for $name without impossible credential guarantees", (agent) => {
    const copy = hostingDisclaimer(agent);
    expect(copy).toContain("Credentials may be stored on the agent computer");
    expect(copy).toContain("Hivra administrators retain infrastructure access");
    expect(copy).not.toMatch(/never (sees|stores)|does not see or store/i);
  });

  it.each(AGENTS)("attributes infrastructure access to the operator for a self-managed $name computer", (agent) => {
    const copy = hostingDisclaimer(agent, "self-managed");
    expect(copy).toContain("Hivra does not become the host operator");
    expect(copy).not.toContain("Hivra administrators retain infrastructure access");
  });

  it("makes the native Codex API-key option visible before launch", () => {
    const codex = WELCOME_AGENT_TYPES.find(agent => agent.key === "codex")!;
    expect(codex.tagline).toContain("API key");
    expect(codex.description).toContain("API key");
    expect(codex.deployCard.summary).toContain("API key");
    expect(codex.deployCard.guardrails.join(" ")).not.toMatch(/does not see or store/);
    expect(hostingDisclaimer(getAgent("codex"))).toContain("OpenAI API key");
  });

  it("does not contradict the credential boundary in welcome-card guardrails", () => {
    for (const agent of WELCOME_AGENT_TYPES) {
      expect(agent.deployCard.guardrails.join(" ")).not.toMatch(/never (sees|stores)|does not see or store/i);
    }
  });

  it("does not advertise Operator OS while its first-party runtime source is outside the public boundary", () => {
    expect(WELCOME_AGENT_TYPES.some((agent) => String(agent.key) === "operatoros")).toBe(false);
  });
  it("keeps Claude Code launchable on the free half-core tier without browser automation", () => {
    const claude = getAgent("claude-code");

    expect(claude).toBeDefined();
    expect(BASE_FLOOR).toEqual({ cpu: 0.5, ram: 1 });
    expect(canLaunchAgent(claude!, "free")).toEqual({ ok: true });
  });

  it("offers Hermes, Claude Code, Codex, Aeon, OpenClaw, and Agent Zero as launchable box agents", () => {
    expect(AGENTS.map((agent) => agent.id)).toEqual(["hermes", "claude-code", "codex", "aeon", "openclaw", "agent-zero"]);
    expect(getAgent("codex")).toMatchObject({
      id: "codex",
      cliKind: "codex",
      browser: true,
    });
  });

  it("keeps the Linux desktop runtime out of the agent picker", () => {
    expect(getAgent("linux-desktop")).toMatchObject({
      id: "linux-desktop",
      resourceKind: "computer",
      provisionKind: "linux-desktop",
      surface: "computer",
      available: true,
      floor: { cpu: 2, ram: 4 },
    });
    expect(AGENTS.some(agent => agent.id === "linux-desktop")).toBe(false);
  });

  it("makes Codex launchable on the free tier, with the same browser surcharge as Claude Code when toggled on", () => {
    const codex = getAgent("codex");

    expect(codex).toBeDefined();
    expect(codex!.browser).toBe(true);
    expect(canLaunchAgent(codex!, "free")).toEqual({ ok: true });
    // Browser off → plain floor; on → same +1 CPU / +2 GB surcharge as claude.
    expect(resizeFloor("codex", false)).toEqual({ cpu: BASE_FLOOR.cpu, ram: BASE_FLOOR.ram });
    expect(resizeFloor("codex", true)).toEqual(resizeFloor("claude-code", true));
  });

  it("treats Aeon as a pool-exempt dashboard host with a fixed 0.5 CPU / 1 GB floor", () => {
    const aeon = getAgent("aeon");

    expect(aeon).toMatchObject({
      id: "aeon",
      surface: "dashboard",
      poolExempt: true,
      connect: "github",
      browser: false,
    });
    expect(aeon!.cliKind).toBeUndefined();
    expect(isPoolExempt("aeon")).toBe(true);
    expect(isPoolExempt("claude-code")).toBe(false);
    // Fixed tiny footprint to host the Next.js dashboard (pool-exempt, so free).
    expect(resizeFloor("aeon", false)).toEqual({ cpu: 0.5, ram: 1 });
    expect(canLaunchAgent(aeon!, "free")).toEqual({ ok: true });
  });

  it("treats OpenClaw as a non-pool-exempt dashboard host needing a paid tier and a 1 CPU / 2 GB floor", () => {
    const openclaw = getAgent("openclaw");

    expect(openclaw).toMatchObject({
      id: "openclaw",
      surface: "dashboard",
      browser: true,
      minPlan: "pro",
      dashboardPort: 18789,
      // Bills inference to the user's managed-Venice wallet (minted at launch).
      managedVenice: true,
    });
    expect(openclaw!.cliKind).toBeUndefined();
    // Runs a real agent loop on-box → charges the compute pool (unlike Aeon).
    expect(isPoolExempt("openclaw")).toBe(false);
    // Browser off → 1/2 (pro); opt in → +1 CPU / +2 GB surcharge → 2/4.
    expect(resizeFloor("openclaw", false)).toEqual({ cpu: 1, ram: 2 });
    expect(resizeFloor("openclaw", true)).toEqual({ cpu: 2, ram: 4 });
    // Paid tier required: the 1/2 footprint can't fit the free pool.
    expect(canLaunchAgent(openclaw!, "free")).toEqual({ ok: false, reason: "Needs Pro" });
    expect(canLaunchAgent(openclaw!, "pro")).toEqual({ ok: true });
  });

  it("treats Agent Zero as a non-pool-exempt dashboard host needing a paid tier and a fixed 1 CPU / 2 GB floor", () => {
    const agentZero = getAgent("agent-zero");

    expect(agentZero).toMatchObject({
      id: "agent-zero",
      surface: "dashboard",
      // Agent Zero ships its own browser in-container; the box CDP stack is off.
      browser: false,
      minPlan: "pro",
      dashboardPort: 50080,
      // Bills inference to the user's managed-Venice wallet (minted at launch).
      managedVenice: true,
    });
    expect(agentZero!.cliKind).toBeUndefined();
    // Runs the Agent Zero container on-box → charges the compute pool (unlike Aeon).
    expect(isPoolExempt("agent-zero")).toBe(false);
    // Floor footprint; no box CDP browser surcharge either way (browser:false).
    expect(resizeFloor("agent-zero", false)).toEqual({ cpu: 1, ram: 2 });
    expect(resizeFloor("agent-zero", true)).toEqual({ cpu: 1, ram: 2 });
    // Paid tier required: the 2/4 footprint can't fit the free pool.
    expect(canLaunchAgent(agentZero!, "free")).toEqual({ ok: false, reason: "Needs Pro" });
    expect(canLaunchAgent(agentZero!, "pro")).toEqual({ ok: true });
  });

  it("describes DeepSeek Harness for retained native rows without exposing an unaccepted launch card", () => {
    const harness = getAgent("deepseek-harness");
    expect(harness).toMatchObject({ surface: "dashboard", available: false, minPlan: "pro", floor: { cpu: 2, ram: 3 } });
    expect(AGENTS.some(agent => agent.id === "deepseek-harness")).toBe(false);
    expect(canLaunchAgent(harness!, "power")).toEqual({ ok: false, reason: "Coming soon" });
  });

  it("keeps the standard BASE_FLOOR for CLI agents (no per-agent override)", () => {
    expect(resizeFloor("claude-code", false)).toEqual({ cpu: BASE_FLOOR.cpu, ram: BASE_FLOOR.ram });
  });
});

/** @jest-environment node */
import {
  SetupRequestBody,
  displaySetupCode,
  hashPollSecret,
  newPollSecret,
  newSetupCode,
  parseSetupCode,
  resolveSetupStatus,
  setupClaimUsable,
  setupLaunchPath,
  type SetupRow,
} from "../core";
import { agentSetupHandshakeEnabled } from "../flag";
import { buildSetupMarkdown, setupPrompt } from "../setup-md";

const NOW = Date.parse("2026-11-17T10:00:00Z");
const ORIGIN = "https://canary.hermesos.cloud";
const base: SetupRow = {
  id: "11111111-1111-4111-8111-111111111111", code: "ABCDEFGH", agent: "claude-code", inference: "venice", client: "Claude Code",
  user_id: null, claimed_at: null, agent_id: null, created_at: "2026-11-17T09:50:00Z", expires_at: "2026-11-17T10:20:00Z",
};
const claimed: SetupRow = { ...base, user_id: "user_1", claimed_at: "2026-11-17T09:55:00Z" };

describe("setup codes and secrets", () => {
  it("makes 8-character codes without look-alike characters", () => {
    for (let i = 0; i < 200; i += 1) expect(newSetupCode()).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  });

  it("shows codes with a dash and reads them back in any form", () => {
    expect(displaySetupCode("ABCDEFGH")).toBe("ABCD-EFGH");
    expect(parseSetupCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(parseSetupCode("ABCDEFG")).toBeNull();
    expect(parseSetupCode("ABCD/EFGH")).toBeNull();
    expect(parseSetupCode(null)).toBeNull();
  });

  it("makes distinct poll secrets and stores only a hash", () => {
    const first = newPollSecret();
    expect(first).toMatch(/^hivra_setup_[A-Za-z0-9_-]{32}$/);
    expect(newPollSecret()).not.toBe(first);
    expect(hashPollSecret(first)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPollSecret(first)).not.toContain(first);
  });
});

describe("SetupRequestBody", () => {
  it("accepts an empty body and the known values", () => {
    expect(SetupRequestBody.safeParse({}).success).toBe(true);
    expect(SetupRequestBody.safeParse({ agent: "hermes", inference: "venice-key", client: "Claude Code" }).success).toBe(true);
  });

  it("refuses unknown agents, fields and odd client names", () => {
    expect(SetupRequestBody.safeParse({ agent: "linux-desktop" }).success).toBe(false);
    expect(SetupRequestBody.safeParse({ agent: "hermes", extra: 1 }).success).toBe(false);
    expect(SetupRequestBody.safeParse({ client: "<script>" }).success).toBe(false);
    expect(SetupRequestBody.safeParse({ inference: "openai" }).success).toBe(false);
  });

  it("refuses model access without an agent, since Launch can't carry it through the picker", () => {
    expect(SetupRequestBody.safeParse({ inference: "venice-key" }).success).toBe(false);
    expect(SetupRequestBody.safeParse({ agent: "codex", inference: "venice-key" }).success).toBe(true);
  });
});

describe("setupLaunchPath", () => {
  it("preselects the agent and model access, with setup attribution", () => {
    expect(setupLaunchPath("claude-code", "venice")).toBe("/dashboard/launch?agent=claude-code&inference=venice&ref=agent-setup");
    expect(setupLaunchPath("hermes", null)).toBe("/dashboard/launch?agent=hermes&ref=agent-setup");
    expect(setupLaunchPath(null, "venice")).toBe("/dashboard/launch?kind=agent&start=1&ref=agent-setup");
  });
});

describe("setupClaimUsable", () => {
  it("lets only the person who opened it continue, and only inside the launch window", () => {
    expect(setupClaimUsable(claimed, "user_1", NOW)).toBe(true);
    expect(setupClaimUsable(claimed, "user_2", NOW)).toBe(false);
    expect(setupClaimUsable(base, "user_1", NOW)).toBe(false);
    // Opened 09:55, so the window closes at 11:55.
    expect(setupClaimUsable(claimed, "user_1", Date.parse("2026-11-17T11:55:00Z"))).toBe(true);
    expect(setupClaimUsable(claimed, "user_1", Date.parse("2026-11-17T12:00:00Z"))).toBe(false);
  });
});

describe("resolveSetupStatus", () => {
  const agent = { id: "22222222-2222-4222-8222-222222222222", name: "Claude Code", type: "claude-code", status: "provisioning" };

  it("waits for the person, then expires an unopened request", () => {
    expect(resolveSetupStatus(base, null, ORIGIN, NOW).status).toBe("waiting_for_person");
    expect(resolveSetupStatus(base, null, ORIGIN, Date.parse("2026-11-17T10:21:00Z")).status).toBe("expired");
  });

  it("waits for Launch after the person opens it, for two hours", () => {
    expect(resolveSetupStatus(claimed, null, ORIGIN, NOW).status).toBe("waiting_for_launch");
    // An opened request outlives the open window.
    expect(resolveSetupStatus(claimed, null, ORIGIN, Date.parse("2026-11-17T11:00:00Z")).status).toBe("waiting_for_launch");
    expect(resolveSetupStatus(claimed, null, ORIGIN, Date.parse("2026-11-17T11:56:00Z")).status).toBe("expired");
  });

  it("follows the launched agent to running or error, with its link", () => {
    const starting = resolveSetupStatus(claimed, agent, ORIGIN, NOW);
    expect(starting.status).toBe("starting");
    expect(starting.agent?.url).toBe(`${ORIGIN}/dashboard/agent/${agent.id}`);
    expect(starting.pollAgainInSeconds).toBe(5);
    const ready = resolveSetupStatus(claimed, { ...agent, status: "running" }, ORIGIN, NOW);
    expect(ready.status).toBe("ready");
    expect(ready.message).toContain(ready.agent!.url);
    expect(ready.pollAgainInSeconds).toBeUndefined();
    expect(resolveSetupStatus(claimed, { ...agent, status: "error" }, ORIGIN, NOW).status).toBe("failed");
  });
});

describe("agentSetupHandshakeEnabled", () => {
  it("is off unless set to 1 or true", () => {
    expect(agentSetupHandshakeEnabled(undefined)).toBe(false);
    expect(agentSetupHandshakeEnabled("0")).toBe(false);
    expect(agentSetupHandshakeEnabled(" TRUE ")).toBe(true);
    expect(agentSetupHandshakeEnabled("1")).toBe(true);
  });
});

describe("setup.md", () => {
  it("points every link at the site serving it", () => {
    const md = buildSetupMarkdown({ origin: ORIGIN, handshake: false });
    expect(md).toContain(setupPrompt(ORIGIN));
    expect(md).toContain(`${ORIGIN}/dashboard/launch?agent=claude-code&inference=venice&ref=agent-setup`);
    expect(md).not.toContain("hivra.cloud");
  });

  it("teaches only the Launch link while the handshake is off", () => {
    const md = buildSetupMarkdown({ origin: ORIGIN, handshake: false });
    expect(md).not.toContain("/api/agent-setup");
    expect(md).toContain("| `hermes` |");
    expect(md).toContain("paid plan");
  });

  it("teaches the setup request and poll while the handshake is on, with the plain link as fallback", () => {
    const md = buildSetupMarkdown({ origin: ORIGIN, handshake: true });
    expect(md).toContain(`curl -sS -X POST ${ORIGIN}/api/agent-setup`);
    expect(md).toContain("x-hivra-setup-token");
    for (const status of ["waiting_for_person", "waiting_for_launch", "starting", "ready", "failed", "expired"]) {
      expect(md).toContain(`\`${status}\``);
    }
    expect(md).toContain("Plain Launch link (fallback)");
  });
});

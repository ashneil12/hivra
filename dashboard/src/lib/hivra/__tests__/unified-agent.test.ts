import { isRunningState, unifiedStateLabel, unifyAll } from "../unified-agent";
import type { HivraAgent } from "../agent-api";

function computer(profile: string | null): HivraAgent {
  return {
    id: `c-${profile ?? "legacy"}`,
    name: "MY_DESKTOP",
    type: "linux-desktop",
    status: "running",
    computer_profile: profile,
  } as unknown as HivraAgent;
}

describe("unifyAll typeLabel", () => {
  it("names a computer after its operating system, not the default Ubuntu template", () => {
    const [windows, omarchy, ubuntu] = unifyAll([], [computer("windows"), computer("omarchy"), computer("ubuntu-desktop")]);
    expect(windows.typeLabel).toBe("Windows");
    expect(omarchy.typeLabel).toBe("Omarchy");
    expect(ubuntu.typeLabel).toBe("Ubuntu Desktop");
  });

  it("keeps Ubuntu Desktop for legacy computers with no stored profile", () => {
    expect(unifyAll([], [computer(null)])[0].typeLabel).toBe("Ubuntu Desktop");
  });

  it("falls back to the catalog name for an unknown profile instead of inventing one", () => {
    expect(unifyAll([], [computer("beos")])[0].typeLabel).toBe("Ubuntu Desktop");
  });

  it("leaves agent labels alone", () => {
    const agent = { id: "a1", name: "CODEX_AGENT", type: "codex", status: "running" } as unknown as HivraAgent;
    expect(unifyAll([], [agent])[0].typeLabel).toBe("Codex");
  });
});

describe("unifyAll software", () => {
  const codex = (agent_software: unknown) => ({ id: "a1", name: "CODEX_AGENT", type: "codex", status: "running", agent_software } as unknown as HivraAgent);

  it("carries the list's software summary only when there is something to say", () => {
    const behind = { badge: "update_available", cli: "codex", installed: "0.140.0", tested: "0.149.1" };
    expect(unifyAll([], [codex(behind)])[0].software).toEqual(behind);
    expect(unifyAll([], [codex({ badge: null, cli: "codex", installed: "0.149.1", tested: "0.149.1" })])[0].software).toBeNull();
    expect(unifyAll([], [codex(undefined)])[0].software).toBeNull();
  });
});

describe("unifyAll canTryAgain", () => {
  const errored = (patch: Record<string, unknown>) => ({
    ...computer("ubuntu-desktop"), status: "error", error: "Desktop never answered",
    computer_substrate: "proxmox-kvm", deployment_mode: "hivra-managed",
    provisioned_at: "2026-09-12T08:30:00Z", vmid: 1113, ...patch,
  }) as unknown as HivraAgent;

  it("is set only for an errored Hivra Cloud computer that was ready once and still has its machine", () => {
    expect(unifyAll([], [errored({})])[0].canTryAgain).toBe(true);
    for (const patch of [
      { provisioned_at: null },
      { vmid: null },
      { computer_substrate: "provider-vm" },
      { deployment_mode: "self-managed" },
      { computer_profile: "windows" },
      { status: "running" },
    ]) {
      expect(unifyAll([], [errored(patch)])[0].canTryAgain).toBeUndefined();
    }
  });
});

describe("unifyAll computers gone from their host", () => {
  const gone = {
    ...computer("ubuntu-desktop"), status: "error", vmid: 101, provisioned_at: "2026-01-01T00:00:00Z",
    error: "This computer no longer exists on its host.",
  } as unknown as HivraAgent;

  it("keeps the stored reason and marks it as only removable", () => {
    const [row] = unifyAll([], [gone]);
    expect(row.attention).toBe("error");
    expect(row.failureReason).toBe("This computer no longer exists on its host.");
    expect(row.missingOnHost).toBe(true);
    expect(row.canTryAgain).toBeUndefined();
  });

  it("does not mark an ordinary failure as gone", () => {
    const [row] = unifyAll([], [{ ...gone, error: "Setup failed." } as HivraAgent]);
    expect(row.missingOnHost).toBeUndefined();
    expect(row.failureReason).toBe("Setup failed.");
  });
});

describe("unifyAll sleep", () => {
  const previous = process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP;
  afterEach(() => {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP;
    else process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP = previous;
  });
  const agent = (status: string, sleep_state?: string | null) =>
    ({ id: `s-${status}-${sleep_state}`, name: "NAP_AGENT", type: "claude-code", status, sleep_state }) as unknown as HivraAgent;

  it("shows a running agent that is not awake as Asleep, and one that is waking as Waking up", () => {
    process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP = "1";
    const [napping, hibernated, waking, awake, plain] = unifyAll([], [
      agent("running", "napping"), agent("running", "hibernated"), agent("running", "waking"),
      agent("running", "awake"), agent("running"),
    ]);
    // Sorted by name within one bucket, so find each by its id.
    const byId = Object.fromEntries([napping, hibernated, waking, awake, plain].map((row) => [row.id, row]));
    expect(unifiedStateLabel(byId["s-running-napping"].state)).toBe("Asleep");
    expect(unifiedStateLabel(byId["s-running-hibernated"].state)).toBe("Asleep");
    expect(unifiedStateLabel(byId["s-running-waking"].state)).toBe("Waking up");
    expect(byId["s-running-awake"].state).toBe("running");
    expect(byId["s-running-undefined"].state).toBe("running");
    // The raw status stays running, and the dot is calm, not the running green.
    expect(byId["s-running-napping"].statusRaw).toBe("running");
    expect(byId["s-running-napping"].dot).not.toBe(byId["s-running-awake"].dot);
    expect(byId["s-running-waking"].dot).not.toBe(byId["s-running-awake"].dot);
  });

  it("keeps a stopped or errored agent as it was, whatever its sleep state says", () => {
    process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP = "1";
    expect(unifyAll([], [agent("stopped", "napping")])[0].state).toBe("stopped");
    expect(unifyAll([], [agent("error", "hibernated")])[0].state).toBe("error");
  });

  it("changes nothing with the switch off", () => {
    delete process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP;
    expect(unifyAll([], [agent("running", "napping")])[0].state).toBe("running");
    expect(unifyAll([], [agent("running", "waking")])[0].state).toBe("running");
  });

  it("lists asleep and waking agents with the running ones", () => {
    process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP = "1";
    const rows = unifyAll([], [
      { ...agent("stopped"), id: "z", name: "A_STOPPED" } as HivraAgent,
      { ...agent("running", "napping"), id: "y", name: "B_NAPPING" } as HivraAgent,
      { ...agent("running"), id: "x", name: "C_RUNNING" } as HivraAgent,
    ]);
    expect(rows.map((row) => row.name)).toEqual(["B_NAPPING", "C_RUNNING", "A_STOPPED"]);
    expect(isRunningState("asleep")).toBe(true);
    expect(isRunningState("waking")).toBe(true);
    expect(isRunningState("running")).toBe(true);
    expect(isRunningState("stopped")).toBe(false);
    expect(isRunningState("provisioning")).toBe(false);
  });
});

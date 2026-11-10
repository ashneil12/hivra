import { unifyAll } from "../unified-agent";
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

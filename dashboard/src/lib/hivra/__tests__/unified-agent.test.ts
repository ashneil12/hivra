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

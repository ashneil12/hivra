/** @jest-environment jsdom */
import { optionLabel } from "../AgentLinksPanel";
import { continueEntry } from "../HomeContinue";
import { statusTone } from "../ResourceSwitcher";
import { unifyAll, type UnifiedAgent } from "@/lib/hivra/unified-agent";
import type { HivraAgent } from "@/lib/hivra/agent-api";

jest.mock("@/components/ui/ThinkingOrb", () => ({ ThinkingOrb: () => null }));

describe("status words for a sleeping agent", () => {
  const previous = process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP;
  beforeEach(() => { process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP = "1"; });
  afterAll(() => {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP;
    else process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP = previous;
  });

  it("offers an asleep agent to continue, because opening it wakes it", () => {
    const [asleep] = unifyAll([], [{ id: "a", name: "NAP", type: "claude-code", status: "running", sleep_state: "napping" } as unknown as HivraAgent]);
    const entry = { item: asleep, visit: { usedAt: 1, tab: "chat" } } as unknown as Parameters<typeof continueEntry>[0][number];
    expect(continueEntry([entry], () => false)?.item.id).toBe("a");
    expect(continueEntry([entry], (agent: UnifiedAgent) => agent.id === "a")).toBeNull();
  });

  it("gives the pill's status a calm tone for Asleep, not the busy one", () => {
    expect(statusTone("asleep")).toBe("off");
    expect(statusTone("Asleep")).toBe("off");
    expect(statusTone("running")).toBe("ok");
    expect(statusTone("waking up")).toBe("busy");
  });

  it("tells two computers with one name apart as asleep or waking up", () => {
    const base = { name: "Desk", kind: "linux-desktop", linked: false, available: true };
    const choices = [
      { ...base, id: "aaaaaaaa1", status: "running", sleepState: "hibernated" },
      { ...base, id: "bbbbbbbb2", status: "running", sleepState: "waking" },
      { ...base, id: "cccccccc3", status: "running" },
    ];
    expect(optionLabel(choices[0], choices)).toBe("Desk (linux-desktop, asleep, aaaaaaaa)");
    expect(optionLabel(choices[1], choices)).toBe("Desk (linux-desktop, waking up, bbbbbbbb)");
    expect(optionLabel(choices[2], choices)).toBe("Desk (linux-desktop, running, cccccccc)");
  });
});

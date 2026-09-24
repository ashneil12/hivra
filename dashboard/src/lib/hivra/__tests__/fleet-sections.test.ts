import {
  duplicateFleetNames,
  fleetEntryHref,
  fleetEntryOpenLabel,
  fleetSections,
  matchesFleetQuery,
} from "../fleet-sections";
import type { UnifiedAgent } from "../unified-agent";

/**
 * The fleet is listed by two surfaces (the switcher menu and the Chat control
 * pane). These specs pin the facts they must share — if they diverge, one offers
 * a resource the other hides.
 */
function agent(
  uid: string,
  name: string,
  extra: Partial<UnifiedAgent> = {},
): UnifiedAgent {
  const kind = uid.startsWith("h-") ? "hermes" : "hivra";
  return {
    uid,
    kind,
    id: uid.slice(2),
    name,
    statusRaw: "running",
    state: "running",
    dot: "#22c55e",
    vendor: kind === "hermes" ? "Hermes" : "OpenAI",
    typeLabel: kind === "hermes" ? "Hermes" : "Codex",
    ...extra,
  };
}

const codexAgent = agent("x-codex", "CODEX_AGENT");
const ubuntu = agent("x-ubuntu", "MY_UBUNTU_DESKTOP", {
  resourceKind: "computer",
  typeLabel: "Ubuntu Desktop",
  computerProfile: "ubuntu-desktop",
});
const hermes = agent("h-instance", "Hermes One");

describe("fleet sections", () => {
  it("splits agents from computers, keeping the incoming order", () => {
    const sections = fleetSections([codexAgent, ubuntu, hermes]);

    expect(sections.map(({ key }) => key)).toEqual(["agent", "computer"]);
    expect(sections[0].items.map(({ uid }) => uid)).toEqual([
      "x-codex",
      "h-instance",
    ]);
    expect(sections[1].items.map(({ uid }) => uid)).toEqual(["x-ubuntu"]);
  });

  it("omits an empty group rather than rendering a bare heading", () => {
    // A computers-only fleet must not show an "Agents" heading over nothing.
    const sections = fleetSections([ubuntu]);
    expect(sections.map(({ key }) => key)).toEqual(["computer"]);
  });

  it("searches across BOTH families", () => {
    // The bug this pins: a search that says it looks for agents but returns
    // computers, or the reverse. Computers must be findable by their own names.
    const sections = fleetSections([codexAgent, ubuntu, hermes], "ubuntu");
    expect(sections).toHaveLength(1);
    expect(sections[0].items.map(({ uid }) => uid)).toEqual(["x-ubuntu"]);
  });

  it("matches on type and vendor, not only the name", () => {
    // "Ubuntu Desktop" is the type label, not the name — someone searching the
    // kind of machine they want should find it.
    expect(fleetSections([ubuntu], "ubuntu desktop")[0]?.items).toHaveLength(1);
    expect(fleetSections([hermes], "hermes")[0]?.items).toHaveLength(1);
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(fleetSections([codexAgent, ubuntu], "zzzz")).toEqual([]);
  });

  it.each([
    ["", true],
    ["   ", true],
    ["CODEX", true],
    ["codex_agent", true],
    ["nope", false],
  ])("matchesFleetQuery(%j) is %s", (query, expected) => {
    expect(matchesFleetQuery(codexAgent, query)).toBe(expected);
  });
});

describe("duplicate fleet names", () => {
  it("flags only names that genuinely repeat", () => {
    const dup = agent("x-ubuntu2", "MY_UBUNTU_DESKTOP", {
      resourceKind: "computer",
    });
    const names = duplicateFleetNames([ubuntu, dup, codexAgent]);

    expect(names.has("MY_UBUNTU_DESKTOP")).toBe(true);
    // A unique name must NOT get an id suffix — it would be noise.
    expect(names.has("CODEX_AGENT")).toBe(false);
  });
});

describe("fleet entry destination", () => {
  it("sends a Hivra chat agent to its conversation", () => {
    expect(fleetEntryHref(codexAgent)).toBe("/dashboard/agent/codex?tab=chat");
  });

  it("sends a computer to its DESKTOP, not a conversation", () => {
    // A computer has no conversation; landing it on one is the bug that started
    // this whole line of work.
    expect(fleetEntryHref(ubuntu)).toBe("/dashboard/agent/ubuntu?tab=desktop");
  });

  it("opens a Linux Sandbox on Manage and never promises it a desktop", () => {
    // A sandbox is terminal-only; the agent page lands it on Manage.
    const sandbox = agent("x-sandbox", "MY_LINUX_SANDBOX", {
      resourceKind: "computer",
      typeLabel: "Linux Sandbox",
      agentType: "linux-terminal",
      computerProfile: null,
    });
    expect(fleetEntryHref(sandbox)).toBe("/dashboard/agent/sandbox?tab=manage");
    expect(fleetEntryOpenLabel(sandbox)).toBe("Open sandbox");
    expect(fleetEntryOpenLabel(ubuntu)).toBe("Open desktop");
    expect(fleetEntryOpenLabel(codexAgent)).toBe("Open agent");
  });

  it("sends a Hermes instance to the instance route, not the agent route", () => {
    // Different family, different shell. The agent route would render the wrong
    // thing for a Hermes box.
    expect(fleetEntryHref(hermes)).toBe("/dashboard/instances/instance");
  });

  it("encodes ids that need it", () => {
    expect(fleetEntryHref(agent("x-a b/c", "Odd"))).toBe(
      "/dashboard/agent/a%20b%2Fc?tab=chat",
    );
  });
});

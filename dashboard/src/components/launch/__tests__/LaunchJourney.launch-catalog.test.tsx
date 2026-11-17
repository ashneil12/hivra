/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { LaunchJourney } from "../LaunchJourney";

const fetchPlanStrictMock = jest.fn();
const summaryMock = jest.fn();
let aboutParam: string | null = null;
let useOrder: string[] = [];
let claimedPages: string[] = [];
let myClaims: Record<string, { status: string }> = {};

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => ({ get: (key: string) => (key === "about" ? aboutParam : null), getAll: () => [] }),
}));

jest.mock("@/lib/hivra/agent-api", () => ({
  ...jest.requireActual("@/lib/hivra/agent-api"),
  fetchPlanStrict: () => fetchPlanStrictMock(),
}));

jest.mock("@/lib/billing/managed-venice-client", () => ({
  ...jest.requireActual("@/lib/billing/managed-venice-client"),
  requestManagedVeniceSummary: () => summaryMock(),
}));

jest.mock("@/lib/abuse/client-fingerprint", () => ({ getFingerprintRequestId: async () => null }));
jest.mock("@/hooks/useTokenGeoAccess", () => ({ useTokenGeoAccess: () => ({ status: "allowed", notice: null }) }));
jest.mock("@/components/billing/ManagedVeniceDepositModal", () => ({ ManagedVeniceDepositModal: () => null }));

const PAID_PLAN = {
  subscribed: true, name: "Operator", key: "operator", maxAgents: 4, maxCpuPerAgent: 8, maxRamPerAgent: 16,
  poolCpu: 16, poolRam: 32, usage: { agentCount: 0, usedCpu: 0, usedRam: 0 },
};

function json(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

const writeText = jest.fn(async () => undefined);

beforeEach(() => {
  jest.clearAllMocks();
  process.env.NEXT_PUBLIC_HIVRA_LAUNCH_CATALOG = "1";
  aboutParam = null;
  useOrder = [];
  claimedPages = [];
  myClaims = {};
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/dashboard/launch");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  fetchPlanStrictMock.mockResolvedValue(PAID_PLAN);
  summaryMock.mockResolvedValue({ ok: true, summary: { wallets: {
    card: { balanceMicroUsd: 5_000_000, availableMicroUsd: 5_000_000, reservedMicroUsd: 0 },
    hermesos: { tokenDisplay: "0", lockedValueMicroUsd: 0, availableMicroUsd: 0, reservedMicroUsd: 0 },
  } } });
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/infrastructure/targets")) return json({ success: true, data: { targets: [] } });
    if (url === "/api/vault") return json({ success: true, data: [] });
    if (url === "/api/hivra/agents") return json({ success: true, data: { agents: [] } });
    if (url === "/api/instances?summary=true") return json({ success: true, data: [] });
    if (url === "/api/hivra/catalog/order") return json({ success: true, data: { order: useOrder } });
    if (url.startsWith("/api/hivra/catalog/claims?profile=")) {
      const profileId = url.split("=")[1];
      return json({ success: true, data: { claim: { profileId, claimed: claimedPages.includes(profileId), mine: myClaims[profileId] ?? null } } });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_HIVRA_LAUNCH_CATALOG;
  delete process.env.NEXT_PUBLIC_HIVRA_MAKER_CLAIMS;
});

async function openLaunch() {
  render(<LaunchJourney />);
  await screen.findByRole("heading", { name: "What do you want to launch?" });
}

const tile = (name: string) => screen.queryByRole("button", { name: new RegExp(`^${name}`) });

/** Waits for the history pop a Back press starts. */
async function popLands() {
  await act(async () => {
    await new Promise(resolve => window.addEventListener("popstate", resolve, { once: true }));
  });
}

describe("the catalog view of Launch", () => {
  it("stays out of the way while its switch is off", async () => {
    delete process.env.NEXT_PUBLIC_HIVRA_LAUNCH_CATALOG;
    await openLaunch();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    fireEvent.click(tile("Codex")!);
    expect(screen.getByRole("heading", { name: /^Review and launch Codex/ })).toBeInTheDocument();
  });

  it("narrows the tiles as the owner searches, and says so when nothing matches", async () => {
    await openLaunch();
    const box = screen.getByRole("searchbox", { name: "Search agents and computers" });

    fireEvent.change(box, { target: { value: "coding" } });
    expect(tile("Claude Code")).toBeInTheDocument();
    expect(tile("Codex")).toBeInTheDocument();
    expect(tile("OpenClaw")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "A computer" })).not.toBeInTheDocument();

    fireEvent.change(box, { target: { value: "spreadsheet" } });
    expect(screen.getByRole("status")).toHaveTextContent("Nothing matches.");
    fireEvent.click(screen.getByRole("button", { name: "show everything" }));
    expect(tile("OpenClaw")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "A computer" })).toBeInTheDocument();
  });

  it("filters by kind and by job", async () => {
    await openLaunch();
    fireEvent.click(screen.getByRole("button", { name: /^Computers/ }));
    expect(screen.queryByRole("heading", { name: "An agent" })).not.toBeInTheDocument();
    expect(tile("Ubuntu Desktop")).toBeInTheDocument();
    // Jobs describe agents, so they step aside for computers.
    expect(screen.queryByRole("heading", { name: "Browse by job" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    const messages = screen.getByRole("button", { name: /^Messages/ });
    fireEvent.click(messages);
    expect(messages).toHaveAttribute("aria-pressed", "true");
    expect(tile("OpenClaw")).toBeInTheDocument();
    expect(tile("Codex")).not.toBeInTheDocument();
    fireEvent.click(messages);
    expect(tile("Codex")).toBeInTheDocument();
  });

  it("opens a page for an agent before Review, and Back returns to the list", async () => {
    await openLaunch();
    fireEvent.click(tile("Codex")!);

    const page = within(screen.getByTestId("launch-catalog-page"));
    expect(page.getByRole("heading", { name: "Codex" })).toHaveFocus();
    expect(page.getByText("Agent · Coding")).toBeInTheDocument();
    const about = within(page.getByRole("group", { name: "About Codex" }));
    expect(about.getByText("OpenAI")).toBeInTheDocument();
    expect(about.getByText("Hivra credits, your own key or your own ChatGPT login")).toBeInTheDocument();
    expect(about.getByRole("link", { name: /Open/ })).toHaveAttribute("href", "https://github.com/openai/codex");
    // Others for the same job are a press away.
    expect(page.getByRole("button", { name: /^Claude Code/ })).toBeInTheDocument();

    fireEvent.click(page.getByRole("button", { name: "Copy the task “Fix a failing test”" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Run the tests in this repository."));
    expect(await page.findByText("Copied")).toBeInTheDocument();

    fireEvent.click(page.getByRole("button", { name: /Everything you can launch/ }));
    await popLands();
    expect(screen.getByRole("heading", { name: "What do you want to launch?" })).toBeInTheDocument();
    expect(screen.queryByTestId("launch-catalog-page")).not.toBeInTheDocument();
  });

  it("goes from a page to Review, and Back from Review returns to that page", async () => {
    await openLaunch();
    fireEvent.click(tile("Codex")!);
    fireEvent.click(screen.getByTestId("launch-catalog-review"));
    expect(screen.getByRole("heading", { name: /^Review and launch Codex/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await popLands();
    await waitFor(() => expect(screen.getByTestId("launch-catalog-page")).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Codex" })).toBeInTheDocument();
  });

  it("shows a computer's picture, and no first tasks or maker", async () => {
    await openLaunch();
    fireEvent.click(tile("Ubuntu Desktop")!);
    const page = within(screen.getByTestId("launch-catalog-page"));
    expect(page.getByText("Computer")).toBeInTheDocument();
    expect(page.getByRole("img", { name: "An Ubuntu desktop on a monitor" })).toHaveAttribute("src", "/images/computers/ubuntu-workspace.webp");
    expect(page.queryByText("Made by")).not.toBeInTheDocument();
    expect(page.queryByRole("heading", { name: "Good first tasks" })).not.toBeInTheDocument();
  });

  it("keeps claiming off the page while maker claims are not turned on", async () => {
    await openLaunch();
    fireEvent.click(tile("Codex")!);
    const about = within(screen.getByRole("group", { name: "About Codex" }));
    expect(about.getByText("Hivra wrote this page and is independent of OpenAI.")).toBeInTheDocument();
    expect(about.queryByRole("link", { name: "Are you the maker?" })).not.toBeInTheDocument();
    const asked = (global.fetch as jest.Mock).mock.calls.map(([input]) => String(input));
    expect(asked.some(url => url.includes("/api/hivra/catalog/claims"))).toBe(false);
  });

  it("offers the maker a way to claim the page, and says once it is claimed", async () => {
    process.env.NEXT_PUBLIC_HIVRA_MAKER_CLAIMS = "1";
    await openLaunch();
    fireEvent.click(tile("Codex")!);
    let about = within(screen.getByRole("group", { name: "About Codex" }));
    expect(about.getByRole("link", { name: "Are you the maker?" })).toHaveAttribute("href", "/dashboard/makers/codex");
    expect(about.getByText("Hivra wrote this page and is independent of OpenAI.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Everything you can launch/ }));
    await popLands();
    claimedPages = ["openclaw"];
    myClaims = { openclaw: { status: "verified" } };
    fireEvent.click(tile("OpenClaw")!);
    about = within(screen.getByRole("group", { name: "About OpenClaw" }));
    expect(await about.findByText("Hivra wrote this page. Its maker has claimed it.")).toBeInTheDocument();
    expect(about.getByRole("link", { name: "Your maker page" })).toHaveAttribute("href", "/dashboard/makers/openclaw");
  });

  it("lists what more people use first once the order is known", async () => {
    useOrder = ["openclaw", "codex"];
    await openLaunch();
    const agents = within(screen.getByRole("region", { name: "An agent" }));
    expect(await agents.findByText(/The ones more people use come first\./)).toBeInTheDocument();
    const names = agents.getAllByRole("button").map(button => button.querySelector("strong")?.textContent).filter(Boolean);
    expect(names.slice(0, 3)).toEqual(["OpenClaw", "Codex", "Claude Code"]);
  });

  it("keeps the fixed order while nothing is known about use", async () => {
    await openLaunch();
    const agents = within(screen.getByRole("region", { name: "An agent" }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith("/api/hivra/catalog/order", expect.anything()));
    expect(agents.queryByText(/come first/)).not.toBeInTheDocument();
    const names = agents.getAllByRole("button").map(button => button.querySelector("strong")?.textContent).filter(Boolean);
    expect(names.slice(0, 2)).toEqual(["Claude Code", "Codex"]);
  });

  it("opens the page a link names", async () => {
    aboutParam = "openclaw";
    render(<LaunchJourney />);
    const page = within(await screen.findByTestId("launch-catalog-page"));
    expect(page.getByRole("heading", { name: "OpenClaw" })).toBeInTheDocument();
    expect(page.getByText("Agent · Messages")).toBeInTheDocument();
  });
});

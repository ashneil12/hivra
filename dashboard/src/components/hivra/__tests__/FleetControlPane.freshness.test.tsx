/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";

import { useRecordVisit } from "@/components/workspace/useRecordVisit";
import { resetResourceInventory, resourceInventory } from "@/lib/workspace/resource-inventory";
import { listRecents, recordVisit } from "@/lib/workspace/recents";

import { FleetControlPane } from "../FleetControlPane";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn(), prefetch: jest.fn() }),
}));
jest.mock("@/lib/workspace/app-open", () => ({
  isAppOpenAtHome: () => false,
  markHomeOpened: () => undefined,
}));

/**
 * Home against the real shared list of agents and computers, not a stand-in:
 * the list is reused between pages, so what Home offers depends on when it
 * was read.
 */

const MINUTE = 60_000;
const row = (id: string, name: string) => ({ id, name, type: "codex", status: "running", cpu: 2, ram: 4 });

let listed: unknown[];
const fetchMock = jest.fn(async (url: string) => ({
  ok: true,
  json: async () => url.startsWith("/api/instances")
    ? { success: true, data: [] }
    : { success: true, data: { agents: listed } },
}));
const listReads = () => fetchMock.mock.calls.filter(([url]) => url === "/api/hivra/agents").length;

let clock: number;
let now: jest.SpyInstance;

beforeEach(() => {
  resetResourceInventory();
  window.localStorage.clear();
  fetchMock.mockClear();
  global.fetch = fetchMock as unknown as typeof fetch;
  clock = 1_800_000_000_000;
  now = jest.spyOn(Date, "now").mockImplementation(() => clock);
  listed = [row("codex", "CODEX_AGENT")];
});

afterEach(() => {
  now.mockRestore();
  resetResourceInventory();
});

async function holdTheList() {
  await Promise.all([resourceInventory.load("hermes"), resourceInventory.load("hivra")]);
  expect(listReads()).toBe(1);
}

it("does not offer an agent deleted since its list was read, even moments later", async () => {
  await holdTheList();
  recordVisit("x-codex", "chat");
  // Deleted on its page, and Home opened straight after.
  listed = [];
  clock += 2_000;

  render(<FleetControlPane requested />);
  // Not even before the list is read again: that is a link to "Agent not found."
  expect(screen.queryByTestId("home-continue")).not.toBeInTheDocument();
  expect(screen.queryByText("CODEX_AGENT")).not.toBeInTheDocument();

  await waitFor(() => expect(screen.getByText("Choose an agent to work with, or a computer of your own.")).toBeInTheDocument());
  expect(listReads()).toBe(2);
  expect(screen.queryByTestId("home-continue")).not.toBeInTheDocument();
  expect(screen.queryByText("CODEX_AGENT")).not.toBeInTheDocument();
});

it("does not offer a stale list's agent while the new read is in flight", async () => {
  await holdTheList();
  recordVisit("x-codex", "chat");
  listed = [];
  clock += 20_000;

  render(<FleetControlPane requested />);
  expect(screen.queryByTestId("home-continue")).not.toBeInTheDocument();
  await waitFor(() => expect(listReads()).toBe(2));
  await waitFor(() => expect(screen.getByText("Choose an agent to work with, or a computer of your own.")).toBeInTheDocument());
  expect(screen.queryByTestId("home-continue")).not.toBeInTheDocument();
});

it("still offers a running agent once the list read since opening lists it", async () => {
  await holdTheList();
  recordVisit("x-codex", "box");
  render(<FleetControlPane requested />);
  expect(await screen.findByTestId("home-continue")).toHaveAttribute("href", "/dashboard/agent/codex?tab=box");
  expect(listReads()).toBe(2);
});

function AgentPageProbe({ uid }: { uid: string }) {
  useRecordVisit(uid, "chat");
  return <p>Working in {uid}</p>;
}

function App({ at }: { at: string | null }) {
  return at ? <AgentPageProbe uid={at} /> : <FleetControlPane requested />;
}

// Two browser tabs: A stays open while B is opened and closed in the other.
// Back in A for two hours, then Home: Continue is A, the one just left.
it("offers the agent you were just working in, not the one opened last", async () => {
  listed = [row("agent_a", "AGENT_A"), row("agent_b", "AGENT_B")];
  const view = render(<App at="x-agent_a" />);
  clock += 5 * MINUTE;
  recordVisit("x-agent_b", "chat");
  clock += 115 * MINUTE;

  view.rerender(<App at={null} />);

  expect(listRecents().map((visit) => visit.uid)).toEqual(["x-agent_a", "x-agent_b"]);
  const card = await screen.findByTestId("home-continue");
  expect(card).toHaveTextContent("AGENT_A");
  expect(card).toHaveTextContent("used just now");
});

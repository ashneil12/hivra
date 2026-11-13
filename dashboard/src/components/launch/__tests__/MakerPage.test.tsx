/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { CatalogClaimView } from "@/lib/hivra/catalog-claim-types";

import { MakerPage } from "../MakerPage";

const LINE = "hivra-claim=0123456789abcdef0123456789abcdef";
const UNCLAIMED: CatalogClaimView = {
  profileId: "openclaw", name: "OpenClaw", repo: "openclaw/openclaw", filePath: ".well-known/hivra.txt",
  claimed: false, mine: null, numbers: null,
};
const PENDING: CatalogClaimView = {
  ...UNCLAIMED, mine: { status: "pending", line: LINE, lastCheck: null, checkedAt: null, verifiedAt: null },
};
const VERIFIED: CatalogClaimView = {
  ...UNCLAIMED,
  claimed: true,
  mine: { status: "verified", line: LINE, lastCheck: "verified", checkedAt: "2026-11-13T12:00:00.000Z", verifiedAt: "2026-11-13T12:00:00.000Z" },
  numbers: { days: 30, people: 1204, launches: 214, activeHours: 1220, runningNow: 61, twoWeekLaunches: 200, twoWeekKept: 122 },
};

function reply(claim: CatalogClaimView | null, status = 200): Response {
  return { ok: status === 200, status, json: async () => (claim ? { success: true, data: { claim } } : { success: false }) } as Response;
}

const writeText = jest.fn(async () => undefined);
const fetchMock = jest.fn();
const posted = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(init.body as string));

beforeEach(() => {
  jest.clearAllMocks();
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

describe("a maker's page", () => {
  it("explains the claim, then gives the maker a line and where to put it", async () => {
    fetchMock.mockResolvedValueOnce(reply(UNCLAIMED)).mockResolvedValueOnce(reply(PENDING));
    render(<MakerPage profileId="openclaw" />);

    const heading = await screen.findByRole("heading", { level: 1, name: "Do you make OpenClaw?" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(fetchMock).toHaveBeenCalledWith("/api/hivra/catalog/claims?profile=openclaw", expect.objectContaining({ cache: "no-store" }));
    expect(screen.getByText(/add to a file in github\.com\/openclaw\/openclaw/)).toBeInTheDocument();
    expect(screen.getByText("When Hivra turns on maker earnings, they go to whoever holds the claim.")).toBeInTheDocument();
    expect(screen.getByText("It comes from use. It cannot be bought or edited.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /OpenClaw's page/ })).toHaveAttribute("href", "/dashboard/launch?start=1&about=openclaw");

    fireEvent.click(screen.getByRole("button", { name: /Get my line/ }));
    const steps = within(await screen.findByRole("group", { name: "How to prove it" }));
    expect(posted()).toEqual([{ profile: "openclaw", action: "start" }]);
    expect(steps.getByText(".well-known/hivra.txt")).toBeInTheDocument();
    expect(steps.getByText(/On the default branch of github\.com\/openclaw\/openclaw/)).toBeInTheDocument();
    expect(steps.getByText(LINE)).toBeInTheDocument();
    expect(steps.getByRole("status")).toHaveTextContent("Not checked yet");

    fireEvent.click(steps.getByRole("button", { name: "Copy the line" }));
    expect(writeText).toHaveBeenCalledWith(LINE);
    expect(await steps.findByText("Copied")).toBeInTheDocument();
  });

  it("says what a check found, and keeps the claim open until the line is there", async () => {
    fetchMock
      .mockResolvedValueOnce(reply(PENDING))
      .mockResolvedValueOnce(reply({ ...PENDING, mine: { ...PENDING.mine!, lastCheck: "file_missing" } }))
      .mockResolvedValueOnce(reply({ ...PENDING, mine: { ...PENDING.mine!, lastCheck: "line_missing" } }))
      .mockResolvedValueOnce(reply(null, 500));
    render(<MakerPage profileId="openclaw" />);
    const check = await screen.findByRole("button", { name: /Check now/ });

    fireEvent.click(check);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Not found yet"));
    expect(posted()).toEqual([{ profile: "openclaw", action: "check" }]);

    fireEvent.click(check);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("The file is there, but this line is not in it"));

    fireEvent.click(check);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not check just now.");
    expect(screen.getByRole("heading", { level: 1, name: "Do you make OpenClaw?" })).toBeInTheDocument();
  });

  it("turns into the maker's numbers once the claim is proven", async () => {
    fetchMock.mockResolvedValueOnce(reply(PENDING)).mockResolvedValueOnce(reply(VERIFIED));
    render(<MakerPage profileId="openclaw" />);
    fireEvent.click(await screen.findByRole("button", { name: /Check now/ }));

    const heading = await screen.findByRole("heading", { level: 1, name: "OpenClaw" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText("Claimed by you")).toBeInTheDocument();

    const numbers = within(screen.getByRole("group", { name: "OpenClaw in the last 30 days" }));
    expect(numbers.getByText("1,204")).toBeInTheDocument();
    expect(numbers.getByText("214")).toBeInTheDocument();
    expect(numbers.getByText("61%")).toBeInTheDocument();
    expect(numbers.getByText("122 of 200 launched earlier.")).toBeInTheDocument();
    expect(numbers.getByText("1,220")).toBeInTheDocument();
    expect(numbers.getByText("61")).toBeInTheDocument();

    const earnings = within(screen.getByRole("group", { name: "Earnings" }));
    expect(earnings.getByText("Not turned on yet")).toBeInTheDocument();
    expect(earnings.getByText("1,220")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Check now/ })).not.toBeInTheDocument();
  });

  it("gives a launch button that opens the agent's page on this site", async () => {
    fetchMock.mockResolvedValueOnce(reply(VERIFIED));
    render(<MakerPage profileId="openclaw" />);
    await screen.findByRole("heading", { level: 1, name: "OpenClaw" });

    const snippet = "[![Launch on Hivra](http://localhost/images/launch-on-hivra.svg)](http://localhost/dashboard/launch?start=1&about=openclaw)";
    expect(screen.getByText(snippet)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Launch on Hivra" })).toHaveAttribute("src", "/images/launch-on-hivra.svg");
    fireEvent.click(screen.getByRole("button", { name: "Copy the launch button" }));
    expect(writeText).toHaveBeenCalledWith(snippet);
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  it("does not guess a share of agents kept before any has had two weeks", async () => {
    fetchMock.mockResolvedValueOnce(reply({ ...VERIFIED, numbers: { ...VERIFIED.numbers!, twoWeekLaunches: 0, twoWeekKept: 0 } }));
    render(<MakerPage profileId="openclaw" />);
    expect(await screen.findByText("Not enough launches yet")).toBeInTheDocument();
    expect(screen.queryByText(/%$/)).not.toBeInTheDocument();
  });

  it("offers another try when the page cannot be loaded", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(reply(UNCLAIMED));
    render(<MakerPage profileId="openclaw" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load this page.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Do you make OpenClaw?" })).toBeInTheDocument();
  });
});

/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { findBannedClaims } from "@/lib/tools/copy-rules";
import StatusPageContent from "../StatusPageContent.client";

type Outcome = { ok: boolean; status?: number } | "reject";

// Drive each surface probe by the path it requests so a single mock can make
// one surface fail while the rest stay healthy.
function mockFetchBy(handler: (path: string) => Outcome) {
  const fetchMock = jest.fn((input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : String(input);
    const outcome = handler(path);
    if (outcome === "reject") return Promise.reject(new Error("network down"));
    return Promise.resolve({
      ok: outcome.ok,
      status: outcome.status ?? (outcome.ok ? 200 : 500),
    });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("StatusPageContent", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("marks every public surface Operational when all probes succeed", async () => {
    mockFetchBy(() => ({ ok: true }));

    render(<StatusPageContent />);

    const operational = await screen.findAllByText("Operational");
    expect(operational).toHaveLength(4);
    expect(screen.getByText("Public pages operational")).toBeInTheDocument();
  });

  it("marks a surface Degraded on a non-2xx response while the rest stay Operational", async () => {
    mockFetchBy((path) => (path === "/sign-in" ? { ok: false, status: 404 } : { ok: true }));

    render(<StatusPageContent />);

    expect(await screen.findByText("Degraded")).toBeInTheDocument();
    expect(screen.getByText("Some public pages degraded")).toBeInTheDocument();
    expect(screen.getAllByText("Operational")).toHaveLength(3);
  });

  it("marks a surface Down when its probe fails and says a public page is not responding", async () => {
    mockFetchBy((path) => (path === "/" ? "reject" : { ok: true }));

    render(<StatusPageContent />);

    expect(await screen.findByText("Down")).toBeInTheDocument();
    expect(screen.getByText("A public page is not responding")).toBeInTheDocument();
  });

  it("shows a checking state before the probes resolve (never blocks render)", () => {
    jest.useFakeTimers();
    // A probe that never settles keeps the page in its initial checking state.
    global.fetch = jest.fn(() => new Promise(() => {})) as unknown as typeof fetch;

    render(<StatusPageContent />);

    expect(screen.getByText("Checking public pages…")).toBeInTheDocument();
  });

  it("re-runs every probe when Re-run checks is clicked", async () => {
    const fetchMock = mockFetchBy(() => ({ ok: true }));

    render(<StatusPageContent />);

    await screen.findAllByText("Operational");
    expect(fetchMock).toHaveBeenCalledTimes(4);

    fireEvent.click(screen.getByRole("button", { name: /re-run checks/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(8));
  });

  it("writes everything the page says without em or en dashes", async () => {
    mockFetchBy(() => ({ ok: true }));

    const { container } = render(<StatusPageContent />);
    await screen.findAllByText("Operational");

    expect(container.textContent).toContain("Checks run in your browser against public pages only.");
    expect(container.textContent).not.toMatch(/[\u2013\u2014]/);
  });

  it("issues unauthenticated, no-store GETs for the public surfaces", async () => {
    const fetchMock = mockFetchBy(() => ({ ok: true }));

    render(<StatusPageContent />);
    await screen.findAllByText("Operational");

    const paths = fetchMock.mock.calls.map((c) => c[0]);
    expect(paths).toEqual(expect.arrayContaining(["/", "/sign-in", "/get-started", "/changelog"]));
    const [, init] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit?];
    expect(init).toMatchObject({ method: "GET", cache: "no-store", credentials: "omit" });
  });

  it("carries the md heading, introduction, closing words and links under one h1", async () => {
    mockFetchBy(() => ({ ok: true }));

    render(<StatusPageContent />);
    await screen.findAllByText("Operational");

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "How Hivra is running." })).toBeInTheDocument();
    expect(
      screen.getByText(/^This page reflects the current health of Hivra.s public pages, checked live from your browser\./),
    ).toBeInTheDocument();
    expect(
      screen.getByText("We would rather explain a disruption plainly than hide it behind a vague uptime percentage."),
    ).toBeInTheDocument();
    expect(screen.getByText(/^Need help with a specific agent\?/)).toHaveTextContent(
      "Need help with a specific agent? Contact info@hivra.cloud and include the identifier of the agent or computer and the approximate time of the problem. Never include credentials or private keys in a support message.",
    );
    expect(screen.getByRole("link", { name: "info@hivra.cloud" })).toHaveAttribute("href", "mailto:info@hivra.cloud");
    expect(screen.getByRole("link", { name: "Return to Hivra" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Security reporting" })).toHaveAttribute("href", "/security");
  });

  it("states what the page does, not an incident process it does not have", async () => {
    mockFetchBy(() => ({ ok: true }));

    const { container } = render(<StatusPageContent />);
    await screen.findAllByText("Operational");

    // There is no incident feed behind this page, so it names no incident list or history.
    expect(screen.queryByRole("heading", { name: /incidents|history/i })).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/no (?:current )?incidents|we.ll describe/i);
    expect(container.textContent).toContain(
      "A page that answers slowly or with an error is marked Degraded, and one that does not answer is marked Down.",
    );
  });

  it("never says the systems are fine before a check has answered", () => {
    jest.useFakeTimers();
    global.fetch = jest.fn(() => new Promise(() => {})) as unknown as typeof fetch;

    const { container } = render(<StatusPageContent />);

    expect(screen.getByRole("heading", { level: 1, name: "How Hivra is running." })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/operational|operating normally/i);
    expect(screen.getByText("Checking public pages…")).toBeInTheDocument();
  });

  it("shows the summary of a failing check beside the md heading", async () => {
    mockFetchBy((path) => (path === "/changelog" ? "reject" : { ok: true }));

    render(<StatusPageContent />);

    expect(await screen.findByText("A public page is not responding")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "How Hivra is running." })).toBeInTheDocument();
  });

  it("lists the four checks in one labelled region inside the page's main landmark", async () => {
    mockFetchBy(() => ({ ok: true }));

    render(<StatusPageContent />);
    await screen.findAllByText("Operational");

    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
    const checks = screen.getByRole("region", { name: "Public surface status" });
    expect(screen.getByRole("main")).toContainElement(checks);
    for (const name of ["Website", "Sign-in page", "Get started", "Changelog"]) {
      expect(checks).toHaveTextContent(name);
    }
    // The row tests that the page loads, so it is named for the page, not for the sign-in service.
    expect(screen.getByRole("status", { name: "Sign-in page: Operational" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Website: Operational" })).toBeInTheDocument();
  });

  it("says what the checks cover and what they do not, and never claims the whole platform is fine", async () => {
    mockFetchBy(() => ({ ok: true }));

    const { container } = render(<StatusPageContent />);
    await screen.findAllByText("Operational");

    const summary = screen.getByText("Public pages operational").closest("div");
    expect(summary).toHaveTextContent(
      "The public pages listed below responded normally. This does not check agents, computers or whether sign-in works.",
    );
    // Four public pages are loaded from the browser: that cannot show agents, computers, billing or sign-in are healthy.
    expect(container.textContent).not.toMatch(/all systems|platform health|major outage|every public surface/i);
  });

  it("names a failing page in the summary, not a platform outage", async () => {
    mockFetchBy((path) => (path === "/sign-in" ? "reject" : { ok: true }));

    const { container } = render(<StatusPageContent />);

    expect(await screen.findByText("A public page is not responding")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/outage|all systems/i);
  });

  it("uses the glossary words, no dashes and no banned claims", async () => {
    mockFetchBy(() => ({ ok: true }));

    const { container } = render(<StatusPageContent />);
    await screen.findAllByText("Operational");

    const text = container.textContent ?? "";
    expect(text).not.toMatch(/\binstances?\b/i);
    expect(text).not.toMatch(/[\u2013\u2014]/);
    expect(findBannedClaims(text)).toEqual([]);
  });
});

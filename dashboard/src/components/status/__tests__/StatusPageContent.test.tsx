/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

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
    expect(screen.getByText("All systems operational")).toBeInTheDocument();
  });

  it("marks a surface Degraded on a non-2xx response while the rest stay Operational", async () => {
    mockFetchBy((path) => (path === "/sign-in" ? { ok: false, status: 404 } : { ok: true }));

    render(<StatusPageContent />);

    expect(await screen.findByText("Degraded")).toBeInTheDocument();
    expect(screen.getByText("Some systems degraded")).toBeInTheDocument();
    expect(screen.getAllByText("Operational")).toHaveLength(3);
  });

  it("marks a surface Down when its probe fails and reports a major outage", async () => {
    mockFetchBy((path) => (path === "/" ? "reject" : { ok: true }));

    render(<StatusPageContent />);

    expect(await screen.findByText("Down")).toBeInTheDocument();
    expect(screen.getByText("Major outage")).toBeInTheDocument();
  });

  it("shows a checking state before the probes resolve (never blocks render)", () => {
    jest.useFakeTimers();
    // A probe that never settles keeps the page in its initial checking state.
    global.fetch = jest.fn(() => new Promise(() => {})) as unknown as typeof fetch;

    render(<StatusPageContent />);

    expect(screen.getByText("Checking systems…")).toBeInTheDocument();
  });

  it("re-runs every probe when Re-run checks is clicked", async () => {
    const fetchMock = mockFetchBy(() => ({ ok: true }));

    render(<StatusPageContent />);

    await screen.findAllByText("Operational");
    expect(fetchMock).toHaveBeenCalledTimes(4);

    fireEvent.click(screen.getByRole("button", { name: /re-run checks/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(8));
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
});

/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { StorageUsageBanner } from "../StorageUsageBanner";

function mockStorageFetch(data: unknown, ok = true) {
  const fetchMock = jest.fn().mockResolvedValue({
    ok,
    json: async () => ({ success: true, data }),
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("StorageUsageBanner", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("renders an amber warning at the warn level", async () => {
    mockStorageFetch({ level: "warn", percent: 83.3 });

    render(<StorageUsageBanner instanceId="inst-1" />);

    expect(await screen.findByText(/running low on storage/i)).toBeInTheDocument();
    expect(screen.getByText(/using 83% of its disk/i)).toBeInTheDocument();
  });

  it("renders a stronger red banner at the critical level", async () => {
    mockStorageFetch({ level: "critical", percent: 96.7 });

    render(<StorageUsageBanner instanceId="inst-2" />);

    expect(await screen.findByText(/storage almost full/i)).toBeInTheDocument();
    expect(screen.getByText(/using 97% of its disk/i)).toBeInTheDocument();
  });

  it("clamps an impossible >100% percent to 100% in the copy", async () => {
    // Defense-in-depth: even if a bad denominator ever yields 198%, a disk can
    // never be more than 100% full, so the user must never see "198%".
    mockStorageFetch({ level: "critical", percent: 197.6 });

    render(<StorageUsageBanner instanceId="inst-clamp" />);

    expect(await screen.findByText(/using 100% of its disk/i)).toBeInTheDocument();
    expect(screen.queryByText(/198%|197%/)).not.toBeInTheDocument();
  });

  it("renders nothing when usage is ok", async () => {
    mockStorageFetch({ level: "ok", percent: 12 });

    const { container } = render(<StorageUsageBanner instanceId="inst-3" />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it("can be dismissed", async () => {
    mockStorageFetch({ level: "warn", percent: 85 });

    render(<StorageUsageBanner instanceId="inst-4" />);

    expect(await screen.findByText(/running low on storage/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /dismiss storage warning/i }));
    expect(screen.queryByText(/running low on storage/i)).not.toBeInTheDocument();
  });

  it("stays silent (and never throws) when the request fails", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;

    const { container } = render(<StorageUsageBanner instanceId="inst-5" />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("does not fetch when no instanceId is provided", () => {
    const fetchMock = mockStorageFetch({ level: "warn", percent: 90 });

    render(<StorageUsageBanner instanceId="" />);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

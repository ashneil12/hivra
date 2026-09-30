/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { SwitchAccessStep } from "../SwitchAccessStep";

const refresh = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

function mockFetchFailure() {
  global.fetch = jest.fn().mockRejectedValue(new TypeError("network")) as unknown as typeof fetch;
}

function mockFetch(status: number, body: unknown) {
  const fetchMock = jest.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("SwitchAccessStep", () => {
  it("needs the confirmation before it can switch", () => {
    const fetchMock = mockFetch(200, { success: true });
    render(<SwitchAccessStep />);

    const button = screen.getByRole("button", { name: "Switch my access to $HIVRA" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Switching can't be undone/)).toBeInTheDocument();
    expect(screen.getByText(/you don't need to switch\. Your \$HermesOS access continues/)).toBeInTheDocument();
  });

  it("posts the convert action and refreshes the page on success", async () => {
    const fetchMock = mockFetch(200, { success: true, data: { convertedAt: "2026-10-02T00:00:00.000Z" } });
    render(<SwitchAccessStep />);

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Switch my access to $HIVRA" }));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/billing/token-access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "convert" }),
    });
  });

  it("shows the server's reason and does not refresh when the switch fails", async () => {
    mockFetch(503, {
      success: false,
      error: "The $HIVRA price is unavailable right now, so the switch can't lock your amounts. Try again in a few minutes.",
    });
    render(<SwitchAccessStep />);

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Switch my access to $HIVRA" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The $HIVRA price is unavailable right now");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes instead of erroring when another tab already switched (409)", async () => {
    mockFetch(409, { success: false, error: "This account has already switched to $HIVRA." });
    render(<SwitchAccessStep />);

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Switch my access to $HIVRA" }));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("treats a 200 with success:false as a failure", async () => {
    mockFetch(200, { success: false, error: "Nope." });
    render(<SwitchAccessStep />);

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Switch my access to $HIVRA" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Nope.");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("doesn't claim an outcome it can't know when the request fails in transit", async () => {
    mockFetchFailure();
    render(<SwitchAccessStep />);

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Switch my access to $HIVRA" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't confirm the switch. Reload this page to see whether it went through.");
    expect(refresh).not.toHaveBeenCalled();
  });
});

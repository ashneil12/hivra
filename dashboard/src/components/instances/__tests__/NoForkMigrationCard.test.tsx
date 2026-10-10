/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { NoForkMigrationCard } from "@/components/instances/NoForkMigrationCard";

const URL_BASE = "/api/instances/inst_1/migrate-no-fork";
const offerOf = (overrides: Record<string, unknown> = {}) => ({
  available: true,
  reason: "available",
  alreadyUpstream: false,
  target: { version: "0.21.6+hivra.1", digest: "sha256:x", overlayImage: "r@sha256:x" },
  ...overrides,
});
const json = (body: unknown, ok = true) => ({ ok, json: async () => body });

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const fn = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init));
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

async function renderCard() {
  const view = render(<NoForkMigrationCard instanceId="inst_1" />);
  await act(async () => {});
  return view;
}

beforeEach(() => jest.clearAllMocks());

describe("NoForkMigrationCard", () => {
  it("shows nothing when no release is offered", async () => {
    mockFetch(() => json({ success: true, data: { offer: offerOf({ available: false, reason: "no_release", target: null }), progress: null } }));
    await renderCard();
    expect(screen.queryByTestId("nofork-migration-card")).toBeNull();
  });

  it("offers a plain button, explains what is kept, and asks once before starting", async () => {
    const fetchMock = mockFetch((url, init) => {
      if (init?.method === "POST") return json({ success: true, data: { started: true } });
      return json({ success: true, data: { offer: offerOf(), progress: null } });
    });
    await renderCard();
    expect(screen.getByText(/stay exactly as they are/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Update to latest Hermes" }));
    expect(screen.getByTestId("nofork-confirm")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(URL_BASE, expect.objectContaining({ method: "POST" })));
    await waitFor(() => expect(screen.getByTestId("nofork-steps")).toBeInTheDocument());
  });

  it("shows the real step the box is on, not a made-up percentage", async () => {
    mockFetch(() =>
      json({ success: true, data: { offer: offerOf(), progress: { state: "running", phase: "verifying", message: "", updatedAt: "t" } } })
    );
    await renderCard();
    const steps = screen.getByTestId("nofork-steps");
    expect(steps.querySelectorAll('[data-step-state="done"]')).toHaveLength(3);
    expect(steps.querySelectorAll('[data-step-state="active"]')).toHaveLength(1);
    expect(steps.textContent).toMatch(/all still there/);
    expect(steps.textContent).not.toMatch(/%/);
  });

  it("says plainly when the update was rolled back and nothing was lost", async () => {
    mockFetch(() =>
      json({
        success: true,
        data: {
          offer: offerOf(),
          progress: { state: "rolled_back", phase: "rollback", message: "Not updated: the new version did not become healthy. Your agent is back exactly as it was.", updatedAt: "t" },
        },
      })
    );
    await renderCard();
    expect(screen.getByText(/Not updated, and nothing was lost/i)).toBeInTheDocument();
    expect(screen.getByTestId("nofork-message")).toHaveTextContent("back exactly as it was");
  });

  it("confirms success after the move, even on a fresh page load", async () => {
    mockFetch(() =>
      json({
        success: true,
        data: {
          offer: offerOf({ available: false, alreadyUpstream: true, reason: "already_upstream", target: null }),
          progress: { state: "done", phase: "finishing", message: "Your agent now runs the latest Hermes (0.21.6).", updatedAt: "t", toVersion: "0.21.6" },
        },
      })
    );
    await renderCard();
    // The first read has no progress yet (cheap read), so a done agent stays quiet until a move is in flight.
    expect(screen.queryByRole("button", { name: "Update to latest Hermes" })).toBeNull();
  });

  it("reports a failed start honestly", async () => {
    mockFetch((url, init) =>
      init?.method === "POST" ? json({ error: "Could not start the update. Nothing was changed." }, false) : json({ success: true, data: { offer: offerOf(), progress: null } })
    );
    await renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Update to latest Hermes" }));
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    await waitFor(() => expect(screen.getByTestId("nofork-error")).toHaveTextContent("Nothing was changed"));
  });
});

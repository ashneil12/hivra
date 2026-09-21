/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import WakePage from "../page";
import { auth } from "@clerk/nextjs/server";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("../WakeFlow", () => ({
  __esModule: true,
  default: ({ instanceId }: { instanceId: string }) => (
    <div data-testid="mock-wake-flow">{instanceId}</div>
  ),
}));

const INSTANCE_ID = "00000000-0000-4000-8000-000000001012";

describe("WakePage", () => {
  it("shows the asleep card with a returning sign-in CTA when signed out", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });

    const page = await WakePage({
      params: Promise.resolve({ instanceId: INSTANCE_ID }),
    });
    render(page);

    expect(screen.getByText(/this agent is asleep/i)).toBeInTheDocument();
    // The CTA must round-trip back to this exact wake page after sign-in.
    const cta = screen.getByRole("link", { name: /sign in to wake it/i });
    expect(cta).toHaveAttribute(
      "href",
      `/sign-in?redirect_url=${encodeURIComponent(`/wake/${INSTANCE_ID}`)}`,
    );
    // No instance details are fetched or leaked pre-auth.
    expect(screen.queryByTestId("mock-wake-flow")).not.toBeInTheDocument();
  });

  it("hands off to the wake flow for signed-in users", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_123" });

    const page = await WakePage({
      params: Promise.resolve({ instanceId: INSTANCE_ID }),
    });
    render(page);

    expect(screen.getByTestId("mock-wake-flow")).toHaveTextContent(INSTANCE_ID);
  });

  it("rejects malformed instance ids without echoing them anywhere", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });

    const page = await WakePage({
      params: Promise.resolve({ instanceId: "<script>alert(1)</script>" }),
    });
    render(page);

    expect(screen.getByText(/doesn't look right/i)).toBeInTheDocument();
    expect(screen.queryByTestId("mock-wake-flow")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /sign in/i })).not.toBeInTheDocument();
  });
});

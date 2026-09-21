/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import AuthFlowError from "../AuthFlowError";
import { captureClientOpsEvent } from "@/lib/client/ops-events";
import posthog from "posthog-js";

jest.mock("@/lib/client/ops-events", () => ({
  captureClientOpsEvent: jest.fn(() => Promise.resolve()),
}));

jest.mock("posthog-js", () => ({
  __esModule: true,
  default: {
    captureException: jest.fn(),
    get_session_id: jest.fn(() => "sess_auth_123"),
  },
}));

describe("AuthFlowError", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("captures the auth route failure and allows the user to retry", async () => {
    const unstable_retry = jest.fn();
    const error = new Error("Sign-up hydration failed");

    render(
      <AuthFlowError
        error={error}
        unstable_retry={unstable_retry}
        route="/sign-up"
        title="Something interrupted sign up."
        description="Retry this step to reload the sign-up flow."
        retryLabel="Retry sign up"
      />
    );

    expect(screen.getByText("Something interrupted sign up.")).toBeInTheDocument();
    expect(
      screen.getByText("Retry this step to reload the sign-up flow.")
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry sign up" }));
    expect(unstable_retry).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(posthog.captureException).toHaveBeenCalledWith(
        error,
        expect.objectContaining({
          source: "auth-error-boundary",
          route: "/sign-up",
          posthogSessionId: "sess_auth_123",
          exception_type: "Error",
          exception_message: "Sign-up hydration failed",
          $exception_type: "Error",
          $exception_message: "Sign-up hydration failed",
        })
      );
    });

    expect(captureClientOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "auth-error-boundary",
        title: "Auth flow render error",
        message: "Sign-up hydration failed",
        route: "/sign-up",
      })
    );
  });
});

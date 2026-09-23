/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const confirmSetup = jest.fn();

jest.mock("@stripe/stripe-js", () => ({
  loadStripe: jest.fn(() => Promise.resolve({})),
}));

jest.mock("@stripe/react-stripe-js", () => ({
  Elements: ({ children }: { children: React.ReactNode }) => <div data-testid="stripe-elements">{children}</div>,
  PaymentElement: () => <div data-testid="payment-element" />,
  useStripe: () => ({ confirmSetup }),
  useElements: () => ({}),
}));

// The component reads the publishable key when the module loads.
process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = "pk_test_123";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { FreeTierCardVerification } = require("../FreeTierCardVerification") as typeof import("../FreeTierCardVerification");

describe("FreeTierCardVerification", () => {
  beforeEach(() => {
    confirmSetup.mockReset();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { clientSecret: "seti_secret_123" } }),
    }) as unknown as typeof fetch;
  });

  it("renders nothing while closed", () => {
    render(<FreeTierCardVerification open={false} onClose={jest.fn()} onVerified={jest.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("is a portalled dialog with a 44px 'Close' that a stray backdrop tap cannot dismiss", async () => {
    const onClose = jest.fn();
    const { container } = render(
      <FreeTierCardVerification open message="Add a card to launch." onClose={onClose} onVerified={jest.fn()} />
    );

    const dialog = screen.getByRole("dialog", { name: "Card verification required" });
    expect(container).not.toContainElement(dialog);
    expect(dialog).toHaveAccessibleDescription("Add a card to launch.");
    expect(await screen.findByTestId("payment-element")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("presentation"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("creates a setup intent and verifies the card, then offers a retry", async () => {
    jest.useFakeTimers();
    const onVerified = jest.fn().mockResolvedValue(undefined);
    confirmSetup.mockResolvedValue({});
    render(<FreeTierCardVerification open onClose={jest.fn()} onVerified={onVerified} />);

    expect(global.fetch).toHaveBeenCalledWith("/api/billing/setup-intent", expect.objectContaining({ method: "POST" }));
    const verify = await screen.findByRole("button", { name: "Verify Card" });
    await act(async () => {
      fireEvent.click(verify);
    });
    expect(confirmSetup).toHaveBeenCalledWith(expect.objectContaining({ redirect: "if_required" }));
    expect(screen.getByRole("status")).toHaveTextContent(/card verification accepted/i);

    await act(async () => {
      jest.advanceTimersByTime(1500);
    });
    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: "Retry Deployment" })).toBeInTheDocument();
    jest.useRealTimers();
  });
});

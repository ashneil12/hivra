/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const confirmSetup = jest.fn();

// What the token geo-policy says about this viewer (hooks/useTokenGeoAccess.ts).
let mockTokenGeo: { status: string; notice: string | null } = { status: "allowed", notice: null };
jest.mock("@/hooks/useTokenGeoAccess", () => ({
  useTokenGeoAccess: () => mockTokenGeo,
  tokenFeaturesShown: (access: { status: string }) => access.status === "allowed",
}));

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
    expect(screen.getByRole("status")).toHaveTextContent("Card verified. Launching again…");

    await act(async () => {
      jest.advanceTimersByTime(1500);
    });
    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1));
    // The only place this check opens is Launch, so it speaks Launch's words.
    expect(await screen.findByRole("button", { name: "Launch again" })).toBeInTheDocument();
    jest.useRealTimers();
  });

  // F13: the fine print pointed a new user at a token route they can't use
  // while crypto billing is switched off.
  describe("the fine print on the Launch card check", () => {
    const original = process.env.NEXT_PUBLIC_CRYPTO_BILLING_ENABLED;
    afterEach(() => {
      if (original === undefined) delete process.env.NEXT_PUBLIC_CRYPTO_BILLING_ENABLED;
      else process.env.NEXT_PUBLIC_CRYPTO_BILLING_ENABLED = original;
    });

    it("names no crypto or token route while crypto billing is off", async () => {
      delete process.env.NEXT_PUBLIC_CRYPTO_BILLING_ENABLED;
      render(<FreeTierCardVerification open onClose={jest.fn()} onVerified={jest.fn()} />);

      await screen.findByTestId("payment-element");
      const dialog = screen.getByRole("dialog", { name: "Card verification required" });
      expect(dialog).toHaveTextContent("This is a fraud-prevention card-on-file check for Free plan access.");
      expect(dialog.textContent).not.toMatch(/crypto|token|\$HermesOS/i);
    });

    it.each([
      ["a viewer the token geo-policy blocks", { status: "blocked", notice: "Token features aren't available to people in the United Kingdom." }],
      ["a viewer the server has not answered for yet", { status: "checking", notice: null }],
      ["a viewer whose geo check failed", { status: "unavailable", notice: null }],
    ])("names no crypto or token route to %s, even with crypto billing on", async (_name, access) => {
      process.env.NEXT_PUBLIC_CRYPTO_BILLING_ENABLED = "true";
      mockTokenGeo = access;
      try {
        render(<FreeTierCardVerification open onClose={jest.fn()} onVerified={jest.fn()} />);

        await screen.findByTestId("payment-element");
        const dialog = screen.getByRole("dialog", { name: "Card verification required" });
        expect(dialog).toHaveTextContent("This is a fraud-prevention card-on-file check for Free plan access.");
        expect(dialog.textContent).not.toMatch(/crypto|token|\$HermesOS/i);
      } finally {
        mockTokenGeo = { status: "allowed", notice: null };
      }
    });

    it("still offers token access as the alternative when crypto billing is on", async () => {
      process.env.NEXT_PUBLIC_CRYPTO_BILLING_ENABLED = "true";
      render(<FreeTierCardVerification open onClose={jest.fn()} onVerified={jest.fn()} />);

      await screen.findByTestId("payment-element");
      expect(screen.getByRole("dialog", { name: "Card verification required" }))
        .toHaveTextContent("Crypto/token access does not require this card flow.");
    });
  });
});

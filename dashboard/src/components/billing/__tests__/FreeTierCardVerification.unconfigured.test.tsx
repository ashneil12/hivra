/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

jest.mock("@stripe/stripe-js", () => ({ loadStripe: jest.fn() }));
jest.mock("@stripe/react-stripe-js", () => ({
  Elements: () => null,
  PaymentElement: () => null,
  useStripe: () => null,
  useElements: () => null,
}));

// No publishable key in this environment.
delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { FreeTierCardVerification } = require("../FreeTierCardVerification") as typeof import("../FreeTierCardVerification");

it("explains a missing Stripe key instead of showing a dead form, and still closes", () => {
  const onClose = jest.fn();
  global.fetch = jest.fn() as unknown as typeof fetch;
  render(<FreeTierCardVerification open onClose={onClose} onVerified={jest.fn()} />);

  expect(screen.getByRole("alert")).toHaveTextContent(/card verification is not configured yet/i);
  expect(screen.queryByRole("button", { name: /verify card/i })).not.toBeInTheDocument();
  expect(global.fetch).not.toHaveBeenCalled();

  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
});

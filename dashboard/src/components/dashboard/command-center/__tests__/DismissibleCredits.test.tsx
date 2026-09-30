/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

import { DismissibleCredits } from "../DismissibleCredits";

const props = {
  summary: null,
  loading: false,
  error: null,
  onTopUp: jest.fn(),
  onManage: jest.fn(),
};

describe("DismissibleCredits", () => {
  beforeEach(() => window.localStorage.clear());

  it("hides from the pocket's own header control and restores with Show credits", () => {
    render(<DismissibleCredits {...props} />);

    const pocket = screen.getByTestId("managed-venice-credits-pocket");
    const hide = screen.getByRole("button", { name: "Hide credits" });
    // The control lives inside the pocket header, not as an overlay beside it.
    expect(pocket).toContainElement(hide);

    fireEvent.click(hide);
    expect(screen.queryByTestId("managed-venice-credits-pocket")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("hivra_cc_credits_hidden")).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: /show credits/i }));
    expect(screen.getByTestId("managed-venice-credits-pocket")).toBeInTheDocument();
    expect(window.localStorage.getItem("hivra_cc_credits_hidden")).toBeNull();
  });

  it("stays hidden on a later visit", () => {
    window.localStorage.setItem("hivra_cc_credits_hidden", "1");
    render(<DismissibleCredits {...props} />);
    expect(screen.queryByTestId("managed-venice-credits-pocket")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /show credits/i })).toBeInTheDocument();
  });
});

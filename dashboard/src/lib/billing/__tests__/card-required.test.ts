import {
  DEFAULT_CARD_REQUIRED_MESSAGE,
  getApiErrorMessage,
  getCardRequiredMessage,
  isCardRequiredResponse,
} from "../card-required";

describe("card-required response helpers", () => {
  it("detects the abuse-gate card-required reason", () => {
    expect(isCardRequiredResponse({ success: false, reason: "card_required" })).toBe(true);
    expect(isCardRequiredResponse({ success: false, reason: "blocked" })).toBe(false);
    expect(isCardRequiredResponse(null)).toBe(false);
  });

  it("uses the API error message when one is present", () => {
    const response = {
      success: false,
      reason: "card_required",
      error: "Please add a card before provisioning.",
    };

    expect(getApiErrorMessage(response, "Deployment failed")).toBe(
      "Please add a card before provisioning."
    );
    expect(getCardRequiredMessage(response)).toBe("Please add a card before provisioning.");
  });

  it("falls back to safe default copy for malformed responses", () => {
    expect(getApiErrorMessage({ error: "   " }, "Deployment failed")).toBe("Deployment failed");
    expect(getCardRequiredMessage({ reason: "card_required" })).toBe(DEFAULT_CARD_REQUIRED_MESSAGE);
  });
});

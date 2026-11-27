import { PRICING_FAQ, visiblePricingFaq } from "../pricing-content";

describe("pricing FAQ once the Free plan is closed", () => {
  it("never mentions a free account in any answer", () => {
    for (const item of visiblePricingFaq(true, true)) {
      expect(item.a).not.toMatch(/free (Hivra )?account/i);
    }
  });

  it("keeps the original answers while the Free plan is open", () => {
    expect(visiblePricingFaq(true, false, true).map((item) => item.a)).toEqual(PRICING_FAQ.map((item) => item.a));
  });
});

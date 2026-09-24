/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render } from "@testing-library/react";

import TermsPage from "../page";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});
jest.mock("@/components/public-site/PublicSite", () => function MockPublicSite({ children }: { children: React.ReactNode }) {
  return <div>{children}</div>;
});

describe("/terms", () => {
  it("keeps the consumer-law clauses the legal review required", () => {
    const { container } = render(<TermsPage />);
    // Owner decision 2026-09-24: 7-day money-back guarantee on card payments.
    expect(container).toHaveTextContent("7-day money-back guarantee");
    // Consumer Contracts Regulations 2013: 14-day cancellation right, refunds within 14 days by the same means.
    expect(container).toHaveTextContent("legal right to cancel within 14 days");
    expect(container).toHaveTextContent("using the same payment method you paid with");
    // Consumer Rights Act 2015 s65: no exclusion of negligence liability for death or personal injury.
    expect(container).toHaveTextContent("death or personal injury caused by negligence");
    expect(container).toHaveTextContent("nothing in these Terms affects your legal rights");
    // Token payments are final only subject to statutory rights and failure to supply.
    expect(container).toHaveTextContent(/Payments in \$HermesOS are final, except where section 9 gives you a legal right to cancel/);
    // Truthfulness: shared hosts, and no stale refund window.
    expect(container).toHaveTextContent("They are not dedicated physical hardware.");
    expect(container).not.toHaveTextContent(/dedicated computing infrastructure/i);
    expect(container).not.toHaveTextContent(/48[- ]?(hour|hr)/i);
    // Every $HIVRA statement is labelled proposed.
    for (const paragraph of Array.from(container.querySelectorAll("p"))) {
      if (paragraph.textContent?.includes("$HIVRA")) expect(paragraph.textContent).toMatch(/propos/i);
    }
    expect(container).not.toHaveTextContent(/[–—]/);
  });
});

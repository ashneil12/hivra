/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";

import TermsPage from "../page";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

describe("/terms holder-compute disclosures", () => {
  it("discloses the placement cap, waitlist, nap and total save-to-disk timing", () => {
    render(<TermsPage />);

    const billing = screen.getByRole("heading", { name: "4. Subscription and Billing" }).parentElement as HTMLElement;
    expect(billing).toHaveTextContent("capped at 20% of CPU capacity and 20% of RAM capacity");
    expect(billing).toHaveTextContent("holders join a waitlist and hosted compute starts only after admission");
    expect(billing).toHaveTextContent("after 4 minutes idle they nap");
    expect(billing).toHaveTextContent("12 further minutes in nap (16 minutes total idle)");
    expect(billing).toHaveTextContent("memory is saved to disk and the computer stops");
  });
});

/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import fs from "fs";
import path from "path";
import React from "react";
import { render, screen, within } from "@testing-library/react";

import SecurityPage, { metadata } from "../page";
import { REPORT_INCLUDES, SECURITY_SECTIONS } from "../security-content";
import {
  GITHUB_PRIVATE_REPORT_URL,
  SECURITY_EMAIL,
  SECURITY_EMAIL_SUBJECT,
  SECURITY_MODEL_URL,
  SECURITY_POLICY_SOURCE_URL,
} from "@/lib/security-contact";
import { findBannedClaims } from "@/lib/tools/copy-rules";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

// The repository's own SECURITY.md is the source of truth for this page. A page
// that promises a different contact, or a stronger claim, than the policy in the
// repository is worse than no page.
const SECURITY_MD = fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", "..", "SECURITY.md"), "utf8");

describe("/security", () => {
  it("is indexable on its own URL", () => {
    expect(metadata.alternates?.canonical).toBe("https://hivra.cloud/security");
    expect(String(metadata.title)).not.toMatch(/\| Hivra$/);
    expect(String(metadata.description).length).toBeLessThanOrEqual(160);
    expect(`${metadata.title} ${metadata.description}`).not.toMatch(/[–—]/);
  });

  it("uses only the contacts that SECURITY.md already publishes: GitHub private reporting and the support address", () => {
    expect(SECURITY_MD).toContain(GITHUB_PRIVATE_REPORT_URL);
    expect(SECURITY_MD).toContain(SECURITY_EMAIL);
    expect(SECURITY_MD).toContain(SECURITY_EMAIL_SUBJECT);
    expect(SECURITY_EMAIL).toBe("info@hivra.cloud");

    render(<SecurityPage />);
    const region = screen.getByRole("region", { name: SECURITY_SECTIONS.report.heading });
    expect(within(region).getByRole("link", { name: "GitHub private vulnerability reporting" })).toHaveAttribute(
      "href",
      GITHUB_PRIVATE_REPORT_URL,
    );
    expect(within(region).getByRole("link", { name: `Email ${SECURITY_EMAIL} with the subject ${SECURITY_EMAIL_SUBJECT}` })).toHaveAttribute(
      "href",
      `mailto:${SECURITY_EMAIL}`,
    );
    // No other address is invented: the only email on the page is the published one.
    const { container } = render(<SecurityPage />);
    const emails = new Set((container.textContent ?? "").match(/[\w.+-]+@[\w-]+\.[\w.-]+/g));
    expect([...emails]).toEqual([SECURITY_EMAIL]);
  });

  it("lists what to include, and does not promise a response time", () => {
    render(<SecurityPage />);
    expect(REPORT_INCLUDES.length).toBeGreaterThanOrEqual(5);
    for (const item of REPORT_INCLUDES) expect(screen.getByText(item)).toBeInTheDocument();
    expect(screen.getByText(/No response-time promise is made/)).toBeInTheDocument();
    expect(SECURITY_MD).toContain("No response-time promise is made");
    expect(document.body.textContent).not.toMatch(/within \d+ (hours?|days?)|bug bounty|reward|safe harbou?r/i);
  });

  it("makes no isolation, encryption or key-handling claim: the security model is a target, and the page says so", () => {
    const { container } = render(<SecurityPage />);
    const text = container.textContent ?? "";
    expect(text).toContain("it does not claim that every control is already in place");
    expect(text).toContain("Hivra cannot guarantee that capable agents are harmless or that compromise is impossible");
    expect(text).not.toMatch(/encrypted at rest|end-to-end|zero[- ]knowledge|cannot read|can't read|military|bank-grade|SOC ?2|ISO ?27001|pen(etration)? test|audited/i);
    expect(findBannedClaims(text)).toEqual([]);
  });

  it("links the source documents and security.txt, with the GitHub links opening in a new tab", () => {
    render(<SecurityPage />);
    const region = screen.getByRole("region", { name: SECURITY_SECTIONS.links.heading });
    const policy = within(region).getByRole("link", { name: "Security policy (SECURITY.md)" });
    expect(policy).toHaveAttribute("href", SECURITY_POLICY_SOURCE_URL);
    expect(policy).toHaveAttribute("target", "_blank");
    expect(within(region).getByRole("link", { name: "Security model" })).toHaveAttribute("href", SECURITY_MODEL_URL);
    expect(within(region).getByRole("link", { name: "security.txt" })).toHaveAttribute("href", "/.well-known/security.txt");
  });

  it("has one H1 and WebPage markup tied to the homepage Organization", () => {
    const { container } = render(<SecurityPage />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const scripts = container.querySelectorAll('script[type="application/ld+json"]');
    expect(scripts).toHaveLength(1);
    const graph = JSON.parse(scripts[0].textContent ?? "{}")["@graph"] as Array<Record<string, unknown>>;
    const page = graph.find((node) => node["@type"] === "WebPage");
    expect(page?.url).toBe("https://hivra.cloud/security");
    expect(page?.publisher).toEqual({ "@id": "https://hivra.cloud/#organization" });
  });
});

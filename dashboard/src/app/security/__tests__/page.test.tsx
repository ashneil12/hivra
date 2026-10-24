/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import fs from "fs";
import path from "path";
import React from "react";
import { render, screen, within } from "@testing-library/react";

import SecurityPage, { metadata } from "../page";
import { SECURITY_COPY } from "../security-content";
import {
  GITHUB_PRIVATE_REPORT_URL,
  SECURITY_EMAIL,
  SECURITY_EMAIL_SUBJECT,
  SECURITY_MODEL_URL,
  SECURITY_POLICY_SOURCE_URL,
} from "@/lib/security-contact";
import { plainInline } from "@/lib/inline-copy";
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

const PAGE_TITLE = "Hivra Security | Vulnerability Reporting and Security Boundaries";
const PAGE_DESCRIPTION =
  "Report a Hivra vulnerability privately, learn which versions receive fixes and understand the limits of our agent security model.";

// The repository's own SECURITY.md is the source of truth for the contacts. A page that
// promises a different contact, or a stronger claim, than the policy in the repository
// is worse than no page.
const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..", "..");
const SECURITY_MD = fs.readFileSync(path.join(REPO_ROOT, "SECURITY.md"), "utf8");

function pageText(): string {
  const { container } = render(<SecurityPage />);
  return container.textContent ?? "";
}

describe("/security metadata", () => {
  it("uses the approved browser title once, with no brand suffix added by the layout", () => {
    expect(metadata.title).toEqual({ absolute: PAGE_TITLE });
    expect(metadata.description).toBe(PAGE_DESCRIPTION);
    expect(PAGE_DESCRIPTION.length).toBeLessThanOrEqual(160);
    expect(metadata.alternates?.canonical).toBe("https://hivra.cloud/security");
    expect(metadata.openGraph).toMatchObject({ title: PAGE_TITLE, description: PAGE_DESCRIPTION });
    expect(metadata.twitter).toMatchObject({ title: PAGE_TITLE, description: PAGE_DESCRIPTION });
    expect(`${PAGE_TITLE} ${PAGE_DESCRIPTION}`).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("/security reporting channels", () => {
  it("uses only contacts that SECURITY.md publishes: GitHub private reporting and the support address", () => {
    expect(SECURITY_MD).toContain(GITHUB_PRIVATE_REPORT_URL);
    expect(SECURITY_MD).toContain(SECURITY_EMAIL);
    expect(SECURITY_MD).toContain(SECURITY_EMAIL_SUBJECT);
    expect(SECURITY_EMAIL).toBe("info@hivra.cloud");
    expect(SECURITY_EMAIL_SUBJECT).toBe("[Hivra security]");
  });

  it("offers the private form and the email, each as a real link, with the subject convention shown", () => {
    render(<SecurityPage />);
    const region = screen.getByRole("region", { name: SECURITY_COPY.report.heading });
    const form = within(region).getByRole("link", { name: "Private reporting form" });
    expect(form).toHaveAttribute("href", GITHUB_PRIVATE_REPORT_URL);
    expect(form).toHaveAttribute("target", "_blank");
    expect(form).toHaveAttribute("rel", expect.stringContaining("noopener"));

    const email = within(region).getByRole("link", { name: SECURITY_EMAIL });
    const href = email.getAttribute("href") ?? "";
    expect(href.startsWith(`mailto:${SECURITY_EMAIL}`)).toBe(true);
    expect(decodeURIComponent(href)).toContain(`subject=${SECURITY_EMAIL_SUBJECT}`);
    expect(region.textContent).toContain(`with ${SECURITY_EMAIL_SUBJECT} in the subject line`);
  });

  it("invents no other address: the only email on the page is the published one", () => {
    const found = pageText().match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? [];
    // A sentence-ending full stop is not part of the address.
    const emails = new Set(found.map((address) => address.replace(/\.+$/, "")));
    expect([...emails]).toEqual([SECURITY_EMAIL]);
  });

  it("lists what to include as five numbered items and asks for no live credentials", () => {
    render(<SecurityPage />);
    const region = screen.getByRole("region", { name: SECURITY_COPY.report.heading });
    const items = within(region).getAllByRole("listitem").filter((item) => item.closest("ol"));
    expect(items).toHaveLength(5);
    expect(items.map((item) => item.querySelector("strong")?.textContent)).toEqual([
      "Where you found it.",
      "What happened.",
      "Why it matters.",
      "What you observed.",
      "How to reach you.",
    ]);
    expect(within(region).getByText(/Please do not send live private keys, passwords, session cookies/)).toBeInTheDocument();
  });

  it("promises no response time, bounty, safe harbour or certification", () => {
    const text = pageText();
    expect(text).toContain("We do not currently promise a fixed acknowledgement or remediation service level.");
    expect(text).not.toMatch(/within \d+ (hours?|days?)|bug bounty|reward|safe harbou?r|SOC ?2|ISO ?27001|certified|independently audited|pen(etration)? test/i);
    // SECURITY.md says the same thing in its own words: no response-time promise.
    expect(SECURITY_MD).toContain("No response-time promise is made");
  });
});

describe("/security claims", () => {
  it("states the limits of isolation, and keeps planned controls as goals", () => {
    const text = pageText();
    expect(text).toContain("not a guarantee that the agent itself is safe");
    expect(text).toContain("Those are product goals, not security guarantees available today.");
    for (const limit of SECURITY_COPY.model.limits) expect(text).toContain(limit);
    expect(screen.getAllByRole("listitem").length).toBeGreaterThanOrEqual(SECURITY_COPY.model.limits.length);
  });

  it("makes no encryption, zero-access or certification claim, and trips no shared banned claim", () => {
    const text = pageText();
    expect(text).not.toMatch(/encrypted at rest|end-to-end|zero[- ]knowledge|cannot read|can't read|military|bank-grade|zero access|no access to your/i);
    expect(findBannedClaims(text)).toEqual([]);
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });

  it("shows no implementer placeholder, and every GitHub link is the Hivra repository", () => {
    const { container } = render(<SecurityPage />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/\[(?:Link|Replace|Insert|Optional|Hivra security model)/i);
    const main = container.querySelector("main");
    const github = [...(main?.querySelectorAll("a[href^='https://github.com']") ?? [])].map((a) => a.getAttribute("href"));
    expect(github.length).toBeGreaterThanOrEqual(3);
    for (const href of github) expect(href).toMatch(/^https:\/\/github\.com\/ashneil12\/hivra\//);
  });
});

describe("/security source links", () => {
  it("links the policy, the model, security.txt and the two site pages, and only the GitHub links open a new tab", () => {
    render(<SecurityPage />);
    const region = screen.getByRole("region", { name: SECURITY_COPY.implementation.heading });
    const policy = within(region).getByRole("link", { name: /^Security policy \(\s*SECURITY\.md\s*\)$/ });
    expect(policy).toHaveAttribute("href", SECURITY_POLICY_SOURCE_URL);
    expect(policy).toHaveAttribute("target", "_blank");
    const model = within(region).getByRole("link", { name: "Hivra security model" });
    expect(model).toHaveAttribute("href", SECURITY_MODEL_URL);
    expect(model).toHaveAttribute("target", "_blank");
    const txt = within(region).getByRole("link", { name: /^\s*security\.txt\s*$/ });
    expect(txt).toHaveAttribute("href", "/.well-known/security.txt");
    expect(txt).not.toHaveAttribute("target");
    expect(within(region).getByRole("link", { name: "Why Hivra" })).toHaveAttribute("href", "/why-hivra");
    expect(within(region).getByRole("link", { name: "How Hivra works" })).toHaveAttribute("href", "/about");
  });

  it("points at files that exist in this repository", () => {
    expect(SECURITY_POLICY_SOURCE_URL.endsWith("/blob/main/SECURITY.md")).toBe(true);
    expect(SECURITY_MODEL_URL.endsWith("/blob/main/docs/SECURITY-MODEL.md")).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, "SECURITY.md"))).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, "docs", "SECURITY-MODEL.md"))).toBe(true);
    const route = path.join(__dirname, "..", "..", ".well-known", "security.txt", "route.ts");
    expect(fs.existsSync(route)).toBe(true);
  });

  it("ends with the contact line, using the same address", () => {
    render(<SecurityPage />);
    const region = screen.getByRole("region", { name: SECURITY_COPY.questions.heading });
    expect(within(region).getByRole("link", { name: SECURITY_EMAIL })).toHaveAttribute("href", `mailto:${SECURITY_EMAIL}`);
    expect(region.textContent).toContain("Please use the private reporting channel for anything that could put users or infrastructure at risk.");
  });
});

describe("/security structure", () => {
  it("has one H1 and WebPage markup tied to the homepage Organization", () => {
    const { container } = render(<SecurityPage />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Security matters more when software can act.");
    const scripts = container.querySelectorAll('script[type="application/ld+json"]');
    expect(scripts).toHaveLength(1);
    const graph = JSON.parse(scripts[0].textContent ?? "{}")["@graph"] as Array<Record<string, unknown>>;
    const page = graph.find((node) => node["@type"] === "WebPage");
    expect(page?.url).toBe("https://hivra.cloud/security");
    expect(page?.name).toBe(PAGE_TITLE);
    expect(page?.publisher).toEqual({ "@id": "https://hivra.cloud/#organization" });
  });

  it("renders every approved paragraph", () => {
    const text = pageText();
    const strings = [
      SECURITY_COPY.masthead.lede,
      ...SECURITY_COPY.position,
      SECURITY_COPY.report.intro,
      SECURITY_COPY.report.notPolished,
      SECURITY_COPY.report.credentials,
      ...SECURITY_COPY.report.testing.paragraphs,
      SECURITY_COPY.report.testing.responseTimes,
      ...SECURITY_COPY.versions.paragraphs,
      ...SECURITY_COPY.model.paragraphs,
      SECURITY_COPY.model.goals,
      SECURITY_COPY.implementation.intro,
    ].map(plainInline);
    for (const sentence of strings) expect(text).toContain(sentence);
  });
});

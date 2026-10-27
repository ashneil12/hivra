/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen, within } from "@testing-library/react";

import FeaturesPage from "../page";
import { plainText, renderInline, staysOnOneLine } from "../_components/Inline";

jest.mock("@/components/public-site/PublicSite", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock("next/link", () => {
  const MockLink = ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

describe("/features page", () => {
  it("opens with the headline, the lead and two clear next steps", () => {
    render(<FeaturesPage />);

    // The headline is about the computer, not the agent: only a paid computer stays on, and the lead says so.
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Give your agent a computer that stays on.");
    expect(screen.getByRole("heading", { level: 2, name: "Less time setting things up. More time getting things done." })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /See supported agents/ })).toHaveAttribute("href", "/agents");
    expect(screen.getByRole("link", { name: /Explore pricing/ })).toHaveAttribute("href", "/pricing");
    // The old quick-summary grid and shared price strip are gone.
    expect(screen.queryByText("What you get on day one")).not.toBeInTheDocument();
    expect(screen.queryByText(/Start Deploying|Deploy My Agent/)).not.toBeInTheDocument();
  });

  it("lists the six features in order, each as a numbered heading with its own link", () => {
    render(<FeaturesPage />);

    expect(screen.getByRole("heading", { level: 2, name: "Six things that make a difference" })).toBeInTheDocument();
    const items = screen.getAllByRole("heading", { level: 3 });
    expect(items.map((heading) => heading.textContent)).toEqual([
      "01. Memory that survives the session",
      "02. A browser that isn't tied to your laptop",
      "03. Work that starts on a schedule",
      "04. Several agents, without several hosting accounts",
      "05. No Docker knowledge required",
      "06. Keep OpenClaw or try Hermes",
    ]);
    const links: Array<[string, string]> = [
      ["Explore persistent memory", "/features/persistent-memory"],
      ["Explore browser automation", "/features/browser-automation"],
      ["Explore scheduled tasks", "/features/scheduled-tasks"],
      ["Explore multiple agents", "/features/multi-agent"],
      ["Explore managed hosting", "/features/no-docker-hosting"],
      ["Explore the OpenClaw option", "/features/openclaw-alternative"],
    ];
    for (const [name, href] of links) {
      expect(screen.getByRole("link", { name: new RegExp(name) })).toHaveAttribute("href", href);
    }
  });

  it("says plainly what the browser, schedule, memory and agents are and are not", () => {
    render(<FeaturesPage />);

    expect(screen.getByText(/Memory isn't perfect or automatic understanding\./)).toBeInTheDocument();
    expect(screen.getByText(/A hosted browser doesn't make those restrictions disappear\./)).toBeInTheDocument();
    expect(screen.getByText(/They are independent agents, not an automatically coordinated team\. Built-in orchestration belongs to Hivra's future plans\./)).toBeInTheDocument();
    expect(screen.getByText(/Migration isn't a one-click promise: configurations and integrations need checking\./)).toBeInTheDocument();
    expect(screen.getByText(/A paid Hivra Cloud computer stays on and is not paused for inactivity\./)).toBeInTheDocument();
    // The sentence sits in the lead under the headline, once, not again in the schedule item.
    expect(screen.getByText(/A paid Hivra Cloud computer stays on and is not paused for inactivity\./).textContent).toMatch(/^That's what Hivra provides\./);
    expect(screen.getByText(/Host OpenClaw on a paid Hivra computer, or choose Hermes, also on a paid Hivra computer/)).toBeInTheDocument();
  });

  it("states the hosting price from the plan facts and ends with the questions", () => {
    render(<FeaturesPage />);

    const price = screen.getByRole("heading", { level: 2, name: "What is included in the hosting price?" }).closest("section")!;
    // Each size sits in a no-wrap span, so the bold phrase is matched on its whole text, not on its own text nodes.
    const bold = (text: string) => (_content: string, element: Element | null) => element?.tagName === "STRONG" && element.textContent === text;
    expect(within(price).getByText(bold("$9.99 a month for 2 vCPU and 4 GB of RAM"))).toBeInTheDocument();
    expect(within(price).getByText(bold("$19.99 a month for 4 vCPU and 8 GB of RAM"))).toBeInTheDocument();
    // The canonical rule (owner decision 2026-10-21): every Hivra Cloud computer is paid, a free account connects its own.
    expect(price.textContent).toContain("Every computer that Hivra Cloud runs for you needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM. A free account works with a computer or server you connect yourself.");
    // No "supported paid" wording anywhere on the hub: it would imply a free or unsupported Hivra Cloud computer.
    expect(document.body.textContent).not.toMatch(/supported paid/i);
    expect(within(price).getByRole("link", { name: /Launch an agent/ })).toHaveAttribute("href", "/agents");
    expect(within(price).getByRole("link", { name: /See pricing/ })).toHaveAttribute("href", "/pricing");

    expect(screen.getByRole("heading", { level: 2, name: "Frequently asked questions" })).toBeInTheDocument();
    expect(screen.getAllByText(/\?$/, { selector: "summary" })).toHaveLength(4);
  });
});

describe("inline markup", () => {
  it("renders bold, code and links, and reads the same string back as plain text", () => {
    const text = "Use **bold**, `code` and a [link](/pricing) or an [outside link](https://example.com/x).";
    const { container } = render(<p>{renderInline(text)}</p>);

    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("code")?.textContent).toBe("code");
    expect(container.querySelector('a[href="/pricing"]')?.getAttribute("target")).toBeNull();
    const outside = container.querySelector('a[href="https://example.com/x"]');
    expect(outside?.getAttribute("target")).toBe("_blank");
    expect(outside?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(container.textContent).toBe(plainText(text));
    expect(plainText(text)).toBe("Use bold, code and a link or an outside link.");
  });

  it("keeps each size on one line in its own span, without changing a character of the text", () => {
    const text = "The sizes are **$19.99 a month for 4 vCPU and 8 GB of RAM** and 2 vCPU with 4 GB of RAM.";
    const { container } = render(<p>{renderInline(text)}</p>);
    expect([...container.querySelectorAll("span")].map((span) => span.textContent)).toEqual(["4 vCPU", "8 GB of RAM", "2 vCPU", "4 GB of RAM"]);
    // Ordinary spaces throughout: what a reader or a crawler gets is the sentence in the copy.
    expect(container.textContent).toBe(plainText(text));
    // The FAQ path does not split anything: its text is mirrored in the FAQPage JSON-LD.
    const answer = render(<p>{renderInline(text, { gloss: true })}</p>);
    expect(answer.container.querySelectorAll("span:not([data-gloss])")).toHaveLength(0);
    expect(answer.container.textContent).toBe(plainText(text));
  });

  it("keeps a short command on one line and lets a long one wrap", () => {
    expect(staysOnOneLine("hermes claw migrate")).toBe(true);
    expect(staysOnOneLine("--dry-run")).toBe(true);
    expect(staysOnOneLine("a-very-long-command-name --with --several --flags")).toBe(false);
  });

  it("keeps code inside a link label", () => {
    const { container } = render(<p>{renderInline("[`hermes claw migrate`](https://example.com)")}</p>);
    expect(container.querySelector("a code")?.textContent).toBe("hermes claw migrate");
    expect(plainText("[`hermes claw migrate`](https://example.com)")).toBe("hermes claw migrate");
  });
});

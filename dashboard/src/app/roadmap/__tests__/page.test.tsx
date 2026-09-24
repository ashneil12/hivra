/** @jest-environment jsdom */
/* eslint-disable @next/next/no-img-element */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen, within } from "@testing-library/react";

import RoadmapPage from "../page";
import { roadmapContent } from "@/lib/roadmap-content";

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

jest.mock("next/image", () => {
  const MockImage = ({ src, alt, ...rest }: { src: string; alt: string; [key: string]: unknown }) => (
    <img src={src} alt={alt} {...rest} />
  );
  MockImage.displayName = "MockImage";
  return MockImage;
});

jest.mock("@/components/InteractiveBackground", () => function MockInteractiveBackground() {
  return null;
});

jest.mock("@/components/theme-toggle", () => ({
  ThemeToggle: () => <button data-testid="theme-toggle">Theme</button>,
}));

jest.mock("framer-motion", () => {
  const motionOnlyProps = new Set([
    "initial",
    "animate",
    "exit",
    "whileInView",
    "transition",
    "viewport",
  ]);

  const createComponent = (tag: keyof React.JSX.IntrinsicElements) => {
    const MockMotionComponent = React.forwardRef((
      {
        children,
        ...props
      }: React.HTMLAttributes<HTMLElement> & {
        initial?: unknown;
        animate?: unknown;
        exit?: unknown;
        whileInView?: unknown;
        transition?: unknown;
        viewport?: unknown;
      },
      ref: React.Ref<HTMLElement>
    ) => {
      const domProps = Object.fromEntries(
        Object.entries(props).filter(([propName]) => !motionOnlyProps.has(propName))
      );

      return React.createElement(tag, { ...domProps, ref }, children);
    });

    MockMotionComponent.displayName = `MockMotion(${tag})`;
    return MockMotionComponent;
  };

  return {
    motion: {
      div: createComponent("div"),
      section: createComponent("section"),
      header: createComponent("header"),
      nav: createComponent("nav"),
      span: createComponent("span"),
      p: createComponent("p"),
      h1: createComponent("h1"),
      h2: createComponent("h2"),
      h3: createComponent("h3"),
      ul: createComponent("ul"),
      li: createComponent("li"),
      a: createComponent("a"),
      button: createComponent("button"),
    },
    useScroll: () => ({ scrollYProgress: 0 }),
    useTransform: () => 0,
    useReducedMotion: () => true,
  };
});

describe("/roadmap page", () => {
  it("renders the live roadmap, source-aligned section headings, and revised two-path messaging", () => {
    render(<RoadmapPage />);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: /Hivra Product Roadmap 2026/i,
      })
    ).toBeInTheDocument();

    expect(screen.getByText("APRIL 2026 · HIVRA.CLOUD")).toBeInTheDocument();
    expect(screen.getByText("The operating system for autonomous agents.")).toBeInTheDocument();

    expect(screen.queryByRole("link", { name: /download roadmap/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /read it here/i })).toHaveAttribute("href", "#what-is-hermesos");
    // FTUE-16: a generic start link goes to sign-up and Launch, not Pro checkout.
    expect(screen.getByRole("link", { name: /deploy hivra/i })).toHaveAttribute("href", "/sign-up");

    const roadmapNav = screen.getByRole("navigation", { name: /roadmap navigation/i });
    expect(within(roadmapNav).getAllByRole("link", { name: /token verification/i }).length).toBeGreaterThanOrEqual(1);
    expect(within(roadmapNav).queryByRole("link", { name: /features/i })).not.toBeInTheDocument();
    expect(within(roadmapNav).queryByRole("link", { name: /compare/i })).not.toBeInTheDocument();
    expect(within(roadmapNav).queryByRole("link", { name: /blog/i })).not.toBeInTheDocument();

    expect(screen.getByText("Both paths give access to the same platform.")).toBeInTheDocument();
    expect(
      screen.getByText("Card users never need a wallet or a token. Self-hosting needs neither a token nor a Hivra account.")
    ).toBeInTheDocument();
    expect(screen.getAllByText(/qualify for a compute tier/i).length).toBeGreaterThanOrEqual(2);

    expect(
      screen.getByRole("heading", {
        level: 2,
        name: /who is hivra for/i,
      })
    ).toBeInTheDocument();

    expect(
      screen.getByRole("heading", {
        level: 2,
        name: /product vision/i,
      })
    ).toBeInTheDocument();

    const directionRow = screen.getByRole("heading", {
      level: 3,
      name: "From platform to economy",
    });
    const visionPayoff = screen.getByText("A single Hivra agent is useful.");
    expect(directionRow.compareDocumentPosition(visionPayoff) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(
      screen.getByText(/There are no dependencies to manage, no configuration files to write, and no setup steps to follow\./i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/This is exploratory and will be detailed when it is ready to ship\./i)
    ).toBeInTheDocument();

    expect(
      screen.getByRole("heading", {
        level: 2,
        name: /^roadmap$/i,
      })
    ).toBeInTheDocument();

    expect(
      screen.getByRole("heading", {
        level: 2,
        name: /what is not on this roadmap/i,
      })
    ).toBeInTheDocument();

    expect(
      screen.getByRole("heading", {
        level: 2,
        name: /fair launch\. community owned\./i,
      })
    ).toBeInTheDocument();
    expect(screen.getByText("TOKEN UTILITY")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Compute access (01) is live today. The other uses below were proposals in April 2026. Some have changed since, and none is a commitment. The current proposal is in the tokenomics."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Credit balances do not unlock or upgrade compute by themselves\./i
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Keeping credits separate from compute tiers prevents a topped-up balance from being mistaken for Free or paid compute access\./i
      )
    ).toBeInTheDocument();

    const bankrLink = screen.getByRole("link", { name: "bankr.bot" });
    expect(bankrLink).toHaveAttribute("href", "https://bankr.bot");
    expect(bankrLink).toHaveAttribute("target", "_blank");
    expect(bankrLink).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("does not promise token holders a governance vote while governance is undecided", () => {
    const { container } = render(<RoadmapPage />);
    expect(container).not.toHaveTextContent(/holders vote/i);
    expect(container).not.toHaveTextContent(/Token holders participate in decisions/i);
    expect(screen.getByText(/No governance model has been chosen/)).toBeInTheDocument();
  });

  it("presents the April 2026 plan as history and keeps present-tense claims true", () => {
    const { container } = render(<RoadmapPage />);
    expect(screen.getByText(/This is Hivra's April 2026 roadmap, kept for the record\./)).toBeInTheDocument();
    for (const stale of [
      /hermesos\.cloud/i,
      /launched into production two weeks ago/i,
      /Never more than 24 hours from a clean restore/i,
      /guaranteed early access/i,
      /moving from a subscription-based model to a token-based access system/i,
      /Hold even a single \$HermesOS token/i,
      /Phase 1 ships in six weeks/i,
      /[\u2013\u2014]/,
    ]) {
      expect(container).not.toHaveTextContent(stale);
    }
    expect(screen.getAllByText(/hivra\.cloud\/token/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Agents on their own computers")).toBeInTheDocument();
  });

  it("labels every token use that is not live as proposed", () => {
    const [live, ...rest] = roadmapContent.token.utilities;
    expect(live.description).toMatch(/^Live today\./);
    for (const utility of rest) {
      if (utility.icon === "governance") continue;
      expect(utility.description).toMatch(/^Proposed: /);
    }
    const phaseBullets = roadmapContent.roadmap.phases.flatMap((phase) =>
      phase.sections.flatMap((section): readonly string[] => ("bullets" in section && section.bullets ? section.bullets : [])),
    );
    for (const bullet of phaseBullets.filter((text) => /\$HermesOS|in the token|token balance|token-based|token spendable/i.test(text))) {
      if (/^Token path: /.test(bullet)) continue;
      expect(bullet).toMatch(/^Proposed: /);
    }
  });
});

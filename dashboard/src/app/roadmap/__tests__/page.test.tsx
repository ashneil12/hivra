/** @jest-environment jsdom */
/* eslint-disable @next/next/no-img-element */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen, within } from "@testing-library/react";

import RoadmapPage from "../page";

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

    expect(screen.getByText("APRIL 2026 · HERMESOS.CLOUD")).toBeInTheDocument();
    expect(screen.getByText("The operating system for autonomous agents.")).toBeInTheDocument();

    expect(screen.queryByRole("link", { name: /download roadmap/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /read it here/i })).toHaveAttribute("href", "#what-is-hermesos");
    expect(screen.getByRole("link", { name: /deploy hivra/i })).toHaveAttribute("href", "/get-started?plan=operator");

    const roadmapNav = screen.getByRole("navigation", { name: /roadmap navigation/i });
    expect(within(roadmapNav).getAllByRole("link", { name: /token verification/i }).length).toBeGreaterThanOrEqual(1);
    expect(within(roadmapNav).queryByRole("link", { name: /features/i })).not.toBeInTheDocument();
    expect(within(roadmapNav).queryByRole("link", { name: /compare/i })).not.toBeInTheDocument();
    expect(within(roadmapNav).queryByRole("link", { name: /blog/i })).not.toBeInTheDocument();

    expect(
      screen.getByText(
        "Both paths give access to the same platform and the same features. Whichever way you choose to enter, $HermesOS powers the underlying infrastructure either way."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "For users paying by card, the platform operates on two layers. The first layer is the one users interact with: a simple credits system. Top up, spend credits, run agents. No wallets, no tokens, no complexity. The second layer is the underlying infrastructure: the platform uses a shared pool to settle platform operations on-chain using $HermesOS. Card users are funding the infrastructure that runs their agents. They are not buying tokens, and the tokens are not theirs. They are simply using a platform whose backend runs on-chain settlement, the same way most apps run on infrastructure their users never see."
      )
    ).toBeInTheDocument();
    expect(screen.getAllByText(/Free plan access \(0\.5 vCPU, 1GB RAM\)/i).length).toBeGreaterThanOrEqual(2);

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
        "$HermesOS is the utility token of the Hivra platform. The token is not a financial instrument. It is functional infrastructure for access, payments, and platform participation. Token utility is being introduced in phases as the platform matures."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Hold even a single \$HermesOS token and get Free plan access: 0\.5 vCPU, 1GB RAM\./i
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
});

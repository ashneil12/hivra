/** @jest-environment jsdom */
/* eslint-disable @next/next/no-img-element */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen, within } from "@testing-library/react";

import TokenVerificationPage from "../page";

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

jest.mock("@/components/theme-toggle", () => ({
  ThemeToggle: () => <button data-testid="theme-toggle">Theme</button>,
}));

jest.mock("@/components/landing/Footer", () => function MockFooter() {
  return <footer>Footer</footer>;
});

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
    },
    useScroll: () => ({ scrollYProgress: 0 }),
    useReducedMotion: () => true,
  };
});

describe("/token page", () => {
  it("renders certified details, the live state board, the flywheel, and holder routes", () => {
    render(<TokenVerificationPage />);

    expect(
      screen.getByRole("heading", { name: "$HermesOS powers the operator economy." })
    ).toBeInTheDocument();
    expect(screen.getByText("Hold for access. Pay annual plans in token. Build what operators use.")).toBeInTheDocument();

    const certifiedPanel = screen.getByLabelText("Certified token details");
    expect(within(certifiedPanel).getByRole("heading", { name: "Certified token details" })).toBeInTheDocument();
    expect(within(certifiedPanel).getByText("Launch transaction")).toBeInTheDocument();
    expect(screen.getByText("0x95ccfD2B81A9667b0Cc979992632F98fc853EBa3")).toBeInTheDocument();
    expect(screen.getByText("@Wayland_Six")).toBeInTheDocument();
    expect(within(certifiedPanel).getByRole("button", { name: "Copy contract address" })).toBeEnabled();

    // Economy intro grounds the bold hero claim before the product-state board.
    const introHeading = screen.getByRole("heading", { name: "The token starts with product use." });
    expect(screen.getByText("01 / THE AGENT ECONOMY")).toBeInTheDocument();
    expect(screen.getByText(/Most tokens begin with a token and then search for utility later/)).toBeInTheDocument();
    expect(screen.getByText(/The platform exists first\. The users exist first\. The operators exist first/)).toBeInTheDocument();
    expect(screen.getByText(/That requires an economic layer built specifically for operators/)).toBeInTheDocument();
    expect(screen.getByText(/\$HermesOS is being designed to become that layer/)).toBeInTheDocument();

    const operatorVisionHeading = screen.getByRole("heading", { name: "Beyond Tools. Towards Operators." });
    expect(screen.getByText("OPERATOR ECONOMY")).toBeInTheDocument();
    expect(screen.getByText(/humans work and agents assist/i)).toBeInTheDocument();
    expect(screen.getByText(/agents will increasingly become operators in their own right/i)).toBeInTheDocument();
    expect(screen.getByText("Operators Can Fund Themselves")).toBeInTheDocument();
    expect(screen.getByText("Operators Can Hire Other Operators")).toBeInTheDocument();
    expect(screen.getByText("Operators Can Learn From The Network")).toBeInTheDocument();
    expect(screen.getByText(/The Hive Mind is the long-term intelligence layer of Hivra/)).toBeInTheDocument();

    // State board: live + shipping next + roadmap folded in
    expect(screen.getByRole("heading", { name: "Live now. Shipping next." })).toBeInTheDocument();
    expect(screen.getByText("02 / STATE OF THE NETWORK")).toBeInTheDocument();
    expect(screen.getByText("Operators Can Work")).toBeInTheDocument();
    expect(screen.getAllByText("Operators Can Earn").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Operators Can Collaborate")).toBeInTheDocument();
    expect(screen.getByText("Operators Become Self-Sustaining")).toBeInTheDocument();
    expect(screen.getAllByText("Self-funding").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Agent-to-agent").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Hive Mind intelligence layer")).toBeInTheDocument();
    expect(screen.getByText(/The most useful operators should be able to earn revenue, fund compute/)).toBeInTheDocument();
    expect(screen.getByText(/without rebuilding every capability themselves/)).toBeInTheDocument();
    expect(screen.getByText(/the whole ecosystem becomes progressively more capable over time/)).toBeInTheDocument();

    // Product loop: stacked cards, not duplicate sections.
    expect(screen.getByRole("heading", { name: "Hold. Use. Build. Get paid." })).toBeInTheDocument();
    expect(screen.getByText("03 / PRODUCT LOOP")).toBeInTheDocument();
    expect(screen.getByText("One loop, not four disconnected promises: hold for access, use token for real product value, build what operators need, and get paid when operators run the work.")).toBeInTheDocument();
    expect(screen.getAllByText("Hold").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Use").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Build").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Get paid")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Get paid when operators use what you build" })).toBeInTheDocument();
    expect(screen.getByText("Operator-pack marketplace payments")).toBeInTheDocument();

    // Holder access: mechanic callout + two tiers with three unlock routes each
    expect(screen.getByRole("heading", { name: "What holding unlocks." })).toBeInTheDocument();
    expect(screen.getByText(/Your tier is set in dollars and locked at verification/)).toBeInTheDocument();
    expect(screen.getByText("Hold $149 of $HermesOS, locked at verification")).toBeInTheDocument();
    expect(screen.getByText("Or pay $9.99/mo by card")).toBeInTheDocument();
    expect(screen.getByText("Or pay $49 in token for a full year")).toBeInTheDocument();
    expect(screen.getByText("Hold $299 of $HermesOS, locked at verification")).toBeInTheDocument();
    expect(screen.getByText("Or pay $99 in token for a full year")).toBeInTheDocument();

    // Nav stays Build, but points to the condensed product-loop area. No standalone Earn nav/label.
    const navBuildLink = screen.getByRole("link", { name: "Build" });
    expect(navBuildLink).toHaveAttribute("href", "#flywheel");
    expect(screen.queryByRole("link", { name: /^Earn$/i })).not.toBeInTheDocument();

    const holderHeading = screen.getByRole("heading", { name: "What holding unlocks." });
    expect(screen.getByText("04 / HOLDER ACCESS")).toBeInTheDocument();
    const mechanicsHeading = screen.getByRole("heading", { name: "Use it for access. Then burn it." });
    expect(
      holderHeading.compareDocumentPosition(mechanicsHeading) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(screen.queryByText("04 / BUILDER ECONOMY · SHIPPING NEXT")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /How builders get paid/ })).not.toBeInTheDocument();

    // Burn area: one clean burn path only; everything else keeps moving for now.
    expect(mechanicsHeading).toBeInTheDocument();
    expect(screen.getByText("05 / BURNS")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Access is the starting point. Over time, $HermesOS becomes the economic layer connecting operators, services, and infrastructure across the ecosystem. Start simple: pay for a yearly Pro or Power plan in $HermesOS. Your access turns on, and once the burn rail is live, that token payment gets burned. Everything else keeps moving through the product for now."
      )
    ).toBeInTheDocument();
    expect(screen.getByText("Pay yearly in $HermesOS")).toBeInTheDocument();
    expect(screen.getByText(/After your access turns on, the token payment is burned/)).toBeInTheDocument();
    expect(screen.getByText("Keep the economy moving")).toBeInTheDocument();
    expect(screen.getAllByText(/stay in circulation for now/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("One burn to start.")).toBeInTheDocument();
    expect(screen.getByText("the full $HermesOS yearly payment")).toBeInTheDocument();
    expect(screen.getByText("annual Pro or Power access")).toBeInTheDocument();
    expect(screen.getByText("Still moving")).toBeInTheDocument();
    expect(screen.getByText("credits, add-ons, packs, builder payments, extra capacity")).toBeInTheDocument();
    expect(screen.queryByText(/Credits and managed Venice paid in \$HermesOS/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/managed Venice payments made in \$HermesOS burn 20%/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/token-paid credits, managed Venice/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/20% of \$HermesOS payments/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/More usage burns as Hivra expands/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Other product payments stay in circulation for now.")).not.toBeInTheDocument();
    expect(screen.queryByText(/Burn policy/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/First burn path/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Circulation stays live/i)).not.toBeInTheDocument();

    // Get paid section sits directly after burns and separates platform credits from $HermesOS.
    const getPaidHeading = screen.getByRole("heading", { name: "Get paid for work people use." });
    expect(screen.getByText("06 / GET PAID")).toBeInTheDocument();
    expect(screen.getByText(/Some contributions are best rewarded with platform credits/)).toBeInTheDocument();
    expect(screen.getByText(/research operators, growth operators, trading research operators/)).toBeInTheDocument();
    expect(screen.getByText(/coding operators, automation operators, and industry-specific operators/)).toBeInTheDocument();
    expect(screen.getByText(/If an operator creates value that other operators or users want access to/)).toBeInTheDocument();
    expect(screen.getByText(/No farming\. No passive rewards/)).toBeInTheDocument();
    expect(screen.getByText("Ship tools operators can run")).toBeInTheDocument();
    expect(screen.getByText("$HermesOS review")).toBeInTheDocument();
    expect(screen.getByText("Bugs, QA, docs, and fixes")).toBeInTheDocument();
    expect(screen.getAllByText("Credits first; token by review").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Guides, support, onboarding, and education")).toBeInTheDocument();
    expect(screen.getByText("Platform credits first")).toBeInTheDocument();
    expect(screen.getByText("Use cases, demos, and ecosystem activation")).toBeInTheDocument();
    expect(screen.getAllByText("Credits first; token by review").length).toBeGreaterThanOrEqual(2);
    expect(
      mechanicsHeading.compareDocumentPosition(getPaidHeading) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    // FAQ
    const faqHeading = screen.getByRole("heading", { name: "Simple answers" });
    expect(screen.getByText("07 / FAQ")).toBeInTheDocument();
    expect(screen.getByText(/Do I need \$HermesOS to use Hivra\?/i)).toBeInTheDocument();
    expect(
      getPaidHeading.compareDocumentPosition(faqHeading) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    // Things deliberately gone
    expect(screen.queryByText(/Do not fake this tier/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/buyback/i)).not.toBeInTheDocument();

    expect(
      screen.getByText(
        "This page covers official token verification and what $HermesOS does inside the product. It is not financial, investment, legal, or trading advice."
      )
    ).toBeInTheDocument();

    expect(
      introHeading.compareDocumentPosition(operatorVisionHeading) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      operatorVisionHeading.compareDocumentPosition(screen.getByRole("heading", { name: "Live now. Shipping next." })) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});

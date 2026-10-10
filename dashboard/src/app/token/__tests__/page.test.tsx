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
  it("separates the verified existing contract and current access from proposals", () => {
    render(<TokenVerificationPage />);
    const main = within(screen.getByRole("main"));
    expect(main.getByRole("heading", { name: "$HermesOS and Hivra." })).toBeInTheDocument();
    expect(main.getByText("0x95ccfD2B81A9667b0Cc979992632F98fc853EBa3")).toBeInTheDocument();
    expect(main.getByRole("link", { name: "View the contract on BaseScan" })).toHaveAttribute("href", "https://basescan.org/token/0x95ccfD2B81A9667b0Cc979992632F98fc853EBa3");
    expect(main.getByRole("heading", { name: "Existing holder access" })).toBeInTheDocument();
    expect(main.getByRole("heading", { name: "The proposed $HIVRA migration" })).toBeInTheDocument();
    expect(main.getByText(/No migration action is offered/)).toBeInTheDocument();
    expect(main.getByText(/Use Hivra and pay by card without connecting a wallet/)).toBeInTheDocument();
    // The dashboard calls this route "Billing" everywhere (nav, Settings row, page eyebrow).
    expect(main.getByRole("link", { name: "Open Billing" })).toHaveAttribute("href", "/dashboard/billing");
    expect(main.queryByText(/Billing & Access/)).not.toBeInTheDocument();
    expect(main.queryByRole("button", { name: /buy|claim|migrate/i })).not.toBeInTheDocument();
    // Two platform token entries: $HIVRA is not launched while dormant.
    expect(main.getByText(/Not launched yet\. There is no \$HIVRA contract yet/)).toBeInTheDocument();
    expect(main.getByText(/Hivra never confirms contract addresses in DMs or private messages/)).toBeInTheDocument();
    expect(main.queryByText(/Nibbii/)).not.toBeInTheDocument();
  });
});

/** @jest-environment jsdom */
/* eslint-disable @next/next/no-img-element */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen, within } from "@testing-library/react";

import TokenVerificationPage from "../page";

jest.mock("@/lib/billing/hivra-token-launch", () => ({
  HIVRA_TOKEN_LAUNCH: {
    contractAddress: "0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf",
    decimals: 18,
    poolId: `0x${"cd".repeat(32)}`,
    activatesAt: "2026-01-01T00:00:00Z",
  },
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

describe("/token page once $HIVRA is live", () => {
  it("lists $HIVRA first with its contract, and $HermesOS as the legacy token", () => {
    render(<TokenVerificationPage />);
    const main = within(screen.getByRole("main"));
    const entries = screen.getAllByText(/0x[0-9a-fA-F]{40}/).map((node) => node.textContent);
    expect(entries).toEqual([
      "0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf",
      "0x95ccfD2B81A9667b0Cc979992632F98fc853EBa3",
    ]);
    expect(main.getByRole("link", { name: "View the $HIVRA contract on BaseScan" })).toHaveAttribute(
      "href",
      "https://basescan.org/token/0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf"
    );
    expect(main.getByText(/The legacy \$HermesOS contract/)).toBeInTheDocument();
    expect(main.queryByText(/Not launched yet/)).not.toBeInTheDocument();
  });
});

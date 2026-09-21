/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";
import { AnimateIn, AnimateStaggerGroup, AnimateStaggerItem } from "../../ui/animate-in";

// ── Mocks ────────────────────────────────────────────────────────────────────
// Framer Motion's whileInView relies on IntersectionObserver which isn't
// available in jsdom. We mock framer-motion so components render their
// children directly and we test the structural/prop contract, not the
// animation runtime itself.

jest.mock("framer-motion", () => {
  const forwardProps = (props: {
    children?: React.ReactNode;
    className?: string;
    style?: React.CSSProperties;
    initial?: unknown;
    animate?: unknown;
    whileInView?: unknown;
    viewport?: unknown;
    transition?: unknown;
    variants?: unknown;
    [key: string]: unknown;
  }) => {
    const cleanRest = { ...props };
    delete cleanRest.initial;
    delete cleanRest.animate;
    delete cleanRest.whileInView;
    delete cleanRest.viewport;
    delete cleanRest.transition;
    delete cleanRest.variants;
    return cleanRest;
  };

  const MockMotionDiv = React.forwardRef(
    (
      props: {
        children?: React.ReactNode;
        className?: string;
        style?: React.CSSProperties;
        [key: string]: unknown;
      },
      ref: React.Ref<HTMLDivElement>
    ) => <div ref={ref} {...forwardProps(props)} />
  );
  MockMotionDiv.displayName = "MotionDiv";

    return {
      motion: {
        div: MockMotionDiv,
      },
      useReducedMotion: () => false,
    };
});

// ── AnimateIn ─────────────────────────────────────────────────────────────────

describe("AnimateIn", () => {
  it("renders its children", () => {
    render(
      <AnimateIn>
        <span data-testid="child">Hello</span>
      </AnimateIn>
    );
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("forwards className to the wrapper div", () => {
    const { container } = render(
      <AnimateIn className="my-class">
        <span>Child</span>
      </AnimateIn>
    );
    expect(container.firstChild).toHaveClass("my-class");
  });

  it("forwards style to the wrapper div", () => {
    const { container } = render(
      <AnimateIn style={{ color: "red" }}>
        <span>Child</span>
      </AnimateIn>
    );
    expect(container.firstChild).toHaveStyle({ color: "red" });
  });

  it("renders without crashing when no optional props are provided", () => {
    expect(() =>
      render(
        <AnimateIn>
          <div />
        </AnimateIn>
      )
    ).not.toThrow();
  });
});

// ── AnimateStaggerGroup ───────────────────────────────────────────────────────

describe("AnimateStaggerGroup", () => {
  it("renders its children", () => {
    render(
      <AnimateStaggerGroup>
        <span data-testid="child">Item</span>
      </AnimateStaggerGroup>
    );
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("forwards className", () => {
    const { container } = render(
      <AnimateStaggerGroup className="grid">
        <div />
      </AnimateStaggerGroup>
    );
    expect(container.firstChild).toHaveClass("grid");
  });

  it("forwards style", () => {
    const { container } = render(
      <AnimateStaggerGroup style={{ gap: "1rem" }}>
        <div />
      </AnimateStaggerGroup>
    );
    expect(container.firstChild).toHaveStyle({ gap: "1rem" });
  });

  it("renders multiple children", () => {
    render(
      <AnimateStaggerGroup>
        <span data-testid="a">A</span>
        <span data-testid="b">B</span>
        <span data-testid="c">C</span>
      </AnimateStaggerGroup>
    );
    expect(screen.getByTestId("a")).toBeInTheDocument();
    expect(screen.getByTestId("b")).toBeInTheDocument();
    expect(screen.getByTestId("c")).toBeInTheDocument();
  });
});

// ── AnimateStaggerItem ────────────────────────────────────────────────────────

describe("AnimateStaggerItem", () => {
  it("renders its children", () => {
    render(
      <AnimateStaggerItem>
        <span data-testid="item-child">Content</span>
      </AnimateStaggerItem>
    );
    expect(screen.getByTestId("item-child")).toBeInTheDocument();
  });

  it("forwards className", () => {
    const { container } = render(
      <AnimateStaggerItem className="etched-card">
        <div />
      </AnimateStaggerItem>
    );
    expect(container.firstChild).toHaveClass("etched-card");
  });

  it("forwards style", () => {
    const { container } = render(
      <AnimateStaggerItem style={{ padding: "2rem" }}>
        <div />
      </AnimateStaggerItem>
    );
    expect(container.firstChild).toHaveStyle({ padding: "2rem" });
  });

  it("renders correctly when nested inside AnimateStaggerGroup", () => {
    render(
      <AnimateStaggerGroup>
        <AnimateStaggerItem>
          <span data-testid="nested">Nested</span>
        </AnimateStaggerItem>
      </AnimateStaggerGroup>
    );
    expect(screen.getByTestId("nested")).toBeInTheDocument();
  });
});

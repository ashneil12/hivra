/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import { Sparkline } from "../Sparkline";

// Motion props are irrelevant here; render plain SVG elements.
jest.mock("framer-motion", () => {
  const strip = (tag: string) =>
    function MotionElement(props: Record<string, unknown>) {
      const rest = { ...props };
      for (const key of ["initial", "animate", "whileInView", "viewport", "transition"]) delete rest[key];
      return React.createElement(tag, rest);
    };
  return {
    motion: { rect: strip("rect"), path: strip("path"), circle: strip("circle") },
    useReducedMotion: () => true,
  };
});

const data = [
  { date: "2026-09-10", count: 3 },
  { date: "2026-09-11", count: 0 },
  { date: "2026-09-12", count: 1234 },
];
const labels = { peak: "peak day", total: "3-day total", barLabel: "{date}: {count} events" };

function readout(container: HTMLElement) {
  return container.querySelector("figcaption [aria-live]");
}

function hitTargets(container: HTMLElement) {
  return Array.from(container.querySelectorAll<SVGRectElement>('rect[tabindex="0"]'));
}

describe("Sparkline", () => {
  it("renders bar-chart dates as HTML text instead of stretched SVG text", () => {
    const { container } = render(<Sparkline data={data} labels={labels} />);
    expect(container.querySelector("svg text")).toBeNull();
    expect(screen.getByText("Sep 10")).toBeInTheDocument();
    expect(screen.getByText("Sep 12")).toBeInTheDocument();
  });

  it("gives each bar a full-slot hit target and reads a tapped day out as text", () => {
    const { container } = render(<Sparkline data={data} labels={labels} />);
    const targets = hitTargets(container);
    expect(targets).toHaveLength(3);
    const widths = targets.map((rect) => Number(rect.getAttribute("width")));
    const slot = (1000 - 16) / 3;
    widths.forEach((width) => expect(width).toBeCloseTo(slot));
    expect(readout(container)).toHaveTextContent("peak day: 1,234");

    fireEvent.pointerDown(targets[2]);
    expect(readout(container)).toHaveTextContent("Sep 12: 1,234 events");

    fireEvent.mouseLeave(targets[2]);
    expect(readout(container)).toHaveTextContent("peak day: 1,234");
  });

  it("reads out a tapped day on the cumulative area chart too", () => {
    const { container } = render(<Sparkline data={data} labels={labels} variant="area" />);
    fireEvent.pointerDown(hitTargets(container)[0]);
    expect(readout(container)).toHaveTextContent("Sep 10: 3 events");
  });
});

/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import { StatusText } from "../StatusText";

describe("StatusText", () => {
  it("stays still on first render and animates only when the word changes", () => {
    const { rerender } = render(<StatusText value="Starting" data-testid="status" />);
    expect(screen.getByTestId("status")).toHaveTextContent("Starting");
    expect(screen.getByTestId("status")).not.toHaveClass("hg-status-swap");
    rerender(<StatusText value="Running" data-testid="status" />);
    expect(screen.getByTestId("status")).toHaveTextContent("Running");
    expect(screen.getByTestId("status")).toHaveClass("hg-status-swap");
  });
});

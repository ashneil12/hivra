/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { LoadingState } from "../LoadingState";
import DashboardLoading from "@/app/dashboard/loading";

it("announces real activity without claiming measurable progress", () => {
  const { rerender } = render(<LoadingState label="Opening Windows…" detail="My computer" dark />);
  expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  expect(screen.getByRole("status")).toHaveTextContent("Opening Windows…");
  expect(screen.getByText("My computer")).toBeInTheDocument();
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  rerender(<LoadingState compact label="Loading files…" />);
  expect(screen.queryByText("My computer")).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Loading files…");
});

it("provides an accessible dashboard route fallback", () => {
  render(<DashboardLoading />);
  expect(screen.getByRole("status")).toHaveTextContent("Opening your workspace…");
});

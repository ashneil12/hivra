/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import ComputerScene from "../ComputerScene";
import DashboardShowcaseSection from "../DashboardShowcaseSection";
import FAQSection from "../FAQSection";

jest.mock("@/components/branding/HivraMark", () => ({ HivraMark: () => <span>Hivra</span> }));

afterEach(cleanup);

test("the computer illustration exposes all three views through native buttons", () => {
  render(<ComputerScene />);
  expect(screen.getByRole("button", { name: "Desktop" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
  expect(screen.getByRole("button", { name: "Terminal" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "Desktop" })).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByText(/projects\//)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Files" }));
  expect(screen.getByText("Projects")).toBeInTheDocument();
  expect(screen.getByText("Notes")).toBeInTheDocument();
  expect(screen.getByText("Tools")).toBeInTheDocument();
  expect(screen.getByText("Interactive illustration")).toBeVisible();
});

test("workspace navigation switches examples without implying real running jobs", () => {
  render(<DashboardShowcaseSection />);
  expect(screen.getAllByText("Example agent")).toHaveLength(3);
  expect(screen.queryByText("Running")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Files" }));
  expect(screen.getByText("workspace / projects")).toBeInTheDocument();
  expect(screen.queryByText("Claude Code")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
  expect(screen.getByText(/pwd/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Agents" }));
  expect(screen.getByText("Claude Code")).toBeInTheDocument();
});

test("FAQ uses native disclosures with every answer retained in the document", () => {
  const { container } = render(<FAQSection />);
  const disclosures = container.querySelectorAll("details");
  expect(disclosures.length).toBeGreaterThan(5);
  expect(disclosures[0]).toHaveAttribute("open");
  disclosures.forEach(item => {
    expect(item.querySelector("summary")).toHaveTextContent(/\S/);
    expect(item.querySelector("p")).toHaveTextContent(/\S/);
  });
});

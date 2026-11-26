/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, render, screen } from "@testing-library/react";
import ReturnToApp from "../ReturnToApp";

const href = "hivra://auth/callback?code=code_123&state=state_123";

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(window, "close").mockImplementation(() => {});
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it("keeps the manual app link available instead of closing the tab", () => {
  const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  render(<ReturnToApp href={href} />);

  expect(screen.getByRole("heading", { name: "Opening Hivra…" })).toBeInTheDocument();
  act(() => { jest.advanceTimersByTime(1500); });

  expect(window.close).not.toHaveBeenCalled();
  expect(screen.getByRole("heading", { name: "Finish in the Hivra app" })).toBeInTheDocument();
  expect(screen.getByText(/choose Open/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open the Hivra app" })).toHaveAttribute("href", href);
  consoleError.mockRestore();
});

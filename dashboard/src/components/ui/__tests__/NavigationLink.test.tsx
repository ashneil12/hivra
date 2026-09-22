/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import NavigationLink from "../NavigationLink";
let mockPending = false;
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, ...props }: { children: ReactNode }) => <a {...props}>{children}</a>,
  useLinkStatus: () => ({ pending: mockPending }),
}));
it("shows feedback only while Next reports a pending navigation", () => {
  const { rerender } = render(<NavigationLink href="/dashboard">Home</NavigationLink>);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  mockPending = true;
  rerender(<NavigationLink href="/dashboard">Home</NavigationLink>);
  expect(screen.getByRole("status", { name: "Opening page" })).toBeInTheDocument();
  expect(screen.getByRole("link")).toHaveAttribute("href", "/dashboard");
  mockPending = false;
  rerender(<NavigationLink href="/dashboard">Home</NavigationLink>);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

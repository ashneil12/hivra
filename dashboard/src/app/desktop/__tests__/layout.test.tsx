/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import DesktopLayout from "../layout";

jest.mock("@/components/auth/AuthClerkProvider", () => ({
  AuthClerkProvider: ({ children }: { children: React.ReactNode }) => <div data-testid="auth-provider">{children}</div>,
}));

it("wraps desktop sign-in routes in the Clerk provider", () => {
  render(<DesktopLayout><div>desktop child</div></DesktopLayout>);
  expect(screen.getByTestId("auth-provider")).toHaveTextContent("desktop child");
});

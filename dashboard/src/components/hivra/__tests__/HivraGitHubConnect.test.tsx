/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { HivraGitHubConnect } from "../HivraGitHubConnect";

jest.mock("posthog-js", () => ({ __esModule: true, default: { capture: jest.fn() } }));
jest.mock("@/lib/hivra/agent-api", () => ({ boxLoginComplete: jest.fn() }));

function setPointer(coarse: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({ matches: coarse && query.includes("coarse"), media: query }) as MediaQueryList,
  });
}

it("treats the token as a one-off secret, not a saved password or prose", () => {
  setPointer(false);
  render(<HivraGitHubConnect boxUrl="https://box.test" onDone={jest.fn()} />);
  const field = screen.getByLabelText("GitHub personal access token");
  expect(field).toHaveAttribute("autocomplete", "off");
  expect(field).toHaveAttribute("autocapitalize", "off");
  expect(field).toHaveAttribute("autocorrect", "off");
  expect(field).toHaveAttribute("spellcheck", "false");
  expect(field).toHaveAttribute("enterkeyhint", "go");
  expect(field).toHaveFocus();
});

it("does not raise the keyboard over step 1 on touch", () => {
  setPointer(true);
  render(<HivraGitHubConnect boxUrl="https://box.test" onDone={jest.fn()} />);
  expect(screen.getByLabelText("GitHub personal access token")).not.toHaveFocus();
  expect(screen.getByRole("link", { name: "Create a fine-grained token" })).toBeVisible();
});

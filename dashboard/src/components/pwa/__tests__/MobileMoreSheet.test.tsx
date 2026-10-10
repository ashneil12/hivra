/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { usePathname } from "next/navigation";

import { MobileMoreSheet } from "../MobileMoreSheet";

const setTheme = jest.fn();
jest.mock("next/navigation", () => ({ usePathname: jest.fn() }));
jest.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "dark", setTheme }) }));

type ClerkHost = Window & { Clerk?: unknown };

function renderSheet(overrides: Partial<Parameters<typeof MobileMoreSheet>[0]> = {}) {
  const props = {
    onClose: jest.fn(),
    onOpenSwitcher: jest.fn(),
    attentionCount: 0,
    userName: "Ash",
    userEmail: "a.very.long.operator.address@example-company.com",
    ...overrides,
  };
  render(<MobileMoreSheet {...props} />);
  return { ...props, sheet: screen.getByRole("dialog", { name: "More" }) };
}

describe("MobileMoreSheet", () => {
  beforeEach(() => {
    (usePathname as jest.Mock).mockReturnValue("/dashboard");
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value() { this.setAttribute("open", ""); } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value() { this.removeAttribute("open"); } });
  });

  afterEach(() => {
    delete (window as ClerkHost).Clerk;
    delete process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE;
    document.documentElement.classList.remove("theme-transition");
  });

  it("lists search, attention, every non-bar destination, account and theme in order", () => {
    const { sheet } = renderSheet({ attentionCount: 2 });
    expect(sheet).toHaveAttribute("open");
    const controls = [...sheet.querySelectorAll("a, button")].map((element) => element.getAttribute("aria-label") ?? element.textContent?.trim());
    expect(controls).toEqual([
      "Close menu",
      "Switch or search",
      "2 agents or computers need attention",
      "Capacity",
      "Activity",
      "Settings",
      "Billing",
      "Applications",
      "Help",
      "Manage account",
      "Sign out",
      "Theme: DarkSwitch to light",
    ]);
    expect(within(sheet).getByRole("button", { name: "Close menu" })).toBeInTheDocument();
    expect(within(sheet).getByRole("link", { name: "2 agents or computers need attention" })).toHaveAttribute("href", "/dashboard?runtimes=1&attention=1");
    expect(within(sheet).getByRole("link", { name: "Billing" })).toHaveAttribute("href", "/dashboard/billing");
    expect(within(sheet).getByText("a.very.long.operator.address@example-company.com")).toBeInTheDocument();
  });

  it("omits the attention row when nothing needs attention", () => {
    const { sheet } = renderSheet();
    expect(within(sheet).queryByText("Needs attention")).not.toBeInTheDocument();
  });

  it("marks the current destination", () => {
    (usePathname as jest.Mock).mockReturnValue("/dashboard/vault");
    const { sheet } = renderSheet();
    expect(within(sheet).getAllByRole("link", { current: "page" })).toEqual([within(sheet).getByRole("link", { name: "Settings" })]);
  });

  it.each([
    ["Escape", (sheet: HTMLElement) => fireEvent(sheet, new Event("cancel", { cancelable: true }))],
    ["backdrop", (sheet: HTMLElement) => fireEvent.click(sheet)],
    ["close button", (sheet: HTMLElement) => fireEvent.click(within(sheet).getByRole("button", { name: "Close menu" }))],
    ["destination", (sheet: HTMLElement) => {
      const link = within(sheet).getByRole("link", { name: "Activity" });
      // jsdom cannot follow the link; only the close matters here.
      link.addEventListener("click", (event) => event.preventDefault());
      fireEvent.click(link);
    }],
  ])("closes on %s", (_label, trigger) => {
    const { sheet, onClose } = renderSheet();
    trigger(sheet);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close when a row inside the sheet is tapped", () => {
    const { sheet, onClose } = renderSheet();
    fireEvent.click(within(sheet).getByText("Account"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("opens the switcher after closing itself", () => {
    const { sheet, onClose, onOpenSwitcher } = renderSheet();
    fireEvent.click(within(sheet).getByRole("button", { name: "Switch or search" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpenSwitcher).toHaveBeenCalledTimes(1);
  });

  it("uses the loaded Clerk instance for hosted account management and sign-out", async () => {
    const clerk = { openUserProfile: jest.fn(), signOut: jest.fn().mockResolvedValue(undefined) };
    (window as ClerkHost).Clerk = clerk;
    const { sheet, onClose } = renderSheet();
    fireEvent.click(within(sheet).getByRole("button", { name: "Manage account" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(clerk.openUserProfile).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(within(sheet).getByRole("button", { name: "Sign out" })); });
    expect(clerk.signOut).toHaveBeenCalledTimes(1);
  });

  it("disables hosted account rows until Clerk has loaded, then enables them while open", () => {
    jest.useFakeTimers();
    try {
      (window as ClerkHost).Clerk = { loaded: false, openUserProfile: jest.fn(), signOut: jest.fn() };
      const { sheet } = renderSheet();
      expect(within(sheet).getByRole("button", { name: "Manage account" })).toBeDisabled();
      expect(within(sheet).getByRole("button", { name: "Sign out" })).toBeDisabled();

      // A cold PWA launch can open the sheet before clerk-js finishes loading.
      const clerk = { loaded: true, openUserProfile: jest.fn(), signOut: jest.fn().mockResolvedValue(undefined) };
      (window as ClerkHost).Clerk = clerk;
      act(() => { jest.advanceTimersByTime(300); });
      expect(within(sheet).getByRole("button", { name: "Manage account" })).toBeEnabled();
      expect(within(sheet).getByRole("button", { name: "Sign out" })).toBeEnabled();
      fireEvent.click(within(sheet).getByRole("button", { name: "Manage account" }));
      expect(clerk.openUserProfile).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("hides hosted billing and profile management in local-auth mode but keeps sign-out", () => {
    process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE = "local";
    const { sheet } = renderSheet();
    expect(within(sheet).queryByRole("link", { name: "Billing" })).not.toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "Manage account" })).not.toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Sign out" })).toBeEnabled();
  });

  it("switches theme with the transition class and stays open", () => {
    const { sheet, onClose } = renderSheet();
    fireEvent.click(within(sheet).getByRole("button", { name: /Theme: Dark/ }));
    expect(setTheme).toHaveBeenCalledWith("light");
    expect(document.documentElement).toHaveClass("theme-transition");
    expect(onClose).not.toHaveBeenCalled();
  });
});

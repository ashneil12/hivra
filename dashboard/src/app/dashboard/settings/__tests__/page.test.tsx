/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { LocaleProvider } from "@/components/i18n/LocaleProvider";
import SettingsPage from "../page";

const setThemeMock = jest.fn();
const clearCacheAndReloadMock = jest.fn();

const useThemeMock = jest.fn();
const useSettingsMock = jest.fn();
const isLocalAuthModeMock = jest.fn();
const useNativeWorkspaceMock = jest.fn();
const useUserMock = jest.fn();

// Clerk and the self-host shim both export exactly these two names.
jest.mock("@clerk/nextjs", () => ({
  useUser: () => useUserMock(),
  UserButton: () => <div data-testid="mock-user-button">User Button</div>,
}));

jest.mock("@/lib/self-host/config", () => ({
  isLocalAuthMode: () => isLocalAuthModeMock(),
}));

jest.mock("next-themes", () => ({
  useTheme: () => useThemeMock(),
}));

jest.mock("@/hooks/use-settings", () => ({
  useSettings: () => useSettingsMock(),
}));

jest.mock("@/components/layout/NativeWorkspaceBridge", () => ({
  useNativeWorkspace: () => useNativeWorkspaceMock(),
}));

jest.mock("@/components/layout/DashboardPageShell", () => ({
  DashboardPageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock("framer-motion", () => {
  const forwardProps = <T extends object>(props: T): T => {
    const cleanRest = { ...props } as T & Record<string, unknown>;
    delete cleanRest.initial;
    delete cleanRest.animate;
    delete cleanRest.exit;
    delete cleanRest.transition;
    delete cleanRest.variants;
    return cleanRest;
  };

  const MotionDiv = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    (props, ref) => <div ref={ref} {...forwardProps(props)} />
  );
  MotionDiv.displayName = "MotionDiv";

  const MotionHeader = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
    (props, ref) => <header ref={ref} {...forwardProps(props)} />
  );
  MotionHeader.displayName = "MotionHeader";

  const MotionSection = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
    (props, ref) => <section ref={ref} {...forwardProps(props)} />
  );
  MotionSection.displayName = "MotionSection";

  return {
    motion: {
      div: MotionDiv,
      header: MotionHeader,
      section: MotionSection,
    },
    useReducedMotion: () => false,
  };
});

const HOSTED_GROUPS = [
  "Account",
  "Plan and billing",
  "Keys and connections",
  "Agent toolkit",
  "On this device",
  "Apps and help",
  "Reset this browser",
];

function groupHeadings() {
  return screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
}

function group(name: string) {
  return within(screen.getByRole("region", { name }));
}

describe("SettingsPage", () => {
  const previousReferralFlag = process.env.NEXT_PUBLIC_HIVRA_REFERRAL_ENABLED;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.NEXT_PUBLIC_HIVRA_REFERRAL_ENABLED;
    isLocalAuthModeMock.mockReturnValue(false);
    useUserMock.mockReturnValue({
      isLoaded: true,
      isSignedIn: true,
      user: { id: "user_123", fullName: "Test User", primaryEmailAddress: { emailAddress: "test@example.com" } },
    });
    useNativeWorkspaceMock.mockReturnValue({ enabled: false, pathname: "/dashboard/settings", ownerKey: null, clearSurfaces: jest.fn() });
    useThemeMock.mockReturnValue({
      theme: "dark",
      setTheme: setThemeMock,
    });
    useSettingsMock.mockReturnValue({
      clearCacheAndReload: clearCacheAndReloadMock,
      isLoaded: true,
    });
  });

  afterAll(() => {
    if (previousReferralFlag === undefined) delete process.env.NEXT_PUBLIC_HIVRA_REFERRAL_ENABLED;
    else process.env.NEXT_PUBLIC_HIVRA_REFERRAL_ENABLED = previousReferralFlag;
  });

  it("calls the page Settings, not Global Settings, and groups it in reading order", () => {
    render(<SettingsPage />);

    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /global settings/i })).not.toBeInTheDocument();
    expect(groupHeadings()).toEqual(HOSTED_GROUPS);
    // The groups are not steps, so no heading carries a position number.
    expect(groupHeadings().some((heading) => /\d/.test(heading ?? ""))).toBe(false);
    // The old destructive-sounding heading is gone; the action is a browser reset.
    expect(screen.queryByText(/danger zone/i)).not.toBeInTheDocument();
  });

  it("exposes the selected theme and changes theme choices without a redundant return action", () => {
    const { rerender } = render(<SettingsPage />);

    expect(screen.queryByRole("button", { name: /return to command center/i })).not.toBeInTheDocument();
    const themeGroup = screen.getByRole("group", { name: "Theme" });
    expect(themeGroup).toHaveAccessibleDescription("Light, dark, or match your device.");
    expect(within(themeGroup).getByRole("button", { name: /dark/i })).toHaveAttribute("aria-pressed", "true");
    expect(within(themeGroup).getByRole("button", { name: /light/i })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(within(themeGroup).getByRole("button", { name: /light/i }));
    expect(setThemeMock).toHaveBeenCalledWith("light");
    useThemeMock.mockReturnValue({ theme: "light", setTheme: setThemeMock });
    rerender(<SettingsPage />);
    expect(screen.getByRole("button", { name: /light/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /dark/i })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /system/i })).toHaveAttribute("aria-pressed", "false");
  });

  it("drops the four display switches nothing read, and says motion follows the device", () => {
    render(<SettingsPage />);

    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    for (const removed of [/reduced motion/i, /auto-scroll/i, /streaming animations/i, /ai reasoning/i]) {
      expect(screen.queryByText(removed)).not.toBeInTheDocument();
    }
    expect(group("On this device").getByText("Motion follows your device's reduce-motion setting.")).toBeInTheDocument();
  });

  it("does not duplicate Capacity, which is in the primary navigation", () => {
    render(<SettingsPage />);
    expect(screen.queryByRole("link", { name: /Infrastructure|Capacity/ })).not.toBeInTheDocument();
  });

  it.each([
    ["Plan and billing", "Billing", "/dashboard/billing", "Plan, payment methods, credits and invoices"],
    ["Plan and billing", "Wallets", "/dashboard/wallet", "Agent wallets and $HermesOS access"],
    ["Keys and connections", "API keys", "/dashboard/vault", "Provider keys and which agents use them"],
    ["Agent toolkit", "Shared agent memory", "/dashboard/settings/memory", "What every new agent starts out knowing"],
    ["Agent toolkit", "Tools and capabilities", "/dashboard/tools", "Add tools to the agents you choose"],
    ["Agent toolkit", "Prompt library", "/dashboard/library", "Ready-made agent roles with tested prompts"],
    ["Agent toolkit", "Templates", "/dashboard/templates", "Save a configured agent and launch it again"],
    ["Apps and help", "Applications", "/dashboard/settings/applications", "Use Hivra in your browser or as a web app"],
    ["Apps and help", "Help", "/dashboard/settings/help", "Support, community and legal information"],
  ])("lists %s › %s as a named row linking to %s", (groupName, name, href, description) => {
    render(<SettingsPage />);

    const link = group(groupName).getByRole("link", { name });
    expect(link).toHaveAttribute("href", href);
    expect(link).toHaveAccessibleDescription(description);
  });

  it("shows every tool up front instead of inside a collapsed More tools disclosure", () => {
    const { container } = render(<SettingsPage />);

    expect(screen.queryByText("More tools")).not.toBeInTheDocument();
    expect(container.querySelector("details")).toBeNull();
    expect(group("Agent toolkit").getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "/dashboard/settings/memory",
      "/dashboard/tools",
      "/dashboard/library",
      "/dashboard/templates",
    ]);
  });

  it("promotes Wallets to one visible row for every hosted account", () => {
    render(<SettingsPage />);

    const walletLinks = screen.getAllByRole("link", { name: /wallet/i });
    expect(walletLinks).toHaveLength(1);
    expect(walletLinks[0]).toHaveAttribute("href", "/dashboard/wallet");
  });

  it("adds Invite and earn only when the referral flag is on", () => {
    const { unmount } = render(<SettingsPage />);
    expect(screen.queryByRole("link", { name: "Invite and earn" })).not.toBeInTheDocument();
    unmount();

    process.env.NEXT_PUBLIC_HIVRA_REFERRAL_ENABLED = "true";
    render(<SettingsPage />);
    expect(group("Agent toolkit").getByRole("link", { name: "Invite and earn" })).toHaveAttribute("href", "/dashboard/settings/referral");
  });

  it("puts the sign-in provider's own account control in the Account group", () => {
    render(<SettingsPage />);

    const account = group("Account");
    expect(account.getByText("Profile and sign-in")).toBeInTheDocument();
    expect(account.getByText("Signed in as test@example.com")).toBeInTheDocument();
    expect(account.getByTestId("mock-user-button")).toBeInTheDocument();
    // Clerk's menu handles sign-out on hosted; the self-host button is not added.
    expect(account.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });

  it("shows the signed-in address verbatim, and a plain description before the user loads", () => {
    useUserMock.mockReturnValue({
      isLoaded: true,
      isSignedIn: true,
      user: { id: "user_123", primaryEmailAddress: { emailAddress: "o$&brien$1@example.com" } },
    });
    const { unmount } = render(<SettingsPage />);
    expect(group("Account").getByText("Signed in as o$&brien$1@example.com")).toBeInTheDocument();
    unmount();

    useUserMock.mockReturnValue({ isLoaded: false, isSignedIn: false, user: null });
    render(<SettingsPage />);
    expect(group("Account").getByText("Your name, email, security and sign-out.")).toBeInTheDocument();
    expect(group("Account").getByTestId("mock-user-button")).toBeInTheDocument();
  });

  it("leaves the account control to the native macOS shell, which renders its own on this route", () => {
    useNativeWorkspaceMock.mockReturnValue({ enabled: true, pathname: "/dashboard/settings", ownerKey: "user_123", clearSurfaces: jest.fn() });
    render(<SettingsPage />);

    expect(screen.queryByRole("region", { name: "Account" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("mock-user-button")).not.toBeInTheDocument();
    expect(groupHeadings()).toEqual(HOSTED_GROUPS.slice(1));
  });

  it("renders the self-hosted variant without hosted billing or wallets", () => {
    isLocalAuthModeMock.mockReturnValue(true);
    render(<SettingsPage />);

    // Same unnumbered headings as hosted, minus billing: nothing renumbers.
    expect(groupHeadings()).toEqual(HOSTED_GROUPS.filter((name) => name !== "Plan and billing"));
    expect(screen.queryByRole("link", { name: "Billing" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /wallet/i })).not.toBeInTheDocument();
    // The account row keeps a way to sign out (asserted in detail below).
    expect(group("Account").getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "API keys" })).toHaveAttribute("href", "/dashboard/vault");
    expect(screen.getByRole("link", { name: "Tools and capabilities" })).toHaveAttribute("href", "/dashboard/tools");
    expect(screen.getByRole("link", { name: "Prompt library" })).toHaveAttribute("href", "/dashboard/library");
    expect(screen.getByRole("link", { name: "Templates" })).toHaveAttribute("href", "/dashboard/templates");
  });

  describe("self-hosted account row", () => {
    const originalLocation = window.location;
    const originalFetch = global.fetch;
    const assignMock = jest.fn();
    const fetchMock = jest.fn();

    beforeEach(() => {
      isLocalAuthModeMock.mockReturnValue(true);
      assignMock.mockReset();
      fetchMock.mockReset();
      Object.defineProperty(window, "location", { configurable: true, value: { ...originalLocation, assign: assignMock } });
      Object.defineProperty(global, "fetch", { configurable: true, value: fetchMock });
    });

    afterEach(() => {
      Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
      Object.defineProperty(global, "fetch", { configurable: true, value: originalFetch });
    });

    it("shows a labelled Sign out button instead of the shim's one-press avatar, and promises no profile tools", () => {
      const { unmount } = render(<SettingsPage />);

      const account = group("Account");
      expect(account.queryByTestId("mock-user-button")).not.toBeInTheDocument();
      expect(account.queryByText("Profile and sign-in")).not.toBeInTheDocument();
      expect(account.getByText("Sign-in")).toBeInTheDocument();
      const signOut = account.getByRole("button", { name: "Sign out" });
      expect(signOut).toHaveAccessibleDescription("Signed in as test@example.com");
      expect(fetchMock).not.toHaveBeenCalled();
      unmount();

      useUserMock.mockReturnValue({ isLoaded: false, isSignedIn: false, user: null });
      render(<SettingsPage />);
      expect(screen.getByText("Signed in to this self-hosted Hivra.")).toBeInTheDocument();
      expect(screen.queryByText("Your name, email, security and sign-out.")).not.toBeInTheDocument();
    });

    it("signs out through the self-host endpoint, then goes to sign-in", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });
      render(<SettingsPage />);

      await act(async () => {
        fireEvent.click(group("Account").getByRole("button", { name: "Sign out" }));
      });

      expect(fetchMock).toHaveBeenCalledWith("/api/self-host/auth/logout", { method: "POST" });
      expect(assignMock).toHaveBeenCalledWith("/sign-in");
    });

    it("stays put and says so when sign-out fails, instead of pretending it worked", async () => {
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
      fetchMock.mockResolvedValue({ ok: false, status: 503 });
      render(<SettingsPage />);

      await act(async () => {
        fireEvent.click(group("Account").getByRole("button", { name: "Sign out" }));
      });

      expect(assignMock).not.toHaveBeenCalled();
      expect(group("Account").getByRole("status")).toHaveTextContent("Couldn't sign out. Try again.");
      expect(group("Account").getByRole("button", { name: "Sign out" })).toBeEnabled();
      errorSpy.mockRestore();
    });
  });

  it("clears the local cache only on a second press, and describes what it clears", () => {
    render(<SettingsPage />);

    const reset = group("Reset this browser");
    const clearCache = reset.getByRole("button", { name: "Clear cache" });
    // Only what clearHermesStorage really removes: cached data and saved layout
    // (terminal tabs). It does not reset most dismissed notices, so it says nothing about them.
    expect(clearCache).toHaveAccessibleDescription(
      "Clears dashboard data cached in this browser and layout choices saved here, like terminal tabs, then reloads the page. Your account, agents and computers aren't affected.",
    );
    fireEvent.click(clearCache);
    expect(clearCacheAndReloadMock).not.toHaveBeenCalled();

    // One verb for every input (touch, mouse, keyboard) in the label and the status.
    const confirm = reset.getByRole("button", { name: "Press again to clear and reload" });
    expect(confirm).toBe(clearCache);
    expect(reset.getByRole("status")).toHaveTextContent("Press the button again within 4 seconds to clear the cache and reload.");
    expect(reset.queryByText(/^tap/i)).not.toBeInTheDocument();
    fireEvent.click(confirm);
    expect(clearCacheAndReloadMock).toHaveBeenCalledTimes(1);
  });

  it("disarms the cache action when the second press does not come within four seconds", () => {
    jest.useFakeTimers();
    try {
      render(<SettingsPage />);
      fireEvent.click(screen.getByRole("button", { name: "Clear cache" }));
      expect(screen.getByRole("button", { name: "Press again to clear and reload" })).toBeInTheDocument();

      act(() => {
        jest.advanceTimersByTime(3999);
      });
      expect(screen.getByRole("button", { name: "Press again to clear and reload" })).toBeInTheDocument();

      act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(screen.getByRole("status")).toHaveTextContent("");
      fireEvent.click(screen.getByRole("button", { name: "Clear cache" }));
      expect(clearCacheAndReloadMock).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not leave the disarm timer running after the page unmounts", () => {
    jest.useFakeTimers();
    try {
      const { unmount } = render(<SettingsPage />);
      const idleTimers = jest.getTimerCount();
      fireEvent.click(screen.getByRole("button", { name: "Clear cache" }));
      expect(jest.getTimerCount()).toBe(idleTimers + 1);
      unmount();
      expect(jest.getTimerCount()).toBeLessThanOrEqual(idleTimers);
    } finally {
      jest.useRealTimers();
    }
  });

  it("shows the site language preference on this device", () => {
    render(
      <LocaleProvider initialLocale="zh-CN">
        <SettingsPage />
      </LocaleProvider>
    );

    const device = group("此设备");
    expect(device.getByText("网站语言")).toBeInTheDocument();
    expect(device.getByText(/Hivra 使用的语言/)).toBeInTheDocument();
    const languageButton = device.getByRole("button", { name: "语言" });
    expect(languageButton).toHaveTextContent("简体中文");

    fireEvent.click(languageButton);

    expect(screen.getByRole("listbox", { name: "语言" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "简体中文" })).toHaveAttribute("aria-selected", "true");
  });

  it("translates the settings surface immediately when the language changes", () => {
    render(
      <LocaleProvider initialLocale="en">
        <SettingsPage />
      </LocaleProvider>
    );

    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Language" }));
    fireEvent.click(screen.getByRole("option", { name: "简体中文" }));

    expect(screen.getByRole("heading", { level: 1, name: "设置" })).toBeInTheDocument();
    expect(groupHeadings()).toEqual(["账户", "计划与账单", "密钥与连接", "Agent 工具箱", "此设备", "应用与帮助", "重置此浏览器"]);
    expect(screen.getByRole("link", { name: "账单" })).toHaveAttribute("href", "/dashboard/billing");
    expect(screen.getByText("网站语言")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "清除缓存" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Settings" })).not.toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "语言" })).toHaveAttribute("aria-expanded", "false");
  });

  it("shows the loading state before settings hydrate", () => {
    useSettingsMock.mockReturnValue({
      clearCacheAndReload: clearCacheAndReloadMock,
      isLoaded: false,
    });

    render(<SettingsPage />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading...");
  });
});

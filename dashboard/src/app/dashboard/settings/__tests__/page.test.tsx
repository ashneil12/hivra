/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { LocaleProvider } from "@/components/i18n/LocaleProvider";
import SettingsPage from "../page";

const setThemeMock = jest.fn();
const updateSettingsMock = jest.fn();
const clearCacheAndReloadMock = jest.fn();

const useThemeMock = jest.fn();
const useSettingsMock = jest.fn();
const isLocalAuthModeMock = jest.fn();

jest.mock("@/lib/self-host/config", () => ({
  isLocalAuthMode: () => isLocalAuthModeMock(),
}));

jest.mock("next-themes", () => ({
  useTheme: () => useThemeMock(),
}));

jest.mock("@/hooks/use-settings", () => ({
  useSettings: () => useSettingsMock(),
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

describe("SettingsPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isLocalAuthModeMock.mockReturnValue(false);
    useThemeMock.mockReturnValue({
      theme: "dark",
      setTheme: setThemeMock,
    });
    useSettingsMock.mockReturnValue({
      settings: {
        reducedMotion: false,
        enableChatAutoScroll: true,
        enableStreamingAnimations: true,
        expandThinkingBlocks: false,
      },
      updateSettings: updateSettingsMock,
      clearCacheAndReload: clearCacheAndReloadMock,
      isLoaded: true,
    });
  });

  it("renders the settings surface with motion dependencies mocked", () => {
    render(<SettingsPage />);

    expect(screen.getByRole("heading", { name: /global settings/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /light/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /dark/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /system/i })).toBeInTheDocument();
  });

  it("exposes the selected theme and changes theme choices without a redundant return action", () => {
    const { rerender } = render(<SettingsPage />);

    expect(screen.queryByRole("button", { name: /return to command center/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /dark/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /light/i })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: /light/i }));
    expect(setThemeMock).toHaveBeenCalledWith("light");
    useThemeMock.mockReturnValue({ theme: "light", setTheme: setThemeMock });
    rerender(<SettingsPage />);
    expect(screen.getByRole("button", { name: /light/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /dark/i })).toHaveAttribute("aria-pressed", "false");
  });

  it.each([
    ["Reduced Motion", "reducedMotion", false, "Minimize transitions and heavy UI animations."],
    ["Auto-Scroll Chat Frame", "enableChatAutoScroll", true, "Automatically pin to the bottom when new messages arrive."],
    ["Streaming Animations", "enableStreamingAnimations", true, "Show fade-in markdown effects when receiving agent streams."],
    ["Uncollapse AI Reasoning", "expandThinkingBlocks", false, 'Start with the AI\'s "Thinking" block automatically expanded.'],
  ])("names the %s switch and preserves its preference update", (name, key, initialValue, description) => {
    const { rerender } = render(<SettingsPage />);
    const toggle = screen.getByRole("switch", { name: name as string });
    expect(toggle).toHaveAttribute("aria-checked", String(initialValue));
    expect(toggle).toHaveAccessibleDescription(description as string);
    fireEvent.click(toggle);
    expect(updateSettingsMock).toHaveBeenCalledWith({ [key as string]: !initialValue });

    const current = useSettingsMock();
    useSettingsMock.mockReturnValue({ ...current, settings: { ...current.settings, [key as string]: !initialValue } });
    rerender(<SettingsPage />);
    expect(screen.getByRole("switch", { name: name as string })).toHaveAttribute("aria-checked", String(!initialValue));
  });

  it("keeps account destinations and the existing memory route reachable", () => {
    render(<SettingsPage />);
    const destinations = within(screen.getByRole("navigation", { name: "Settings destinations" }));
    expect(destinations.getByRole("link", { name: /^Billing/ })).toHaveAttribute("href", "/dashboard/billing");
    expect(destinations.getByRole("link", { name: /^Vault/ })).toHaveAttribute("href", "/dashboard/vault");
    expect(destinations.getByRole("link", { name: /^Infrastructure/ })).toHaveAttribute("href", "/dashboard/infrastructure");
    expect(destinations.getByRole("link", { name: /^Applications/ })).toHaveAttribute("href", "/dashboard/settings/applications");
    expect(destinations.getByRole("link", { name: /^Help/ })).toHaveAttribute("href", "/dashboard/settings/help");
    expect(screen.getByRole("link", { name: /What all your agents should know/ })).toHaveAttribute("href", "/dashboard/settings/memory");
  });

  it("keeps optional tools available while hiding hosted billing in local mode", () => {
    isLocalAuthModeMock.mockReturnValue(true);
    render(<SettingsPage />);
    expect(screen.queryByRole("link", { name: /^Billing/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("More tools"));
    expect(screen.getByRole("link", { name: "Tools & capabilities" })).toHaveAttribute("href", "/dashboard/tools");
    expect(screen.getByRole("link", { name: "Prompt Library" })).toHaveAttribute("href", "/dashboard/library");
    expect(screen.getByRole("link", { name: "Templates" })).toHaveAttribute("href", "/dashboard/templates");
    expect(screen.queryByRole("link", { name: "Wallet" })).not.toBeInTheDocument();
  });

  it("preserves the existing local-cache action and describes its effects", () => {
    render(<SettingsPage />);
    const clearCache = screen.getByRole("button", { name: "Wipe Local State" });
    expect(clearCache).toHaveAccessibleDescription(/Wipes all local UI preferences, saved drafts/);
    fireEvent.click(clearCache);
    expect(clearCacheAndReloadMock).toHaveBeenCalledTimes(1);
  });

  it("shows the site language preference in appearance settings", () => {
    render(
      <LocaleProvider initialLocale="zh-CN">
        <SettingsPage />
      </LocaleProvider>
    );

    expect(screen.getByText("网站语言")).toBeInTheDocument();
    expect(screen.getByText(/Hivra 使用的语言/)).toBeInTheDocument();
    const languageButton = screen.getByRole("button", { name: "语言" });
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

    expect(screen.getByRole("heading", { name: /global settings/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Language" }));
    fireEvent.click(screen.getByRole("option", { name: "简体中文" }));

    expect(screen.getByRole("heading", { name: /全局\s*设置/ })).toBeInTheDocument();
    expect(screen.getByText("外观")).toBeInTheDocument();
    expect(screen.getByText("网站语言")).toBeInTheDocument();
    expect(screen.getByText("聊天与 Agent 界面")).toBeInTheDocument();
    expect(screen.getAllByRole("switch")).toHaveLength(4);
    expect(screen.queryByRole("switch", { name: "Reduced Motion" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /global settings/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "语言" })).toHaveAttribute("aria-expanded", "false");
  });

  it("shows the loading state before settings hydrate", () => {
    useSettingsMock.mockReturnValue({
      settings: {
        reducedMotion: false,
        enableChatAutoScroll: false,
        enableStreamingAnimations: false,
        expandThinkingBlocks: false,
      },
      updateSettings: updateSettingsMock,
      clearCacheAndReload: clearCacheAndReloadMock,
      isLoaded: false,
    });

    render(<SettingsPage />);

    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });
});

/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

import { LanguageSwitcher, LocaleProvider } from "../LocaleProvider";

describe("LanguageSwitcher", () => {
  beforeEach(() => {
    document.cookie = "hermes_locale=; Max-Age=0; Path=/";
    window.localStorage.clear();
  });

  it("opens a custom language menu instead of the browser-native select menu", () => {
    render(
      <LocaleProvider initialLocale="en">
        <LanguageSwitcher />
      </LocaleProvider>,
    );

    expect(screen.queryByRole("combobox", { name: "Language" })).not.toBeInTheDocument();

    const languageButton = screen.getByRole("button", { name: "Language" });
    expect(languageButton).toHaveTextContent("English");

    fireEvent.click(languageButton);

    expect(screen.getByRole("listbox", { name: "Language" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "English" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: "简体中文" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Español" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Português" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Français" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Deutsch" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "日本語" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "한국어" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: "简体中文" }));

    expect(languageButton).toHaveTextContent("简体中文");
    expect(document.documentElement).toHaveAttribute("lang", "zh-CN");
    expect(window.localStorage.getItem("hermes_locale")).toBe("zh-CN");
  });

  it("persists a newly added locale from the shared custom menu", () => {
    render(
      <LocaleProvider initialLocale="en">
        <LanguageSwitcher />
      </LocaleProvider>,
    );

    const languageButton = screen.getByRole("button", { name: "Language" });
    fireEvent.click(languageButton);
    fireEvent.click(screen.getByRole("option", { name: "日本語" }));

    expect(languageButton).toHaveTextContent("日本語");
    expect(document.documentElement).toHaveAttribute("lang", "ja");
    expect(window.localStorage.getItem("hermes_locale")).toBe("ja");
  });
});

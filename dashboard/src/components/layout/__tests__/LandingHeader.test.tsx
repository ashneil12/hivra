/** @jest-environment jsdom */
/* eslint-disable @next/next/no-img-element */
import "@testing-library/jest-dom";
import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import LandingHeader from "../LandingHeader";
import { LocaleProvider } from "@/components/i18n/LocaleProvider";

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock("next/link", () => {
  const MockLink = ({
    href,
    children,
    onClick,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    onClick?: React.MouseEventHandler;
    [key: string]: unknown;
  }) => (
    <a href={href} onClick={onClick} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

jest.mock("next/image", () => {
  const MockImage = ({ src, alt, ...rest }: { src: string; alt: string; [key: string]: unknown }) => (
    <img src={src} alt={alt} {...rest} />
  );
  MockImage.displayName = "MockImage";
  return MockImage;
});

jest.mock("lucide-react", () => ({
  ArrowRight: () => <svg data-testid="icon-arrow-right" />,
  Check: () => <svg data-testid="icon-check" />,
  ChevronDown: () => <svg data-testid="icon-chevron-down" />,
  Languages: () => <svg data-testid="icon-languages" />,
  Menu: () => <svg data-testid="icon-menu" />,
  X: () => <svg data-testid="icon-close" />,
}));

jest.mock("@/components/theme-toggle", () => ({
  ThemeToggle: () => <button data-testid="theme-toggle">Theme</button>,
}));

// Auth state is passed as a prop (resolved server-side by the parent page),
// so no Clerk mock is needed.

// ── Tests ────────────────────────────────────────────────────────────────────

describe("LandingHeader", () => {

  // ── Brand ─────────────────────────────────────────────────────────────────

  it("renders the site brand name", () => {
    render(<LandingHeader />);
    expect(screen.getByRole("link", { name: "Hivra, back to homepage" })).toHaveTextContent("Hivra");
  });

  it("renders the project-authored Hivra mark beside the site name", () => {
    render(<LandingHeader />);
    expect(screen.getByTestId("hivra-mark")).toBeInTheDocument();
    expect(document.querySelector('img[src="/favicon-brand.png"]')).not.toBeInTheDocument();
  });

  // ── Nav links ─────────────────────────────────────────────────────────────

  it("includes the Pricing anchor in the public navigation", () => {
    render(<LandingHeader />);
    const links = screen.getAllByRole("link", { name: "Pricing" });
    expect(links[0]).toHaveAttribute("href", "/#pricing");
  });

  it("makes computers and open source first-class navigation choices", () => {
    render(<LandingHeader />);
    expect(screen.getByRole("link", { name: "Computers" })).toHaveAttribute("href", "/#computers");
    expect(screen.queryByRole("link", { name: "Open source" })).not.toBeInTheDocument();
  });

  it("includes an Agents link in the public navigation", () => {
    render(<LandingHeader />);
    const links = screen.getAllByRole("link", { name: "Agents" });
    expect(links[0]).toHaveAttribute("href", "/#agents");
  });

  it("includes a Register link in the public navigation", () => {
    render(<LandingHeader />);
    const links = screen.getAllByRole("link", { name: "Register" });
    expect(links[0]).toHaveAttribute("href", "/get-started?plan=free");
  });

  it("keeps navigation focused with tokenomics and a real GitHub placement", () => {
    render(<LandingHeader />);
    expect(screen.queryByRole("link", { name: /how it works/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /use cases/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /features/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /compare/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Blog" })).toHaveAttribute("href", "/blog");
    expect(screen.getByRole("link", { name: "Tokenomics" })).toHaveAttribute("href", "/tokenomics");
    expect(screen.getByRole("link", { name: "Litepaper" })).toHaveAttribute("href", "/docs/litepaper/");
    expect(screen.getByRole("link", { name: "Hivra on GitHub" })).toHaveAttribute("href", "https://github.com/ashneil12/hivra");
  });

  // ── Auth-aware CTAs ───────────────────────────────────────────────────────

  it("signed-out users (default) see Log in + Register CTA", () => {
    render(<LandingHeader />);

    expect(screen.getAllByRole("link", { name: /log in/i })[0]).toHaveAttribute(
      "href",
      "/sign-in"
    );
    expect(
      screen.getAllByRole("link", { name: /register/i })[0]
    ).toHaveAttribute("href", "/get-started?plan=free");
    expect(screen.queryByRole("link", { name: /reserve/i })).not.toBeInTheDocument();
    // Signed-in CTA must not render.
    expect(screen.queryByRole("link", { name: /open dashboard/i })).not.toBeInTheDocument();
  });

  it("isSignedIn=false explicitly shows Log in + Register CTA", () => {
    render(<LandingHeader isSignedIn={false} />);

    expect(screen.getAllByRole("link", { name: /log in/i })[0]).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /register/i })[0]).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /reserve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /open dashboard/i })).not.toBeInTheDocument();
  });

  it("isSignedIn=true shows Open Dashboard CTA and no Log in link", () => {
    render(<LandingHeader isSignedIn={true} />);

    const dashboard = screen.getAllByRole("link", { name: /open dashboard/i })[0];
    expect(dashboard).toBeInTheDocument();
    expect(dashboard).toHaveAttribute("href", "/dashboard");

    expect(screen.queryByRole("link", { name: /log in/i })).not.toBeInTheDocument();
  });

  // ── Layout / responsive ───────────────────────────────────────────────────

  beforeAll(() => {
    Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: jest.fn(() => ({ matches: false, addEventListener: jest.fn(), removeEventListener: jest.fn() })) });
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  });

  it("opens the mobile dialog, traps both tab directions, and restores focus on Escape", () => {
    render(<LandingHeader />);
    const toggle = screen.getByRole("button", { name: "Open menu" });
    toggle.focus();
    fireEvent.click(toggle);
    const dialog = screen.getByRole("dialog", { name: "Open menu" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-controls", dialog.id);
    const close = within(dialog).getByRole("button", { name: "Close menu" });
    const last = within(dialog).getByRole("link", { name: "Register" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Open menu" })).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
  });

  it("closes on navigation and restores the previous scroll-lock state", () => {
    document.body.style.overflow = "auto";
    render(<LandingHeader />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    expect(document.body.style.overflow).toBe("hidden");
    const dialog = screen.getByRole("dialog", { name: "Open menu" });
    fireEvent.click(within(dialog).getByRole("link", { name: "Agents" }));
    expect(screen.queryByRole("dialog", { name: "Open menu" })).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("auto");
    document.body.style.overflow = "";
  });

  it("retains the signed-in dashboard action in the mobile dialog", () => {
    render(<LandingHeader isSignedIn />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    const dialog = screen.getByRole("dialog", { name: "Open menu" });
    expect(within(dialog).getByRole("link", { name: "Open Dashboard" })).toHaveAttribute("href", "/dashboard");
    expect(within(dialog).queryByRole("link", { name: "Register" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("link", { name: "Log in" })).not.toBeInTheDocument();
  });

  it("keeps ordinary navigation in the same tab", () => {
    render(<LandingHeader />);
    within(screen.getByRole("navigation", { name: "Primary navigation" })).getAllByRole("link").forEach((link) => {
      expect(link).not.toHaveAttribute("target", "_blank");
    });
  });

  // ── Accessibility ─────────────────────────────────────────────────────────

  it("nav element is rendered as a semantic nav", () => {
    render(<LandingHeader />);
    expect(screen.getByRole("navigation", { name: "Primary navigation" })).toBeInTheDocument();
  });

  it("renders Chinese navigation and a language selector when the locale is Chinese", () => {
    render(
      <LocaleProvider initialLocale="zh-CN">
        <LandingHeader />
      </LocaleProvider>
    );

    expect(screen.getAllByRole("link", { name: "价格" })[0]).toHaveAttribute("href", "/#pricing");
    expect(screen.getByRole("link", { name: "Computers" })).toHaveAttribute("href", "/#computers");
    expect(screen.getAllByRole("link", { name: "Agents" })[0]).toHaveAttribute("href", "/#agents");
    expect(screen.getAllByRole("link", { name: /登录/i })[0]).toHaveAttribute("href", "/sign-in");
    expect(screen.getAllByRole("button", { name: "语言" })[0]).toHaveTextContent("简体中文");

    fireEvent.click(screen.getAllByRole("button", { name: "语言" })[0]);

    expect(screen.getByRole("listbox", { name: "语言" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /English/i })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("option", { name: /简体中文/i })).toHaveAttribute("aria-selected", "true");
  });

  it("renders newly supported Spanish navigation and the full shared language menu", () => {
    render(
      <LocaleProvider initialLocale="es">
        <LandingHeader />
      </LocaleProvider>
    );

    expect(screen.getAllByRole("link", { name: "Precios" })[0]).toHaveAttribute("href", "/#pricing");
    expect(screen.queryByRole("link", { name: "Open source" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Agents" })[0]).toHaveAttribute("href", "/#agents");
    expect(screen.getAllByRole("link", { name: /Iniciar sesión/i })[0]).toHaveAttribute("href", "/sign-in");
    expect(screen.getAllByRole("button", { name: "Idioma" })[0]).toHaveTextContent("Español");

    fireEvent.click(screen.getAllByRole("button", { name: "Idioma" })[0]);

    const dialog = screen.getByRole("dialog", { name: "Idioma" });
    expect(dialog).toBeInTheDocument();
    expect(dialog.parentElement).toBe(document.body);
    expect(screen.getByRole("listbox", { name: "Idioma" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Español" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: "Português" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Français" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Deutsch" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "日本語" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "한국어" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: "日本語" }));

    expect(screen.queryByRole("dialog", { name: "Idioma" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "言語" })[0]).toHaveTextContent("日本語");
    expect(document.documentElement).toHaveAttribute("lang", "ja");
  });
});

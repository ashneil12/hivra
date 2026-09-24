/** @jest-environment jsdom */
/* eslint-disable @next/next/no-img-element */
import "@testing-library/jest-dom";
import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import LandingHeader, { FunnelHeader, HomeOrDashboardLink } from "../LandingHeader";
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
  ArrowLeft: () => <svg data-testid="icon-arrow-left" />,
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

// Auth state is passed as a prop (resolved server-side by the parent page), or
// read from Clerk's `__client_uat` cookie when the page leaves it undefined.
const clearSessionHint = () => {
  document.cookie.split(";").map((part) => part.trim().split("=")[0]).filter(Boolean)
    .forEach((name) => { document.cookie = `${name}=; Max-Age=0; path=/`; });
};

// Phones (<=680px) reorder the menu dialog; everything wider keeps the tablet order.
const mockPhoneWidth = (phone: boolean) => {
  window.matchMedia = jest.fn((query: string) => ({ matches: phone && query === "(max-width: 680px)", addEventListener: jest.fn(), removeEventListener: jest.fn() })) as unknown as typeof window.matchMedia;
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("LandingHeader", () => {
  afterEach(clearSessionHint);
  afterEach(() => mockPhoneWidth(false));

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
    // FTUE-16: sign-up, then Launch; no plan page first.
    expect(links[0]).toHaveAttribute("href", "/sign-up");
  });

  it("keeps ecosystem discoverable without a primary token pitch", () => {
    render(<LandingHeader />);
    expect(screen.queryByRole("link", { name: /how it works/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /use cases/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /features/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /compare/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Blog" })).toHaveAttribute("href", "/blog");
    expect(screen.getByRole("link", { name: "Ecosystem" })).toHaveAttribute("href", "/ecosystem");
    expect(screen.queryByRole("link", { name: "Token" })).not.toBeInTheDocument();
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
    ).toHaveAttribute("href", "/sign-up");
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
    mockPhoneWidth(true);
    render(<LandingHeader />);
    const toggle = screen.getByRole("button", { name: "Open menu" });
    toggle.focus();
    fireEvent.click(toggle);
    const dialog = screen.getByRole("dialog", { name: "Open menu" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-controls", dialog.id);
    const close = within(dialog).getByRole("button", { name: "Close menu" });
    const last = within(dialog).getAllByRole("button").at(-1)!;
    expect(last).toHaveAccessibleName("Language");
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

  it("puts the account actions straight under the menu header on phones, before the page links", () => {
    mockPhoneWidth(true);
    render(<LandingHeader />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    const dialog = screen.getByRole("dialog", { name: "Open menu" });
    const register = within(dialog).getByRole("link", { name: "Register" });
    const agents = within(dialog).getByRole("link", { name: "Agents" });
    expect(register.compareDocumentPosition(agents) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "Log in" })).toHaveAttribute("href", "/sign-in");
    expect(within(dialog).getAllByRole("link", { name: /litepaper/i })).toHaveLength(1);
    expect(within(dialog).getByTestId("theme-toggle")).toBeInTheDocument();
  });

  it("keeps the tablet menu order: page links, extras with the litepaper, then account actions", () => {
    render(<LandingHeader />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    const dialog = screen.getByRole("dialog", { name: "Open menu" });
    const register = within(dialog).getByRole("link", { name: "Register" });
    const litepaper = within(dialog).getByRole("link", { name: "Read the litepaper" });
    expect(litepaper).toHaveAttribute("href", "/docs/litepaper/");
    expect(litepaper.compareDocumentPosition(register) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "Agents" }).compareDocumentPosition(register) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("closes only the in-menu language list on Escape, then the menu on a second Escape", () => {
    mockPhoneWidth(true);
    render(<LandingHeader />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    const dialog = screen.getByRole("dialog", { name: "Open menu" });
    const language = within(dialog).getByRole("button", { name: "Language" });
    fireEvent.click(language);
    const listbox = within(dialog).getByRole("listbox", { name: "Language" });
    // The trigger is the dialog's last row, so the list opens upward.
    expect(listbox).toHaveStyle({ bottom: "calc(100% + 8px)" });
    const option = within(listbox).getAllByRole("option")[0];
    option.focus();
    fireEvent.keyDown(option, { key: "Escape" });
    expect(within(dialog).queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Open menu" })).toBeInTheDocument();
    expect(language).toHaveFocus();
    fireEvent.keyDown(language, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Open menu" })).not.toBeInTheDocument();
  });

  it("keeps a phone-width login link in the header row, beside the icon menu button", () => {
    const { container } = render(<LandingHeader />);
    const row = container.querySelector("header > div")!;
    const login = within(row as HTMLElement).getAllByRole("link", { name: "Log in" }).at(-1)!;
    expect(login).toHaveAttribute("href", "/sign-in");
    expect(login.nextElementSibling).toBe(screen.getByRole("button", { name: "Open menu" }));
  });

  it("reads Clerk's session hint when the page does not pass auth state", () => {
    document.cookie = "__client_uat=1758000000; path=/";
    render(<LandingHeader />);
    expect(screen.getAllByRole("link", { name: "Open Dashboard" })[0]).toHaveAttribute("href", "/dashboard");
    expect(screen.queryByRole("link", { name: /log in/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Register" })).not.toBeInTheDocument();
  });

  it("treats a zero or suffixed-zero session hint as signed out", () => {
    document.cookie = "__client_uat=1758000000; path=/";
    document.cookie = "__client_uat_Abc123=0; path=/";
    render(<LandingHeader />);
    expect(screen.getAllByRole("link", { name: "Register" })[0]).toHaveAttribute("href", "/sign-up");
    expect(screen.queryByRole("link", { name: "Open Dashboard" })).not.toBeInTheDocument();
  });

  it("lets a route-resolved signed-out state win over a stale session hint", () => {
    document.cookie = "__client_uat=1758000000; path=/";
    render(<LandingHeader isSignedIn={false} />);
    expect(screen.getAllByRole("link", { name: /log in/i })[0]).toHaveAttribute("href", "/sign-in");
    expect(screen.queryByRole("link", { name: "Open Dashboard" })).not.toBeInTheDocument();
  });

  it("points error-page visitors home or, when signed in, to the dashboard", () => {
    const { unmount } = render(<HomeOrDashboardLink />);
    expect(screen.getByRole("link", { name: "Back to Hivra" })).toHaveAttribute("href", "/");
    unmount();
    document.cookie = "__client_uat=1758000000; path=/";
    render(<HomeOrDashboardLink />);
    expect(screen.getByRole("link", { name: "Open dashboard" })).toHaveAttribute("href", "/dashboard");
  });

  it("gives funnel pages a brand link home without a back control", () => {
    render(<FunnelHeader homeHref="/" trailing={<button type="button">Language</button>} />);
    const home = screen.getByRole("link", { name: "Hivra home" });
    expect(home).toHaveAttribute("href", "/");
    expect(home).toHaveTextContent("Hivra");
    expect(screen.getByTestId("hivra-mark")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Language" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /back/i })).not.toBeInTheDocument();
  });

  it("renders the funnel brand as plain text when there is no home to go to (local auth)", () => {
    render(<FunnelHeader />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("Hivra")).toBeInTheDocument();
    expect(screen.getByTestId("hivra-mark")).toBeInTheDocument();
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

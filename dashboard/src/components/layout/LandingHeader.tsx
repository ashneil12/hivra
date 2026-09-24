"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Menu, X } from "lucide-react";
import { HivraMark } from "@/components/branding/HivraMark";
import { ThemeToggle } from "@/components/theme-toggle";
import { LanguageSwitcher, useLocale } from "@/components/i18n/LocaleProvider";
import styles from "../public-site/public-site.module.css";
import SourceLink from "../public-site/SourceLink";
import { PUBLIC_PROJECT_LINKS } from "@/lib/public-project-links";
import { PUBLIC_START_HREF } from "@/lib/public-start";

interface LandingHeaderProps {
  /**
   * Auth resolved by the route; public pages do not mount ClerkProvider.
   * Left undefined, the header falls back to Clerk's readable session hint.
   */
  isSignedIn?: boolean;
}

const CLERK_CLIENT_UAT = "__client_uat";

/** Clerk keeps a non-httpOnly `__client_uat` (optionally suffixed) at 0 while signed out. */
function readClerkSessionHint(): boolean {
  if (typeof document === "undefined") return false;
  let unsuffixed: string | undefined;
  let suffixed: string | undefined;
  for (const part of document.cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === CLERK_CLIENT_UAT) unsuffixed = rest.join("=");
    else if (name.startsWith(`${CLERK_CLIENT_UAT}_`)) suffixed ??= rest.join("=");
  }
  return Number.parseInt(suffixed ?? unsuffixed ?? "0", 10) > 0;
}

const subscribeToNothing = () => () => {};

/** An explicit route-resolved value wins; otherwise read the cookie hint after hydration. */
export function useSignedInHint(isSignedIn?: boolean): boolean {
  const hint = useSyncExternalStore(subscribeToNothing, readClerkSessionHint, () => false);
  return isSignedIn ?? hint;
}

/** Matches the phone header breakpoint in public-site.module.css. */
const PHONE_MENU_QUERY = "(max-width: 680px)";

function subscribeToPhoneMenu(onChange: () => void) {
  if (typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(PHONE_MENU_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const readPhoneMenu = () => typeof window.matchMedia === "function" && window.matchMedia(PHONE_MENU_QUERY).matches;

/** Public error pages: signed-in visitors go to the dashboard instead of the homepage. */
export function HomeOrDashboardLink({ className, style }: { className?: string; style?: CSSProperties }) {
  const signedIn = useSignedInHint();
  return signedIn
    ? <Link href="/dashboard" className={className} style={style}>Open dashboard <ArrowRight size={14} aria-hidden="true" /></Link>
    : <Link href="/" className={className} style={style}><ArrowLeft size={14} aria-hidden="true" /> Back to Hivra</Link>;
}

/**
 * Slim brand bar for the sign-in, sign-up and get-started funnel. Without
 * `homeHref` (local auth, where "/" loops back to sign-in) the brand is not a link.
 */
export function FunnelHeader({ trailing, homeHref }: { trailing?: ReactNode; homeHref?: string }) {
  const brand = <><HivraMark size={28} /><span>Hivra</span></>;
  return (
    <header className={styles.funnelBar}>
      {homeHref
        ? <Link href={homeHref} aria-label="Hivra home" className={styles.brand}>{brand}</Link>
        : <span className={styles.brand}>{brand}</span>}
      {trailing ? <div className={styles.funnelTools}>{trailing}</div> : null}
    </header>
  );
}

export default function LandingHeader({ isSignedIn: isSignedInProp }: LandingHeaderProps = {}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const brandRef = useRef<HTMLAnchorElement>(null);
  const { copy } = useLocale();
  const isSignedIn = useSignedInHint(isSignedInProp);
  // Phones get the account row first; the tablet dialog keeps it at the bottom.
  const phoneMenu = useSyncExternalStore(subscribeToPhoneMenu, readPhoneMenu, () => false);
  const links = [
    { label: "Agents", href: "/#agents" },
    { label: "Computers", href: "/#computers" },
    { label: copy.nav.pricing, href: "/#pricing" },
    { label: "Blog", href: "/blog" },
    { label: "Ecosystem", href: "/ecosystem" },
    { label: "Litepaper", href: "/docs/litepaper/" },
  ];

  useEffect(() => {
    if (!menuOpen) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const priorOverflow = document.body.style.overflow;
    const desktop = window.matchMedia("(min-width: 1200px)");
    const brand = brandRef.current;
    const menuButton = menuButtonRef.current;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>("button")?.focus();
    const onResize = () => { if (desktop.matches) setMenuOpen(false); };
    desktop.addEventListener("change", onResize);
    return () => {
      desktop.removeEventListener("change", onResize);
      document.body.style.overflow = priorOverflow;
      if (dialog.open) dialog.close();
      (desktop.matches ? brand : menuButton)?.focus({ preventScroll: true });
    };
  }, [menuOpen]);

  const accountLinks = (mobile = false) => (
    <div className={mobile ? [styles.mobileAccount, phoneMenu && styles.mobileAccountTop].filter(Boolean).join(" ") : styles.accountLinks}>
      {!isSignedIn && <Link href="/sign-in" className={styles.loginLink} onClick={() => setMenuOpen(false)}>{copy.nav.login}</Link>}
      <Link href={isSignedIn ? "/dashboard" : PUBLIC_START_HREF} className={styles.headerCta} onClick={() => setMenuOpen(false)}>
        {isSignedIn ? copy.nav.openDashboard : copy.nav.register}<ArrowRight size={16} strokeWidth={1.5} aria-hidden="true" />
      </Link>
    </div>
  );

  return (
    <header className={styles.header} data-public-header>
      <div className={styles.headerInner}>
        <Link ref={brandRef} href="/" aria-label="Hivra, back to homepage" className={styles.brand}><HivraMark size={32} /><span>Hivra</span></Link>
        <nav className={styles.desktopNav} aria-label="Primary navigation">
          {links.map(({ label, href }) => <Link key={href} href={href}>{label}</Link>)}
        </nav>
        <div className={styles.headerTools}>
          {PUBLIC_PROJECT_LINKS.repository.status === "published" && <SourceLink className={styles.headerSource} />}
          <div className={styles.themeControl}><ThemeToggle /></div>
          <div className={styles.desktopLanguage}><LanguageSwitcher presentation="modal" /></div>
          <div className={styles.mobileLanguage}><LanguageSwitcher presentation="modal" compact /></div>
        </div>
        <div className={styles.desktopAccount}>{accountLinks()}</div>
        <Link href={isSignedIn ? "/dashboard" : "/sign-in"} className={styles.mobileLogin}>{isSignedIn ? copy.nav.openDashboard : copy.nav.login}</Link>
        <button ref={menuButtonRef} type="button" className={styles.menuToggle} aria-label={copy.nav.mobileMenu} aria-expanded={menuOpen} aria-controls={menuId} aria-haspopup="dialog" onClick={() => setMenuOpen(true)}>
          <span>{copy.nav.mobileMenu}</span><Menu size={18} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
      <div className={styles.readingBar} aria-hidden="true" />
      <dialog ref={dialogRef} id={menuId} aria-label={copy.nav.mobileMenu} className={styles.mobileMenu}
        onCancel={(event) => { event.preventDefault(); setMenuOpen(false); }}
        onClose={() => setMenuOpen(false)}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) setMenuOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); setMenuOpen(false); return; }
          if (event.key !== "Tab") return;
          // The theme and language rows only show at phone widths; skip hidden stops.
          const stops = [...event.currentTarget.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')].filter((stop) => stop.checkVisibility?.() ?? true);
          const first = stops[0];
          const last = stops[stops.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}>
        <div className={styles.menuTop}>
          <span className={styles.menuBrand}>Hivra</span>
          <button type="button" className={styles.menuClose} onClick={() => setMenuOpen(false)}>{copy.nav.closeMobileMenu}<X size={20} strokeWidth={1.5} aria-hidden="true" /></button>
        </div>
        {phoneMenu && accountLinks(true)}
        <nav aria-label="Mobile navigation" className={styles.mobileNav}>
          {links.map(({ label, href }, index) => (
            <Link key={href} href={href} onClick={() => setMenuOpen(false)} style={{ "--menu-order": index } as CSSProperties}>
              <span>{label}</span><ArrowRight size={24} strokeWidth={1.5} aria-hidden="true" />
            </Link>
          ))}
        </nav>
        <div className={styles.mobileExtras}>
          <Link href="/#founder" onClick={() => setMenuOpen(false)}>Why I’m building Hivra</Link>
          {/* Phones already list the litepaper in the menu links above. */}
          {!phoneMenu && <Link href="/docs/litepaper/" onClick={() => setMenuOpen(false)}>Read the litepaper</Link>}
          {PUBLIC_PROJECT_LINKS.repository.status === "published" && <SourceLink />}
          <div className={styles.menuTools}>
            <div className={styles.themeControl}><ThemeToggle /></div>
            {/* Last row of the dialog: open upward so every option stays on screen. */}
            <div className={styles.menuLanguage}><LanguageSwitcher placement="top" /></div>
          </div>
        </div>
        {!phoneMenu && accountLinks(true)}
      </dialog>
      <noscript>
        <nav aria-label="Mobile navigation" className={styles.noScriptNav}>
          {links.map(({ label, href }) => <a key={href} href={href}>{label}</a>)}
          <a href={isSignedIn ? "/dashboard" : PUBLIC_START_HREF}>{isSignedIn ? copy.nav.openDashboard : copy.nav.register}</a>
        </nav>
      </noscript>
    </header>
  );
}

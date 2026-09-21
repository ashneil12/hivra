"use client";

import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { ArrowRight, Menu, X } from "lucide-react";
import { HivraMark } from "@/components/branding/HivraMark";
import { ThemeToggle } from "@/components/theme-toggle";
import { LanguageSwitcher, useLocale } from "@/components/i18n/LocaleProvider";
import styles from "../public-site/public-site.module.css";
import SourceLink from "../public-site/SourceLink";

interface LandingHeaderProps {
  /** Auth is resolved by the route; public pages do not mount ClerkProvider. */
  isSignedIn?: boolean;
}

export default function LandingHeader({ isSignedIn = false }: LandingHeaderProps = {}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const brandRef = useRef<HTMLAnchorElement>(null);
  const { copy } = useLocale();
  const links = [
    { label: "Agents", href: "/#agents" },
    { label: "Computers", href: "/#computers" },
    { label: copy.nav.pricing, href: "/#pricing" },
    { label: "Open source", href: "/#open-source" },
    { label: "Blog", href: "/blog" },
    { label: "Tokenomics", href: "/#tokenomics" },
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
    <div className={mobile ? styles.mobileAccount : styles.accountLinks}>
      {!isSignedIn && <Link href="/sign-in" className={styles.loginLink} onClick={() => setMenuOpen(false)}>{copy.nav.login}</Link>}
      <Link href={isSignedIn ? "/dashboard" : "/get-started?plan=free"} className={styles.headerCta} onClick={() => setMenuOpen(false)}>
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
          <SourceLink className={styles.headerSource} />
          <div className={styles.themeControl}><ThemeToggle /></div>
          <div className={styles.desktopLanguage}><LanguageSwitcher presentation="modal" /></div>
          <div className={styles.mobileLanguage}><LanguageSwitcher presentation="modal" compact /></div>
        </div>
        <div className={styles.desktopAccount}>{accountLinks()}</div>
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
          const stops = [...event.currentTarget.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];
          const first = stops[0];
          const last = stops[stops.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}>
        <div className={styles.menuTop}>
          <span className={styles.menuBrand}>Hivra</span>
          <button type="button" className={styles.menuClose} onClick={() => setMenuOpen(false)}>{copy.nav.closeMobileMenu}<X size={20} strokeWidth={1.5} aria-hidden="true" /></button>
        </div>
        <nav aria-label="Mobile navigation" className={styles.mobileNav}>
          {links.map(({ label, href }, index) => (
            <Link key={href} href={href} onClick={() => setMenuOpen(false)} style={{ "--menu-order": index } as CSSProperties}>
              <span>{label}</span><ArrowRight size={24} strokeWidth={1.5} aria-hidden="true" />
            </Link>
          ))}
        </nav>
        <div className={styles.mobileExtras}><Link href="/#downloads" onClick={() => setMenuOpen(false)}>Download the app</Link><Link href="/#founder" onClick={() => setMenuOpen(false)}>Why I’m building Hivra</Link><Link href="/docs/litepaper/" onClick={() => setMenuOpen(false)}>Read the litepaper</Link><SourceLink /></div>
        {accountLinks(true)}
      </dialog>
      <noscript>
        <nav aria-label="Mobile navigation" className={styles.noScriptNav}>
          {links.map(({ label, href }) => <a key={href} href={href}>{label}</a>)}
          <a href={isSignedIn ? "/dashboard" : "/get-started?plan=free"}>{isSignedIn ? copy.nav.openDashboard : copy.nav.register}</a>
        </nav>
      </noscript>
    </header>
  );
}

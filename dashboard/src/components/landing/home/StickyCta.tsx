"use client";

import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { AnimatePresence, m } from "framer-motion";
import { EASE_OUT } from "./motion";
import styles from "./home.module.css";

/**
 * On phones, keep the one ask within reach once the hero's button has
 * scrolled away. Hidden while pricing or the closing ask is on screen, so it
 * never covers a button that says the same thing.
 */
export default function StickyCta({ href, label, note }: { href: string; label: string; note: string }) {
  const [heroGone, setHeroGone] = useState(false);
  const [askVisible, setAskVisible] = useState(false);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const hero = document.getElementById("hero-primary-cta");
    const asks = [...["pricing", "start"].map(id => document.getElementById(id)), document.querySelector("footer")].filter((node): node is HTMLElement => Boolean(node));
    const heroObserver = new IntersectionObserver(([entry]) => setHeroGone(!entry.isIntersecting && entry.boundingClientRect.top < 0));
    const seen = new Map<Element, boolean>();
    const askObserver = new IntersectionObserver(entries => {
      for (const entry of entries) seen.set(entry.target, entry.isIntersecting);
      setAskVisible([...seen.values()].some(Boolean));
    });
    if (hero) heroObserver.observe(hero);
    asks.forEach(node => askObserver.observe(node));
    return () => {
      heroObserver.disconnect();
      askObserver.disconnect();
    };
  }, []);

  const show = heroGone && !askVisible;
  return (
    <AnimatePresence>
      {show ? (
        <m.div
          className={styles.sticky}
          initial={{ y: 90, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 90, opacity: 0 }}
          transition={{ duration: 0.32, ease: EASE_OUT }}
        >
          <a href={href} className={styles.stickyCta} data-cta="sticky">
            <span>{label}</span>
            <ArrowRight size={17} aria-hidden="true" />
          </a>
          <span className={styles.stickyNote}>{note}</span>
        </m.div>
      ) : null}
    </AnimatePresence>
  );
}

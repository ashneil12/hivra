"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useScroll } from "framer-motion";
import styles from "./secondary-site.module.css";

/** Matches the single-column breakpoint in secondary-site.module.css. */
const WIDE_LAYOUT_QUERY = "(min-width: 701px)";

export default function ArticleNavigation({ items }: { items: { id: string; label: string }[] }) {
  const { scrollYProgress } = useScroll();
  const [active, setActive] = useState(items[0]?.id ?? "");
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    // Server HTML ships the contents open for the wide sticky column; single-column CSS hides
    // the list until this runs, so phones start collapsed without painting it above the article.
    const details = detailsRef.current;
    if (!details) return;
    if (!window.matchMedia(WIDE_LAYOUT_QUERY).matches) details.open = false;
    details.dataset.tocReady = "";
  }, []);
  useEffect(() => {
    if (!("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible[0]) setActive(visible[0].target.id);
    }, { rootMargin: "-15% 0px -55% 0px" });
    items.forEach(({ id }) => { const element = document.getElementById(id); if (element) observer.observe(element); });
    return () => observer.disconnect();
  }, [items]);
  return <>
    <motion.div className={styles.readingProgress} style={{ scaleX: scrollYProgress }} aria-hidden="true" />
    <aside className={styles.contents}><details ref={detailsRef} open><summary>In this article</summary><nav aria-label="Article sections">{items.map(({ id, label }, index) => <a key={id} href={`#${id}`} aria-current={active === id ? "location" : undefined}><span>{String(index + 1).padStart(2, "0")}</span>{label}</a>)}</nav></details></aside>
  </>;
}

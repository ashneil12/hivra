"use client";

import { useEffect, useState } from "react";
import { motion, useScroll } from "framer-motion";
import styles from "./secondary-site.module.css";

export default function ArticleNavigation({ items }: { items: { id: string; label: string }[] }) {
  const { scrollYProgress } = useScroll();
  const [active, setActive] = useState(items[0]?.id ?? "");
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
    <aside className={styles.contents}><details open><summary>In this article</summary><nav aria-label="Article sections">{items.map(({ id, label }, index) => <a key={id} href={`#${id}`} aria-current={active === id ? "location" : undefined}><span>{String(index + 1).padStart(2, "0")}</span>{label}</a>)}</nav></details></aside>
  </>;
}

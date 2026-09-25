"use client";

import { useRef } from "react";
import { m, useScroll } from "framer-motion";
import { EASE_OUT, useArmedEntrance, useMotionPref, useRange, useVisible } from "./motion";
import styles from "./home.module.css";

const STRIPS = 14;

function Strip({ index, lit }: { index: number; lit: boolean }) {
  const offset = (index % 2 === 0 ? -1 : 1) * (140 + ((index * 53) % 90));
  const delay = Math.abs(index - (STRIPS - 1) / 2) * 0.035 + ((index * 17) % 5) * 0.02;
  const controls = useArmedEntrance(lit, { y: offset, opacity: 0 }, { y: 0, opacity: 1 }, { duration: 0.9, delay, ease: EASE_OUT });
  const width = 100 / STRIPS;
  return (
    <m.span
      className={styles.logoStrip}
      animate={controls}
      style={{ left: `${index * width}%`, width: `calc(${width}% + 0.5px)`, backgroundPosition: `${(index / (STRIPS - 1)) * 100}% 0` }}
    />
  );
}

/** The monolith, and the mark assembling out of its barcode. */
export default function ClosingArt() {
  const ref = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLDivElement>(null);
  const { off } = useMotionPref();
  const lit = useVisible(markRef, { amount: 0.6, once: true });
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const scale = useRange(scrollYProgress, [0, 1], off ? [1, 1] : [1.16, 1]);
  const y = useRange(scrollYProgress, [0, 1], off ? [0, 0] : [-40, 40]);
  return (
    <div ref={ref} className={styles.closingArt} aria-hidden="true">
      <m.picture className={styles.closingImage} style={{ scale, y }}>
        <source media="(max-width: 760px)" srcSet="/images/home/monolith-900.webp" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/images/home/monolith-1600.webp" alt="" width={1600} height={900} loading="lazy" decoding="async" />
      </m.picture>
      <span className={styles.closingShade} />
      <div ref={markRef} className={styles.logoMark} data-lit={lit || off ? "" : undefined}>
        {Array.from({ length: STRIPS }, (_, index) => <Strip key={index} index={index} lit={lit} />)}
      </div>
    </div>
  );
}

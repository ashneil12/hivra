"use client";

import { useRef } from "react";
import { m, useScroll, type MotionValue } from "framer-motion";
import { useMotionPref, useRange } from "./motion";
import styles from "./home.module.css";

function Word({ word, progress, from, to }: { word: string; progress: MotionValue<number>; from: number; to: number }) {
  const opacity = useRange(progress, [from, to], [0.16, 1]);
  const blur = useRange(progress, [from, to], ["blur(3px)", "blur(0px)"]);
  return <m.span style={{ opacity, filter: blur }}>{word} </m.span>;
}

/**
 * Quote lines that light up word by word as they scroll through the viewport.
 * The server HTML (and motion off) shows the lines fully lit.
 */
export default function LitWords({ lines }: { lines: readonly string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const { off, ready } = useMotionPref();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 85%", "end 55%"] });
  const animated = ready && !off;
  const total = lines.reduce((sum, line) => sum + line.split(" ").length, 0);
  const step = 1 / Math.max(1, total);
  let cursor = 0;
  return (
    <div ref={ref} className={styles.founderLines}>
      {lines.map((line, lineIndex) => (
        <p key={line} data-lead={lineIndex === 1 ? "" : undefined}>
          {animated
            ? line.split(" ").map((word, wordIndex) => {
                const from = cursor * step;
                cursor += 1;
                return <Word key={`${wordIndex}-${word}`} word={word} progress={scrollYProgress} from={from} to={Math.min(1, from + step * 4)} />;
              })
            : line}
        </p>
      ))}
    </div>
  );
}

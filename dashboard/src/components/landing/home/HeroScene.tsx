"use client";

import { useRef } from "react";
import { m } from "framer-motion";
import { Globe, LaptopMinimal, RotateCcw, Server, Smartphone, SquareTerminal } from "lucide-react";
import { EASE_OUT, useMotionPref, usePageVisible, useTypedLines, useVisible } from "./motion";
import styles from "./home.module.css";
import { ThinkingOrb } from "@/components/ui/ThinkingOrb";
import { planSizeParts } from "@/lib/blog/plan-facts";

const ENTRY_SIZE = planSizeParts("entry");

/**
 * An illustration, not a recording. It reads top to bottom as one story:
 * your laptop closes, the agent keeps working on its own computer, and you
 * can open it again from anywhere. The labels reuse the hero's own phrases.
 */
const SESSION = [
  "> ship the settings page",
  "● Read app/settings/page.tsx",
  "● Edit app/settings/page.tsx",
  "● Run npm test",
  "└ all tests passed",
  "● Open the preview",
] as const;

/** The laptop shows as closed once the agent is a couple of steps in. */
const CLOSE_AFTER_LINE = 3;

const PLACES = [
  { icon: Globe, label: "Browser" },
  { icon: Smartphone, label: "Phone" },
  { icon: SquareTerminal, label: "Terminal" },
] as const;

function lineKind(line: string) {
  if (line.startsWith(">")) return styles.lineUser;
  if (line.startsWith("└")) return styles.lineResult;
  return styles.lineTool;
}

export default function HeroScene() {
  const ref = useRef<HTMLDivElement>(null);
  const { off } = useMotionPref();
  const visible = useVisible(ref, { amount: 0.2 });
  const pageShown = usePageVisible();
  const typing = useTypedLines(SESSION, visible && pageShown, { cps: 54, pause: 420, startDelay: 900 });
  const laptopClosed = off || typing.finished || typing.done >= CLOSE_AFTER_LINE;

  // With motion off everything is simply there; `animate` always says where to end up.
  const enter = (delay: number) => ({
    initial: { opacity: 0, y: 18 },
    animate: { opacity: 1, y: 0 },
    transition: off ? { duration: 0 } : { duration: 0.9, delay, ease: EASE_OUT },
  });

  return (
    <div ref={ref} className={styles.scene}>
      <div className={styles.sceneBackdrop} aria-hidden="true">
        <span className={styles.sceneGlow} />
      </div>
      <div className={styles.flow} aria-hidden="true">
        <m.div className={styles.flowLaptop} data-closed={laptopClosed ? "" : undefined} {...enter(0.1)}>
          <LaptopMinimal size={16} />
          <span>Your laptop</span>
          <span className={styles.flowState}>
            <i />
            {laptopClosed ? "Closed" : "Open"}
          </span>
        </m.div>

        <span className={styles.flowLink} data-live={!off && laptopClosed ? "" : undefined} />

        <m.div className={styles.win} {...enter(0.25)}>
          <div className={styles.winBar}>
            <span className={styles.winDots}><i /><i /><i /></span>
            <b>Claude Code</b>
            <span className={styles.winHost}>agent-01</span>
            <span className={styles.winChip}><i />Running</span>
          </div>
          <div className={styles.winSpec}>
            <Server size={13} />
            <span>Your agent&apos;s own computer</span>
            <span className={styles.winSpecSize}>Ubuntu · {ENTRY_SIZE.cpu} · {ENTRY_SIZE.ram}</span>
          </div>
          <div className={styles.winBody}>
            {SESSION.map((line, index) => {
              const text = index < typing.done ? line : index === typing.done ? typing.partial : "";
              if (!text && index > typing.done) return <p key={line} className={styles.lineEmpty} />;
              return (
                <p key={line} className={lineKind(line)}>
                  {text}
                  {index === typing.done && !typing.finished ? <span className={styles.caret} /> : null}
                </p>
              );
            })}
            <p className={styles.lineWorking} data-shown={typing.finished ? "" : undefined}>
              <ThinkingOrb state="working" size={20} theme="dark" />
              Working
            </p>
          </div>
        </m.div>

        <span className={styles.flowLink} />

        <m.div className={styles.flowAnywhere} {...enter(0.4)}>
          <span className={styles.flowAnywhereTitle}>Access it from anywhere</span>
          <span className={styles.flowPlaces}>
            {PLACES.map(({ icon: Icon, label }) => (
              <span key={label}>
                <Icon size={13} />
                {label}
              </span>
            ))}
          </span>
        </m.div>
      </div>
      <div className={styles.sceneMeta}>
        <span>Illustration</span>
        {!off ? (
          <button type="button" onClick={typing.restart} disabled={!typing.finished} aria-label="Replay the illustration">
            <RotateCcw size={12} aria-hidden="true" />
            Replay
          </button>
        ) : null}
      </div>
    </div>
  );
}

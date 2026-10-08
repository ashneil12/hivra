"use client";

import { useRef, type PointerEvent } from "react";
import { m, useMotionValue, useScroll, useSpring, useTransform } from "framer-motion";
import { Cpu, KeyRound, Power, RotateCcw } from "lucide-react";
import { EASE_OUT, useMotionPref, usePageVisible, useRange, useTypedLines, useVisible } from "./motion";
import styles from "./home.module.css";

/** An illustration of an agent session on a Hivra computer, not a recording. */
const SESSION = [
  "> ship the settings page",
  "● Read app/settings/page.tsx",
  "● Edit app/settings/page.tsx",
  "● Run npm test",
  "└ all tests passed",
  "● Open the preview",
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
  const live = !off && visible && pageShown;
  const typing = useTypedLines(SESSION, visible && pageShown, { cps: 54, pause: 420, startDelay: 900 });

  // Pointer parallax (mouse only) and a tilt away as the hero scrolls out.
  const px = useMotionValue(0);
  const py = useMotionValue(0);
  const sx = useSpring(px, { stiffness: 120, damping: 18, mass: 0.6 });
  const sy = useSpring(py, { stiffness: 120, damping: 18, mass: 0.6 });
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end start"] });
  const scrollTilt = useRange(scrollYProgress, [0, 1], [0, 14]);
  const scrollLift = useRange(scrollYProgress, [0, 1], [0, -70]);
  const rotateY = useTransform(sx, v => (off ? 0 : v * 9 - 12));
  const rotateX = useTransform([sy, scrollTilt], ([y, t]: number[]) => (off ? 0 : 8 - y * 7 + t));

  function onMove(event: PointerEvent<HTMLDivElement>) {
    if (off || event.pointerType !== "mouse") return;
    const rect = event.currentTarget.getBoundingClientRect();
    px.set((event.clientX - rect.left) / rect.width - 0.5);
    py.set((event.clientY - rect.top) / rect.height - 0.5);
  }
  function onLeave() {
    px.set(0);
    py.set(0);
  }

  // The entrance starts from its hidden state at mount; with motion off it
  // jumps straight to the finished state instead (motion can be switched off
  // after mount, so `animate` must always say where to end up).
  const shown = { opacity: 1, x: 0, y: 0, z: 0, scale: 1, rotateX: 0, filter: "blur(0px)" };
  const enter = (delay: number, from: Record<string, number | string>) => ({
    initial: { opacity: 0, ...from },
    animate: shown,
    transition: off ? { duration: 0 } : { duration: 1.1, delay, ease: EASE_OUT },
  });

  const float = (amplitude: number, duration: number, delay = 0) =>
    live ? { animate: { y: [0, -amplitude, 0] }, transition: { duration, delay, repeat: Infinity, ease: "easeInOut" as const } } : {};

  return (
    <div ref={ref} className={styles.scene} onPointerMove={onMove} onPointerLeave={onLeave}>
      <div className={styles.sceneBackdrop} aria-hidden="true">
        <span className={styles.sceneGlow} />
        <span className={styles.sceneFloor} />
        <span className={styles.sceneBars} />
      </div>
      <m.div className={styles.sceneRig} style={{ rotateX, rotateY, y: scrollLift }} aria-hidden="true">
        <m.div className={styles.win} {...enter(0.15, { y: 60, z: -220, rotateX: 22, scale: 0.9, filter: "blur(10px)" })}>
          <div className={styles.winBar}>
            <span className={styles.winDots}><i /><i /><i /></span>
            <b>Claude Code</b>
            <span className={styles.winHost}>agent-01</span>
            <span className={styles.winChip}><i />Running</span>
          </div>
          <div className={styles.winBody}>
            {SESSION.map((line, index) => {
              const shown = index < typing.done ? line : index === typing.done ? typing.partial : "";
              if (!shown && index > typing.done) return <p key={line} className={styles.lineEmpty} />;
              return (
                <p key={line} className={lineKind(line)}>
                  {shown}
                  {index === typing.done && !typing.finished ? <span className={styles.caret} /> : null}
                </p>
              );
            })}
            {typing.finished ? (
              <p className={styles.lineWorking}>
                <span className={styles.spinner} />
                Working
              </p>
            ) : null}
          </div>
          <div className={styles.tmuxBar}>
            <span>[agent-01] 0:claude*</span>
            <span>Hivra Cloud</span>
          </div>
          <span className={styles.winSweep} />
        </m.div>

        <m.div className={styles.scenePhone} {...enter(0.85, { x: 70, y: 40, z: 120 })}>
          <m.div className={styles.scenePhoneInner} {...float(7, 7, 0.4)}>
            <span className={styles.phoneIsland} />
            <span className={styles.phoneTitle}>agent-01</span>
            <span className={styles.phoneChip}><i />Running</span>
            <span className={styles.phoneLine} />
            <span className={styles.phoneLine} data-short="" />
            <span className={styles.phoneLine} />
            <span className={styles.phoneInput}>Message agent-01</span>
          </m.div>
        </m.div>

        <m.div className={`${styles.floatChip} ${styles.chipA}`} {...enter(1.15, { y: 30, z: 80 })}>
          <m.span {...float(6, 6.4)}><Power size={13} />Stays on</m.span>
        </m.div>
        <m.div className={`${styles.floatChip} ${styles.chipB}`} {...enter(1.3, { y: 30, z: 60 })}>
          <m.span {...float(5, 7.2, 0.8)}><KeyRound size={13} />Your login</m.span>
        </m.div>
        <m.div className={`${styles.floatChip} ${styles.chipC}`} {...enter(1.45, { y: 30, z: 40 })}>
          <m.span {...float(6, 8, 1.4)}><Cpu size={13} />2 vCPU · 4 GB</m.span>
        </m.div>
      </m.div>
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

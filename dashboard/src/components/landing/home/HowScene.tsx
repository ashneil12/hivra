"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { animate, m, useMotionValue, useMotionValueEvent, useScroll, useTransform, type MotionValue } from "framer-motion";
import { Check, GitBranch, Image as ImageIcon, KeyRound, Landmark, Lock, RefreshCw, TerminalSquare, X, type LucideIcon } from "lucide-react";
import { useMotionPref, usePageVisible, useRange, useTypedLines, useVisible, useWideScreen } from "./motion";
import styles from "./home.module.css";

export interface HowCopy {
  steps: readonly { n: string; title: string; body: string }[];
  allowed: readonly string[];
  blocked: readonly string[];
  note: string;
}

/** An illustration of a tmux session, not a recording. */
const TMUX_LINES = [
  "> refactor the billing module",
  "● Read lib/billing.ts",
  "● Edit lib/billing.ts",
  "● Run the tests",
  "└ all tests passed",
  "● Commit the change",
] as const;

function lineClass(line: string) {
  if (line.startsWith(">")) return styles.lineUser;
  if (line.startsWith("└")) return styles.lineResult;
  return styles.lineTool;
}

/* ------------------------------------------------------------ step 01 -- */

/** The laptop closes; the computer keeps going. */
function StayOn({ t, live }: { t: MotionValue<number>; live: boolean }) {
  const typed = useTypedLines(TMUX_LINES, live, { cps: 46, pause: 520, startDelay: 400 });
  const lid = useTransform(t, [0.05, 0.55], [0, 84]);
  const screenGlow = useTransform(t, [0.05, 0.5], [1, 0]);
  const cable = useTransform(t, [0.3, 0.6], [1, 0.12]);
  const chip = useTransform(t, [0.45, 0.65], [0, 1]);
  const chipScale = useTransform(chip, [0, 1], [0.8, 1]);
  return (
    <div className={styles.howVisual} aria-hidden="true">
      <div className={styles.howWin}>
        <div className={styles.winBar}>
          <span className={styles.winDots}><i /><i /><i /></span>
          <b>Terminal</b>
          <span className={styles.winHost}>agent-01</span>
          <span className={styles.winChip}><i />Running</span>
        </div>
        <div className={styles.winBody}>
          {TMUX_LINES.map((line, index) => {
            const text = index < typed.done ? line : index === typed.done ? typed.partial : "";
            return (
              <p key={line} className={text ? lineClass(line) : styles.lineEmpty}>
                {text}
                {index === typed.done && !typed.finished ? <span className={styles.caret} /> : null}
              </p>
            );
          })}
        </div>
        <div className={styles.tmuxBar}><span>[work] 0:claude*</span><span>tmux</span></div>
      </div>
      <m.div className={styles.howStill} style={{ opacity: chip, scale: chipScale }}>
        <i />Still running
      </m.div>
      <svg className={styles.howCable} viewBox="0 0 200 120" preserveAspectRatio="none">
        <m.path d="M 10 110 C 60 110, 90 20, 190 12" style={{ opacity: cable }} />
      </svg>
      <div className={styles.laptop}>
        <m.div className={styles.laptopLid} style={{ rotateX: lid }}>
          <m.span className={styles.laptopScreen} style={{ opacity: screenGlow }} />
        </m.div>
        <div className={styles.laptopBase} />
        <span className={styles.laptopLabel}>Your laptop</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ step 02 -- */

/** The same session, handed to a phone. */
function Handoff({ t }: { t: MotionValue<number> }) {
  const winScale = useTransform(t, [0.05, 0.45], [1, 0.52]);
  const winOpacity = useTransform(t, [0.25, 0.45], [1, 0]);
  const winBlur = useTransform(t, [0.2, 0.45], ["blur(0px)", "blur(6px)"]);
  const phoneScale = useTransform(t, [0.25, 0.6], [0.72, 1]);
  const phoneOpacity = useTransform(t, [0.25, 0.45], [0, 1]);
  const phoneY = useTransform(t, [0.25, 0.6], [60, 0]);
  const button = useTransform(t, [0.55, 0.66], [0, 1]);
  const tap = useTransform(t, [0.72, 0.9], [0, 1]);
  const tapScale = useTransform(tap, [0, 1], [0.3, 2.6]);
  const tapOpacity = useTransform(tap, [0, 0.2, 1], [0, 0.8, 0]);
  const [driving, setDriving] = useState(() => t.get() >= 0.78);
  useMotionValueEvent(t, "change", v => setDriving(v >= 0.78));
  return (
    <div className={styles.howVisual} aria-hidden="true">
      <m.div className={styles.howWin} style={{ scale: winScale, opacity: winOpacity, filter: winBlur }}>
        <div className={styles.winBar}>
          <span className={styles.winDots}><i /><i /><i /></span>
          <b>Desktop</b>
          <span className={styles.winHost}>agent-01</span>
          <span className={styles.winChip}><i />Running</span>
        </div>
        <div className={styles.howDesk}>
          <span className={styles.howDeskWin} />
          <span className={styles.howDeskWin} data-b="" />
        </div>
      </m.div>
      <m.div className={styles.howPhone} style={{ scale: phoneScale, opacity: phoneOpacity, y: phoneY }}>
        <span className={styles.phoneIsland} />
        <div className={styles.howPhoneHead}>
          <b>agent-01</b>
          <span className={driving ? styles.phoneChipRed : styles.phoneChip}><i />{driving ? "You're driving" : "Running"}</span>
        </div>
        <div className={styles.howPhoneScreen}>
          <span className={styles.howDeskWin} />
          <span className={styles.howDeskWin} data-b="" />
        </div>
        <m.span className={styles.takeOver} style={{ opacity: button }}>
          Take over here <RefreshCw size={11} />
          <m.span className={styles.tapRing} style={{ scale: tapScale, opacity: tapOpacity }} />
        </m.span>
      </m.div>
    </div>
  );
}

/* ------------------------------------------------------------ step 03 -- */

const RING = { cx: 300, cy: 210, r: 108 };
const LANES = [120, 210, 300];
const OK_ICONS: LucideIcon[] = [GitBranch, KeyRound, TerminalSquare];
const NO_ICONS: LucideIcon[] = [ImageIcon, Lock, Landmark];

function AllowLine({ t, lane }: { t: MotionValue<number>; lane: number }) {
  const start = 0.26 + lane * 0.08;
  const draw = useTransform(t, [start, start + 0.14], [0, 1]);
  const y = LANES[lane];
  return <m.path d={`M 150 ${y} C 205 ${y}, 205 ${RING.cy}, ${RING.cx - 62} ${RING.cy}`} className={styles.allowLine} style={{ pathLength: draw }} filter="url(#how-glow)" />;
}

function BlockLine({ t, lane }: { t: MotionValue<number>; lane: number }) {
  const start = 0.5 + lane * 0.1;
  const reach = useTransform(t, [start, start + 0.08, start + 0.1, start + 0.2], [0, 1, 1, 0]);
  const flash = useTransform(t, [start + 0.07, start + 0.1, start + 0.2], [0, 1, 0]);
  const flashScale = useTransform(flash, [0, 1], [0.5, 1.6]);
  const y = LANES[lane];
  const x2 = RING.cx + Math.sqrt(Math.max(0, RING.r * RING.r - (y - RING.cy) * (y - RING.cy))) + 4;
  return (
    <g>
      <m.line x1={450} y1={y} x2={x2} y2={y} className={styles.blockLine} style={{ pathLength: reach }} />
      <m.circle cx={x2} cy={y} r={14} className={styles.blockFlash} style={{ opacity: flash, scale: flashScale }} />
    </g>
  );
}

function AllowItem({ t, lane, label }: { t: MotionValue<number>; lane: number; label: string }) {
  const Icon = OK_ICONS[lane];
  const on = useTransform(t, [0.34 + lane * 0.08, 0.4 + lane * 0.08], [0, 1]);
  return (
    <li style={{ top: `${(LANES[lane] / 420) * 100}%` }}>
      <Icon size={14} />
      {label}
      <m.span className={styles.okMark} style={{ opacity: on, scale: on }}><Check size={11} /></m.span>
    </li>
  );
}

function BlockItem({ t, lane, label }: { t: MotionValue<number>; lane: number; label: string }) {
  const Icon = NO_ICONS[lane];
  const hit = useTransform(t, [0.58 + lane * 0.1, 0.64 + lane * 0.1], [0, 1]);
  return (
    <li style={{ top: `${(LANES[lane] / 420) * 100}%` }}>
      <Icon size={14} />
      <span className={styles.blockLabel}>{label}<m.i style={{ scaleX: hit }} /></span>
      <m.span className={styles.noMark} style={{ opacity: hit, scale: hit }}><X size={11} /></m.span>
    </li>
  );
}

/** What it gets, and what stays out. */
function Boundary({ t, copy }: { t: MotionValue<number>; copy: HowCopy }) {
  const ring = useTransform(t, [0, 0.22], [0, 1]);
  const box = useTransform(t, [0.08, 0.24], [0, 1]);
  const boxScale = useTransform(box, [0, 1], [0.7, 1]);
  return (
    <div className={`${styles.howVisual} ${styles.boundaryVisual}`} aria-hidden="true">
      <svg className={styles.boundarySvg} viewBox="0 0 600 420">
        <defs>
          <filter id="how-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="5" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        {copy.allowed.map((label, lane) => <AllowLine key={label} t={t} lane={lane} />)}
        {copy.blocked.map((label, lane) => <BlockLine key={label} t={t} lane={lane} />)}
        <m.circle cx={RING.cx} cy={RING.cy} r={RING.r} className={styles.ring} style={{ pathLength: ring, rotate: -90 }} filter="url(#how-glow)" />
        <circle cx={RING.cx} cy={RING.cy} r={RING.r + 16} className={styles.ringOuter} />
      </svg>
      <m.div className={styles.boundaryBox} style={{ opacity: box, scale: boxScale }}>
        <b>agent-01</b>
        <span>its own computer</span>
      </m.div>
      <ul className={styles.allowList}>
        {copy.allowed.map((label, lane) => <AllowItem key={label} t={t} lane={lane} label={label} />)}
      </ul>
      <ul className={styles.blockList}>
        {copy.blocked.map((label, lane) => <BlockItem key={label} t={t} lane={lane} label={label} />)}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------ layouts -- */

/** A step visual that plays once when it scrolls into view (stacked layout). */
function useLocalTimeline(ref: RefObject<HTMLElement | null>, duration: number) {
  const { off } = useMotionPref();
  const t = useMotionValue(off ? 1 : 0);
  const inView = useVisible(ref, { amount: 0.4, once: true });
  useEffect(() => {
    if (off) {
      t.set(1);
      return;
    }
    if (inView) {
      const controls = animate(t, 1, { duration, ease: "easeInOut" });
      return () => controls.stop();
    }
  }, [off, inView, t, duration]);
  return { t, inView };
}

function StackedStep({ index, step, copy }: { index: number; step: HowCopy["steps"][number]; copy: HowCopy }) {
  const ref = useRef<HTMLDivElement>(null);
  const { t, inView } = useLocalTimeline(ref, index === 2 ? 5 : 3.2);
  const pageShown = usePageVisible();
  return (
    <div ref={ref} className={styles.howStackStep}>
      <div className={styles.howStepText} data-active="">
        <span className={styles.howNum}>{step.n}</span>
        <h3>{step.title}</h3>
        <p>{step.body}</p>
      </div>
      <div className={styles.howStage}>
        {index === 0 ? <StayOn t={t} live={inView && pageShown} /> : index === 1 ? <Handoff t={t} /> : <Boundary t={t} copy={copy} />}
      </div>
    </div>
  );
}

export default function HowScene({ copy }: { copy: HowCopy }) {
  const outer = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const { off } = useMotionPref();
  const wide = useWideScreen();
  const pinned = wide && !off;
  const pageShown = usePageVisible();
  const stageVisible = useVisible(stageRef, { amount: 0.3, key: pinned });
  const { scrollYProgress: p } = useScroll({ target: outer, offset: ["start start", "end end"] });
  const [active, setActive] = useState(0);
  useMotionValueEvent(p, "change", v => setActive(v < 0.34 ? 0 : v < 0.68 ? 1 : 2));

  const t1 = useRange(p, [0.02, 0.3], [0, 1]);
  const t2 = useRange(p, [0.36, 0.64], [0, 1]);
  const t3 = useRange(p, [0.7, 0.98], [0, 1]);
  const o1 = useRange(p, [0.3, 0.36], [1, 0]);
  const o2 = useRange(p, [0.3, 0.36, 0.64, 0.7], [0, 1, 1, 0]);
  const o3 = useRange(p, [0.64, 0.7], [0, 1]);
  const rail = useRange(p, [0, 1], [0, 1]);

  // The outer element always renders, so the scroll tracker has a target
  // whichever layout is showing.
  return (
    <div ref={outer} className={styles.howOuter} data-pinned={pinned ? "" : undefined}>
      {pinned ? (
        <div ref={stageRef} className={styles.howSticky}>
          <ol className={styles.howSteps}>
            <m.span className={styles.howRail} style={{ scaleY: rail }} aria-hidden="true" />
            {copy.steps.map((step, index) => (
              <li key={step.n} className={styles.howStepText} data-active={active === index ? "" : undefined}>
                <span className={styles.howNum}>{step.n}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
          <div className={styles.howStage}>
            <m.div className={styles.howLayer} style={{ opacity: o1 }}><StayOn t={t1} live={stageVisible && pageShown} /></m.div>
            <m.div className={styles.howLayer} style={{ opacity: o2 }}><Handoff t={t2} /></m.div>
            <m.div className={styles.howLayer} style={{ opacity: o3 }}><Boundary t={t3} copy={copy} /></m.div>
            <p className={styles.howNote}>{copy.note}</p>
          </div>
        </div>
      ) : (
        <div className={styles.howStack}>
          {copy.steps.map((step, index) => <StackedStep key={step.n} index={index} step={step} copy={copy} />)}
          <p className={styles.howNote}>{copy.note}</p>
        </div>
      )}
    </div>
  );
}

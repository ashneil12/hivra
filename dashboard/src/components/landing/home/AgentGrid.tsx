"use client";

import { useRef, type PointerEvent } from "react";
import { m, useMotionValue, useSpring, useTransform } from "framer-motion";
import { ArrowUpRight } from "lucide-react";
import { EASE_OUT, useArmedEntrance, useMotionPref, useTypedLines, useVisible } from "./motion";
import styles from "./home.module.css";

export interface GridAgent {
  id: string;
  name: string;
  role: string;
  line: string;
  href: string;
  screen: readonly string[];
}

function Screen({ lines, running, delay }: { lines: readonly string[]; running: boolean; delay: number }) {
  const typed = useTypedLines(lines, running, { cps: 60, pause: 260, startDelay: delay });
  return (
    <div className={styles.cardScreen} aria-hidden="true">
      {lines.map((line, index) => {
        const text = index < typed.done ? line : index === typed.done ? typed.partial : "";
        const ok = line.startsWith("✓");
        const cmd = index === 0;
        return (
          <p key={line} className={ok ? styles.cardLineOk : cmd ? styles.cardLineCmd : undefined}>
            {text}
            {index === typed.done && !typed.finished ? <span className={styles.caret} /> : null}
          </p>
        );
      })}
    </div>
  );
}

function Card({ agent, index, inView }: { agent: GridAgent; index: number; inView: boolean }) {
  const { off } = useMotionPref();
  const px = useMotionValue(0.5);
  const py = useMotionValue(0.5);
  const sx = useSpring(px, { stiffness: 200, damping: 20 });
  const sy = useSpring(py, { stiffness: 200, damping: 20 });
  const rotateY = useTransform(sx, v => (off ? 0 : (v - 0.5) * 10));
  const rotateX = useTransform(sy, v => (off ? 0 : (0.5 - v) * 8));
  const spotX = useTransform(sx, v => `${v * 100}%`);
  const spotY = useTransform(sy, v => `${v * 100}%`);

  function onMove(event: PointerEvent<HTMLAnchorElement>) {
    if (off || event.pointerType !== "mouse") return;
    const rect = event.currentTarget.getBoundingClientRect();
    px.set((event.clientX - rect.left) / rect.width);
    py.set((event.clientY - rect.top) / rect.height);
  }
  function onLeave() {
    px.set(0.5);
    py.set(0.5);
  }

  const entrance = useArmedEntrance(
    inView,
    { opacity: 0, y: 70, rotateX: 38, z: -160 },
    { opacity: 1, y: 0, rotateX: 0, z: 0 },
    { duration: 1.05, delay: 0.08 * index, ease: EASE_OUT },
  );

  return (
    <m.div className={styles.cardWrap} animate={entrance}>
      <m.a
        href={agent.href}
        className={styles.card}
        aria-label={`Launch ${agent.name}`}
        data-cta={`agent-${agent.id}`}
        onPointerMove={onMove}
        onPointerLeave={onLeave}
        style={{ rotateX, rotateY, ["--spot-x" as string]: spotX, ["--spot-y" as string]: spotY }}
      >
        <span className={styles.cardSpot} aria-hidden="true" />
        <span className={styles.cardEdge} aria-hidden="true" />
        <span className={styles.cardTop}>
          <span className={styles.cardDot} aria-hidden="true" />
          <span className={styles.cardRole}>{agent.role}</span>
          <ArrowUpRight className={styles.cardArrow} size={18} aria-hidden="true" />
        </span>
        <span className={styles.cardName}>{agent.name}</span>
        <span className={styles.cardLine}>{agent.line}</span>
        <Screen lines={agent.screen} running={inView} delay={500 + index * 260} />
      </m.a>
    </m.div>
  );
}

export default function AgentGrid({ agents }: { agents: readonly GridAgent[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useVisible(ref, { amount: 0.15, once: true });
  return (
    <div ref={ref} className={styles.cardGrid}>
      {agents.map((agent, index) => <Card key={agent.id} agent={agent} index={index} inView={inView} />)}
    </div>
  );
}

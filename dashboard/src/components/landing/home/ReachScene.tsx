"use client";

import { useEffect, useRef, useState } from "react";
import { animate, m, useMotionValue, useMotionValueEvent, useScroll, useTransform, type MotionValue } from "framer-motion";
import { Check, Folder, Image as ImageIcon, KeyRound, Landmark, Lock, Briefcase, TerminalSquare } from "lucide-react";
import { useMotionPref, useVisible, useWideScreen } from "./motion";
import styles from "./home.module.css";

export interface ReachCopy {
  eyebrow: string;
  titleA: string;
  bodyA: readonly string[];
  kicker: string;
  titleB: string;
  bodyB: string;
  states: readonly { id: string; label: string; caption: string }[];
  shareCaption: string;
  note: string;
  items: readonly { id: string; label: string }[];
  project: string;
}

// Diagram geometry (viewBox 640 x 470).
const AGENT_A = { x: 220, y: 236 };
const AGENT_B = { x: 548, y: 226 };
const ITEM_POS: Record<string, { x: number; y: number }> = {
  photos: { x: 90, y: 144 },
  passwords: { x: 220, y: 130 },
  bank: { x: 350, y: 144 },
  clients: { x: 90, y: 336 },
  keys: { x: 220, y: 352 },
  project: { x: 350, y: 336 },
};
const ICONS: Record<string, typeof Folder> = { photos: ImageIcon, passwords: Lock, bank: Landmark, clients: Briefcase, keys: KeyRound, project: Folder };

/** Where each beat happens along the scene's 0..1 progress. */
const T = {
  reachStart: 0.08,
  reachEach: 0.06,
  swapA: 0.5,
  swapB: 0.58,
  moveStart: 0.56,
  moveEnd: 0.74,
  wallStart: 0.62,
  wallEnd: 0.78,
  shareStart: 0.8,
  shareEnd: 0.9,
};
const SHARED_POINT = 0.44;
const SEPARATE_POINT = 0.97;

function Reach({ p, id, index }: { p: MotionValue<number>; id: string; index: number }) {
  const target = ITEM_POS[id];
  const start = T.reachStart + index * T.reachEach;
  const draw = useTransform(p, [start, start + 0.08, T.swapA, T.moveStart + 0.02], [0, 1, 1, 0]);
  const drawn = useTransform(draw, v => (v > 0.001 ? 1 : 0));
  const glow = useTransform(p, [start + 0.05, start + 0.1, T.swapA, T.moveStart + 0.04], [0, 1, 1, 0]);
  const glowScale = useTransform(glow, [0, 1], [0.6, 1]);
  return (
    <g>
      <m.path d={`M ${AGENT_A.x} ${AGENT_A.y} L ${target.x} ${target.y}`} className={styles.reachLine} style={{ pathLength: draw, opacity: drawn }} />
      <m.circle cx={target.x} cy={target.y} r={34} className={styles.reachHalo} style={{ opacity: glow, scale: glowScale }} />
    </g>
  );
}

function Item({ p, id, label, index, project }: { p: MotionValue<number>; id: string; label: string; index: number; project?: boolean }) {
  const pos = ITEM_POS[id];
  const Icon = ICONS[id];
  const start = T.reachStart + index * T.reachEach;
  const hot = useTransform(p, [start + 0.05, start + 0.09, T.swapA, T.moveStart + 0.04], [0, 1, 1, 0]);
  const safe = useTransform(p, [T.wallStart, T.wallEnd], [0, 1]);
  const shared = useTransform(p, [T.shareStart, T.shareEnd], [0, 1]);
  return (
    <m.g className={styles.reachItem} style={{ x: pos.x, y: pos.y }} data-item={id}>
      <m.rect x={-60} y={-24} width={120} height={48} rx={12} className={styles.reachItemBox} />
      <m.rect x={-60} y={-24} width={120} height={48} rx={12} className={styles.reachItemHot} style={{ opacity: hot }} />
      {project ? <m.rect x={-60} y={-24} width={120} height={48} rx={12} className={styles.reachItemShared} style={{ opacity: shared }} /> : null}
      <foreignObject x={-58} y={-20} width={116} height={40}>
        <div className={styles.reachItemLabel}>
          <Icon size={13} aria-hidden="true" />
          <span>{label}</span>
        </div>
      </foreignObject>
      {!project ? (
        <m.g style={{ opacity: safe }}>
          <circle cx={54} cy={-22} r={9} className={styles.reachLockDot} />
          <foreignObject x={46} y={-30} width={16} height={16}>
            <div className={styles.reachLockIcon}><Lock size={9} aria-hidden="true" /></div>
          </foreignObject>
        </m.g>
      ) : (
        <m.g style={{ opacity: shared }}>
          <circle cx={54} cy={-22} r={9} className={styles.reachShareDot} />
          <foreignObject x={46} y={-30} width={16} height={16}>
            <div className={styles.reachLockIcon}><Check size={10} aria-hidden="true" /></div>
          </foreignObject>
        </m.g>
      )}
    </m.g>
  );
}

function Diagram({ p, copy }: { p: MotionValue<number>; copy: ReachCopy }) {
  const agentX = useTransform(p, [T.moveStart, T.moveEnd], [AGENT_A.x, AGENT_B.x]);
  const agentY = useTransform(p, [T.moveStart, (T.moveStart + T.moveEnd) / 2, T.moveEnd], [AGENT_A.y, AGENT_A.y - 70, AGENT_B.y]);
  const agentScale = useTransform(p, [T.moveStart, (T.moveStart + T.moveEnd) / 2, T.moveEnd], [1, 1.18, 1]);
  const pcOpacity = useTransform(p, [T.moveStart - 0.06, T.moveStart + 0.04], [0, 1]);
  const pcY = useTransform(p, [T.moveStart - 0.06, T.moveStart + 0.06], [26, 0]);
  const wall = useTransform(p, [T.wallStart, T.wallEnd], [0, 1]);
  const wallGlow = useTransform(p, [T.wallEnd - 0.04, T.wallEnd + 0.02, T.wallEnd + 0.12], [0, 1, 0.45]);
  const share = useTransform(p, [T.shareStart, T.shareEnd], [0, 1]);
  const laptopDim = useTransform(p, [T.wallStart, T.wallEnd], [1, 0.72]);
  const personal = copy.items;
  return (
    <svg className={styles.reachSvg} viewBox="0 0 640 470" role="img" aria-label="Illustration: an agent on your laptop can reach your photos, passwords, bank session, client work and keys. On a separate computer it only reaches the project folder you share.">
      <defs>
        <linearGradient id="reach-pc" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#23262b" />
          <stop offset="1" stopColor="#121417" />
        </linearGradient>
        <filter id="reach-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="5" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      {/* your laptop */}
      <m.g style={{ opacity: laptopDim }}>
        <rect x={14} y={52} width={412} height={352} rx={20} className={styles.reachLaptop} />
        <rect x={14} y={52} width={412} height={36} rx={20} className={styles.reachLaptopBar} />
        <circle cx={38} cy={70} r={4.5} fill="#ff5f57" />
        <circle cx={54} cy={70} r={4.5} fill="#febc2e" />
        <circle cx={70} cy={70} r={4.5} fill="#28c840" />
        <text x={220} y={75} textAnchor="middle" className={styles.reachLaptopTitle}>Your laptop</text>
      </m.g>

      {/* the boundary seals your laptop */}
      <m.rect x={6} y={44} width={428} height={368} rx={26} className={styles.reachWall} style={{ pathLength: wall }} filter="url(#reach-glow)" />
      <m.text x={420} y={434} textAnchor="end" className={styles.reachWallLabel} style={{ opacity: wall }}>Stays with you</m.text>

      {/* its own computer */}
      <m.g style={{ opacity: pcOpacity, y: pcY }}>
        <rect x={470} y={112} width={160} height={232} rx={18} fill="url(#reach-pc)" className={styles.reachPc} />
        <rect x={470} y={112} width={160} height={30} rx={18} className={styles.reachLaptopBar} />
        <text x={550} y={132} textAnchor="middle" className={styles.reachLaptopTitle}>Its own computer</text>
        <rect x={488} y={292} width={124} height={34} rx={9} className={styles.reachPcSlot} />
        <foreignObject x={488} y={292} width={124} height={34}>
          <div className={styles.reachPcSlotLabel}><TerminalSquare size={12} aria-hidden="true" />workspace</div>
        </foreignObject>
      </m.g>

      {/* reach lines, drawn under everything else */}
      {personal.map((item, index) => <Reach key={item.id} p={p} id={item.id} index={index} />)}
      <Reach p={p} id="project" index={personal.length} />

      {/* the one line you choose to share */}
      <m.path d={`M ${ITEM_POS.project.x + 60} ${ITEM_POS.project.y} C 440 ${ITEM_POS.project.y}, 446 309, 488 309`} className={styles.shareLine} style={{ pathLength: share }} />

      {personal.map((item, index) => <Item key={item.id} p={p} id={item.id} label={item.label} index={index} />)}
      <Item p={p} id="project" label={copy.project} index={personal.length} project />

      {/* the agent */}
      <m.g style={{ x: agentX, y: agentY, scale: agentScale }}>
        <m.circle r={46} className={styles.reachAgentHalo} style={{ opacity: wallGlow }} />
        <circle r={30} className={styles.reachAgent} />
        <text y={5} textAnchor="middle" className={styles.reachAgentLabel}>Agent</text>
      </m.g>
    </svg>
  );
}

export default function ReachScene({ copy }: { copy: ReachCopy }) {
  const outer = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const { off } = useMotionPref();
  const wide = useWideScreen();
  const pinned = wide && !off;
  const inView = useVisible(stage, { amount: 0.35, once: true });
  const p = useMotionValue(off ? 1 : 0);
  const [separate, setSeparate] = useState(off);

  const { scrollYProgress } = useScroll({ target: outer, offset: ["start start", "end end"] });
  useMotionValueEvent(scrollYProgress, "change", v => {
    if (pinned) p.set(v);
  });
  useMotionValueEvent(p, "change", v => setSeparate(v >= T.swapA + 0.04));

  useEffect(() => {
    if (off) {
      p.set(1);
      return;
    }
    if (pinned) {
      p.set(scrollYProgress.get());
      return;
    }
    if (inView) {
      const controls = animate(p, 1, { duration: 7.5, ease: "linear", delay: 0.2 });
      return () => controls.stop();
    }
  }, [off, pinned, inView, p, scrollYProgress]);

  function show(target: "shared" | "separate") {
    const point = target === "shared" ? SHARED_POINT : SEPARATE_POINT;
    if (pinned && outer.current) {
      const rect = outer.current.getBoundingClientRect();
      const top = window.scrollY + rect.top;
      const travel = outer.current.offsetHeight - window.innerHeight;
      window.scrollTo({ top: top + travel * point, behavior: "smooth" });
      return;
    }
    if (off) {
      p.set(point);
      return;
    }
    animate(p, point, { duration: 1.2, ease: [0.65, 0, 0.35, 1] });
  }

  const aOpacity = useTransform(p, [T.swapA, T.swapA + 0.05], [1, 0]);
  const aY = useTransform(p, [T.swapA, T.swapA + 0.06], [0, -40]);
  const bOpacity = useTransform(p, [T.swapB - 0.02, T.swapB + 0.05], [0, 1]);
  const bY = useTransform(p, [T.swapB - 0.02, T.swapB + 0.06], [40, 0]);
  const kicker = useTransform(p, [0.3, 0.4], [0, 1]);
  const current = separate ? copy.states[1] : copy.states[0];

  return (
    <div ref={outer} className={styles.reachOuter} data-pinned={pinned ? "" : undefined}>
      <div ref={stage} className={styles.reachStage}>
        <div className={styles.reachText}>
          <span className={styles.eyebrow}>{copy.eyebrow}</span>
          <m.div className={styles.reachBlock} style={pinned ? { opacity: aOpacity, y: aY } : undefined}>
            <h2 id="why-heading" className={styles.sectionTitle}>{copy.titleA}</h2>
            {copy.bodyA.map(line => <p key={line} className={styles.bodyText}>{line}</p>)}
            <m.p className={styles.reachKicker} style={pinned ? { opacity: kicker } : undefined}>{copy.kicker}</m.p>
          </m.div>
          <m.div className={`${styles.reachBlock} ${styles.reachBlockB}`} style={pinned ? { opacity: bOpacity, y: bY } : undefined}>
            <h3 className={styles.sectionTitle}>{copy.titleB}</h3>
            <p className={styles.bodyText}>{copy.bodyB}</p>
            <p className={styles.reachShare}><i aria-hidden="true" />{copy.shareCaption}</p>
          </m.div>
        </div>
        <div className={styles.reachVisual}>
          <Diagram p={p} copy={copy} />
          <div className={styles.reachControls} role="group" aria-label="Compare the two set-ups">
            {copy.states.map(state => (
              <button key={state.id} type="button" aria-pressed={(state.id === "separate") === separate} onClick={() => show(state.id as "shared" | "separate")}>
                {state.label}
              </button>
            ))}
          </div>
          <p className={styles.reachCaption} aria-live="polite">{current.caption}</p>
          <p className={styles.reachNote}>{copy.note}</p>
        </div>
      </div>
    </div>
  );
}

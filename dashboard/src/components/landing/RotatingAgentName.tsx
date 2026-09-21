"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Terminal-style decode for the hero headline:
 * "Launch <Hermes Agent → Claude Code → Codex → OpenClaw → AEON → any AI agent>
 *  in one click." — each new name scrambles through random glyphs and resolves
 * left-to-right, in a monospace "code token" with a blinking caret. Loops.
 *
 * Monospace keeps every glyph the same width, so the scramble never changes the
 * token's box size — the rest of the headline stays put. Names are also stacked
 * as invisible sizers so the box reserves the widest name (+ caret). The visual
 * is aria-hidden; HeroSection supplies an sr-only canonical for AT/SEO.
 */
const AGENT_NAMES = [
  "Hermes Agent",
  "Claude Code",
  "Codex",
  "OpenClaw",
  "AEON",
  "any AI agent",
] as const;

const CYCLE_MS = 2200;
const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/\\<>[]{}#*+=:";
const CARET = "▍";

export default function RotatingAgentName() {
  const [index, setIndex] = useState(0);
  const [display, setDisplay] = useState<string>(AGENT_NAMES[0]);
  const prevWordRef = useRef<string>(AGENT_NAMES[0]);
  const rafRef = useRef<number | null>(null);
  const reduceRef = useRef(false);

  // Advance to the next name on a fixed cadence (skip when reduced-motion).
  useEffect(() => {
    reduceRef.current = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reduceRef.current) return;
    const id = setInterval(() => {
      setIndex((prev) => (prev + 1) % AGENT_NAMES.length);
    }, CYCLE_MS);
    return () => clearInterval(id);
  }, []);

  // Run the decode whenever the target name changes.
  useEffect(() => {
    const to = AGENT_NAMES[index];
    const from = prevWordRef.current;
    // No animation needed: on mount (from === to) `display` already shows the
    // word, and under reduced-motion the index never advances past the first.
    if (reduceRef.current || from === to) {
      prevWordRef.current = to;
      return;
    }

    const len = Math.max(from.length, to.length);
    const schedule = Array.from({ length: len }, (_, i) => {
      const start = i * 2; // left-to-right reveal
      return { from: from[i] ?? "", to: to[i] ?? "", start, end: start + 9 + (i % 3) * 3 };
    });

    let frame = 0;
    const tick = () => {
      let out = "";
      let settled = 0;
      for (const cell of schedule) {
        if (cell.to === " ") {
          out += " ";
          settled++;
        } else if (frame >= cell.end) {
          out += cell.to;
          settled++;
        } else if (frame >= cell.start) {
          out += GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
        } else {
          out += cell.from && cell.from !== " " ? cell.from : "";
        }
      }
      setDisplay(out);
      if (settled === schedule.length) {
        prevWordRef.current = to;
        rafRef.current = null;
        return;
      }
      frame += 1;
      rafRef.current = requestAnimationFrame(tick);
    };

    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [index]);

  const tokenStyle: React.CSSProperties = {
    gridArea: "1 / 1",
    fontFamily: "var(--font-mono), 'Space Mono', monospace",
    fontSize: "0.86em",
    letterSpacing: "-0.01em",
    whiteSpace: "pre",
  };

  return (
    <span aria-hidden="true" style={{ display: "inline-grid", verticalAlign: "baseline" }}>
      {/* invisible sizers reserve the widest name (+ caret) */}
      {AGENT_NAMES.map((name) => (
        <span key={name} style={{ ...tokenStyle, visibility: "hidden" }}>
          {name}
          {CARET}
        </span>
      ))}
      {/* live decoding token */}
      <span style={{ ...tokenStyle, color: "var(--gold-leaf)" }}>
        {display}
        <span className="rot-caret">{CARET}</span>
      </span>
    </span>
  );
}

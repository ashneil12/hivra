"use client";

import React, { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";

import { hermesMotion } from "@/components/ui/motion";

interface Piece {
  id: number;
  dx: number;
  lift: number;
  fall: number;
  rot: number;
  size: number;
  round: boolean;
  color: string;
  delay: number;
  dur: number;
}

// Built in an effect (not during render) so the random calls stay out of the
// render phase — the repo's react-hooks/purity rule forbids Math.random() in
// render. One-shot: a single burst on mount.
function buildPieces(count: number, colors: string[], durationMs: number): Piece[] {
  return Array.from({ length: count }, (_, i) => {
    const angle = Math.random() * Math.PI * 2;
    const velocity = 90 + Math.random() * 300;
    return {
      id: i,
      dx: Math.cos(angle) * velocity,
      lift: 70 + Math.random() * 230,
      fall: 360 + Math.random() * 460,
      rot: Math.random() * 720 - 360,
      size: 6 + Math.random() * 7,
      round: Math.random() > 0.6,
      color: colors[i % colors.length],
      delay: Math.random() * 0.14,
      dur: (durationMs / 1000) * (0.8 + Math.random() * 0.5),
    };
  });
}

/**
 * Dependency-free celebration confetti built on framer-motion (already a
 * project dep — no canvas-confetti). One burst on mount: particles pop up
 * from an origin point, then fall under faux gravity while fading. Honors
 * `prefers-reduced-motion` by rendering nothing.
 *
 * Place inside a `position: relative; overflow: hidden` container — the
 * burst is clipped to that box. Purely decorative (aria-hidden).
 */
export function ConfettiBurst({
  count = 84,
  colors = ["#ff2c2d", "#e3c989", "#b08d3f", "#1a1a1a", "#fdfcf9"],
  originX = 0.5,
  originY = 0.3,
  durationMs = 2100,
}: {
  count?: number;
  colors?: string[];
  originX?: number;
  originY?: number;
  durationMs?: number;
}) {
  const reduceMotion = useReducedMotion();
  const [pieces, setPieces] = useState<Piece[]>([]);

  useEffect(() => {
    if (reduceMotion) return;
    setPieces(buildPieces(count, colors, durationMs));
    // One-shot burst on mount; intentionally not re-running on prop identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (reduceMotion || pieces.length === 0) return null;

  return (
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        pointerEvents: "none",
        zIndex: 6,
      }}
    >
      {pieces.map((p) => (
        <motion.span
          key={p.id}
          initial={{ opacity: 0, x: 0, y: 0, rotate: 0, scale: 0.6 }}
          animate={{
            opacity: [0, 1, 1, 0],
            x: [0, p.dx * 0.4, p.dx * 0.85, p.dx],
            y: [0, -p.lift, p.fall * 0.55, p.fall],
            rotate: p.rot,
            scale: 1,
          }}
          transition={{
            duration: p.dur,
            delay: p.delay,
            ease: hermesMotion.ease,
            times: [0, 0.15, 0.7, 1],
          }}
          style={{
            position: "absolute",
            left: `${originX * 100}%`,
            top: `${originY * 100}%`,
            width: p.size,
            height: p.round ? p.size : p.size * 0.5,
            borderRadius: p.round ? "50%" : 1,
            background: p.color,
          }}
        />
      ))}
    </div>
  );
}

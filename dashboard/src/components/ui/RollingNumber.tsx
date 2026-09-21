"use client";

import React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

interface RollingNumberProps {
  value: number;
  locale?: string;
  className?: string;
  style?: React.CSSProperties;
  ariaLabel?: string;
}

export function RollingNumber({ value, locale = "en-US", className, style, ariaLabel }: RollingNumberProps) {
  const reduceMotion = useReducedMotion();
  const formatted = Number.isFinite(value) ? value.toLocaleString(locale) : "—";
  const chars = formatted.split("");

  return (
    <span
      className={className}
      style={{ display: "inline-flex", alignItems: "baseline", ...style }}
      aria-label={ariaLabel ?? `${formatted}`}
      role="text"
    >
      {chars.map((char, index) => {
        const isDigit = /\d/.test(char);
        const positionKey = `pos-${chars.length}-${index}`;
        if (!isDigit) {
          return (
            <span
              key={positionKey}
              aria-hidden="true"
              style={{ display: "inline-block", lineHeight: 1.2 }}
            >
              {char}
            </span>
          );
        }
        return (
          <span
            key={positionKey}
            aria-hidden="true"
            style={{
              display: "inline-block",
              position: "relative",
              overflow: "hidden",
              lineHeight: 1.2,
              height: "1.2em",
              minWidth: "0.55em",
              textAlign: "center",
            }}
          >
            <AnimatePresence initial={false} mode="popLayout">
              <motion.span
                key={char}
                initial={reduceMotion ? { y: 0, opacity: 1 } : { y: "100%", opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={reduceMotion ? { y: 0, opacity: 0 } : { y: "-100%", opacity: 0 }}
                transition={
                  reduceMotion
                    ? { duration: 0 }
                    : { type: "spring", stiffness: 220, damping: 26, mass: 0.9 }
                }
                style={{ display: "inline-block", lineHeight: 1.2 }}
              >
                {char}
              </motion.span>
            </AnimatePresence>
          </span>
        );
      })}
    </span>
  );
}

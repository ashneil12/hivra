"use client";

import type { Transition, Variants } from "framer-motion";

const HERMES_EASE: [number, number, number, number] = [0.16, 1, 0.3, 1];
const HERMES_SNAPPY_EASE: [number, number, number, number] = [0.2, 0.9, 0.24, 1];

export const hermesMotion = {
  ease: HERMES_EASE,
  snappyEase: HERMES_SNAPPY_EASE,
  duration: {
    instant: 0.01,
    fast: 0.18,
    base: 0.28,
    slow: 0.42,
  },
  spring: {
    dock: {
      type: "spring" as const,
      stiffness: 380,
      damping: 30,
      mass: 0.82,
    },
    panel: {
      type: "spring" as const,
      stiffness: 320,
      damping: 28,
      mass: 0.88,
    },
  },
};

type PresenceOptions = {
  offset?: number;
  scale?: number;
};

type FadeSlideOptions = {
  axis?: "x" | "y";
  offset?: number;
  exitOffset?: number;
  duration?: number;
};

function buildHiddenState(
  reduceMotion: boolean,
  { offset = 20, scale = 0.985 }: PresenceOptions = {}
) {
  return reduceMotion
    ? { opacity: 0 }
    : {
        opacity: 0,
        y: offset,
        scale,
      };
}

function buildVisibleState(reduceMotion: boolean) {
  return reduceMotion
    ? { opacity: 1 }
    : {
        opacity: 1,
        y: 0,
        scale: 1,
      };
}

export function buildHermesEntranceTransition(
  reduceMotion: boolean,
  delay = 0,
  duration = hermesMotion.duration.base
): Transition {
  return reduceMotion
    ? {
        duration: hermesMotion.duration.instant,
        delay,
      }
    : {
        duration,
        delay,
        ease: hermesMotion.ease,
      };
}

export function buildHermesEntranceVariants(
  reduceMotion: boolean,
  options?: PresenceOptions
): Variants {
  return {
    hidden: buildHiddenState(reduceMotion, options),
    visible: {
      ...buildVisibleState(reduceMotion),
      transition: buildHermesEntranceTransition(reduceMotion),
    },
  };
}

// Shared fade/slide motion for premium surfaces that should avoid spring or scale wobble.
export function buildHermesFadeSlideVariants(
  reduceMotion: boolean,
  options?: FadeSlideOptions
): Variants {
  const axis = options?.axis ?? "y";
  const offset = options?.offset ?? 18;
  const exitOffset = options?.exitOffset ?? Math.max(10, offset - 6);
  const duration = options?.duration ?? hermesMotion.duration.base;

  return {
    hidden: reduceMotion
      ? { opacity: 0 }
      : {
          opacity: 0,
          [axis]: offset,
        },
    visible: reduceMotion
      ? {
          opacity: 1,
          transition: buildHermesEntranceTransition(reduceMotion, 0, duration),
        }
      : {
          opacity: 1,
          [axis]: 0,
          transition: buildHermesEntranceTransition(reduceMotion, 0, duration),
        },
    exit: reduceMotion
      ? {
          opacity: 0,
          transition: buildHermesOverlayTransition(reduceMotion),
        }
      : {
          opacity: 0,
          [axis]: exitOffset,
          transition: buildHermesOverlayTransition(reduceMotion),
        },
  };
}

export function buildHermesStaggerVariants(
  reduceMotion: boolean,
  staggerChildren = 0.08,
  delayChildren = 0
): Variants {
  return {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: reduceMotion
        ? {
            duration: hermesMotion.duration.instant,
            delayChildren,
          }
        : {
            staggerChildren,
            delayChildren,
          },
    },
  };
}

function buildHermesOverlayTransition(reduceMotion: boolean): Transition {
  return reduceMotion
    ? { duration: hermesMotion.duration.instant }
    : {
        duration: hermesMotion.duration.fast,
        ease: hermesMotion.snappyEase,
      };
}

export function buildHermesOverlayVariants(reduceMotion: boolean): Variants {
  return {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: buildHermesOverlayTransition(reduceMotion),
    },
    exit: {
      opacity: 0,
      transition: buildHermesOverlayTransition(reduceMotion),
    },
  };
}

export function buildHermesSurfaceSpring(
  reduceMotion: boolean,
  spring: keyof typeof hermesMotion.spring = "panel"
): Transition {
  return reduceMotion
    ? { duration: hermesMotion.duration.instant }
    : hermesMotion.spring[spring];
}

export function buildHermesSurfaceVariants(
  reduceMotion: boolean,
  options?: PresenceOptions & { spring?: keyof typeof hermesMotion.spring }
): Variants {
  const spring = options?.spring ?? "panel";
  return {
    hidden: buildHiddenState(reduceMotion, options),
    visible: {
      ...buildVisibleState(reduceMotion),
      transition: buildHermesSurfaceSpring(reduceMotion, spring),
    },
    exit: {
      ...buildHiddenState(reduceMotion, {
        offset: Math.max(12, (options?.offset ?? 20) - 4),
        scale: options?.scale ?? 0.985,
      }),
      transition: buildHermesOverlayTransition(reduceMotion),
    },
  };
}

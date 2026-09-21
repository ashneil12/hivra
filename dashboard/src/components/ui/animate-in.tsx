"use client";

import React, { ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";

import {
  buildHermesEntranceTransition,
  buildHermesEntranceVariants,
  buildHermesStaggerVariants,
} from "@/components/ui/motion";

interface AnimateInProps {
  children: ReactNode;
  delay?: number;
  duration?: number;
  yOffset?: number;
  className?: string;
  style?: React.CSSProperties;
}

export function AnimateIn({ children, delay = 0, duration = 0.6, yOffset = 20, className, style }: AnimateInProps) {
  const reduceMotion = useReducedMotion();
  const variants = buildHermesEntranceVariants(Boolean(reduceMotion), { offset: yOffset });

  return (
    <motion.div
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, margin: "0px" }}
      variants={variants}
      transition={buildHermesEntranceTransition(Boolean(reduceMotion), delay, duration)}
      className={className}
      style={style}
    >
      {children}
    </motion.div>
  );
}

export function AnimateStaggerGroup({ children, className, style, staggerDelay = 0.1, delay = 0 }: { children: ReactNode, className?: string, style?: React.CSSProperties, staggerDelay?: number, delay?: number }) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, margin: "0px", amount: 0.1 }}
      variants={buildHermesStaggerVariants(Boolean(reduceMotion), staggerDelay, delay)}
      className={className}
      style={style}
    >
      {children}
    </motion.div>
  );
}

export function AnimateStaggerItem({ children, className, style, yOffset = 20 }: { children: ReactNode, className?: string, style?: React.CSSProperties, yOffset?: number }) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      variants={buildHermesEntranceVariants(Boolean(reduceMotion), { offset: yOffset })}
      className={className}
      style={style}
    >
      {children}
    </motion.div>
  );
}

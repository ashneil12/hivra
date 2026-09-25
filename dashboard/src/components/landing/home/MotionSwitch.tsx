"use client";

import { useMotionPref } from "./motion";
import styles from "./home.module.css";

/** Lets anyone turn the page's motion off, and remembers it. */
export default function MotionSwitch() {
  const { off, ready, setUserOff } = useMotionPref();
  if (!ready) return null;
  return (
    <button type="button" className={styles.motionSwitch} aria-pressed={!off} onClick={() => setUserOff(!off)}>
      <span aria-hidden="true" data-on={!off ? "" : undefined} />
      Motion {off ? "off" : "on"}
    </button>
  );
}

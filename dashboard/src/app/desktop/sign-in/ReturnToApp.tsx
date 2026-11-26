"use client";

import { useEffect, useState } from "react";
import styles from "../desktop.module.css";

/**
 * Sends the browser to hivra:// once. The tab stays open because browsers can
 * ask before opening an external app, and the person may need the manual link
 * after answering or dismissing that prompt.
 */
export default function ReturnToApp({ href }: { href: string }) {
  const [handedOff, setHandedOff] = useState(false);

  useEffect(() => {
    window.location.href = href;
    const timer = window.setTimeout(() => setHandedOff(true), 1500);
    return () => window.clearTimeout(timer);
  }, [href]);

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>{handedOff ? "Finish in the Hivra app" : "Opening Hivra…"}</h1>
        <p className={styles.body}>
          {handedOff
            ? "If your browser asked whether to open Hivra, choose Open. You can close this tab after the app opens."
            : "Taking you back to the Hivra app."}
        </p>
        <a className={styles.button} href={href}>Open the Hivra app</a>
      </div>
    </main>
  );
}

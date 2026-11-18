"use client";

import { useEffect } from "react";
import styles from "../desktop.module.css";

/** Sends the browser to hivra:// once, and offers a button in case the browser asks first. */
export default function ReturnToApp({ href }: { href: string }) {
  useEffect(() => {
    window.location.href = href;
  }, [href]);

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>You&apos;re signed in</h1>
        <p className={styles.body}>Head back to the Hivra app to carry on. You can close this tab.</p>
        <a className={styles.button} href={href}>Open the Hivra app</a>
      </div>
    </main>
  );
}

"use client";

import { useEffect, useState } from "react";
import styles from "../desktop.module.css";

/**
 * Sends the browser to hivra:// once, then tries to close the tab.
 *
 * Browsers only let a page close a tab that a script opened, so the close
 * usually does nothing; the page then says plainly that the tab can go. The
 * button stays for a browser that asked before opening the app.
 */
export default function ReturnToApp({ href }: { href: string }) {
  const [handedOff, setHandedOff] = useState(false);

  useEffect(() => {
    window.location.href = href;
    const timer = window.setTimeout(() => {
      setHandedOff(true);
      window.close();
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [href]);

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>{handedOff ? "You're signed in" : "Opening Hivra…"}</h1>
        <p className={styles.body}>
          {handedOff
            ? "The Hivra app has your sign-in. You can close this tab."
            : "Taking you back to the Hivra app."}
        </p>
        <a className={styles.button} href={href}>Open the Hivra app</a>
      </div>
    </main>
  );
}

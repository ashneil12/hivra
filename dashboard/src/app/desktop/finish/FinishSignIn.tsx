"use client";

import { useEffect, useRef, useState } from "react";
import { useClerk } from "@clerk/nextjs";
import styles from "../desktop.module.css";

/**
 * Turns the desktop app's one-time ticket into a session in this web view,
 * then opens Home. A web view that already holds a session (another account)
 * is signed out first so the ticket's account wins.
 */
export default function FinishSignIn({ ticket }: { ticket: string }) {
  const clerk = useClerk();
  const started = useRef(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!clerk.loaded || started.current) return;
    started.current = true;
    (async () => {
      try {
        if (clerk.session) await clerk.signOut();
        const signIn = clerk.client?.signIn;
        if (!signIn) throw new Error("sign-in unavailable");
        const attempt = await signIn.create({ strategy: "ticket", ticket });
        if (attempt.status !== "complete" || !attempt.createdSessionId) throw new Error(`status ${attempt.status}`);
        await clerk.setActive({ session: attempt.createdSessionId });
        window.location.replace("/dashboard");
      } catch {
        setFailed(true);
      }
    })();
  }, [clerk, ticket]);

  return (
    <main className={styles.page}>
      <div className={styles.card} role="status" aria-live="polite">
        {failed ? (
          <>
            <h1 className={styles.title}>That sign-in link has expired</h1>
            <p className={styles.body}>Links from the browser only last two minutes. Try signing in again from the app.</p>
            <a className={styles.button} href="/sign-in">Sign in here instead</a>
          </>
        ) : (
          <>
            <h1 className={styles.title}>Signing you in…</h1>
            <p className={styles.body}>This only takes a moment.</p>
          </>
        )}
      </div>
    </main>
  );
}

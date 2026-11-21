"use client";

// Ties the setup request to the signed-in person, then opens Launch with the
// agent preselected. On a refusal it says why and stays put.

import { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./page.module.css";

export default function ContinueSetupButton({ code }: { code: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/agent-setup/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const body = await res.json().catch(() => null) as { data?: { launchPath?: string }; error?: string } | null;
      const launchPath = body?.data?.launchPath;
      if (res.ok && launchPath && launchPath.startsWith("/dashboard/launch")) {
        router.push(launchPath);
        return;
      }
      setError(body?.error ?? "Hivra couldn't continue this setup. Try again in a moment.");
    } catch {
      setError("Hivra couldn't reach the server. Check your connection and try again.");
    }
    setBusy(false);
  };

  return (
    <>
      <button type="button" className={`action-button ${styles.primary}`} onClick={go} disabled={busy}>
        {busy ? "Opening Launch…" : "Continue to Launch"}
      </button>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </>
  );
}

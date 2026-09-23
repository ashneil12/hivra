"use client";

import { useCallback, useEffect, useState } from "react";

import { clientLog } from "@/lib/client/logger";

import styles from "./BillingPanels.module.css";

interface ManagedVeniceInstanceSummary {
  id: string;
  name: string;
  status: string;
  walletType: string | null;
}

interface SwitchResult {
  applied: boolean;
  applyError: string | null;
}

export function isManagedVeniceInstance(row: Record<string, unknown>): boolean {
  const config = row.config && typeof row.config === "object" ? (row.config as Record<string, unknown>) : null;
  const mv = config?.managedVenice && typeof config.managedVenice === "object"
    ? (config.managedVenice as Record<string, unknown>)
    : null;
  if (mv?.enabled === true) return true;
  // The customer provision path never writes config.managedVenice (0 of 181
  // prod instances ever carried it), so the durable signal is the managed-proxy
  // base URL persisted on agentSettings — mirrors the server off-ramp gate and
  // resolveProviderBaseUrl. Without this the panel matched zero real managed boxes.
  const agentSettings =
    config?.agentSettings && typeof config.agentSettings === "object"
      ? (config.agentSettings as Record<string, unknown>)
      : null;
  const customLlmBaseUrl =
    typeof agentSettings?.customLlmBaseUrl === "string" ? agentSettings.customLlmBaseUrl : "";
  return customLlmBaseUrl.includes("/api/managed-venice/");
}

function readWalletType(row: Record<string, unknown>): string | null {
  const config = row.config && typeof row.config === "object" ? (row.config as Record<string, unknown>) : null;
  const mv = config?.managedVenice && typeof config.managedVenice === "object"
    ? (config.managedVenice as Record<string, unknown>)
    : null;
  const wallet = typeof mv?.walletType === "string" ? mv.walletType : null;
  return wallet;
}

export function ManagedVeniceByokSwitchPanel() {
  const [instances, setInstances] = useState<ManagedVeniceInstanceSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keysByInstance, setKeysByInstance] = useState<Record<string, string>>({});
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [resultByInstance, setResultByInstance] = useState<Record<string, SwitchResult | { error: string }>>({});

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/instances", { cache: "no-store" });
      if (!res.ok) {
        setLoadError("Could not load your agents. Refresh to retry.");
        setInstances([]);
        return;
      }
      const payload = await res.json();
      const rows = Array.isArray(payload?.data?.instances)
        ? (payload.data.instances as Record<string, unknown>[])
        : [];
      const filtered = rows.filter(isManagedVeniceInstance);
      const summaries = filtered.map<ManagedVeniceInstanceSummary>((row) => ({
        id: String(row.id ?? ""),
        name: typeof row.name === "string" ? row.name : String(row.id ?? "agent"),
        status: typeof row.status === "string" ? row.status : "unknown",
        walletType: readWalletType(row),
      }));
      setInstances(summaries);
      setLoadError(null);
    } catch (error) {
      clientLog.warn(
        "managed-venice-byok-switch: instances fetch failed",
        { source: "managed-venice-byok-switch-panel" },
        error
      );
      setLoadError("Could not load your agents. Refresh to retry.");
      setInstances([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSwitch = async (instanceId: string) => {
    const apiKey = (keysByInstance[instanceId] || "").trim();
    if (!apiKey) {
      setResultByInstance((prev) => ({
        ...prev,
        [instanceId]: { error: "Paste your Venice API key first." },
      }));
      return;
    }
    setPendingId(instanceId);
    setResultByInstance((prev) => {
      const next = { ...prev };
      delete next[instanceId];
      return next;
    });
    try {
      const res = await fetch(`/api/instances/${encodeURIComponent(instanceId)}/managed-venice`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || !payload?.success) {
        const message =
          (payload?.error && typeof payload.error === "string" && payload.error) ||
          "Switch failed. Confirm your Venice API key and try again.";
        setResultByInstance((prev) => ({ ...prev, [instanceId]: { error: message } }));
        return;
      }
      const applied = Boolean(payload?.data?.applied);
      const applyError =
        typeof payload?.data?.applyError === "string" ? payload.data.applyError : null;
      setResultByInstance((prev) => ({
        ...prev,
        [instanceId]: { applied, applyError },
      }));
      setKeysByInstance((prev) => {
        const next = { ...prev };
        delete next[instanceId];
        return next;
      });
      await refresh();
    } catch (error) {
      clientLog.warn(
        "managed-venice-byok-switch: switch request failed",
        { source: "managed-venice-byok-switch-panel", instanceId },
        error
      );
      setResultByInstance((prev) => ({
        ...prev,
        [instanceId]: { error: "Switch failed. Network or server error — try again." },
      }));
    } finally {
      setPendingId(null);
    }
  };

  if (instances === null) {
    return (
      <section data-testid="managed-venice-byok-switch-panel" className={styles.panel}>
        <p className={styles.lede} style={{ margin: 0 }}>Loading your managed Venice agents…</p>
      </section>
    );
  }

  if (instances.length === 0 && !loadError) {
    return null;
  }

  return (
    <section
      data-testid="managed-venice-byok-switch-panel"
      className={styles.panel}
      aria-labelledby="managed-venice-byok-title"
    >
      <p className={styles.eyebrow}>Bring your own Venice key</p>
      <h3 className={styles.title} id="managed-venice-byok-title">Switch off managed Venice</h3>
      <p className={styles.lede}>
        Route this agent directly to api.venice.ai with your own Venice API key. Your managed
        proxy key is revoked, the agent&apos;s runtime is rewritten, and the container restarts.
      </p>
      <p className={styles.lede}>
        Want <strong>OpenAI, Anthropic, OpenRouter</strong> or another provider instead? You
        don&apos;t need this form — open your agent and switch the model from its built-in model
        picker, then add your provider key there. The form below only covers routing directly to
        api.venice.ai with your own Venice key.
      </p>

      {loadError ? <p className={styles.errorText} style={{ marginTop: "0.75rem" }}>{loadError}</p> : null}

      <div className={styles.byokList}>
        {instances.map((inst) => {
          const result = resultByInstance[inst.id];
          const pending = pendingId === inst.id;
          const inputId = `managed-venice-byok-key-${inst.id}`;
          return (
            <div key={inst.id} className={styles.byokRow}>
              <div className={styles.byokRowHead}>
                <label className={styles.byokName} htmlFor={inputId}>{inst.name}</label>
                <span className={styles.byokMeta}>
                  {inst.status}
                  {inst.walletType ? ` · wallet: ${inst.walletType}` : null}
                </span>
              </div>
              <div className={styles.byokForm}>
                <input
                  id={inputId}
                  type="password"
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="done"
                  placeholder="Paste your Venice API key (from venice.ai/settings/api)"
                  value={keysByInstance[inst.id] || ""}
                  onChange={(event) =>
                    setKeysByInstance((prev) => ({ ...prev, [inst.id]: event.target.value }))
                  }
                  disabled={pending}
                  className={styles.input}
                />
                <button
                  type="button"
                  onClick={() => handleSwitch(inst.id)}
                  disabled={pending}
                  className={`${styles.button} ${styles.primary}`}
                >
                  {pending ? "Switching…" : "Switch to my key"}
                </button>
              </div>
              {result && "error" in result ? (
                <p className={styles.errorText}>{result.error}</p>
              ) : null}
              {result && !("error" in result) ? (
                <p className={result.applied ? styles.resultGood : styles.resultWarn}>
                  {result.applied
                    ? "Switched. The agent restarts with your Venice key on the next request."
                    : result.applyError ||
                      "Saved your key, but the live container update did not run yet."}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

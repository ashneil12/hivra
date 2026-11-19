"use client";

import { useEffect, useRef, useState } from "react";
import { getBoxModel, setBoxModel } from "@/lib/hivra/agent-api";
import { veniceModelName } from "@/lib/venice/model-catalog";
import { VeniceModelList } from "./VeniceModelList";
import styles from "./AgentModelSettings.module.css";

type Load = { state: "loading" } | { state: "stopped" } | { state: "unreachable" } | { state: "old" } | { state: "other" } | { state: "ready" };

export function HermesModelSettings({ chatUrl, apiToken, agentName, running, disabled }: {
  chatUrl: string; apiToken?: string | null; agentName: string; running: boolean; disabled: boolean;
}) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [current, setCurrent] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    let alive = true;
    // A stopped computer cannot answer; say so instead of asking for an update.
    if (!running) { setLoad({ state: "stopped" }); return () => { alive = false; }; }
    setLoad({ state: "loading" });
    void getBoxModel(chatUrl, apiToken).then(r => {
      if (!alive) return;
      if (r.error) setLoad({ state: "unreachable" });
      else if (!r.hermesConfig) setLoad({ state: "old" });
      else if (r.provider === "other") setLoad({ state: "other" });
      else { setCurrent(r.model); setLoad({ state: "ready" }); }
    });
    return () => { alive = false; };
  }, [chatUrl, apiToken, running]);

  if (load.state === "loading") return <p className={styles.help}>Checking which model {agentName} uses…</p>;
  if (load.state === "stopped") return <p className={styles.help}>Start this computer to choose which model {agentName} uses.</p>;
  if (load.state === "unreachable") return <p className={styles.notice}>Hivra couldn&apos;t reach {agentName} to read its model. Refresh the page to try again, or pick a model in {agentName}&apos;s own settings.</p>;
  if (load.state === "old") return <p className={styles.notice}>Update {agentName} to choose its model here. Until then, pick a model in {agentName}&apos;s own settings.</p>;
  if (load.state === "other") return <p className={styles.notice}>{agentName} uses a provider you set up in {agentName} itself, so its model is chosen there.</p>;

  const selected = picked ?? current;
  const canUse = running && !disabled && !saving && !!picked && picked !== current;
  const apply = async () => {
    if (!picked || inFlight.current || !canUse) return;
    inFlight.current = true; setSaving(true); setNotice(null); setError(null);
    const id = picked;
    try {
      const r = await setBoxModel(chatUrl, id, apiToken);
      if (r.ok) { setCurrent(id); setPicked(null); setNotice(`${agentName} now uses ${veniceModelName(id)} for new chats.`); }
      else setError(r.error || "Could not change the model.");
    } finally { inFlight.current = false; setSaving(false); }
  };
  return <div style={{ display: "grid", gap: 10 }}>
    <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--ink-black)" }}>Model</h4>
    <p className={styles.help}>Which model {agentName} uses for new chats. {agentName}&apos;s own model picker keeps working too.</p>
    <VeniceModelList label="Model" value={selected} current={current} disabled={!running || disabled || saving}
      onChange={id => { setPicked(id); setNotice(null); setError(null); }} />
    {!running ? <p className={styles.help}>Start this computer to change its model.</p> : null}
    <div className={styles.actions}>
      <button type="button" className={styles.primary} disabled={!canUse} onClick={() => void apply()}>
        Use {veniceModelName(selected)}
      </button>
    </div>
    {notice ? <p role="status" className={styles.notice}>{notice}</p> : null}
    {error ? <p role="alert" className={styles.warning}>{error}</p> : null}
  </div>;
}

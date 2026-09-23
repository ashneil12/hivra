"use client";

import {
  ArrowUpRight,
  CheckCircle2,
  CircleDashed,
  ExternalLink,
  KeyRound,
  Link2,
  Loader2,
  RadioTower,
  RefreshCw,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import styles from "./BuzzConnectionsPage.module.css";

type Connection = {
  id: string;
  relayUrl: string;
  openUrl: string;
  relayPublicKey: string;
  displayName: string;
  software: string | null;
  version: string | null;
  requiresMembership: boolean;
  revision: number;
  status: "ready" | "disconnected";
  observedAt: string;
};

type Binding = {
  id: string;
  connectionId: string;
  agentId: string;
  agentName: string;
  agentType: string;
  publicKey: string;
  status: "claim_pending" | "joined" | "leave_pending" | "revoked";
  lastHealthAt: string | null;
  joinedAt: string | null;
  revokedAt: string | null;
  lastErrorCode: string | null;
  runtimeAdapter: "not_installed" | "install_pending" | "active" | "remove_pending" | "removed";
  runtimeProvider: "openai" | "anthropic" | "venice" | null;
  runtimeModel: string | null;
  runtimeLastObservedAt: string | null;
  runtimeLastErrorCode: string | null;
};

type Agent = {
  id: string;
  name: string;
  type: string;
  status: string;
  desiredState: string;
};

type Summary = { connections: Connection[]; bindings: Binding[]; agents: Agent[] };

class BuzzApiError extends Error {}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...init });
  const body = await response.json().catch(() => null) as { success?: boolean; data?: T; error?: string } | null;
  if (!response.ok || body?.success !== true || body.data === undefined) {
    throw new BuzzApiError(body?.error || "Buzz could not complete that request.");
  }
  return body.data;
}

function json(method: "POST" | "DELETE", body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function fingerprint(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-8)}`;
}

function statusLabel(status: Binding["status"]) {
  return status === "claim_pending" ? "Waiting to join"
    : status === "leave_pending" ? "Leaving relay"
    : status === "joined" ? "Membership verified" : "Disconnected";
}

function runtimeLabel(status: Binding["runtimeAdapter"]) {
  return status === "active" ? "Buzz runtime active"
    : status === "install_pending" ? "Runtime installation pending"
    : status === "remove_pending" ? "Runtime removal pending"
    : status === "removed" ? "Runtime removed" : "Runtime not installed";
}

type RuntimeDraft = {
  provider: "openai" | "anthropic" | "venice";
  model: string;
  apiKey: string;
  ownerPublicKey: string;
};

const newRuntimeDraft = (): RuntimeDraft => ({
  provider: "openai",
  model: "gpt-5",
  apiKey: "",
  ownerPublicKey: "",
});

export function BuzzConnectionsPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [relayUrl, setRelayUrl] = useState("");
  const [selectedAgent, setSelectedAgent] = useState<Record<string, string>>({});
  const [invite, setInvite] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingLeave, setConfirmingLeave] = useState<string | null>(null);
  // Removing the runtime deletes the sidecar and its in-guest secret file.
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);
  const [runtimeDrafts, setRuntimeDrafts] = useState<Record<string, RuntimeDraft>>({});

  const load = useCallback(async () => {
    try {
      setSummary(await api<Summary>("/api/hivra/buzz"));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Buzz connections could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const activeBindings = useMemo(() => new Set(
    (summary?.bindings ?? []).filter((binding) => binding.status !== "revoked")
      .map((binding) => `${binding.connectionId}:${binding.agentId}`),
  ), [summary]);

  async function connect(event: FormEvent) {
    event.preventDefault();
    setBusy("connect"); setError(null); setNotice(null);
    try {
      await api("/api/hivra/buzz", json("POST", { relayUrl }));
      setRelayUrl("");
      setNotice("Relay identity inspected and pinned to this account.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Buzz relay could not be connected.");
    } finally { setBusy(null); }
  }

  async function bindAgent(connectionId: string, agentId: string) {
    const inviteCode = invite[connectionId];
    if (!agentId || !inviteCode?.trim()) {
      setError("Choose an agent and paste its one-time Buzz invite.");
      return;
    }
    setBusy(`bind:${connectionId}`); setError(null); setNotice(null);
    try {
      const outcome = await api<{ status: string; reason?: string }>("/api/hivra/buzz/bindings", json("POST", {
        connectionId, agentId, inviteCode: inviteCode.trim(), operationId: crypto.randomUUID(),
      }));
      setInvite((current) => ({ ...current, [connectionId]: "" }));
      setNotice(outcome.status === "joined"
        ? "The relay verified this agent's independent identity."
        : "The request is safely saved. Resume it when the relay is reachable.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Agent could not join Buzz.");
    } finally { setBusy(null); }
  }

  async function action(binding: Binding, kind: "resume" | "health" | "disconnect") {
    setBusy(`${kind}:${binding.id}`); setError(null); setNotice(null);
    try {
      const path = `/api/hivra/buzz/bindings/${binding.id}`;
      const outcome: { status: string; healthy?: boolean; reason?: string } = kind === "disconnect"
        ? await api<{ status: string; healthy?: boolean; reason?: string }>(path, json("DELETE", {}))
        : await api<{ status: string; healthy?: boolean; reason?: string }>(path, json("POST", { action: kind }));
      setNotice(kind === "health"
        ? outcome.healthy ? "Relay membership is healthy." : "The relay did not confirm membership."
        : kind === "disconnect" && outcome.status === "revoked"
          ? "The relay identity was removed and its private key was destroyed."
          : kind === "disconnect" && outcome.reason === "absence_proof_unavailable"
            ? "The remote leave was sent, but Hivra kept the private key until another joined identity can verify the relay-signed absence roster."
          : outcome.status === "joined" ? "Relay membership is verified." : "The operation remains safely resumable.");
      setConfirmingLeave(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Buzz operation could not be completed.");
    } finally { setBusy(null); }
  }

  function runtimeDraft(bindingId: string) {
    return runtimeDrafts[bindingId] ?? newRuntimeDraft();
  }

  function updateRuntimeDraft(bindingId: string, patch: Partial<RuntimeDraft>) {
    setRuntimeDrafts((current) => ({
      ...current,
      [bindingId]: { ...(current[bindingId] ?? newRuntimeDraft()), ...patch },
    }));
  }

  async function runtimeAction(binding: Binding, kind: "install" | "resume" | "health" | "remove") {
    const draft = runtimeDraft(binding.id);
    if (kind === "install" && ((draft.provider !== "venice" && !draft.apiKey)
      || !draft.model.trim() || !/^[a-f0-9]{64}$/.test(draft.ownerPublicKey))) {
      setError("Choose a model and enter the 64-character Buzz owner public key. Direct providers also need an API key.");
      return;
    }
    setBusy(`runtime:${kind}:${binding.id}`); setError(null); setNotice(null);
    try {
      const body = kind === "install" ? {
        action: "runtime_install",
        operationId: crypto.randomUUID(),
        provider: draft.provider,
        model: draft.model.trim(),
        ...(draft.provider === "venice" ? {} : { apiKey: draft.apiKey }),
        ownerPublicKey: draft.ownerPublicKey,
      } : { action: `runtime_${kind}` };
      const outcome = await api<{ status: string; healthy?: boolean; reason?: string }>(
        `/api/hivra/buzz/bindings/${binding.id}`,
        json("POST", body),
      );
      if (kind === "install") {
        updateRuntimeDraft(binding.id, { apiKey: "" });
      }
      setNotice(kind === "health"
        ? outcome.healthy ? "The pinned Buzz sidecar is active on this computer." : "The runtime could not be confirmed."
        : kind === "remove" && outcome.status === "removed" ? "Buzz runtime and its in-guest secret file were removed."
        : outcome.status === "active" ? "Buzz runtime is active and restricted to its owner identity."
        : "The runtime operation is safely saved and can be resumed.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Buzz runtime operation could not be completed.");
    } finally { setBusy(null); }
  }

  return (
    <main id="buzz" className={styles.page}>
      <div className={styles.gridBackdrop} aria-hidden="true" />
      <div className={styles.inner}>
        <Link href="/dashboard?runtimes=1" className={styles.breadcrumb}>Home <span>/</span> Collaboration</Link>

        <header className={styles.header}>
          <div>
            <span className={styles.eyebrow}><RadioTower size={12} /> Agent collaboration</span>
            <h1>Collaboration, <em>without shared identity.</em></h1>
            <p>Buzz is the first collaboration adapter: connect a workspace, then admit each agent with its own cryptographic identity.</p>
          </div>
          <div className={styles.headerState}>
            <span>Connection layer</span>
            <strong><span className={styles.liveDot} /> Private preview</strong>
          </div>
        </header>

        <section className={styles.truthStrip} aria-label="Current Buzz integration status">
          <div><ShieldCheck size={18} /><span><strong>Available now</strong> Pinned relay identity, per-agent keys, signed roster health and safe leave reconciliation.</span></div>
          <div><CircleDashed size={18} /><span><strong>Private preview</strong> Install the pinned Buzz ACP sidecar on a running Proxmox agent computer. Other substrates remain unavailable.</span></div>
        </section>

        {(error || notice) && (
          <div role={error ? "alert" : "status"} className={error ? styles.error : styles.notice}>
            {error || notice}
          </div>
        )}

        <div className={styles.workspace}>
          <aside className={styles.connectRail}>
            <div className={styles.railHeading}>
              <span>01</span>
              <div><h2>Connect a relay</h2><p>Use the HTTPS address shown by your Buzz workspace.</p></div>
            </div>
            <form onSubmit={connect} className={styles.form}>
              <label>
                <span>Relay URL</span>
                <input value={relayUrl} onChange={(event) => setRelayUrl(event.target.value)}
                  placeholder="https://buzz.example" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
                <small>Hivra verifies NIP-42/98 support and pins the relay&apos;s public key before saving it.</small>
              </label>
              <button className={styles.primary} disabled={busy !== null || !relayUrl.trim()}>
                {busy === "connect" ? <Loader2 className={styles.spinner} size={15} /> : <Link2 size={15} />}
                Connect relay
              </button>
            </form>
            <div className={styles.guide}>
              <h3>Need a Buzz workspace?</h3>
              <p>Create or open one in Buzz, make a single-use invite, then return here.</p>
              <a href="https://github.com/block/buzz" target="_blank" rel="noreferrer">Buzz project <ExternalLink size={12} /></a>
            </div>
            <dl className={styles.protocolFacts}>
              <div><dt>Auth</dt><dd>NIP-42 / 98</dd></div>
              <div><dt>Custody</dt><dd>AES-GCM sealed</dd></div>
              <div><dt>Identity</dt><dd>1 key / agent</dd></div>
            </dl>
          </aside>

          <section className={styles.connections}>
            <div className={styles.sectionHeading}>
              <div><span>02</span><h2>Agent memberships</h2></div>
              <button className={styles.iconButton} onClick={() => void load()} disabled={busy !== null || loading} aria-label="Refresh Buzz connections">
                <RefreshCw className={loading ? styles.spinner : undefined} size={15} />
              </button>
            </div>

            {loading ? (
              <div className={styles.skeleton} aria-label="Loading Buzz connections"><span /><span /><span /></div>
            ) : summary?.connections.length ? summary.connections.map((connection) => {
              const bindings = summary.bindings.filter((binding) => binding.connectionId === connection.id);
              const eligibleAgents = summary.agents.filter((agent) => !activeBindings.has(`${connection.id}:${agent.id}`));
              const currentAgent = selectedAgent[connection.id] || eligibleAgents[0]?.id || "";
              return (
                <article key={connection.id} className={styles.connection}>
                  <div className={styles.connectionHeader}>
                    <div className={styles.relayIdentity}>
                      <div className={styles.relayIcon}><RadioTower size={18} /></div>
                      <div><h3>{connection.displayName}</h3><p>{connection.relayUrl}</p></div>
                    </div>
                    <a href={connection.openUrl} target="_blank" rel="noreferrer" className={styles.openLink}>Open relay <ArrowUpRight size={13} /></a>
                  </div>
                  <div className={styles.relayMeta}>
                    <div><span>Relay key</span><strong title={connection.relayPublicKey}>{fingerprint(connection.relayPublicKey)}</strong></div>
                    <div><span>Protocol</span><strong>{connection.requiresMembership ? "Private membership" : "Open relay"}</strong></div>
                    <div><span>Revision</span><strong>{connection.revision}</strong></div>
                  </div>

                  <div className={styles.bindArea}>
                    <div className={styles.bindCopy}><h4>Admit an agent</h4><p>The invite is encrypted immediately and erased after a verified claim.</p></div>
                    {eligibleAgents.length ? (
                      <div className={styles.bindForm}>
                        <label><span>Agent</span><select value={currentAgent} onChange={(event) => setSelectedAgent((state) => ({ ...state, [connection.id]: event.target.value }))}>
                          {eligibleAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.type}</option>)}
                        </select></label>
                        <label><span>One-time invite</span><input type="password" value={invite[connection.id] || ""}
                          onChange={(event) => setInvite((state) => ({ ...state, [connection.id]: event.target.value }))} autoComplete="off" /></label>
                        <button className={styles.primary} onClick={() => void bindAgent(connection.id, currentAgent)}
                          disabled={busy !== null || !currentAgent || !invite[connection.id]?.trim()}>
                          {busy === `bind:${connection.id}` ? <Loader2 className={styles.spinner} size={14} /> : <KeyRound size={14} />} Admit agent
                        </button>
                      </div>
                    ) : (
                      <div className={styles.allAssigned}>Every available agent already has a live identity here. <Link href="/dashboard/launch">Launch another</Link></div>
                    )}
                  </div>

                  <div className={styles.bindingList}>
                    {bindings.length ? bindings.map((binding) => {
                      const draft = runtimeDraft(binding.id);
                      const canInstall = binding.status === "joined"
                        && (binding.runtimeAdapter === "not_installed" || binding.runtimeAdapter === "removed");
                      return (
                        <div key={binding.id} className={`${styles.bindingShell} ${binding.status === "revoked" ? styles.revoked : ""}`}>
                          <div className={styles.binding}>
                            <div className={styles.bindingMain}>
                              <span className={binding.status === "joined" ? styles.healthyDot : styles.pendingDot} />
                              <div><strong>{binding.agentName}</strong><small>{binding.agentType} · {fingerprint(binding.publicKey)}</small></div>
                            </div>
                            <div className={styles.bindingState}>
                              <span>{statusLabel(binding.status)}</span>
                              <small>{runtimeLabel(binding.runtimeAdapter)}{binding.runtimeModel ? ` · ${binding.runtimeModel}` : ""}</small>
                            </div>
                            <div className={styles.bindingActions}>
                              {binding.status === "claim_pending" && <button aria-label={`Resume Buzz join for ${binding.agentName}`} onClick={() => void action(binding, "resume")} disabled={busy !== null}>Resume</button>}
                              {binding.status === "joined" && <button aria-label={`Check Buzz membership for ${binding.agentName}`} onClick={() => void action(binding, "health")} disabled={busy !== null}><CheckCircle2 size={13} /> Membership</button>}
                              {binding.status !== "revoked" && confirmingLeave !== binding.id && (
                                <button aria-label={`Leave Buzz relay for ${binding.agentName}`} onClick={() => setConfirmingLeave(binding.id)} disabled={busy !== null}><Unplug size={13} /> Leave</button>
                              )}
                              {binding.status !== "revoked" && confirmingLeave === binding.id && (
                                <>
                                  <button aria-label={`Confirm Buzz leave for ${binding.agentName}`} onClick={() => void action(binding, "disconnect")} disabled={busy !== null}>Confirm leave</button>
                                  <button aria-label={`Cancel Buzz leave for ${binding.agentName}`} onClick={() => setConfirmingLeave(null)} disabled={busy !== null}>Cancel</button>
                                </>
                              )}
                            </div>
                          </div>
                          {canInstall && (
                            <div className={styles.runtimePanel}>
                              <div className={styles.runtimeCopy}>
                                <div><span>03</span><h4>Activate the in-computer runtime</h4></div>
                                <p>This creates a separate Buzz ACP sidecar. It uses this provider key and does not reuse the agent&apos;s existing vendor login or conversation.</p>
                              </div>
                              <div className={styles.runtimeForm}>
                                <label><span>Provider</span><select aria-label={`Buzz runtime provider for ${binding.agentName}`} value={draft.provider}
                                  onChange={(event) => updateRuntimeDraft(binding.id, {
                                    provider: event.target.value as RuntimeDraft["provider"],
                                    model: event.target.value === "anthropic" ? "claude-sonnet-4-5"
                                      : event.target.value === "venice" ? "deepseek-v4-flash-0731-fast" : "gpt-5",
                                  })}>
                                  <option value="openai">OpenAI</option><option value="anthropic">Anthropic</option>
                                  <option value="venice">Venice · saved API key</option>
                                </select></label>
                                <label><span>Model</span><input aria-label={`Buzz runtime model for ${binding.agentName}`} value={draft.model}
                                  autoCapitalize="none" autoCorrect="off" spellCheck={false}
                                  onChange={(event) => updateRuntimeDraft(binding.id, { model: event.target.value })} /></label>
                                {draft.provider === "venice" ? (
                                  <div className={styles.vaultCredential}><span>Credential</span><strong>Venice key from your API keys</strong>
                                    <Link href="/dashboard/vault">Manage key <ArrowUpRight size={12} /></Link></div>
                                ) : (
                                  <label><span>Provider API key</span><input aria-label={`Buzz runtime API key for ${binding.agentName}`} type="password"
                                    value={draft.apiKey} autoComplete="off" onChange={(event) => updateRuntimeDraft(binding.id, { apiKey: event.target.value })} /></label>
                                )}
                                <label className={styles.ownerField}><span>Buzz owner public key</span><input aria-label={`Buzz owner public key for ${binding.agentName}`}
                                  value={draft.ownerPublicKey} maxLength={64} autoCapitalize="none" autoCorrect="off" spellCheck={false}
                                  onChange={(event) => updateRuntimeDraft(binding.id, { ownerPublicKey: event.target.value.toLowerCase() })} /></label>
                                <button className={styles.primary} onClick={() => void runtimeAction(binding, "install")} disabled={busy !== null
                                  || (draft.provider !== "venice" && !draft.apiKey) || !draft.model.trim()
                                  || !/^[a-f0-9]{64}$/.test(draft.ownerPublicKey)}>
                                  {busy === `runtime:install:${binding.id}` ? <Loader2 className={styles.spinner} size={14} /> : <KeyRound size={14} />} Activate runtime
                                </button>
                              </div>
                              <small className={styles.secretNote}>The provider key is write-only: encrypted while installation is pending, then erased after the exact guest receipt is verified.</small>
                            </div>
                          )}
                          {binding.status === "joined" && binding.runtimeAdapter === "install_pending" && (
                            <div className={styles.runtimeBar}><span>Installation is pending and safely resumable.</span><button onClick={() => void runtimeAction(binding, "resume")} disabled={busy !== null}>Resume runtime</button></div>
                          )}
                          {binding.status === "joined" && binding.runtimeAdapter === "active" && (
                            <div className={styles.runtimeBar}><span><span className={styles.healthyDot} /> Owner-only Buzz sidecar active{binding.runtimeLastObservedAt ? ` · checked ${new Date(binding.runtimeLastObservedAt).toLocaleString()}` : ""}</span><div>
                              <button onClick={() => void runtimeAction(binding, "health")} disabled={busy !== null}>Check runtime</button>
                              {/* Remove becomes Cancel in place, so it keeps focus and a double tap cannot confirm. */}
                              <button aria-label={confirmingRemove === binding.id ? `Cancel Buzz runtime removal for ${binding.agentName}` : undefined}
                                onClick={() => setConfirmingRemove(confirmingRemove === binding.id ? null : binding.id)} disabled={busy !== null}>
                                {confirmingRemove === binding.id ? "Cancel" : "Remove runtime"}
                              </button>
                              {confirmingRemove === binding.id && (
                                <button aria-label={`Confirm remove runtime for ${binding.agentName}`} className={styles.dangerButton}
                                  onClick={() => { setConfirmingRemove(null); void runtimeAction(binding, "remove"); }} disabled={busy !== null}>Confirm remove</button>
                              )}
                            </div></div>
                          )}
                          {binding.status === "joined" && binding.runtimeAdapter === "remove_pending" && (
                            <div className={styles.runtimeBar}><span>Removal is pending; the relay identity remains intact.</span><button onClick={() => void runtimeAction(binding, "remove")} disabled={busy !== null}>Resume removal</button></div>
                          )}
                        </div>
                      );
                    }) : <div className={styles.emptyBindings}>No agents have joined this relay yet.</div>}
                  </div>
                </article>
              );
            }) : (
              <div className={styles.emptyState}>
                <RadioTower size={26} />
                <h3>No relay connected</h3>
                <p>Start with the relay address from Buzz. Nothing is installed on an agent until membership is verified.</p>
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

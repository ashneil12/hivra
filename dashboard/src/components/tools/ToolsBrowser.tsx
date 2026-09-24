"use client";

// ToolsBrowser — the /dashboard/tools surface (Tools v2).
//
// One place to browse every tool and install it onto ANY of your agents, across
// both lanes (CLI boxes + Hermes instances). Built to scale: search + category
// filter over the full catalog, and a per-tool agent picker so one action can fan
// out to many agents.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Check, Plus, Search, Wrench, Trash2, X, Zap, Layers, ExternalLink } from "lucide-react";
import touch from "@/components/tools/touch.module.css";
import { SafePortal } from "@/components/ui/SafePortal";
import { useInfrastructureDialog } from "@/components/infrastructure/useInfrastructureDialog";
import { ComposioKeyPanel } from "@/components/instances/ComposioKeyPanel";
import { ComposioAppPicker } from "@/components/instances/ComposioAppPicker";
import {
  useComposioKey,
  useComposioConnect,
  useComposioConnectedApps,
} from "@/lib/composio/use-composio-connect";

const mono: React.CSSProperties = {
  fontFamily: "var(--font-mono), monospace",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.16em",
  opacity: 0.62,
};

interface EnvField { key: string; label: string; secret: boolean; required: boolean; placeholder?: string }
interface ToolMeta {
  id: string; name: string; description: string; category: string;
  trust: string; mcpName: string; env: EnvField[]; skillCount: number;
  repoUrl?: string;
}
interface Target {
  uid: string; lane: "cli" | "hermes"; id: string; name: string;
  type: string; status: string; installable: boolean; blockedReason?: string;
  blockedMessage?: string; installedTools?: string[];
}
interface FanResult { uid: string; ok: boolean; error?: string }

const REMOVE_CONFIRM_MS = 4000;
// A second tap sooner than this after arming is the same double tap, not a confirmation.
const REMOVE_CONFIRM_DELAY_MS = 600;

async function readJson(r: Response): Promise<Record<string, unknown> | null> {
  try { return (await r.json()) as Record<string, unknown>; } catch { return null; }
}

const input: React.CSSProperties = {
  padding: "9px 11px", border: "1px solid var(--etched-border)",
  background: "rgba(255,255,255,0.04)", color: "var(--ink-black)",
  fontSize: 13, outline: "none", width: "100%", boxSizing: "border-box",
};

export function ToolsBrowser() {
  const [tools, setTools] = useState<ToolMeta[] | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [viewTab, setViewTab] = useState<"all" | "installed">("all");
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("all");
  const [openTool, setOpenTool] = useState<ToolMeta | null>(null);
  const [showComposioAppPicker, setShowComposioAppPicker] = useState(false);

  const composioKey = useComposioKey();
  const composioConnect = useComposioConnect();
  const connectedApps = useComposioConnectedApps();

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/tools", { cache: "no-store" });
      const j = await readJson(r);
      if (!r.ok || !j || j.success !== true) {
        setLoadError((j?.error as string) || `Couldn't load tools (${r.status})`);
        setTools([]);
        return;
      }
      const d = j.data as { tools?: ToolMeta[]; targets?: Target[] };
      setLoadError(null);
      setTools(d.tools || []);
      setTargets(d.targets || []);
    } catch (e) {
      setLoadError((e as Error).message || "Network error");
      setTools([]);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => { if (alive) await load(); })();
    return () => { alive = false; };
  }, [load]);

  const categories = useMemo(() => {
    const set = new Set((tools || []).map((t) => t.category));
    return ["all", ...Array.from(set).sort()];
  }, [tools]);

  const getInstalledTargetsForTool = useCallback((t: ToolMeta): Target[] => {
    return targets.filter((tg) => tg.installedTools?.includes(t.mcpName));
  }, [targets]);

  const installedToolsCount = useMemo(() => {
    if (!tools) return 0;
    return tools.filter((t) => getInstalledTargetsForTool(t).length > 0).length;
  }, [tools, getInstalledTargetsForTool]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (tools || []).filter((t) => {
      if (viewTab === "installed" && getInstalledTargetsForTool(t).length === 0) return false;
      if (cat !== "all" && t.category !== cat) return false;
      if (!needle) return true;
      return (
        t.name.toLowerCase().includes(needle) ||
        t.description.toLowerCase().includes(needle) ||
        t.category.toLowerCase().includes(needle)
      );
    });
  }, [tools, viewTab, q, cat, getInstalledTargetsForTool]);

  const installableTargets = targets.filter((t) => t.installable);

  return (
    // minmax(0, 1fr): the scrolling chip strip must not widen the column past the page.
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 20 }}>
      {/* Subtle & Compact Composio Automation Router Panel */}
      <div
        style={{
          border: "1px solid var(--etched-border)",
          background: "rgba(255,255,255,0.02)",
          padding: "14px 16px",
          display: "grid",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Zap size={16} style={{ color: "var(--gold-leaf)", opacity: 0.8 }} />
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <strong className="serif" style={{ fontSize: 15.5, fontWeight: 400, color: "var(--ink-black)" }}>
                  Composio Tool Router
                </strong>
                <span className="mono" style={{ ...mono, fontSize: 8.5, color: "var(--gold-leaf)", border: "1px solid var(--etched-border)", padding: "2px 6px" }}>
                  Automated for all agents
                </span>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
                Connect Gmail, Slack, GitHub, Linear, HubSpot, and 500+ apps directly to all your agents.
              </div>
            </div>
          </div>
          {composioKey.hasKey ? (
            <button
              type="button"
              onClick={() => setShowComposioAppPicker(true)}
              className={touch.touchTarget}
              style={{
                border: "1px solid var(--gold-leaf)",
                background: "rgba(197,160,89,0.10)",
                color: "var(--ink-black)",
                padding: "6px 12px",
                fontSize: 12,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <Layers size={13} />
              Connect Apps (1,400+)
            </button>
          ) : null}
        </div>

        <ComposioKeyPanel composioKey={composioKey} />

        {connectedApps.apps.size > 0 ? (
          <div className="mono" style={{ ...mono, fontSize: 9, color: "var(--text-secondary)", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span>Connected Apps ({connectedApps.apps.size}):</span>
            {Array.from(connectedApps.apps).map((slug) => (
              <span key={slug} style={{ border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.04)", padding: "1px 6px", color: "var(--ink-black)" }}>
                {slug}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {showComposioAppPicker ? (
        <ComposioAppPicker
          open={showComposioAppPicker}
          onClose={() => setShowComposioAppPicker(false)}
          onConnect={(slug) => composioConnect.launch(slug)}
          launching={composioConnect.launching}
          connectedApps={connectedApps.apps}
        />
      ) : null}

      {/* Primary View Switcher (All Tools vs Installed) */}
      <div style={{ display: "flex", gap: 12, borderBottom: "1px solid var(--etched-border)", paddingBottom: 12, alignItems: "center" }}>
        <button
          type="button"
          onClick={() => setViewTab("all")}
          className={`mono ${touch.touchTarget}`}
          style={{
            ...mono, opacity: 1,
            border: "none", background: "transparent",
            color: viewTab === "all" ? "var(--gold-leaf)" : "var(--text-secondary)",
            fontSize: 12, fontWeight: viewTab === "all" ? 600 : 400,
            cursor: "pointer", padding: "4px 8px", position: "relative",
          }}
        >
          Catalog ({tools?.length ?? 0})
        </button>
        <button
          type="button"
          onClick={() => setViewTab("installed")}
          className={`mono ${touch.touchTarget}`}
          style={{
            ...mono, opacity: 1,
            border: "none", background: "transparent",
            color: viewTab === "installed" ? "var(--gold-leaf)" : "var(--text-secondary)",
            fontSize: 12, fontWeight: viewTab === "installed" ? 600 : 400,
            cursor: "pointer", padding: "4px 8px", position: "relative",
          }}
        >
          Installed on Agents ({installedToolsCount})
        </button>
      </div>

      {/* Controls */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ position: "relative", flex: "1 1 260px", minWidth: 0 }}>
          <Search size={14} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", opacity: 0.5 }} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search tools…"
            aria-label="Search tools"
            type="search"
            className="hivra-search-input"
            enterKeyHint="search"
            autoCapitalize="off"
            autoCorrect="off"
            style={{ ...input, paddingLeft: 32 }}
          />
        </div>
        <div className={touch.chipStrip} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCat(c)}
              className={`mono ${touch.touchTarget}`}
              style={{
                ...mono, opacity: 1,
                border: `1px solid ${cat === c ? "var(--gold-leaf)" : "var(--etched-border)"}`,
                background: cat === c ? "rgba(197,160,89,0.10)" : "transparent",
                color: cat === c ? "var(--ink-black)" : "var(--text-secondary)",
                padding: "6px 11px", cursor: "pointer",
              }}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      <div className="mono" style={{ ...mono }}>
        {tools === null ? "Loading…" : `${shown.length} of ${tools.length} tools · ${installableTargets.length} agent${installableTargets.length === 1 ? "" : "s"} ready`}
      </div>

      {/* Catalog */}
      {tools === null ? (
        <div style={{ padding: 48, textAlign: "center" }}>
          <Loader2 size={18} style={{ animation: "spin 1s linear infinite", opacity: 0.5 }} />
        </div>
      ) : loadError ? (
        <div style={{ border: "1px dashed var(--etched-border)", padding: "24px 20px", textAlign: "center", color: "#e06c5a", fontSize: 13.5 }}>
          {loadError}
          <div style={{ marginTop: 12 }}>
            <button type="button" onClick={() => void load()} className={touch.touchTarget} style={{ border: "1px solid var(--etched-border)", background: "transparent", color: "var(--ink-black)", padding: "6px 14px", cursor: "pointer", fontSize: 12.5 }}>Retry</button>
          </div>
        </div>
      ) : shown.length === 0 ? (
        <div style={{ border: "1px dashed var(--etched-border)", padding: "28px 20px", textAlign: "center", color: "var(--text-muted)", fontSize: 13.5 }}>
          {viewTab === "installed" ? "No tools currently installed on your agents." : `No tools match “${q}”.`}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 300px), 1fr))", gap: 12 }}>
          {shown.map((t) => {
            const activeTargets = getInstalledTargetsForTool(t);
            return (
              <div
                key={t.id}
                style={{
                  border: `1px solid ${activeTargets.length > 0 ? "var(--gold-leaf)" : "var(--etched-border)"}`,
                  background: activeTargets.length > 0 ? "rgba(197,160,89,0.04)" : "rgba(255,255,255,0.03)",
                  padding: "14px 15px", display: "grid", gap: 10, minWidth: 0, position: "relative",
                }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", gap: 10, minWidth: 0 }}>
                  <Wrench size={13} style={{ marginTop: 3, flexShrink: 0, color: "var(--gold-leaf)", opacity: 0.7 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <strong className="serif" style={{ fontSize: 15.5, fontWeight: 400, color: "var(--ink-black)" }}>{t.name}</strong>
                    <div className="mono" style={{ ...mono, fontSize: 9, marginTop: 3, display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <span>{t.category}</span>
                      {t.env.some((f) => f.required) ? <span>key required</span> : <span>no key</span>}
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.5 }}>
                  {t.description}
                </div>

                {activeTargets.length > 0 ? (
                  <div className="mono" style={{ ...mono, fontSize: 9, color: "var(--gold-leaf)", display: "flex", alignItems: "center", gap: 4, overflowWrap: "anywhere" }}>
                    <Check size={11} style={{ flexShrink: 0 }} /> Installed on {activeTargets.map((tg) => tg.name).join(", ")}
                  </div>
                ) : null}

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
                  <button
                    type="button"
                    onClick={() => setOpenTool(t)}
                    className={touch.touchTarget}
                    style={{
                      border: "1px solid var(--gold-leaf)", background: activeTargets.length > 0 ? "rgba(197,160,89,0.10)" : "transparent",
                      color: "var(--ink-black)", padding: "7px 14px", cursor: "pointer",
                      fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 6, justifySelf: "start",
                    }}
                  >
                    {activeTargets.length > 0 ? <Wrench size={12} /> : <Plus size={12} />}
                    {activeTargets.length > 0 ? "Manage / Edit Agents" : "Install on agents"}
                  </button>

                  {t.repoUrl ? (
                    <a
                      href={t.repoUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`mono ${touch.touchTarget}`}
                      style={{
                        ...mono,
                        fontSize: 9,
                        color: "var(--text-secondary)",
                        textDecoration: "none",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        opacity: 0.8,
                      }}
                    >
                      <ExternalLink size={10} /> GitHub
                    </a>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {openTool ? (
        <InstallDialog
          tool={openTool}
          targets={targets}
          onClose={() => setOpenTool(null)}
          onDone={() => { void load(); }}
        />
      ) : null}
    </div>
  );
}

interface InstallDialogProps { tool: ToolMeta; targets: Target[]; onClose: () => void; onDone: () => void }

// SafePortal mounts its node after the first commit; rendering the panel inside
// it lets the focus/Escape hook find the dialog when it mounts.
function InstallDialog(props: InstallDialogProps) {
  return (
    <SafePortal>
      <InstallDialogPanel {...props} />
    </SafePortal>
  );
}

function InstallDialogPanel({ tool, targets, onClose, onDone }: InstallDialogProps) {
  // Pre-select targets that already have this tool installed
  const [picked, setPicked] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    for (const tg of targets) {
      if (tg.installedTools?.includes(tool.mcpName)) {
        initial.add(tg.uid);
      }
    }
    return initial;
  });
  const [env, setEnv] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"install" | "uninstall" | null>(null);
  const [results, setResults] = useState<FanResult[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Installed agents are preselected, so Remove needs a second, separate press to run.
  const [removeStep, setRemoveStep] = useState<"idle" | "arming" | "armed">("idle");
  const removeArmed = removeStep !== "idle";
  const removeTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => () => {
    removeTimersRef.current.forEach((t) => clearTimeout(t));
  }, []);

  const missingRequired = tool.env.some((f) => f.required && !(env[f.key] || "").trim());

  const disarmRemove = () => {
    removeTimersRef.current.forEach((t) => clearTimeout(t));
    removeTimersRef.current = [];
    setRemoveStep("idle");
  };

  // A changed selection changes what Remove would hit, so it must be confirmed again.
  const toggle = (uid: string) => {
    disarmRemove();
    setPicked((prev) => {
      const n = new Set(prev);
      if (n.has(uid)) n.delete(uid); else n.add(uid);
      return n;
    });
  };

  const run = useCallback(async (op: "install" | "uninstall") => {
    if (busy || picked.size === 0) return;
    setBusy(op); setErr(null); setResults(null);
    try {
      const body: Record<string, unknown> = { toolId: tool.id, targets: Array.from(picked), op };
      if (op === "install") body.env = env;
      const r = await fetch("/api/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await readJson(r);
      if (!r.ok || !j || j.success !== true) {
        setErr((j?.error as string) || `Failed (${r.status})`);
        return;
      }
      const d = j.data as { results?: FanResult[] };
      setResults(d.results || []);
      onDone();
    } catch (e) {
      setErr((e as Error).message || "Network error");
    } finally {
      setBusy(null);
    }
  }, [busy, picked, tool.id, env, onDone]);

  // Focus moves in, Tab stays inside, Escape closes (not mid-request), and focus returns to the trigger.
  const dialogRef = useInfrastructureDialog({ onClose, closeOnEscape: busy === null });

  const handleRemove = () => {
    if (busy !== null || picked.size === 0 || removeStep === "arming") return;
    if (removeStep === "armed") {
      disarmRemove();
      void run("uninstall");
      return;
    }
    setRemoveStep("arming");
    removeTimersRef.current = [
      setTimeout(() => setRemoveStep("armed"), REMOVE_CONFIRM_DELAY_MS),
      setTimeout(() => {
        removeTimersRef.current = [];
        setRemoveStep("idle");
      }, REMOVE_CONFIRM_MS),
    ];
  };

  return (
    <div
      ref={dialogRef as React.RefObject<HTMLDivElement | null>}
      role="dialog" aria-modal="true" aria-label={`Manage ${tool.name}`}
      onClick={onClose}
      className={touch.sheetOverlay}
      style={{ position: "fixed", top: 0, left: 0, right: 0, height: "var(--workspace-viewport-height, 100dvh)", zIndex: 1000, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={touch.sheetPanel}
        style={{ width: "min(640px, 100%)", maxHeight: "min(calc(var(--workspace-viewport-height, 100dvh) - 40px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px)), 780px)", display: "flex", flexDirection: "column", background: "var(--bg-surface, #fff)", border: "1px solid var(--etched-border)", boxShadow: "0 24px 80px rgba(0,0,0,0.35)" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "18px 20px 12px", borderBottom: "1px solid var(--etched-border)" }}>
          <div>
            <div className="mono" style={{ ...mono, marginBottom: 5 }}>Manage tool</div>
            <h3 className="serif" style={{ fontSize: "clamp(1.1rem, 3vw, 1.45rem)", fontWeight: 400, margin: 0, color: "var(--ink-black)" }}>{tool.name}</h3>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className={touch.dismissButton} style={{ border: "1px solid var(--etched-border)", background: "transparent", color: "var(--text-secondary)", padding: "5px 7px", cursor: "pointer", height: 28 }}>
            <X size={14} />
          </button>
        </div>

        <div style={{ overflowY: "auto", overscrollBehavior: "contain", padding: "16px 20px", flex: 1, minHeight: 0, display: "grid", gap: 16 }}>
          {tool.env.length > 0 ? (
            <div style={{ display: "grid", gap: 8 }}>
              <div className="mono" style={{ ...mono }}>Credentials</div>
              {tool.env.map((f) => (
                <label key={f.key} style={{ display: "grid", gap: 4 }}>
                  <span className="mono" style={{ ...mono, fontSize: 9, opacity: 0.8 }}>
                    {f.label}{f.required ? " *" : " (optional)"}
                  </span>
                  <input
                    type={f.secret ? "password" : "text"}
                    autoComplete={f.secret ? "new-password" : "off"}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    value={env[f.key] || ""}
                    onChange={(e) => setEnv((p) => ({ ...p, [f.key]: e.target.value }))}
                    placeholder={f.placeholder || f.key}
                    style={input}
                  />
                </label>
              ))}
            </div>
          ) : null}

          <div style={{ display: "grid", gap: 8 }}>
            <div className="mono" style={{ ...mono }}>Agents</div>
            {targets.length === 0 ? (
              <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>You have no agents yet.</div>
            ) : (
              targets.map((tg) => {
                const on = picked.has(tg.uid);
                const isCurrentlyInstalled = tg.installedTools?.includes(tool.mcpName);
                const res = results?.find((r) => r.uid === tg.uid);
                // Sentences read better as body text than in the uppercase status tag.
                const note = res && !res.ok ? res.error : !tg.installable ? tg.blockedMessage : undefined;
                return (
                  <button
                    key={tg.uid}
                    type="button"
                    disabled={!tg.installable}
                    onClick={() => toggle(tg.uid)}
                    aria-pressed={on}
                    className={touch.touchTarget}
                    style={{
                      textAlign: "left",
                      border: `1px solid ${on ? "var(--gold-leaf)" : "var(--etched-border)"}`,
                      background: on ? "rgba(197,160,89,0.08)" : "rgba(255,255,255,0.03)",
                      padding: "9px 11px", display: "flex", alignItems: "center", gap: 10,
                      cursor: tg.installable ? "pointer" : "default",
                      opacity: tg.installable ? 1 : 0.5, minWidth: 0,
                    }}
                  >
                    <span style={{ width: 14, flexShrink: 0, color: "var(--gold-leaf)" }}>{on ? <Check size={13} /> : null}</span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 13.5, color: "var(--ink-black)", overflowWrap: "anywhere" }}>{tg.name}</span>
                      <span className="mono" style={{ ...mono, fontSize: 9, marginLeft: 8, display: "inline-block", whiteSpace: "nowrap" }}>
                        {tg.lane === "hermes" ? "hermes" : tg.type}
                      </span>
                      {note ? (
                        <span style={{ display: "block", marginTop: 3, fontSize: 11.5, lineHeight: 1.45, color: res && !res.ok ? "#e06c5a" : "var(--text-muted)" }}>
                          {note}
                        </span>
                      ) : null}
                    </span>
                    {isCurrentlyInstalled ? (
                      <span className="mono" style={{ ...mono, fontSize: 9, color: "var(--gold-leaf)", marginRight: 8, flexShrink: 0, whiteSpace: "nowrap" }}>
                        ✓ Installed
                      </span>
                    ) : null}
                    <span className="mono" style={{ ...mono, fontSize: 9, color: res ? (res.ok ? "var(--gold-leaf)" : "#e06c5a") : undefined }}>
                      {res ? (res.ok ? "done" : "failed") : tg.installable || tg.blockedMessage ? tg.status : tg.blockedReason || tg.status}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className={touch.sheetFooter} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "12px 20px", borderTop: "1px solid var(--etched-border)", flexWrap: "wrap" }}>
          <span style={{ fontSize: 11.5, color: err ? "#e06c5a" : "var(--text-muted)" }}>
            {err || `${picked.size} selected`}
          </span>
          {/* The two actions wrap as a pair; at 480px and below the pair dissolves so Remove (ownRow) gets its own row. */}
          <div className="flex max-[481px]:contents" style={{ gap: 8 }}>
            <div className={touch.ownRow} style={{ display: "flex" }}>
              <button
                type="button"
                disabled={busy !== null || picked.size === 0}
                onClick={handleRemove}
                aria-live="polite"
                aria-disabled={removeStep === "arming" || undefined}
                className={touch.touchTarget}
                style={{
                  border: `1px solid ${removeArmed ? "#e06c5a" : "var(--etched-border)"}`,
                  background: removeArmed ? "color-mix(in srgb, #e06c5a 14%, transparent)" : "transparent",
                  color: "#e06c5a", fontWeight: removeArmed ? 600 : undefined,
                  opacity: removeStep === "arming" ? 0.6 : undefined,
                  padding: "8px 14px", cursor: busy || picked.size === 0 || removeStep === "arming" ? "default" : "pointer", fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 6,
                }}
              >
                {busy === "uninstall" ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : <Trash2 size={12} />}
                {removeArmed ? `Confirm remove from ${picked.size} agent${picked.size === 1 ? "" : "s"}` : "Remove"}
              </button>
            </div>
            <button
              type="button"
              disabled={busy !== null || picked.size === 0 || missingRequired}
              onClick={() => { disarmRemove(); void run("install"); }}
              className={touch.touchTarget}
              style={{
                border: "1px solid var(--gold-leaf)",
                background: busy || picked.size === 0 || missingRequired ? "transparent" : "var(--gold-leaf)",
                color: busy || picked.size === 0 || missingRequired ? "var(--text-muted)" : "var(--ink-black)",
                padding: "8px 18px", cursor: busy || picked.size === 0 || missingRequired ? "default" : "pointer",
                fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 6,
              }}
            >
              {busy === "install" ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : <Plus size={12} />}
              Save / Install{picked.size ? ` (${picked.size})` : ""}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

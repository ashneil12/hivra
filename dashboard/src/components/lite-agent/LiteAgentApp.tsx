"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Brain, Cloud, Cpu, Loader2, Plus, Settings2, Trash2, X } from "lucide-react";

/**
 * The free Lite cloud agent: create it, chat with it, tune it. Everything goes
 * through /api/lite-agents, which signs calls to the Lite agent Worker as the
 * signed-in user. Shown only while NEXT_PUBLIC_HIVRA_FREE_CLOUD_AGENT is on.
 */

interface Allowance {
  day: string;
  used: number;
  limit: number;
}

interface Me {
  agents: Array<{ id: string; name: string; createdAt: string }>;
  allowance: Allowance;
  limits: { maxAgents: number; maxSessions: number };
  modelsConfigured: boolean;
}

interface Agent {
  id: string;
  name: string;
  persona: string;
  usesOwnKey: boolean;
  ownKeyModel: string | null;
  notes: Array<{ id: number; text: string }>;
  sessions: Array<{ id: string; title: string; updatedAt: string }>;
}

interface Message {
  id: number | string;
  role: "user" | "assistant";
  content: string;
}

const API = "/api/lite-agents";

const ERRORS: Record<string, string> = {
  daily_limit: "You've used today's free messages. They come back at midnight UTC, or add your own model key in Settings.",
  model_unavailable: "The model didn't answer. Your free message was given back, so try again in a moment.",
  own_key_failed: "Your own model key didn't answer. Check it in Settings.",
  own_key_required: "Add your own model key in Settings before choosing it here.",
  inference_selection_required: "Choose an inference mode before sending.",
  invalid_managed_request: "This managed QA reply needs a short message.",
  managed_credits_required: "Available Hivra credits do not cover this reply. Top up credits or explicitly choose your own key.",
  managed_request_already_used: "This managed request was already submitted. Check the chat before sending it again.",
  managed_reply_failed: "The managed model didn't return a reply. Check the chat before submitting a new request.",
  no_model_configured: "Free agents aren't switched on here yet.",
  not_configured: "Free agents aren't switched on here yet.",
  agent_limit: "You already have your free agent.",
  session_limit: "This agent has reached its chat limit. Delete an old chat to start a new one.",
  worker_unreachable: "Couldn't reach your agent. Try again in a moment.",
};

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = typeof data?.error === "string" ? data.error : "unknown";
    const error = new Error(ERRORS[code] ?? "Something went wrong. Try again.") as Error & { code?: string; data?: unknown };
    error.code = code;
    error.data = data;
    throw error;
  }
  return data as T;
}

const PANEL: React.CSSProperties = {
  border: "1px solid var(--etched-border)",
  background: "var(--hg-fill-1)",
  borderRadius: 16,
};

const BUTTON: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  minHeight: 40,
  padding: "0 14px",
  borderRadius: 999,
  border: "1px solid var(--etched-border)",
  background: "transparent",
  color: "var(--text-primary)",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const PRIMARY: React.CSSProperties = { ...BUTTON, background: "var(--text-primary)", color: "var(--bg-primary, #fff)", border: "none" };

const INPUT: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "10px 12px",
  borderRadius: 12,
  border: "1px solid var(--etched-border)",
  background: "var(--hg-fill-1)",
  color: "var(--text-primary)",
  fontSize: 14,
  fontFamily: "inherit",
};

function AllowanceLine({ allowance, ownKey }: { allowance: Allowance | null; ownKey: boolean }) {
  if (ownKey) return <span>Using your own model key</span>;
  if (!allowance) return null;
  const left = Math.max(allowance.limit - allowance.used, 0);
  return (
    <span>
      {left} of {allowance.limit} free messages left today
    </span>
  );
}

function CreateAgent({ onCreated }: { onCreated: (agent: Agent) => void }) {
  const [name, setName] = useState("");
  const [persona, setPersona] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api<{ agent: Agent }>("POST", "/agents", { name: name.trim(), persona: persona.trim() });
      onCreated(agent);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={create} style={{ ...PANEL, padding: "2rem clamp(1rem, 4vw, 2rem)", display: "grid", gap: 16, maxWidth: 560, margin: "0 auto" }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--text-secondary)", fontSize: 13 }}>
        <Cloud size={16} /> Free, lives in the cloud, always there
      </span>
      <h1 className="serif" style={{ fontSize: "1.8rem", fontWeight: 600, margin: 0, lineHeight: 1.15 }}>
        Meet your cloud agent
      </h1>
      <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 14, lineHeight: 1.6 }}>
        Give it a name and it&apos;s ready. It remembers what you tell it and is there whenever you open Hivra.
      </p>
      <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 600 }}>
        Name
        <input style={INPUT} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Pip" autoFocus />
      </label>
      <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 600 }}>
        <span>
          How should it behave? <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>Optional</span>
        </span>
        <textarea
          style={{ ...INPUT, minHeight: 88, resize: "vertical" }}
          value={persona}
          onChange={(e) => setPersona(e.target.value)}
          maxLength={4000}
          placeholder="Friendly and brief. Helps me plan my week and keep track of ideas."
        />
      </label>
      {error && <p style={{ margin: 0, color: "var(--danger, #c0392b)", fontSize: 13 }}>{error}</p>}
      <button type="submit" style={{ ...PRIMARY, minHeight: 44 }} disabled={busy || !name.trim()}>
        {busy ? <Loader2 size={16} className="animate-spin" /> : null} Create my agent
      </button>
    </form>
  );
}

function SettingsPanel({
  agent,
  onChange,
  onDeleted,
  onClose,
}: {
  agent: Agent;
  onChange: (agent: Agent) => void;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(agent.name);
  const [persona, setPersona] = useState(agent.persona);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const run = async (work: () => Promise<void>, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
      setMessage(done);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const patch = (body: Record<string, unknown>, done: string) =>
    run(async () => {
      const { agent: next } = await api<{ agent: Agent }>("PATCH", `/agents/${agent.id}`, body);
      onChange(next);
    }, done);

  return (
    <aside style={{ ...PANEL, padding: "1.25rem", display: "grid", gap: 18, alignContent: "start" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <strong style={{ fontSize: 15 }}>Settings</strong>
        <button type="button" onClick={onClose} style={{ ...BUTTON, minHeight: 32, padding: "0 8px" }} aria-label="Close settings">
          <X size={16} />
        </button>
      </div>

      <section style={{ display: "grid", gap: 8 }}>
        <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 600 }}>
          Name
          <input style={INPUT} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </label>
        <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 600 }}>
          Personality and instructions
          <textarea style={{ ...INPUT, minHeight: 96, resize: "vertical" }} value={persona} onChange={(e) => setPersona(e.target.value)} maxLength={4000} />
        </label>
        <button type="button" style={BUTTON} disabled={busy || !name.trim()} onClick={() => patch({ name: name.trim(), persona: persona.trim() }, "Saved.")}>
          Save
        </button>
      </section>

      <section style={{ display: "grid", gap: 8 }}>
        <strong style={{ fontSize: 13, display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Brain size={14} /> What it remembers
        </strong>
        {agent.notes.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary)" }}>Nothing yet. Tell it something about you and it will keep it.</p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
            {agent.notes.map((note) => (
              <li key={note.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, lineHeight: 1.5 }}>
                <span style={{ flex: 1 }}>{note.text}</span>
                <button
                  type="button"
                  aria-label="Forget this"
                  style={{ ...BUTTON, minHeight: 28, padding: "0 6px", border: "none" }}
                  disabled={busy}
                  onClick={() => patch({ deleteNote: note.id }, "Forgotten.")}
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={{ display: "grid", gap: 8 }}>
        <strong style={{ fontSize: 13 }}>Your own model key</strong>
        <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>
          {agent.usesOwnKey
            ? `Using your key with ${agent.ownKeyModel}. Messages don't count against the free allowance.`
            : "Any OpenAI-compatible provider. With your own key there's no daily limit."}
        </p>
        {agent.usesOwnKey ? (
          <button type="button" style={BUTTON} disabled={busy} onClick={() => patch({ ownKey: null }, "Back on the free allowance.")}>
            Remove my key
          </button>
        ) : (
          <>
            <input style={INPUT} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.provider.com/v1" />
            <input style={INPUT} value={model} onChange={(e) => setModel(e.target.value)} placeholder="Model id" />
            <input style={INPUT} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="API key" type="password" autoComplete="off" />
            <button
              type="button"
              style={BUTTON}
              disabled={busy || !baseUrl.trim() || !model.trim() || !apiKey.trim()}
              onClick={() =>
                patch({ ownKey: { baseUrl: baseUrl.trim(), model: model.trim(), apiKey: apiKey.trim() } }, "Your key is set.").then(() => setApiKey(""))
              }
            >
              Use my key
            </button>
          </>
        )}
      </section>

      <section style={{ display: "grid", gap: 8 }}>
        <button
          type="button"
          style={{ ...BUTTON, color: "var(--danger, #c0392b)" }}
          disabled={busy}
          onClick={() => {
            if (!window.confirm(`Delete ${agent.name} and everything it remembers? This can't be undone.`)) return;
            void run(async () => {
              await api("DELETE", `/agents/${agent.id}`);
              onDeleted();
            }, "Deleted.");
          }}
        >
          Delete this agent
        </button>
      </section>
      {message && <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary)" }}>{message}</p>}
    </aside>
  );
}

function Chat({ agent, allowance, setAllowance, onAgent, explicitInference }: {
  agent: Agent;
  allowance: Allowance | null;
  setAllowance: (a: Allowance | null) => void;
  onAgent: (agent: Agent) => void;
  explicitInference: boolean;
}) {
  const [sessionId, setSessionId] = useState<string | null>(agent.sessions[0]?.id ?? null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [inference, setInference] = useState<"" | "byok" | "managed">("");
  const managedAttempt = useRef<{ id: string; sessionId: string; content: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const managed = explicitInference && inference === "managed";
  const canSend = !explicitInference || (managed ? draft.trim().length <= 1000 : inference === "byok" && agent.usesOwnKey);

  const refreshAgent = useCallback(async () => {
    const { agent: next } = await api<{ agent: Agent }>("GET", `/agents/${agent.id}`);
    onAgent(next);
  }, [agent.id, onAgent]);

  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    api<{ messages: Message[] }>("GET", `/agents/${agent.id}/sessions/${sessionId}`)
      .then(({ messages: list }) => !cancelled && setMessages(list))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [agent.id, sessionId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, sending]);

  const newChat = async () => {
    setError(null);
    try {
      const { session } = await api<{ session: { id: string } }>("POST", `/agents/${agent.id}/sessions`, {});
      setSessionId(session.id);
      await refreshAgent();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const send = async (event?: React.FormEvent) => {
    event?.preventDefault();
    const content = draft.trim();
    if (!content || sending || !canSend) return;
    setError(null);
    setSending(true);
    let target = sessionId;
    try {
      if (!target) {
        const { session } = await api<{ session: { id: string } }>("POST", `/agents/${agent.id}/sessions`, {});
        target = session.id;
        setSessionId(target);
      }
      setMessages((list) => [...list, { id: `pending-${Date.now()}`, role: "user", content }]);
      setDraft("");
      const path = managed ? "managed-messages" : explicitInference ? "own-key-messages" : "messages";
      if (managed && (managedAttempt.current?.sessionId !== target || managedAttempt.current?.content !== content)) {
        managedAttempt.current = { id: crypto.randomUUID(), sessionId: target, content };
      }
      const result = await api<{ reply: Message; allowance: Allowance | null }>(
        "POST",
        `/agents/${agent.id}/sessions/${target}/${path}`,
        managed ? { content, requestId: managedAttempt.current?.id } : { content },
      );
      if (managed) managedAttempt.current = null;
      setMessages((list) => [...list, result.reply]);
      if (result.allowance) setAllowance(result.allowance);
      await refreshAgent();
    } catch (e) {
      const err = e as Error & { code?: string; data?: { allowance?: Allowance } };
      setMessages((list) => list.filter((m) => !(typeof m.id === "string" && m.id.startsWith("pending-"))));
      setDraft(content);
      if (err.code === "managed_credits_required") managedAttempt.current = null;
      if (err.code === "managed_request_already_used" && target) {
        const history = await api<{ messages: Message[] }>("GET", `/agents/${agent.id}/sessions/${target}`).catch(() => null);
        if (history) setMessages(history.messages);
      }
      if (err.data?.allowance) setAllowance(err.data.allowance);
      setError(err.message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 220px) minmax(0, 1fr)", gap: 16 }} className="lite-agent-chat">
      <nav style={{ ...PANEL, padding: 10, display: "grid", gap: 4, alignContent: "start", maxHeight: "70vh", overflowY: "auto" }}>
        <button type="button" style={{ ...BUTTON, justifyContent: "flex-start" }} onClick={newChat}>
          <Plus size={14} /> New chat
        </button>
        {agent.sessions.map((session) => (
          <button
            key={session.id}
            type="button"
            onClick={() => setSessionId(session.id)}
            style={{
              ...BUTTON,
              justifyContent: "flex-start",
              border: "none",
              fontWeight: session.id === sessionId ? 600 : 400,
              background: session.id === sessionId ? "var(--hg-fill-2, var(--hg-fill-1))" : "transparent",
              overflow: "hidden",
              whiteSpace: "nowrap",
              textOverflow: "ellipsis",
              display: "block",
              textAlign: "left",
            }}
          >
            {session.title}
          </button>
        ))}
      </nav>

      <section style={{ ...PANEL, display: "grid", gridTemplateRows: "1fr auto", minHeight: "60vh", maxHeight: "75vh" }}>
        <div style={{ overflowY: "auto", padding: "1.25rem", display: "grid", gap: 12, alignContent: "start" }}>
          {messages.length === 0 && !sending && (
            <div style={{ color: "var(--text-secondary)", fontSize: 14, lineHeight: 1.6, padding: "2rem 0", textAlign: "center" }}>
              Say hello to {agent.name}. Try “Remember that I work best in the mornings” or “Help me plan this week.”
            </div>
          )}
          {messages.map((m) => (
            <div
              key={m.id}
              style={{
                justifySelf: m.role === "user" ? "end" : "start",
                maxWidth: "min(80%, 640px)",
                padding: "10px 14px",
                borderRadius: 16,
                fontSize: 14,
                lineHeight: 1.55,
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                background: m.role === "user" ? "var(--hg-fill-2, var(--hg-fill-1))" : "transparent",
                border: m.role === "user" ? "none" : "1px solid var(--etched-border)",
              }}
            >
              {m.content}
            </div>
          ))}
          {sending && (
            <div style={{ justifySelf: "start", display: "inline-flex", gap: 8, alignItems: "center", color: "var(--text-secondary)", fontSize: 13 }}>
              <Loader2 size={14} className="animate-spin" /> {agent.name} is thinking
            </div>
          )}
          <div ref={endRef} />
        </div>
        <form onSubmit={send} style={{ borderTop: "1px solid var(--etched-border)", padding: 12, display: "grid", gap: 8 }}>
          {error && <p style={{ margin: 0, fontSize: 13, color: "var(--danger, #c0392b)" }}>{error}</p>}
          {explicitInference && (
            <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
              Inference for this chat
              <select style={INPUT} value={inference} disabled={sending} onChange={(e) => {
                setInference(e.target.value === "managed" ? "managed" : e.target.value === "byok" ? "byok" : "");
              }}>
                <option value="">Choose an inference mode</option>
                <option value="byok" disabled={!agent.usesOwnKey}>My own model key</option>
                <option value="managed">Hivra credits (Preview)</option>
              </select>
            </label>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              maxLength={managed ? 1000 : 8000}
              rows={1}
              placeholder={`Message ${agent.name}`}
              style={{ ...INPUT, minHeight: 44, maxHeight: 160, resize: "none" }}
            />
            <button type="submit" aria-label="Send" style={{ ...PRIMARY, minHeight: 44, width: 44, padding: 0 }} disabled={sending || !draft.trim() || !canSend}>
              <ArrowUp size={18} />
            </button>
          </div>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {explicitInference ? (
              inference === "managed" ? "One reply on Hivra credits. No tools or memory." : null
            ) : <AllowanceLine allowance={allowance} ownKey={agent.usesOwnKey} />}
          </span>
        </form>
      </section>
    </div>
  );
}

export function LiteAgentApp({ explicitInference = false }: { explicitInference?: boolean }) {
  const [me, setMe] = useState<Me | null>(null);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [allowance, setAllowance] = useState<Allowance | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const data = await api<Me>("GET", "/me");
      setMe(data);
      setAllowance(data.allowance);
      const first = data.agents[0];
      if (first) {
        const { agent: full } = await api<{ agent: Agent }>("GET", `/agents/${first.id}`);
        setAgent(full);
      } else {
        setAgent(null);
      }
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    // Defer the first load so no state is set inside the effect body itself.
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  if (loadError) {
    return (
      <div style={{ ...PANEL, padding: "2rem", textAlign: "center", display: "grid", gap: 12, justifyItems: "center" }}>
        <p style={{ margin: 0, color: "var(--text-secondary)" }}>{loadError}</p>
        <button type="button" style={BUTTON} onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  }

  if (!me) {
    return (
      <div style={{ display: "grid", placeItems: "center", minHeight: "40vh", color: "var(--text-secondary)" }}>
        <Loader2 size={20} className="animate-spin" />
      </div>
    );
  }

  if (!agent) return <CreateAgent onCreated={(created) => { setAgent(created); void load(); }} />;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <style>{`@media (max-width: 720px) { .lite-agent-chat { grid-template-columns: minmax(0, 1fr) !important; } .lite-agent-chat > nav { max-height: 140px !important; } }`}</style>
      <header style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "grid", gap: 4 }}>
          <h1 className="serif" style={{ fontSize: "1.6rem", fontWeight: 600, margin: 0 }}>{agent.name}</h1>
          <span style={{ fontSize: 13, color: "var(--text-secondary)", display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Cloud size={14} /> Free cloud agent
          </span>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Link href="/dashboard/launch" style={{ ...BUTTON, textDecoration: "none" }}>
            <Cpu size={14} /> Give it a computer
          </Link>
          <button type="button" style={BUTTON} onClick={() => setShowSettings((v) => !v)} aria-expanded={showSettings}>
            <Settings2 size={14} /> Settings
          </button>
        </div>
      </header>
      {!explicitInference && !me.modelsConfigured && !agent.usesOwnKey && (
        <p style={{ ...PANEL, margin: 0, padding: "0.75rem 1rem", fontSize: 13, color: "var(--text-secondary)" }}>
          Free messages aren&apos;t switched on here yet. Add your own model key in Settings to start chatting.
        </p>
      )}
      <div style={{ display: "grid", gridTemplateColumns: showSettings ? "minmax(0, 1fr) minmax(260px, 340px)" : "minmax(0, 1fr)", gap: 16 }} className="lite-agent-layout">
        <style>{`@media (max-width: 900px) { .lite-agent-layout { grid-template-columns: minmax(0, 1fr) !important; } }`}</style>
        <Chat agent={agent} allowance={allowance} setAllowance={setAllowance} onAgent={setAgent} explicitInference={explicitInference} />
        {showSettings && (
          <SettingsPanel
            agent={agent}
            onChange={setAgent}
            onDeleted={() => {
              setShowSettings(false);
              void load();
            }}
            onClose={() => setShowSettings(false)}
          />
        )}
      </div>
    </div>
  );
}

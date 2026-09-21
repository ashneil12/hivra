"use client";

// Hivra agent chat — HermesOS-styled streaming chat with a sessions sidebar
// (history). Talks to a deployed runtime (a box running the official `claude`
// CLI) over its NDJSON stream-json, directly browser->box. Sessions persist per
// box in localStorage; each session resumes its own Claude session_id.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import posthog from "posthog-js";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Send, Loader2, Check, X, Plus, MessageSquare, Trash2, ChevronRight, ChevronDown, Square, RotateCcw, Copy, Paperclip, PanelLeft, Brain, Cpu, ThumbsUp, ThumbsDown } from "lucide-react";

import { listBoxSessions, readBoxSession, stampAgentFirstUsage, uploadBoxFile, type BoxMessage } from "@/lib/hivra/agent-api";
import { getGoal } from "@/lib/hivra/agent-identity";
import { requestAgentWelcomeMessage, isHiddenWelcomeTitle } from "@/lib/hivra/agent-welcome";
import { getAdapter, type AgentKind, type ChatSink, type ToolStatus } from "@/lib/hivra/agent-adapters";
import { clientLog } from "@/lib/client/logger";
import { captureClient } from "@/lib/telemetry/posthog-client";
import { CodeBlock } from "@/components/markdown/CodeBlock";
import { copyTextToClipboard } from "@/lib/client/clipboard";
import { MemoryUsageBanner } from "@/components/memory/MemoryUsageBanner";

// Fenced code → the shared syntax-highlighted CodeBlock (same component the
// Hermes chat uses); inline code keeps a lightweight mono chip.
const MD_COMPONENTS = {
 code(props: { className?: string; children?: React.ReactNode }) {
 const { className, children } = props;
 const text = String(children ?? "").replace(/\n$/, "");
 const lang = /language-(\w+)/.exec(className || "")?.[1];
 if (lang || text.includes("\n")) return <CodeBlock language={lang || "text"} value={text} />;
 return <code style={{ fontFamily: "var(--font-mono), monospace", fontSize: "0.9em", background: "var(--bg-elevated)", border: "1px solid var(--etched-border)", padding: "1px 5px" }}>{text}</code>;
 },
};

// Hover copy-the-whole-message affordance for assistant replies.
function MessageCopy({ text }: { text: string }) {
 const [copied, setCopied] = useState(false);
 return (
 <button
 type="button"
 aria-label="Copy message"
 onClick={() => {
 void copyTextToClipboard(text).then((ok) => {
 if (!ok) return;
 setCopied(true);
 window.setTimeout(() => setCopied(false), 1600);
 });
 }}
 className="mono"
 style={{ display: "inline-flex", alignItems: "center", gap: 5, border: "1px solid var(--etched-border)", background: "transparent", color: copied ? "#22c55e" : "var(--text-muted)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", padding: "3px 8px", cursor: "pointer", marginTop: 6 }}
 >
 {copied ? <Check size={11} /> : <Copy size={11} />} {copied ? "Copied" : "Copy"}
 </button>
 );
}

// Thumbs up / down on an assistant reply. Subtle, mirrors the MessageCopy chip
// styling; the selected thumb stays highlighted. Firing the analytics event is
// the caller's job (so it can attach instance/message context).
function MessageFeedback({ rating, onRate }: { rating?: "up" | "down"; onRate: (r: "up" | "down") => void }) {
 const base = {
 display: "inline-flex",
 alignItems: "center",
 border: "1px solid var(--etched-border)",
 background: "transparent",
 cursor: "pointer",
 padding: "3px 7px",
 marginTop: 6,
 } as const;
 return (
 <span style={{ display: "inline-flex", gap: 6, marginLeft: 8 }}>
 <button
 type="button"
 aria-label="Good response"
 aria-pressed={rating === "up"}
 onClick={() => onRate("up")}
 style={{ ...base, color: rating === "up" ? "#22c55e" : "var(--text-muted)" }}
 >
 <ThumbsUp size={11} />
 </button>
 <button
 type="button"
 aria-label="Bad response"
 aria-pressed={rating === "down"}
 onClick={() => onRate("down")}
 style={{ ...base, color: rating === "down" ? "#c0392b" : "var(--text-muted)" }}
 >
 <ThumbsDown size={11} />
 </button>
 </span>
 );
}

interface ToolChip {
 id?: string;
 name: string;
 detail: string;
 status: ToolStatus;
 result?: string;
}

interface ChatMessage {
 role: "user" | "assistant";
 text: string;
 tools: ToolChip[];
 streaming?: boolean;
}

interface Session {
 id: string;
 title: string;
 claudeSessionId: string | null;
 messages: ChatMessage[];
 createdAt: number;
 /** Box-backed session whose messages have been fetched from the VM. */
 loaded?: boolean;
}

export interface HivraChatProps {
 boxUrl: string;
 agentName?: string;
 accent?: string;
 /** Which CLI the box runs — selects the stream parser. Default "claude". */
 agentKind?: AgentKind;
 /** Stable key for persisting chat history (e.g. the agent id), so sessions
 * survive the box's tunnel URL changing on stop/start. Defaults to boxUrl. */
 storageKey?: string;
 /** Bearer token for the box's /api/sessions endpoints (history from the VM). */
 token?: string | null;
 /** Onboarding goal id — drives the welcome's starter suggestions. */
 goal?: string | null;
 /** Optional launch context — lets the first assistant message avoid generic setup chatter. */
 context?: string | null;
 /** The concrete first task captured at launch. When set, the first auto-welcome
 * turn DOES the task and returns the result ("do, don't show") instead of a menu. */
 firstTask?: string | null;
 /** Agent signature emoji for the welcome + avatar. */
 emoji?: string | null;
 /** Instance id — when set, surfaces the read-only memory-pressure banner. */
 instanceId?: string;
 /** Current model id this box runs (e.g. the agent's llm_config.model). When
 * unset, the composer shows the agent's native-CLI default label. Display only. */
 modelLabel?: string | null;
}

// Map a box session message (from the VM's own session store) to a ChatMessage.
function boxMsgToChat(m: BoxMessage): ChatMessage {
 return {
 role: m.role,
 text: m.text || "",
 tools: (m.tools || []).map((name) => ({ name, detail: "", status: "done" as ToolStatus })),
 };
}

const MAX_SESSIONS = 30;

// Per-session draft key — the half-typed message survives reloads + session switches.
function draftKey(sk: string, sessionId: string): string {
 return "hivra_draft_" + sk.replace(/[^a-z0-9]/gi, "").slice(-32) + "_" + sessionId;
}

function keyFor(boxUrl: string): string {
 return "hivra_sessions_" + boxUrl.replace(/[^a-z0-9]/gi, "").slice(-32);
}
function newId(): string {
 return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function parseNdjsonLine(line: string): Record<string, unknown> | null {
 const trimmed = line.trim();
 if (!trimmed) return null;
 try {
 const parsed: unknown = JSON.parse(trimmed);
 return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
 ? (parsed as Record<string, unknown>)
 : null;
 } catch {
 return null;
 }
}

function emptySession(): Session {
 return { id: newId(), title: "New chat", claudeSessionId: null, messages: [], createdAt: Date.now() };
}
function loadSessions(boxUrl: string): Session[] {
 try {
 const raw = window.localStorage.getItem(keyFor(boxUrl));
 if (!raw) return [];
 const parsed = JSON.parse(raw) as Session[];
 if (!Array.isArray(parsed)) return [];
 return parsed
 // Drop any hidden welcome-generation session persisted before the rail filter landed.
 .filter((s) => !isHiddenWelcomeTitle(s.title))
 .map((s) => ({ ...s, messages: (s.messages || []).map((m) => ({ ...m, streaming: false })) }));
 } catch {
 return [];
 }
}
function saveSessions(boxUrl: string, sessions: Session[]) {
 try {
 window.localStorage.setItem(keyFor(boxUrl), JSON.stringify(sessions.slice(0, MAX_SESSIONS)));
 } catch {
 /* quota / SSR — ignore */
 }
}
// Remember which chat was open (per box) so switching survives a reload / leaving
// and returning to the Chat tab.
function loadActiveId(boxUrl: string): string | null {
 try { return window.localStorage.getItem(keyFor(boxUrl) + "_active"); } catch { return null; }
}
function saveActiveId(boxUrl: string, id: string) {
 try { window.localStorage.setItem(keyFor(boxUrl) + "_active", id); } catch { /* ignore */ }
}

function toolIcon(name: string): string {
 if (name === "Bash") return "⚙";
 if (/browser|cdp|harness|navigate|screenshot/i.test(name)) return "🌐";
 if (/write|edit|notebook/i.test(name)) return "✎";
 if (/read|grep|glob|search/i.test(name)) return "🔎";
 return "🔧";
}
// A single tool card. Collapsed by default — header shows ⚙ name + command +
// status; click to expand the output (when there is one).
function ToolCard({ tool }: { tool: ToolChip }) {
 const [open, setOpen] = useState(false);
 const hasResult = Boolean(tool.result);
 return (
 <div style={{ background: "var(--bg-elevated)", border: "1px solid var(--etched-border)", fontFamily: "var(--font-mono)", fontSize: 11.5 }}>
 <div
 onClick={() => hasResult && setOpen((o) => !o)}
 style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, padding: "5px 9px", cursor: hasResult ? "pointer" : "default" }}
 >
 {hasResult ? (
 open ? <ChevronDown size={12} style={{ color: "var(--text-muted)", flexShrink: 0 }} /> : <ChevronRight size={12} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
 ) : (
 <span style={{ width: 12, flexShrink: 0 }} />
 )}
 <span aria-hidden>{toolIcon(tool.name)}</span>
 <b style={{ color: "var(--ink-black)" }}>{tool.name}</b>
 {tool.detail ? (
 <span style={{ color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{tool.detail}</span>
 ) : (
 <span style={{ flex: 1 }} />
 )}
 {tool.status === "running" ? (
 <Loader2 size={12} style={{ animation: "spin 1s linear infinite", color: "var(--text-muted)", flexShrink: 0 }} />
 ) : tool.status === "error" ? (
 <X size={13} style={{ color: "#c0392b", flexShrink: 0 }} />
 ) : (
 <Check size={13} style={{ color: "var(--gold-leaf)", flexShrink: 0 }} />
 )}
 </div>
 {open && hasResult ? (
 <div style={{ padding: "0 9px 7px 28px", color: tool.status === "error" ? "#c0392b" : "var(--text-secondary)", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 220, overflow: "auto" }}>
 {tool.result}
 </div>
 ) : null}
 </div>
 );
}

export function HivraChat({ boxUrl, agentName = "Claude Code", accent = "var(--gold-leaf)", agentKind = "claude", storageKey, token, goal, context, firstTask, emoji, instanceId, modelLabel }: HivraChatProps) {
 const skey = storageKey || boxUrl;
 // "Think" — extended-reasoning toggle, mirroring paioclaw's reasoning on/off.
 // Persisted per box so the preference survives reloads.
 const [think, setThink] = useState(false);
 useEffect(() => {
 try { setThink(window.localStorage.getItem("hivra_think_" + skey.replace(/[^a-z0-9]/gi, "").slice(-32)) === "1"); } catch { /* storage disabled */ }
 }, [skey]);
 const toggleThink = useCallback(() => {
 setThink((v) => {
 const next = !v;
 try { window.localStorage.setItem("hivra_think_" + skey.replace(/[^a-z0-9]/gi, "").slice(-32), next ? "1" : "0"); } catch { /* storage disabled */ }
 return next;
 });
 }, [skey]);
 const thinkRef = useRef(false);
 useEffect(() => { thinkRef.current = think; }, [think]);
 // The model name to surface in the composer. Falls back to the agent's CLI
 // default when no explicit override is wired (e.g. native Claude Code).
 const shownModel = (modelLabel || "").trim() || (agentKind === "claude" ? "Claude Code (default)" : `${agentName} (default)`);
 const [sessions, setSessions] = useState<Session[]>([emptySession()]);
 const [activeId, setActiveId] = useState<string>("");
 const [input, setInput] = useState("");
 const [busy, setBusy] = useState(false);
 const [boxHistoryChecked, setBoxHistoryChecked] = useState(false);
 const [hasBoxHistory, setHasBoxHistory] = useState(false);
 const activeIdRef = useRef<string>("");
 const scrollRef = useRef<HTMLDivElement>(null);
 const autoWelcomeAttemptedRef = useRef(false);
 // Per-turn scratch state for the active agent's parser (e.g. codex's id→text
 // segment map). Reset at the start of each send().
 const turnStateRef = useRef<Record<string, unknown>>({});
 // Aborts the in-flight turn. The box kills the CLI when the client disconnects,
 // so aborting the fetch genuinely stops the agent (not just the UI).
 const abortRef = useRef<AbortController | null>(null);
 // Every async turn captures the current generation. Changing the backing box
 // or stable storage identity invalidates that generation before aborting so a
 // late fetch result or reader callback cannot target the replacement chat.
 const requestGenerationRef = useRef(0);
 // Last user message of the active turn, so a failed turn can offer a one-tap retry.
 const [lastFailed, setLastFailed] = useState<string | null>(null);
 // Thumbs up/down selection per assistant message, keyed by `${sessionId}:${index}`
 // so a rating sticks to its message and survives session switches. UI-only state
 // (the event itself goes to PostHog) — not persisted across reloads.
 const [feedback, setFeedback] = useState<Record<string, "up" | "down">>({});
 // Pending attachments (already uploaded to the box; sent with the next message).
 const [attachments, setAttachments] = useState<{ name: string; path: string }[]>([]);
 const attachmentsRef = useRef<{ name: string; path: string }[]>([]);
 useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
 const [uploading, setUploading] = useState(false);
 const fileInputRef = useRef<HTMLInputElement>(null);
 // Sessions rail visibility — collapsed by default on narrow screens.
 const [showRail, setShowRail] = useState(false);
 useEffect(() => {
 if (typeof window !== "undefined" && window.innerWidth < 720) setShowRail(false);
 }, []);

 useEffect(() => {
 requestGenerationRef.current += 1;
 const controller = abortRef.current;
 abortRef.current = null;
 controller?.abort();
 turnStateRef.current = {};
 autoWelcomeAttemptedRef.current = false;
 setBusy(false);
 setLastFailed(null);

 return () => {
 requestGenerationRef.current += 1;
 const activeController = abortRef.current;
 abortRef.current = null;
 activeController?.abort();
 };
 }, [boxUrl, skey]);

 const uploadAttachment = useCallback(async (file: File) => {
 if (!token || uploading || attachmentsRef.current.length >= 5) return;
 if (file.size > 8 * 1024 * 1024) return;
 setUploading(true);
 try {
 const dataBase64 = await new Promise<string>((resolve, reject) => {
 const fr = new FileReader();
 fr.onload = () => resolve(String(fr.result).split(",")[1] || "");
 fr.onerror = () => reject(new Error("read failed"));
 fr.readAsDataURL(file);
 });
 const r = await uploadBoxFile(boxUrl, file.name || "pasted.png", dataBase64, token);
 if (r.ok && r.path) setAttachments((prev) => [...prev, { name: file.name || "pasted.png", path: r.path! }]);
 } catch { /* drop silently; the user can retry */ }
 finally { setUploading(false); }
 }, [boxUrl, token, uploading]);

 // Load persisted sessions for this box (or start fresh), and re-open whichever
 // chat was active last time (falls back to the newest).
 useEffect(() => {
 const loaded = loadSessions(skey);
 const next = loaded.length ? loaded : [emptySession()];
 setSessions(next);
 const saved = loadActiveId(skey);
 setActiveId(saved && next.some((s) => s.id === saved) ? saved : next[0].id);
 }, [skey]);

 // Drafts: restore the per-session half-typed message on open/switch…
 useEffect(() => {
 if (!activeId) return;
 try {
 setInput(window.localStorage.getItem(draftKey(skey, activeId)) || "");
 } catch { /* storage disabled */ }
 }, [activeId, skey]);
 // …and persist it (debounced) as the user types.
 const draftTimerRef = useRef<number | null>(null);
 useEffect(() => {
 if (!activeId) return;
 if (draftTimerRef.current) window.clearTimeout(draftTimerRef.current);
 draftTimerRef.current = window.setTimeout(() => {
 try {
 const k = draftKey(skey, activeId);
 if (input) window.localStorage.setItem(k, input);
 else window.localStorage.removeItem(k);
 } catch { /* storage disabled */ }
 }, 400);
 return () => { if (draftTimerRef.current) window.clearTimeout(draftTimerRef.current); };
 }, [input, activeId, skey]);

 // Pull the box's REAL session history (the VM's own session store) and merge
 // it into the sidebar as stubs; each stub's messages load lazily on click.
 useEffect(() => {
 let cancelled = false;
 setBoxHistoryChecked(false);
 setHasBoxHistory(false);
 const pull = async () => {
 const box = await listBoxSessions(boxUrl, token);
 if (cancelled) return;
 setBoxHistoryChecked(true);
 if (box.length === 0) return;
 setHasBoxHistory(true);
 setSessions((prev) => {
 const have = new Set(prev.map((s) => s.claudeSessionId).filter(Boolean));
 const stubs: Session[] = box
 .filter((b) => !have.has(b.id))
 .map((b) => ({ id: "box-" + b.id, title: b.title || "Session", claudeSessionId: b.id, messages: [], createdAt: b.updatedAt, loaded: false }));
 if (stubs.length === 0) return prev;
 return [...prev, ...stubs].sort((a, b) => b.createdAt - a.createdAt);
 });
 };
 void pull();
 const onFocus = () => void pull();
 window.addEventListener("focus", onFocus);
 return () => {
 cancelled = true;
 window.removeEventListener("focus", onFocus);
 };
 }, [boxUrl, token]);

 useEffect(() => {
 activeIdRef.current = activeId;
 if (activeId) saveActiveId(skey, activeId); // persist the open chat per box
 }, [activeId, skey]);

 // Persist when idle (avoid thrashing localStorage on every token).
 useEffect(() => {
 if (!busy) saveSessions(skey, sessions);
 }, [sessions, busy, skey]);

 const active = useMemo(() => sessions.find((s) => s.id === activeId) || sessions[0], [sessions, activeId]);

 // Activate a session; if it's an unloaded box-backed stub, fetch its messages
 // from the VM first so history shows up.
 const selectSession = useCallback(
 (s: Session) => {
 setActiveId(s.id);
 if (s.claudeSessionId && !s.loaded && s.messages.length === 0) {
 void readBoxSession(boxUrl, s.claudeSessionId, token).then((msgs) => {
 setSessions((prev) => prev.map((x) => (x.id === s.id ? { ...x, messages: msgs.map(boxMsgToChat), loaded: true } : x)));
 });
 }
 },
 [boxUrl, token],
 );

 // Smart autoscroll: follow the stream only while the user is at (or near) the
 // bottom. Scrolling up to re-read mid-stream pins the view; returning to the
 // bottom re-engages following. `force` is for user-initiated sends.
 const stickToBottomRef = useRef(true);
 const onScrollPane = useCallback(() => {
 const el = scrollRef.current;
 if (!el) return;
 stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
 }, []);
 const scrollDown = useCallback((force?: boolean) => {
 if (!force && !stickToBottomRef.current) return;
 requestAnimationFrame(() => {
 const el = scrollRef.current;
 if (el) el.scrollTop = el.scrollHeight;
 });
 }, []);

 const updateActive = useCallback((fn: (s: Session) => Session) => {
 setSessions((prev) => prev.map((s) => (s.id === activeIdRef.current ? fn(s) : s)));
 }, []);

 useEffect(() => {
 if (!boxHistoryChecked || hasBoxHistory || busy || autoWelcomeAttemptedRef.current) return;
 if (!active || active.messages.length > 0) return;
 const flagKey = `hivra:first-welcome:${skey}`;
 try {
 if (window.localStorage.getItem(flagKey) === "1") return;
 } catch {
 // Storage is only a duplicate guard; the chat still works without it.
 }

 autoWelcomeAttemptedRef.current = true;
 const welcomeGeneration = requestGenerationRef.current;
 const isCurrentWelcome = () => requestGenerationRef.current === welcomeGeneration;
 setBusy(true);
 const hasFirstTask = Boolean((firstTask || "").trim());
 updateActive((s) => ({
 ...s,
 title: s.title === "New chat" ? "Welcome" : s.title,
 messages: [{ role: "assistant", text: "", tools: [], streaming: true }],
 }));

 // The agent opens the conversation on its own — and when a first task was
 // captured at launch, this turn DOES it and returns the result ("do, don't
 // show"). Fire the activation event once per box (the localStorage guard
 // above makes this run at most once). Analytics must never break the chat.
 try {
 captureClient("agent_initiated_message_sent", {
 agent_id: skey,
 agent_kind: agentKind,
 lane: "hivra",
 has_first_task: hasFirstTask,
 $insert_id: `auto_first_task_${skey}`,
 });
 } catch {
 // Best-effort analytics only.
 }

 void requestAgentWelcomeMessage({
 boxUrl,
 token,
 agentKind,
 agentName,
 goal,
 context,
 firstTask,
 channel: "chat",
 })
 .then((text) => {
 if (!isCurrentWelcome()) return;
 updateActive((s) => ({
 ...s,
 title: s.title === "New chat" ? "Welcome" : s.title,
 messages: [{ role: "assistant", text, tools: [], streaming: false }],
 }));
 try {
 window.localStorage.setItem(flagKey, "1");
 } catch {
 // Best-effort duplicate guard only.
 }
 })
 .catch((err) => {
 if (!isCurrentWelcome()) return;
 clientLog.warn("agent first message generation failed", {
 source: "hivra-chat",
 failureType: "hivra_chat_welcome_generation_failed",
 agentKind,
 agentName,
 }, err);
 updateActive((s) => ({ ...s, messages: [] }));
 })
 .finally(() => {
 if (!isCurrentWelcome()) return;
 setBusy(false);
 scrollDown();
 });
 }, [agentKind, agentName, active, boxHistoryChecked, boxUrl, busy, context, firstTask, goal, hasBoxHistory, scrollDown, skey, token, updateActive]);

 const updateAssistant = useCallback(
 (fn: (msg: ChatMessage) => ChatMessage) => {
 updateActive((s) => {
 const messages = s.messages.slice();
 const last = messages.length - 1;
 if (last >= 0 && messages[last].role === "assistant") messages[last] = fn(messages[last]);
 return { ...s, messages };
 });
 },
 [updateActive],
 );

 const upsertTool = useCallback(
 (id: string | undefined, patch: Partial<ToolChip>) => {
 updateAssistant((m) => {
 const tools = m.tools.slice();
 const idx = id ? tools.findIndex((t) => t.id === id) : -1;
 if (idx >= 0) tools[idx] = { ...tools[idx], ...patch };
 else tools.push({ id, name: "tool", detail: "", status: "running", ...patch });
 return { ...m, tools };
 });
 },
 [updateAssistant],
 );

 // One stream event → UI. The per-agent parsing lives in the adapter registry
 // (agent-adapters), which the welcome path shares — so live + welcome can't
 // diverge. This component only provides the sink that maps parser intents onto
 // React state, plus the per-turn scratch state in turnStateRef.
 const handleEvent = useCallback(
 (ev: Record<string, unknown>) => {
 const sink: ChatSink = {
 setSessionId: (id) => updateActive((s) => ({ ...s, claudeSessionId: id })),
 appendText: (t) => updateAssistant((m) => ({ ...m, text: m.text + t })),
 setText: (t) => updateAssistant((m) => ({ ...m, text: t })),
 upsertTool: (id, patch) => upsertTool(id, patch),
 appendWarning: (t) => updateAssistant((m) => ({ ...m, text: m.text + "\n\n⚠ " + t })),
 };
 getAdapter(agentKind).parseEvent(ev, sink, turnStateRef.current);
 },
 [agentKind, updateActive, updateAssistant, upsertTool],
 );

 const send = useCallback(
 async (raw: string) => {
 if (busy) return;
 const text = raw.trim();
 if (!text) return;
 const session = sessions.find((s) => s.id === activeIdRef.current);
 const resumeId = session?.claudeSessionId || null;
 const images = attachmentsRef.current.map((a) => a.path);
 setInput("");
 setAttachments([]);
 try { window.localStorage.removeItem(draftKey(skey, activeIdRef.current)); } catch { /* ignore */ }
 setBusy(true);
 setLastFailed(null);
 const controller = new AbortController();
 const requestGeneration = ++requestGenerationRef.current;
 const isCurrentRequest = () =>
 requestGenerationRef.current === requestGeneration && abortRef.current === controller;
 abortRef.current = controller;
 turnStateRef.current = getAdapter(agentKind).createTurnState(); // fresh per-turn parser state
 const shownText = images.length ? text + "\n\n📎 " + images.map((p) => p.split("/").pop()).join(", ") : text;
 updateActive((s) => ({
 ...s,
 title: s.messages.length === 0 ? text.slice(0, 42) : s.title,
 messages: [
 ...s.messages,
 { role: "user", text: shownText, tools: [] },
 { role: "assistant", text: "", tools: [], streaming: true },
 ],
 }));
 stickToBottomRef.current = true; // a fresh send re-engages following
 scrollDown(true);

 let resp: Response;
 try {
 resp = await fetch(`${boxUrl.replace(/\/$/, "")}/api/chat`, {
 method: "POST",
 headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
 // `reasoning` carries the composer's "Think" toggle. The box's /api/chat
 // server lives in the hivra-provisioner repo (not here), and this repo
 // can't confirm it reads this field — but an extra JSON key is ignored
 // by a server that doesn't, so sending it is regression-safe and wires
 // the toggle the moment the box supports it.
 // TODO(paioclaw-riplist): confirm the box chat server's reasoning param
 // name/shape (does it accept `reasoning: boolean`, or a thinking-level
 // string like the cron path's, or `--model`-style flags?) and align this
 // key + the TaskModal cron path so chat and scheduled tasks match.
 body: JSON.stringify({ message: text, sessionId: resumeId, ...(images.length ? { images } : {}), ...(thinkRef.current ? { reasoning: true } : {}) }),
 signal: controller.signal,
 });
 } catch (e) {
 if (!isCurrentRequest()) return;
 abortRef.current = null;
 // User-initiated stop before the response opened — leave the turn as-is,
 // no scary error.
 if ((e as Error).name === "AbortError") {
 updateAssistant((m) => ({ ...m, streaming: false }));
 } else {
 updateAssistant((m) => ({ ...m, text: "⚠ Couldn't reach your agent. It may be starting up — try again in a moment.", streaming: false }));
 setLastFailed(text);
 }
 setBusy(false);
 return;
 }
 if (!isCurrentRequest()) return;
 if (!resp.ok || !resp.body) {
 abortRef.current = null;
 updateAssistant((m) => ({ ...m, text: "⚠ Your agent hit an error (HTTP " + resp.status + "). Try again.", streaming: false }));
 setLastFailed(text);
 setBusy(false);
 return;
 }

 // agent_first_message_sent — the funnel's Hivra-lane activation event.
 // Fires once per box (localStorage guard keyed on the stable storage
 // key); the $insert_id makes PostHog dedupe any double-fire across
 // devices/reinstalls best-effort. Analytics must never break the chat.
 try {
 const firstMessageKey = "hermes:first_message_sent:" + skey;
 if (!window.localStorage.getItem(firstMessageKey)) {
 window.localStorage.setItem(firstMessageKey, "1");
 void stampAgentFirstUsage(skey);
 posthog.capture("agent_first_message_sent", {
 box_id: skey,
 agent_kind: agentKind,
 lane: "hivra",
 $insert_id: "agent_first_message_sent_" + skey,
 });
 }
 } catch {
 // localStorage unavailable (private mode) — skip the once-guard.
 }

 const reader = resp.body.getReader();
 const dec = new TextDecoder();
 let buf = "";
 const dispatchLine = (line: string): boolean => {
 if (!isCurrentRequest()) return false;
 const event = parseNdjsonLine(line);
 if (!event) return true;
 try {
 handleEvent(event);
 } catch {
 /* skip malformed or unsupported event */
 }
 scrollDown();
 return true;
 };
 try {
 for (;;) {
 const { done, value } = await reader.read();
 if (!isCurrentRequest()) return;
 if (done) {
 buf += dec.decode();
 } else {
 buf += dec.decode(value, { stream: true });
 }
 let idx: number;
 while ((idx = buf.indexOf("\n")) >= 0) {
 const line = buf.slice(0, idx);
 buf = buf.slice(idx + 1);
 if (!dispatchLine(line)) return;
 }
 if (!done) continue;
 if (buf.trim() && !dispatchLine(buf)) return;
 buf = "";
 break;
 }
 } catch {
 if (!isCurrentRequest()) return;
 /* stream ended (incl. user-initiated abort) */
 }
 if (!isCurrentRequest()) return;
 abortRef.current = null;
 updateAssistant((m) => ({ ...m, streaming: false }));
 updateActive((s) => ({ ...s, messages: s.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)) }));
 setBusy(false);
 scrollDown();
 },
 [agentKind, boxUrl, busy, handleEvent, scrollDown, sessions, updateActive, updateAssistant, token, skey],
 );

 // Stop the in-flight turn. Aborting the fetch disconnects from the box, which
 // kills the underlying CLI process — a real interrupt, not just a UI reset.
 const stop = useCallback(() => {
 abortRef.current?.abort();
 }, []);

 // Record a thumbs up/down on an assistant message and fire the funnel event.
 // Toggling the same thumb clears it (and emits rating "none"); the capture goes
 // through the init-safe helper so analytics can never break the chat.
 const rateMessage = useCallback(
 (index: number, rating: "up" | "down") => {
 const key = activeIdRef.current + ":" + index;
 setFeedback((prev) => {
 const next = { ...prev };
 const cleared = prev[key] === rating;
 if (cleared) delete next[key];
 else next[key] = rating;
 captureClient("chat_feedback", {
 rating: cleared ? "none" : rating,
 agent_id: skey,
 ...(instanceId ? { instance_id: instanceId } : {}),
 message_id: activeIdRef.current + ":" + index,
 agent_kind: agentKind,
 lane: "hivra",
 });
 return next;
 });
 },
 [agentKind, instanceId, skey],
 );

 const newChat = useCallback(() => {
 if (busy) return;
 const s = emptySession();
 setSessions((prev) => [s, ...prev].slice(0, MAX_SESSIONS));
 setActiveId(s.id);
 setInput("");
 }, [busy]);

 const deleteChat = useCallback(
 (id: string) => {
 setSessions((prev) => {
 const next = prev.filter((s) => s.id !== id);
 const final = next.length ? next : [emptySession()];
 if (id === activeIdRef.current) setActiveId(final[0].id);
 return final;
 });
 },
 [],
 );

 useEffect(() => {
 scrollDown();
 }, [active?.messages, scrollDown]);

 const messages = active?.messages || [];
 // Welcome suggestions: the chosen goal's three concrete starters (falls back to
 // the general-purpose goal so there's always something to tap). Tapping one
 // sends it as the first message — the seeded agent answers in character.
 const goalDef = goal ? getGoal(goal) : null;
 const starters = (goalDef ?? getGoal(undefined)).starters;

 return (
 <div style={{ display: "flex", height: "100%", minHeight: 0, background: "var(--bg-surface)" }}>
 {/* Sessions sidebar */}
 {showRail ? (
 <div className="flex w-[232px] shrink-0 flex-col border-r border-[var(--etched-border)]">
 <button
 type="button"
 onClick={newChat}
 disabled={busy}
 className="mx-3 mt-3 inline-flex min-h-[40px] items-center justify-center gap-2 border border-[var(--etched-border)] text-[13px] font-semibold text-[var(--ink-black)] transition-colors hover:border-[var(--hivra-red-line)] hover:bg-[var(--bg-elevated)] disabled:opacity-50"
 >
 <Plus size={15} /> New chat
 </button>
 <div className="flex-1 overflow-y-auto p-2">
 {sessions.map((s) => {
 const isActive = s.id === activeId;
 return (
 <div
 key={s.id}
 onClick={() => !busy && selectSession(s)}
 className={[
 "group mb-0.5 flex items-center gap-2 px-2.5 py-2",
 busy ? "cursor-default" : "cursor-pointer",
 isActive
 ? "bg-[var(--hivra-red-soft)]"
 : "hover:bg-[var(--bg-elevated)]",
 ].join(" ")}
 >
 <MessageSquare size={13} className="shrink-0 text-[var(--text-muted)]" />
 <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--ink-black)]">
 {s.title || "New chat"}
 </span>
 {sessions.length > 1 ? (
 <button
 type="button"
 aria-label="Delete chat"
 onClick={(e) => {
 e.stopPropagation();
 deleteChat(s.id);
 }}
 className="inline-flex p-0.5 text-[var(--text-muted)] opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
 >
 <Trash2 size={12} />
 </button>
 ) : null}
 </div>
 );
 })}
 </div>
 </div>
 ) : null}

 {/* Chat column */}
 <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, position: "relative" }}>
 {instanceId ? <MemoryUsageBanner instanceId={instanceId} /> : null}
 <div className="absolute left-2 top-2 z-[5] flex items-center gap-1.5">
 <button
 type="button"
 aria-label={showRail ? "Hide chats" : "Show chats"}
 title={showRail ? "Hide chats" : "Show chats"}
 onClick={() => setShowRail((v) => !v)}
 className="inline-flex border border-[var(--etched-border)] bg-[var(--bg-surface)] p-1.5 text-[var(--text-muted)] transition-colors hover:text-[var(--ink-black)]"
 >
 <PanelLeft size={13} />
 </button>
 {!showRail ? (
 <button
 type="button"
 aria-label="New chat"
 title="New chat"
 onClick={newChat}
 disabled={busy}
 className="inline-flex border border-[var(--etched-border)] bg-[var(--bg-surface)] p-1.5 text-[var(--text-muted)] transition-colors hover:text-[var(--ink-black)] disabled:opacity-40"
 >
 <Plus size={13} />
 </button>
 ) : null}
 </div>
 <div ref={scrollRef} onScroll={onScrollPane} style={{ flex: 1, overflowY: "auto", padding: "28px 0" }}>
 <div style={{ maxWidth: 760, margin: "0 auto", padding: "0 20px" }}>
 {messages.length === 0 ? (
 <div className="flex min-h-full items-center justify-center px-4">
 <div style={{ textAlign: "center", maxWidth: 470, paddingBottom: "6vh" }}>
 <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 52, height: 52, borderRadius: "50%", background: accent, color: "#fff", fontSize: 22, fontFamily: "var(--font-mono)", marginBottom: 16 }}>
 {emoji || (agentName.trim().charAt(0).toUpperCase() || "A")}
 </div>
 <div className="serif" style={{ fontSize: 26, fontWeight: 400, color: "var(--ink-black)", marginBottom: 6 }}>
 Hi, I&apos;m {agentName}.
 </div>
 <div style={{ fontSize: 13.5, color: "var(--text-secondary)", maxWidth: 440, margin: "0 auto 22px", lineHeight: 1.6 }}>
 {goalDef ? `I'm set up to help you ${goalDef.label.toLowerCase()}. Want to start with one of these?` : "Tell me what you need — or start with one of these."}
 </div>
 <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 470, margin: "0 auto" }}>
 {starters.map((s, i) => (
 <button
 key={i}
 type="button"
 disabled={busy}
 onClick={() => void send(s)}
 className="flex items-center gap-2.5 border border-[var(--etched-border)] bg-[var(--bg-elevated)] px-3.5 py-3 text-left text-[13.5px] leading-[1.45] text-[var(--ink-black)] transition-colors hover:border-[var(--hivra-red-line)] disabled:opacity-50"
 >
 <span style={{ color: "var(--gold-leaf)", flexShrink: 0 }} aria-hidden>→</span> {s}
 </button>
 ))}
 </div>
 <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 16 }}>…or just type below.</div>
 </div>
 </div>
 ) : null}
 {messages.map((m, i) => {
 const isUser = m.role === "user";
 return (
 <div key={i} style={{ display: "flex", gap: 12, marginBottom: 22, flexDirection: isUser ? "row-reverse" : "row" }}>
 <div
 style={{
 width: 26,
 height: 26,
 flexShrink: 0,
 borderRadius: "50%",
 border: "1px solid var(--etched-border)",
 background: isUser ? "var(--bg-elevated)" : accent,
 color: isUser ? "var(--ink-black)" : "#fff",
 display: "flex",
 alignItems: "center",
 justifyContent: "center",
 fontSize: 10,
 fontWeight: 700,
 fontFamily: "var(--font-mono)",
 }}
 >
 {isUser ? "YOU" : (agentName.trim().charAt(0).toUpperCase() || "A")}
 </div>
 <div style={{ flex: isUser ? "0 1 auto" : 1, minWidth: 0, maxWidth: isUser ? "80%" : undefined }}>
 {m.tools.length > 0 ? (
 <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
 {m.tools.map((t, j) => (
 <ToolCard key={t.id || j} tool={t} />
 ))}
 </div>
 ) : null}
 <div className="hivra-md" style={{ fontSize: 14.5, lineHeight: 1.6, color: "var(--ink-black)", wordBreak: "break-word", ...(isUser ? { background: "var(--hivra-red-soft)", border: "1px solid var(--hivra-red-line)", padding: "9px 13px" } : null) }}>
 {m.role === "assistant" && !m.text && m.streaming ? (
 <span className="inline-flex items-center gap-1.5 py-1" aria-label="Thinking">
 <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--text-muted)] [animation-duration:1s]" />
 <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--text-muted)] [animation-delay:0.15s] [animation-duration:1s]" />
 <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--text-muted)] [animation-delay:0.3s] [animation-duration:1s]" />
 <span className="sr-only">Thinking…</span>
 </span>
 ) : m.role === "assistant" ? (
 <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{m.text}</ReactMarkdown>
 ) : (
 <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
 )}
 </div>
 {m.role === "assistant" && m.text && !m.streaming ? (
 <span style={{ display: "inline-flex", alignItems: "center" }}>
 <MessageCopy text={m.text} />
 <MessageFeedback rating={feedback[activeId + ":" + i]} onRate={(r) => rateMessage(i, r)} />
 </span>
 ) : null}
 </div>
 </div>
 );
 })}
 </div>
 </div>

 <div className="border-t border-[var(--etched-border)] bg-[var(--bg-surface)] px-4 pb-3 pt-3">
 {lastFailed && !busy ? (
 <div className="mx-auto mb-2 w-full max-w-[760px]">
 <button
 type="button"
 onClick={() => {
 const t = lastFailed;
 setLastFailed(null);
 void send(t);
 }}
 className="inline-flex items-center gap-1.5 border border-[var(--etched-border)] bg-[var(--bg-elevated)] px-3 py-1.5 text-[12.5px] text-[var(--ink-black)] transition-colors hover:border-[var(--hivra-red-line)]"
 >
 <RotateCcw size={13} /> Retry
 </button>
 </div>
 ) : null}
 <form
 onSubmit={(e) => {
 e.preventDefault();
 void send(input);
 }}
 className="mx-auto w-full max-w-[760px] border border-[var(--etched-border)] transition-colors focus-within:border-[var(--hivra-red-line)]"
 >
 <textarea
 value={input}
 onChange={(e) => setInput(e.target.value)}
 onKeyDown={(e) => {
 if (e.key === "Enter" && !e.shiftKey) {
 e.preventDefault();
 void send(input);
 }
 }}
 onPaste={(e) => {
 if (!token) return;
 const item = Array.from(e.clipboardData?.items || []).find((i) => i.type.startsWith("image/"));
 const f = item?.getAsFile();
 if (f) { e.preventDefault(); void uploadAttachment(f); }
 }}
 rows={1}
 placeholder={`Message ${agentName}…`}
 className="block w-full resize-none bg-transparent px-3.5 pt-3 text-[14px] text-[var(--ink-black)] outline-none placeholder:text-[var(--text-muted)]"
 style={{ minHeight: 44, maxHeight: 160, fontFamily: "inherit" }}
 />
 <div className="flex items-center gap-1.5 px-2 pb-2">
 {token ? (
 <>
 <input
 ref={fileInputRef}
 type="file"
 accept="image/*,.txt,.md,.csv,.json,.log"
 style={{ display: "none" }}
 onChange={(e) => {
 const f = e.target.files?.[0];
 if (f) void uploadAttachment(f);
 e.target.value = "";
 }}
 />
 <button
 type="button"
 aria-label="Attach a file"
 title="Attach an image or text file (the agent reads it on the box)"
 disabled={busy || uploading || attachments.length >= 5}
 onClick={() => fileInputRef.current?.click()}
 className="inline-flex min-h-[34px] items-center px-2.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--ink-black)] disabled:opacity-40"
 >
 {uploading ? <Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} /> : <Paperclip size={15} />}
 </button>
 </>
 ) : null}
 <span
 className="mono inline-flex items-center gap-1.5 rounded-full border border-[var(--etched-border)] px-2.5 py-1 text-[10.5px] uppercase tracking-[0.06em] text-[var(--text-muted)]"
 title="The model this agent is currently running"
 >
 <Cpu size={11} /> {shownModel}
 </span>
 <button
 type="button"
 role="switch"
 aria-checked={think}
 aria-label="Toggle extended reasoning"
 title="Think — let the agent reason for longer before answering"
 onClick={toggleThink}
 className={[
 "mono inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10.5px] uppercase tracking-[0.06em] transition-colors",
 think
 ? "border-transparent bg-[var(--ink-black)] text-[var(--bg-surface)]"
 : "border-[var(--etched-border)] text-[var(--text-muted)] hover:text-[var(--ink-black)]",
 ].join(" ")}
 >
 <Brain size={11} /> Think{think ? " · On" : ""}
 </button>
 <span className="flex-1" />
 {busy ? (
 <button
 type="button"
 onClick={stop}
 aria-label="Stop response"
 title="Stop the agent"
 className="inline-flex min-h-[34px] items-center gap-1.5 border border-[var(--ink-black)] px-3 text-[12.5px] font-semibold text-[var(--ink-black)] transition-colors hover:bg-[var(--bg-elevated)]"
 >
 <Square size={13} fill="currentColor" /> Stop response
 </button>
 ) : (
 <button
 type="submit"
 disabled={!input.trim()}
 aria-label="Send message"
 className="inline-flex min-h-[34px] items-center gap-1.5 bg-[var(--ink-black)] px-3 text-[12.5px] font-semibold text-[var(--bg-surface)] transition-opacity disabled:opacity-40"
 >
 <Send size={14} />
 <span className="hidden md:inline">Send message</span>
 </button>
 )}
 </div>
 </form>
 {attachments.length > 0 ? (
 <div className="mx-auto mt-2 flex w-full max-w-[760px] flex-wrap gap-1.5">
 {attachments.map((a) => (
 <span key={a.path} className="mono inline-flex items-center gap-1.5 rounded-full border border-[var(--etched-border)] bg-[var(--bg-elevated)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)]">
 <Paperclip size={10} /> {a.name}
 <button type="button" aria-label={`Remove ${a.name}`} onClick={() => setAttachments((prev) => prev.filter((x) => x.path !== a.path))} className="inline-flex text-[var(--text-muted)] transition-colors hover:text-[var(--ink-black)]">
 <X size={11} />
 </button>
 </span>
 ))}
 </div>
 ) : null}
 <p className="mx-auto mt-2 w-full max-w-[760px] text-center text-[11px] text-[var(--text-muted)]">
 Runs the official agent CLI on this computer · Enter to send, Shift+Enter for newline
 </p>
 </div>
 </div>
 </div>
 );
}

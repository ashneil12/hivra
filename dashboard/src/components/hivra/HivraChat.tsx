"use client";

// Hivra agent chat — HermesOS-styled streaming chat with a sessions sidebar
// (history). Talks to a deployed runtime (a box running the official `claude`
// CLI) over its NDJSON stream-json, directly browser->box. Sessions persist per
// box in localStorage; each session resumes its own Claude session_id.

import { Children, isValidElement, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import posthog from "posthog-js";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Send, Loader2, Check, X, Plus, MessageSquare, Trash2, ChevronRight, ChevronDown, Square, RotateCcw, Copy, Paperclip, PanelLeft, Brain, Cpu, ThumbsUp, ThumbsDown } from "lucide-react";

import { boxChatRunEventsUrl, listBoxChatRuns, listBoxSessions, readBoxSession, stampAgentFirstUsage, stopBoxChatRun, uploadBoxFile, type BoxChatRun, type BoxMessage } from "@/lib/hivra/agent-api";
import { getGoal } from "@/lib/hivra/agent-identity";
import { startAgentWelcomeRun, isHiddenWelcomeTitle } from "@/lib/hivra/agent-welcome";
import { getAdapter, type AgentKind, type ChatSink, type ToolStatus } from "@/lib/hivra/agent-adapters";
import { clientLog } from "@/lib/client/logger";
import { captureClient } from "@/lib/telemetry/posthog-client";
import { CodeBlock } from "@/components/markdown/CodeBlock";
import { copyTextToClipboard } from "@/lib/client/clipboard";
import { MemoryUsageBanner } from "@/components/memory/MemoryUsageBanner";
import styles from "./HivraChat.module.css";

// Fenced code (any <pre>, including one-line blocks with no language) → the
// shared syntax-highlighted CodeBlock, which scrolls inside its own box.
// Inline code keeps a lightweight mono chip that wraps anywhere.
export const CHAT_MARKDOWN_COMPONENTS = {
 pre(props: { children?: React.ReactNode }) {
 const child = Children.toArray(props.children)[0];
 if (isValidElement<{ className?: string; children?: React.ReactNode }>(child)) {
 const text = String(child.props.children ?? "").replace(/\n$/, "");
 const lang = /language-([\w-]+)/.exec(child.props.className || "")?.[1];
 return <CodeBlock language={lang || "text"} value={text} />;
 }
 return <CodeBlock language="text" value={String(props.children ?? "")} />;
 },
 code(props: { children?: React.ReactNode }) {
 return <code style={{ fontFamily: "var(--font-mono), monospace", fontSize: "0.9em", background: "var(--bg-elevated)", border: "1px solid var(--etched-border)", padding: "1px 5px", overflowWrap: "anywhere" }}>{props.children}</code>;
 },
 table({ children }: { children?: React.ReactNode }) {
 return <div className="chat-md-table-wrapper"><table className="chat-md-table">{children}</table></div>;
 },
 // Replies open links in a new tab so tapping one never navigates the
 // dashboard (or the installed PWA) away and aborts the running turn.
 a({ href, children }: { href?: string; children?: React.ReactNode }) {
 return <a href={href} target="_blank" rel="noopener noreferrer" className="chat-md-link" style={{ overflowWrap: "anywhere" }}>{children}</a>;
 },
};

const COARSE_POINTER_QUERY = "(hover: none) and (pointer: coarse)";
const NARROW_QUERY = "(max-width: 767px)";

function matchesMedia(query: string): boolean {
 return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

function useMediaQuery(query: string): boolean {
 const subscribe = useCallback((onChange: () => void) => {
 if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
 const list = window.matchMedia(query);
 list.addEventListener?.("change", onChange);
 return () => list.removeEventListener?.("change", onChange);
 }, [query]);
 return useSyncExternalStore(subscribe, () => matchesMedia(query), () => false);
}

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_EDGE = 2048;
const PASSTHROUGH_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function formatMegabytes(bytes: number): string {
 return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readBase64(blob: Blob): Promise<string> {
 return new Promise<string>((resolve, reject) => {
 const fr = new FileReader();
 fr.onload = () => resolve(String(fr.result).split(",")[1] || "");
 fr.onerror = () => reject(new Error("read failed"));
 fr.readAsDataURL(blob);
 });
}

async function decodeImage(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; release: () => void } | null> {
 if (typeof createImageBitmap === "function") {
 try {
 const bitmap = await createImageBitmap(file);
 return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
 } catch {
 // Fall through to <img>, which also decodes HEIC on Safari.
 }
 }
 if (typeof Image === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
 const url = URL.createObjectURL(file);
 try {
 const img = await new Promise<HTMLImageElement>((resolve, reject) => {
 const el = new Image();
 el.onload = () => resolve(el);
 el.onerror = () => reject(new Error("decode failed"));
 el.src = url;
 });
 return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
 } catch {
 URL.revokeObjectURL(url);
 return null;
 }
}

// Phone photos are 12+ MP JPEG or HEIC. Anything larger than 2048px, over the
// upload limit, or in a format the box may not read is re-encoded as a JPEG no
// larger than 2048px. Returns null to upload the original file unchanged.
async function prepareImageAttachment(file: File): Promise<{ blob: Blob; name: string } | null> {
 if (!file.type.startsWith("image/") || file.type === "image/gif" || file.type === "image/svg+xml") return null;
 if (typeof document === "undefined") return null;
 const decoded = await decodeImage(file);
 if (!decoded) return null;
 try {
 const longest = Math.max(decoded.width, decoded.height);
 if (!longest) return null;
 if (longest <= MAX_IMAGE_EDGE && file.size <= MAX_ATTACHMENT_BYTES && PASSTHROUGH_IMAGE_TYPES.has(file.type)) return null;
 const scale = Math.min(1, MAX_IMAGE_EDGE / longest);
 const canvas = document.createElement("canvas");
 canvas.width = Math.max(1, Math.round(decoded.width * scale));
 canvas.height = Math.max(1, Math.round(decoded.height * scale));
 const ctx = canvas.getContext("2d");
 if (!ctx) return null;
 ctx.fillStyle = "#fff";
 ctx.fillRect(0, 0, canvas.width, canvas.height);
 ctx.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
 const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
 if (!blob) return null;
 return { blob, name: `${(file.name || "photo").replace(/\.[^.]+$/, "")}.jpg` };
 } finally {
 decoded.release();
 }
}

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
 className={`mono ${styles.msgAction}`}
 style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5, border: "1px solid var(--etched-border)", background: "transparent", color: copied ? "#22c55e" : "var(--text-muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", padding: "3px 8px", cursor: "pointer", marginTop: 6 }}
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
 justifyContent: "center",
 border: "1px solid var(--etched-border)",
 background: "transparent",
 cursor: "pointer",
 padding: "3px 7px",
 marginTop: 6,
 } as const;
 return (
 <span className={styles.msgFeedback} style={{ display: "inline-flex", marginLeft: 8 }}>
 <button
 type="button"
 aria-label="Good response"
 aria-pressed={rating === "up"}
 onClick={() => onRate("up")}
 className={styles.msgAction}
 style={{ ...base, color: rating === "up" ? "#22c55e" : "var(--text-muted)" }}
 >
 <ThumbsUp size={11} />
 </button>
 <button
 type="button"
 aria-label="Bad response"
 aria-pressed={rating === "down"}
 onClick={() => onRate("down")}
 className={styles.msgAction}
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
 status: ToolStatus | "unknown";
 result?: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  tools: ToolChip[];
  streaming?: boolean;
  /** "disconnected": this page lost the reply's stream, but the agent keeps
   * working on its computer and the reply fills in once it is reachable.
   * "unknown": the run finished while no page was watching and the computer
   * no longer keeps its log, so only the text that arrived here is shown. */
  outcome?: "complete" | "error" | "stopped" | "disconnected" | "unknown";
  /** The box run producing this reply: the key for Stop and for re-attaching. */
  runId?: string;
  /** The computer confirmed it started the run (its `_run` line arrived). */
  started?: boolean;
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
 tools: (m.tools || []).map((name) => ({ name, detail: "", status: "unknown" as const })),
 };
}

// A conversation's history from the computer. A conversation the agent opened
// itself starts with the hidden first-contact prompt, which never shows.
function boxHistoryToChat(messages: BoxMessage[]): ChatMessage[] {
 return messages.filter((m) => !(m.role === "user" && isHiddenWelcomeTitle(m.text))).map(boxMsgToChat);
}

// What a conversation shows before a reply adopted from a run that is still
// going: its history from the box up to and including that turn's prompt. The
// box may already hold the turn's output so far, which the reply replays in
// full. A welcome is its conversation's first turn, and its prompt is hidden.
function historyBeforeRunningTurn(history: ChatMessage[], prompt: string | null, welcome: boolean): ChatMessage[] {
 if (welcome) return [];
 const asked: ChatMessage[] = prompt ? [{ role: "user", text: prompt, tools: [] }] : [];
 const lastUser = history.map((m) => m.role).lastIndexOf("user");
 const head = (prompt || "").replace(/…$/, "");
 if (lastUser >= 0 && head && history[lastUser].text.startsWith(head)) return history.slice(0, lastUser + 1);
 // The box has not recorded this turn's prompt yet.
 return [...history, ...asked];
}

// A pending reply whose run the computer no longer lists. Finished runs are kept
// for a week, and the list holds only the newest ones, so a run that started
// and then aged out finished while no page watched it: keep what arrived and
// say so, not that it failed. A reply with no sign its run ever started may
// never have reached the computer, and keeps the failure state.
function settleMissingRun(m: ChatMessage): ChatMessage {
 const started = Boolean(m.started || m.text.trim() || m.tools.length);
 return { ...m, streaming: false, outcome: started ? "unknown" : "error" };
}

// A box-history stub for this conversation that has not been opened yet: the
// placeholder a chat that learns the conversation's id (a reply adopted from
// another device) replaces.
function isUnopenedStubOf(s: Session, conversationId: string | null): boolean {
 return Boolean(conversationId) && s.claudeSessionId === conversationId && s.loaded === false && s.messages.length === 0;
}

// The user's message as another device's run list names it: the computer keeps
// the first 120 characters as the run's title.
const RUN_TITLE_LIMIT = 120;
function promptFromRunTitle(title: string): string | null {
 const text = title.trim();
 if (!text) return null;
 return title.length >= RUN_TITLE_LIMIT ? text + "…" : text;
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

// Chat turns run on the box detached from the request that started them. The
// client picks the run id so Stop and re-attach work before the box answers.
function newRunId(): string {
 if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
 const b = crypto.getRandomValues(new Uint8Array(16));
 b[6] = (b[6] & 0x0f) | 0x40;
 b[8] = (b[8] & 0x3f) | 0x80;
 const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
 return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

type RunStreamResult =
 | { kind: "done"; done: Record<string, unknown> }
 | { kind: "ended" | "failed"; sawRun: boolean }
 | { kind: "superseded" };
type RunFollowResult = RunStreamResult | { kind: "missing" } | { kind: "unreachable" };
const RUN_RETRY_DELAYS_MS = [0, 1000, 2000, 4000, 8000, 15000];

/** A session's in-flight turn, as registered for Stop and re-attach. */
interface TurnHandle {
 controller: AbortController;
 /** False once the turn was stopped or the chat moved to another computer. */
 isCurrent: () => boolean;
 /** Unregister the turn and clear the session's busy state. */
 finish: () => void;
}
/** How a turn's POST ended. "settled": the reply was closed. The rest are
 * failures to start the turn, which each caller words for itself. */
type TurnEnd =
 | { kind: "settled" }
 | { kind: "superseded" }
 | { kind: "aborted" }
 | { kind: "unreachable" }
 | { kind: "refused"; status: number; reason: string };

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
function ToolCard({ tool, streaming = false, interrupted = false }: { tool: ToolChip; streaming?: boolean; interrupted?: boolean }) {
  const [open, setOpen] = useState(false);
  const hasResult = Boolean(tool.result);
  const disclosureId = `tool-result-${useId().replace(/:/g, "")}`;
  const unconfirmed = tool.status === "unknown" || (!streaming && tool.status === "running");
  const statusLabel = unconfirmed ? (interrupted ? "Interrupted" : "Unconfirmed") : tool.status === "running" ? "Running" : tool.status === "error" ? "Failed" : "Completed";
  return (
    <div style={{ background: "var(--bg-elevated)", border: "1px solid var(--etched-border)", fontFamily: "var(--font-mono)", fontSize: 11.5 }}>
      <button
        type="button"
        className={`hivra-chat-tool-toggle ${styles.msgAction}`}
        aria-label={`${tool.name}${tool.detail ? ` · ${tool.detail}` : ""} — ${statusLabel}`}
        disabled={!hasResult}
        aria-expanded={hasResult ? open : undefined}
        aria-controls={hasResult ? disclosureId : undefined}
        onClick={() => hasResult && setOpen((o) => !o)}
        style={{ display: "flex", width: "100%", alignItems: "center", gap: 7, minWidth: 0, padding: "5px 9px", border: 0, background: "transparent", color: "inherit", textAlign: "left", cursor: hasResult ? "pointer" : "default" }}
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
        {unconfirmed ? (
          <span style={{ color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", flexShrink: 0 }}>{statusLabel}</span>
        ) : tool.status === "running" ? (
          <Loader2 className="hivra-chat-spinner" size={12} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
 ) : tool.status === "error" ? (
 <X size={13} style={{ color: "#c0392b", flexShrink: 0 }} />
 ) : (
 <Check size={13} style={{ color: "var(--gold-leaf)", flexShrink: 0 }} />
 )}
      </button>
      {hasResult ? (
        <div id={disclosureId} hidden={!open} style={{ padding: "0 9px 7px 28px", color: tool.status === "error" ? "#c0392b" : "var(--text-secondary)", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 220, overflow: "auto" }}>
          {tool.result}
        </div>
 ) : null}
 </div>
 );
}

function AssistantActivity({ tools, streaming, outcome, text }: { tools: ToolChip[]; streaming?: boolean; outcome?: ChatMessage["outcome"]; text: string }) {
  if (!streaming && tools.length === 0) return null;
  const runningTools = streaming ? tools.filter((tool) => tool.status === "running") : [];
  const running = runningTools[runningTools.length - 1];
  const failed = tools.some((tool) => tool.status === "error");
  const unconfirmed = tools.some((tool) => tool.status === "running" || tool.status === "unknown");
  const summary = streaming ? (running ? "Working" : text ? "Responding" : "Waiting for response")
    : outcome === "disconnected" ? "Still working"
    : outcome === "unknown" ? "Finished while you were away"
    : outcome === "stopped" ? "Activity stopped"
    : outcome === "error" ? "Response failed"
    : unconfirmed ? "Completion unconfirmed" : failed ? "Actions include failures" : "Completed";
  const detail = running ? `${runningTools.length > 1 ? `${runningTools.length} actions running · ` : ""}${running.name}${running.detail ? ` · ${running.detail}` : ""}` : tools.length ? `${tools.length} action${tools.length === 1 ? "" : "s"}` : "";
  const dot = streaming ? "is-running" : outcome === "error" || failed ? "is-error" : unconfirmed || outcome === "stopped" || outcome === "disconnected" || outcome === "unknown" ? "is-muted" : "is-done";
  return (
    <div className="hivra-chat-activity" role="status" aria-live="polite" aria-atomic="true">
      <span className={`hivra-chat-activity-dot ${dot}`} aria-hidden />
      <span className="hivra-chat-activity-label">{summary}</span>
      <span className="hivra-chat-activity-detail">{detail}</span>
    </div>
  );
}

function ToolHistory({ message }: { message: ChatMessage }) {
 const [open, setOpen] = useState(false);
 const id = useId();
 if (!message.tools.length) return null;
 return (
 <div className="hivra-chat-tool-history">
 <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
 <ChevronRight size={12} aria-hidden style={{ transform: open ? "rotate(90deg)" : undefined }} />
 {message.tools.length} action{message.tools.length === 1 ? "" : "s"}
 </button>
 <div id={id} hidden={!open}>
 <div className="hivra-chat-tool-history-list">
 {message.tools.map((tool, i) => <ToolCard key={tool.id || i} tool={tool} streaming={message.streaming} interrupted={message.outcome === "stopped"} />)}
 </div>
 </div>
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
 // Conversations run independently: each session owns its in-flight turn, so
 // several chats can be working on the box at once. `busy` is the open one.
 const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
 const busy = busyIds.has(activeId);
 const anyBusy = busyIds.size > 0;
 const setSessionBusy = useCallback((sessionId: string, on: boolean) => {
 setBusyIds((prev) => {
 if (prev.has(sessionId) === on) return prev;
 const next = new Set(prev);
 if (on) next.add(sessionId); else next.delete(sessionId);
 return next;
 });
 }, []);
 const [boxHistoryChecked, setBoxHistoryChecked] = useState(false);
 const [hasBoxHistory, setHasBoxHistory] = useState(false);
 const activeIdRef = useRef<string>("");
 const scrollRef = useRef<HTMLDivElement>(null);
 const autoWelcomeAttemptedRef = useRef(false);
 // Per-turn scratch state for each session's parser (e.g. codex's id→text
 // segment map). Reset at the start of each send() for that session.
 const turnStateRef = useRef(new Map<string, Record<string, unknown>>());
 // Aborts this page's connection to a session's in-flight turn. The run itself
 // is detached on the box: only an explicit Stop (runRef's id) ends it.
 const abortRef = useRef(new Map<string, AbortController>());
 // The box run id of each session's in-flight turn, for Stop.
 const runRef = useRef(new Map<string, string>());
 // Set once the box has shown it runs turns detached (a `_run` line or a run list).
 const runsSupportedRef = useRef(false);
 // Every async turn captures the current generation. Changing the backing box
 // or stable storage identity invalidates that generation before aborting so a
 // late fetch result or reader callback cannot target the replacement chat.
 const requestGenerationRef = useRef(0);
 // Last user message of each session's failed turn, for a one-tap retry.
 const [failedBySession, setFailedBySession] = useState<Record<string, string>>({});
 const lastFailed = failedBySession[activeId] ?? null;
 const setLastFailed = useCallback((sessionId: string, text: string | null) => {
 setFailedBySession((prev) => {
 if (text === null) {
 if (!(sessionId in prev)) return prev;
 const next = { ...prev };
 delete next[sessionId];
 return next;
 }
 return { ...prev, [sessionId]: text };
 });
 }, []);
 // Thumbs up/down selection per assistant message, keyed by `${sessionId}:${index}`
 // so a rating sticks to its message and survives session switches. UI-only state
 // (the event itself goes to PostHog) — not persisted across reloads.
 const [feedback, setFeedback] = useState<Record<string, "up" | "down">>({});
 // Pending attachments (already uploaded to the box; sent with the next message).
 const [attachments, setAttachments] = useState<{ name: string; path: string }[]>([]);
 const attachmentsRef = useRef<{ name: string; path: string }[]>([]);
 useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
 const [uploading, setUploading] = useState(false);
 const [attachError, setAttachError] = useState<string | null>(null);
 const fileInputRef = useRef<HTMLInputElement>(null);
 const composerRef = useRef<HTMLTextAreaElement>(null);
 const composerDockRef = useRef<HTMLDivElement>(null);
 // Touch keyboards have no Shift+Enter, so there Return inserts a newline and
 // only the Send button sends.
 const coarsePointer = useMediaQuery(COARSE_POINTER_QUERY);
 const narrow = useMediaQuery(NARROW_QUERY);
 const composerCap = narrow ? 120 : 160;
 useEffect(() => {
   const textarea = composerRef.current;
   if (!textarea) return;
   textarea.style.height = "auto";
   textarea.style.height = `${Math.max(44, Math.min(textarea.scrollHeight, composerCap))}px`;
   textarea.style.overflowY = textarea.scrollHeight > composerCap ? "auto" : "hidden";
 }, [input, composerCap]);
 // Sessions rail visibility. Below md it is an overlay drawer, closed by default.
 const [showRail, setShowRail] = useState(false);
 const drawerOpen = showRail && narrow;
 const railToggleRef = useRef<HTMLButtonElement>(null);
 const drawerRef = useRef<HTMLDivElement>(null);
 const drawerId = useId();
 useEffect(() => {
 if (!drawerOpen) return;
 const onKey = (event: KeyboardEvent) => {
 if (event.key === "Escape") setShowRail(false);
 };
 window.addEventListener("keydown", onKey);
 return () => window.removeEventListener("keydown", onKey);
 }, [drawerOpen]);
 // The drawer is modal below md: focus moves into it on open and back to the
 // toggle once it closes (Escape, backdrop, Close chats, or a pick).
 const drawerWasOpenRef = useRef(false);
 useEffect(() => {
 if (drawerOpen) {
 drawerWasOpenRef.current = true;
 drawerRef.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus();
 return;
 }
 if (!drawerWasOpenRef.current) return;
 drawerWasOpenRef.current = false;
 if (!showRail) railToggleRef.current?.focus();
 }, [drawerOpen, showRail]);
 const trapDrawerFocus = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
 if (event.key !== "Tab") return;
 const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled])"));
 if (focusable.length === 0) return;
 const first = focusable[0];
 const last = focusable[focusable.length - 1];
 if (event.shiftKey && document.activeElement === first) {
 event.preventDefault();
 last.focus();
 } else if (!event.shiftKey && document.activeElement === last) {
 event.preventDefault();
 first.focus();
 }
 }, []);

 useEffect(() => {
 const abortAll = () => {
 requestGenerationRef.current += 1;
 const controllers = [...abortRef.current.values()];
 abortRef.current.clear();
 for (const controller of controllers) controller.abort();
 turnStateRef.current.clear();
 };
 abortAll();
 autoWelcomeAttemptedRef.current = false;
 setBusyIds(new Set());
 setFailedBySession({});

 return abortAll;
 }, [boxUrl, skey]);

 const uploadAttachment = useCallback(async (file: File) => {
 if (!token || uploading || attachmentsRef.current.length >= 5) return;
 setAttachError(null);
 setUploading(true);
 try {
 const prepared = await prepareImageAttachment(file).catch(() => null);
 const blob: Blob = prepared?.blob ?? file;
 const name = prepared?.name ?? (file.name || "pasted.png");
 if (blob.size > MAX_ATTACHMENT_BYTES) {
 setAttachError(`This file is ${formatMegabytes(blob.size)} — the limit is 8 MB`);
 return;
 }
 const dataBase64 = await readBase64(blob);
 const r = await uploadBoxFile(boxUrl, name, dataBase64, token);
 if (r.ok && r.path) {
 setAttachments((prev) => [...prev, { name, path: r.path! }]);
 } else {
 clientLog.warn("chat attachment upload rejected", { source: "hivra-chat", failureType: "hivra_chat_attachment_upload_failed", agentKind, reason: r.error });
 setAttachError("Upload failed — try again");
 }
 } catch (err) {
 clientLog.warn("chat attachment upload failed", { source: "hivra-chat", failureType: "hivra_chat_attachment_upload_failed", agentKind }, err);
 setAttachError("Upload failed — try again");
 } finally {
 setUploading(false);
 }
 }, [agentKind, boxUrl, token, uploading]);

 // Load persisted sessions for this box (or start fresh), and re-open whichever
 // chat was active last time (falls back to the newest).
 // `loadedKey` marks which box's sessions are in state, so resuming detached
 // runs never scans the previous box's chats.
 const [loadedKey, setLoadedKey] = useState<string | null>(null);
 useEffect(() => {
 const loaded = loadSessions(skey);
 const next = loaded.length ? loaded : [emptySession()];
 setSessions(next);
 setLoadedKey(skey);
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

 // Persist on a short debounce (avoid thrashing localStorage on every token).
 // With parallel chats some session is often streaming, so waiting for idle
 // could postpone saving indefinitely; loadSessions clears stale streaming.
 // Nothing is saved until this box's sessions are in state: saving the
 // placeholder chat (or the previous box's chats) would overwrite its history.
 useEffect(() => {
 if (loadedKey !== skey) return;
 const timer = window.setTimeout(() => saveSessions(skey, sessions), anyBusy ? 1000 : 0);
 return () => window.clearTimeout(timer);
 }, [sessions, anyBusy, loadedKey, skey]);
 // Leaving must not lose a reply's run id inside the save debounce: the next
 // visit uses it to pick the still-running reply back up. Closing the tab fires
 // pagehide; in-app navigation only unmounts the chat.
 const sessionsRef = useRef<Session[]>(sessions);
 const sessionsKeyRef = useRef<string | null>(null);
 useEffect(() => {
 sessionsRef.current = sessions;
 sessionsKeyRef.current = loadedKey;
 }, [sessions, loadedKey]);
 useEffect(() => {
 const flush = () => {
 if (sessionsKeyRef.current === skey) saveSessions(skey, sessionsRef.current);
 };
 window.addEventListener("pagehide", flush);
 return () => {
 window.removeEventListener("pagehide", flush);
 flush();
 };
 }, [skey]);

 const active = useMemo(() => sessions.find((s) => s.id === activeId) || sessions[0], [sessions, activeId]);

 // Activate a session; if it's an unloaded box-backed stub, fetch its messages
 // from the VM first so history shows up. A stub that loaded meanwhile (a
 // running reply was adopted into it) keeps what it has.
 const selectSession = useCallback(
 (s: Session) => {
 setActiveId(s.id);
 if (matchesMedia(NARROW_QUERY)) setShowRail(false);
 if (s.claudeSessionId && !s.loaded && s.messages.length === 0) {
 void readBoxSession(boxUrl, s.claudeSessionId, token).then((msgs) => {
 setSessions((prev) => prev.map((x) => (x.id === s.id && !x.loaded ? { ...x, messages: boxHistoryToChat(msgs), loaded: true } : x)));
 });
 }
 },
 [boxUrl, token],
 );

 // Smart autoscroll: follow the stream only while the user is at (or near) the
 // bottom. Scrolling up to re-read mid-stream pins the view; returning to the
 // bottom re-engages following. `force` is for user-initiated sends.
 const stickToBottomRef = useRef(true);
 const scrollFrameRef = useRef<number | null>(null);
 const [showLatest, setShowLatest] = useState(false);
 const onScrollPane = useCallback(() => {
 const el = scrollRef.current;
 if (!el) return;
 const following = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
 stickToBottomRef.current = following;
 setShowLatest(!following);
 }, []);
 const scrollDown = useCallback((force?: boolean) => {
 if (force) {
 stickToBottomRef.current = true;
 setShowLatest(false);
 }
 if (!stickToBottomRef.current || scrollFrameRef.current !== null) return;
 scrollFrameRef.current = requestAnimationFrame(() => {
 scrollFrameRef.current = null;
 // A scroll-up between the stream event and this frame must win.
 if (!stickToBottomRef.current) return;
 const el = scrollRef.current;
 // An empty chat has nothing to follow; pinning it would clip the greeting
 // on short screens.
 if (el && el.dataset.empty !== "true") el.scrollTop = el.scrollHeight;
 });
 }, []);
 useEffect(() => {
 scrollDown(true);
 const pane = scrollRef.current;
 if (pane?.dataset.empty === "true") pane.scrollTop = 0;
 return () => {
 if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
 scrollFrameRef.current = null;
 };
 }, [activeId, scrollDown]);
 // The pane also changes size without a scroll event: the soft keyboard
 // opening, the composer growing. Re-pin when following, otherwise refresh
 // the "Return to latest" state.
 useEffect(() => {
 const pane = scrollRef.current;
 if (!pane) return;
 const onResize = () => {
 if (stickToBottomRef.current) scrollDown();
 else onScrollPane();
 };
 const observer = typeof ResizeObserver === "function" ? new ResizeObserver(onResize) : null;
 observer?.observe(pane);
 if (composerDockRef.current) observer?.observe(composerDockRef.current);
 const viewport = typeof window !== "undefined" ? window.visualViewport : null;
 viewport?.addEventListener("resize", onResize);
 return () => {
 observer?.disconnect();
 viewport?.removeEventListener("resize", onResize);
 };
 }, [onScrollPane, scrollDown]);

 // Stream updates target the session that started the turn, never whichever
 // chat happens to be open when the event arrives.
 const updateSession = useCallback((sessionId: string, fn: (s: Session) => Session) => {
 setSessions((prev) => prev.map((s) => (s.id === sessionId ? fn(s) : s)));
 }, []);

 const updateAssistant = useCallback(
 (sessionId: string, fn: (msg: ChatMessage) => ChatMessage) => {
 updateSession(sessionId, (s) => {
 const messages = s.messages.slice();
 const last = messages.length - 1;
 if (last >= 0 && messages[last].role === "assistant") messages[last] = fn(messages[last]);
 return { ...s, messages };
 });
 },
 [updateSession],
 );

 // A run writes into its own reply by id, so a reply that finished while the
 // chat was closed lands in the right message even if it is no longer last.
 const updateRunMessage = useCallback(
 (sessionId: string, runId: string | undefined, fn: (msg: ChatMessage) => ChatMessage) => {
 if (!runId) return updateAssistant(sessionId, fn);
 updateSession(sessionId, (s) => {
 const index = s.messages.findIndex((m) => m.role === "assistant" && m.runId === runId);
 if (index < 0) return s;
 const messages = s.messages.slice();
 messages[index] = fn(messages[index]);
 return { ...s, messages };
 });
 },
 [updateAssistant, updateSession],
 );

 const upsertTool = useCallback(
 (sessionId: string, runId: string | undefined, id: string | undefined, patch: Partial<ToolChip>) => {
 updateRunMessage(sessionId, runId, (m) => {
 const tools = m.tools.slice();
 const idx = id ? tools.findIndex((t) => t.id === id) : -1;
 if (idx >= 0) tools[idx] = { ...tools[idx], ...patch };
 else tools.push({ id, name: "tool", detail: "", status: "running", ...patch });
 return { ...m, tools };
 });
 },
 [updateRunMessage],
 );

 // One stream event → UI. The per-agent parsing lives in the adapter registry
 // (agent-adapters), which the welcome path shares — so live + welcome can't
 // diverge. This component only provides the sink that maps parser intents onto
 // React state, plus the per-turn scratch state in turnStateRef.
 const handleEvent = useCallback(
 (sessionId: string, ev: Record<string, unknown>, runId?: string) => {
 const sink: ChatSink = {
 // A box-history stub listed for this conversation before this chat knew
 // its id (a reply adopted from another device) is the same chat: drop it.
 setSessionId: (id) => setSessions((prev) => prev
 .filter((s) => s.id === sessionId || s.id === activeIdRef.current || !isUnopenedStubOf(s, id))
 .map((s) => (s.id === sessionId ? { ...s, claudeSessionId: id } : s))),
 appendText: (t) => updateRunMessage(sessionId, runId, (m) => ({ ...m, text: m.text + t })),
 setText: (t) => updateRunMessage(sessionId, runId, (m) => ({ ...m, text: t })),
 upsertTool: (id, patch) => upsertTool(sessionId, runId, id, patch),
 appendWarning: (t) => updateRunMessage(sessionId, runId, (m) => ({ ...m, text: m.text + "\n\n⚠ " + t, outcome: "error" })),
 };
 let turnState = turnStateRef.current.get(sessionId);
 if (!turnState) { turnState = {}; turnStateRef.current.set(sessionId, turnState); }
 getAdapter(agentKind).parseEvent(ev, sink, turnState);
 },
 [agentKind, updateRunMessage, upsertTool],
 );

 // Read one NDJSON chat stream into a reply. `_done` means the run finished; a
 // stream can also just stop (network drop, proxy timeout, box restart) while
 // the run keeps working on the box. `_run` says the box runs turns detached.
 const readRunStream = useCallback(
 async (body: ReadableStream<Uint8Array>, sessionId: string, runId: string | undefined, isCurrent: () => boolean): Promise<RunStreamResult> => {
 const reader = body.getReader();
 const dec = new TextDecoder();
 const seen: { run: boolean; done: Record<string, unknown> | null } = { run: false, done: null };
 let buf = "";
 const dispatchLine = (line: string): boolean => {
 if (!isCurrent()) return false;
 const event = parseNdjsonLine(line);
 if (!event) return true;
 if (event.type === "_run" && !seen.run) {
 seen.run = true;
 runsSupportedRef.current = true;
 updateRunMessage(sessionId, runId, (m) => (m.started ? m : { ...m, started: true }));
 }
 if (event.type === "_done") seen.done = event;
 try {
 handleEvent(sessionId, event, runId);
 } catch {
 /* skip malformed or unsupported event */
 }
 if (activeIdRef.current === sessionId) scrollDown();
 return true;
 };
 try {
 for (;;) {
 const { done, value } = await reader.read();
 if (!isCurrent()) return { kind: "superseded" };
 buf += done ? dec.decode() : dec.decode(value, { stream: true });
 let idx: number;
 while ((idx = buf.indexOf("\n")) >= 0) {
 const line = buf.slice(0, idx);
 buf = buf.slice(idx + 1);
 if (!dispatchLine(line)) return { kind: "superseded" };
 }
 if (!done) continue;
 if (buf.trim() && !dispatchLine(buf)) return { kind: "superseded" };
 break;
 }
 } catch {
 if (!isCurrent()) return { kind: "superseded" };
 return { kind: "failed", sawRun: seen.run };
 }
 return seen.done ? { kind: "done", done: seen.done } : { kind: "ended", sawRun: seen.run };
 },
 [handleEvent, scrollDown, updateRunMessage],
 );

 // Re-read a run from the box, rebuilding its reply from the start, and keep
 // following it live until it finishes. Used when a stream drops mid-turn and
 // when the chat reopens with replies that were still running.
 const followRun = useCallback(
 async (sessionId: string, runId: string, isCurrent: () => boolean, signal: AbortSignal, attempts: number): Promise<RunFollowResult> => {
 for (let attempt = 0; attempt < attempts; attempt++) {
 const wait = RUN_RETRY_DELAYS_MS[Math.min(attempt, RUN_RETRY_DELAYS_MS.length - 1)];
 if (wait) await new Promise((resolve) => window.setTimeout(resolve, wait));
 if (!isCurrent()) return { kind: "superseded" };
 let resp: Response;
 try {
 resp = await fetch(boxChatRunEventsUrl(boxUrl, runId), { cache: "no-store", headers: token ? { Authorization: `Bearer ${token}` } : {}, signal });
 } catch {
 if (!isCurrent()) return { kind: "superseded" };
 continue;
 }
 if (!isCurrent()) return { kind: "superseded" };
 if (resp.status === 404) return { kind: "missing" };
 if (!resp.ok || !resp.body) continue;
 turnStateRef.current.set(sessionId, getAdapter(agentKind).createTurnState());
 updateRunMessage(sessionId, runId, (m) => ({ ...m, text: "", tools: [], outcome: undefined, streaming: true, started: true }));
 const result = await readRunStream(resp.body, sessionId, runId, isCurrent);
 if (result.kind === "done" || result.kind === "superseded") return result;
 }
 return { kind: "unreachable" };
 },
 [agentKind, boxUrl, readRunStream, token, updateRunMessage],
 );

 // Close a reply from the box's `_done` line (null: an older runtime whose
 // stream simply ended, which always meant the turn finished).
 const finalizeRun = useCallback(
 (sessionId: string, runId: string | undefined, done: Record<string, unknown> | null) => {
 updateRunMessage(sessionId, runId, (m) => {
 if (done?.interrupted) {
 return { ...m, streaming: false, outcome: "error", text: m.text + (m.text ? "\n\n" : "") + "⚠ The run was interrupted before it finished because the agent's computer restarted." };
 }
 if (done?.stopped) return { ...m, streaming: false, outcome: "stopped" };
 return { ...m, streaming: false, outcome: m.outcome === "error" ? "error" : "complete" };
 });
 },
 [updateRunMessage],
 );

 // Register a session's in-flight turn so Stop finds its controller and run id,
 // and every async step can tell it is still that session's current turn.
 const beginTurn = useCallback(
 (sessionId: string, runId: string): TurnHandle => {
 const controller = new AbortController();
 const generation = requestGenerationRef.current;
 const isCurrent = () => requestGenerationRef.current === generation && abortRef.current.get(sessionId) === controller;
 abortRef.current.set(sessionId, controller);
 runRef.current.set(sessionId, runId);
 turnStateRef.current.set(sessionId, getAdapter(agentKind).createTurnState()); // fresh per-turn parser state
 setSessionBusy(sessionId, true);
 const finish = () => {
 if (abortRef.current.get(sessionId) === controller) abortRef.current.delete(sessionId);
 if (runRef.current.get(sessionId) === runId) runRef.current.delete(sessionId);
 turnStateRef.current.delete(sessionId);
 setSessionBusy(sessionId, false);
 };
 return { controller, isCurrent, finish };
 },
 [agentKind, setSessionBusy],
 );

 // Carry a turn from its POST to its end, writing into the reply `runId` names.
 // The box runs the turn detached, so a stream that drops mid-turn re-attaches
 // through the run's log. A normal send and the first-contact welcome share
 // this path; each words its own failure to start.
 const driveTurn = useCallback(
 async (sessionId: string, runId: string, turn: TurnHandle, post: (signal: AbortSignal) => Promise<Response>, onAccepted?: () => void): Promise<TurnEnd> => {
 let resp: Response;
 try {
 resp = await post(turn.controller.signal);
 } catch (e) {
 if (!turn.isCurrent()) return { kind: "superseded" };
 // User stops invalidate the turn before aborting. Any current failure
 // here is an unexpected transport error.
 if ((e as Error).name === "AbortError") return { kind: "aborted" };
 // The request may have reached the box before the connection failed.
 const recovered = await followRun(sessionId, runId, turn.isCurrent, turn.controller.signal, 2);
 if (recovered.kind === "superseded") return recovered;
 if (recovered.kind !== "done") return { kind: "unreachable" };
 finalizeRun(sessionId, runId, recovered.done);
 return { kind: "settled" };
 }
 if (!turn.isCurrent()) return { kind: "superseded" };
 if (!resp.ok || !resp.body) {
 // 409 (this conversation is still working) and 429 (too many runs) carry a
 // reason worth showing as-is.
 const detail = resp.status === 409 || resp.status === 429 ? (await resp.json().catch(() => null)) as { error?: unknown } | null : null;
 if (!turn.isCurrent()) return { kind: "superseded" };
 return { kind: "refused", status: resp.status, reason: typeof detail?.error === "string" ? detail.error : "" };
 }
 onAccepted?.();
 let result: RunFollowResult = await readRunStream(resp.body, sessionId, runId, turn.isCurrent);
 if (result.kind === "superseded") return result;
 if (result.kind !== "done" && result.sawRun) {
 // The run keeps going on the box when the stream drops; pick it back up.
 result = await followRun(sessionId, runId, turn.isCurrent, turn.controller.signal, RUN_RETRY_DELAYS_MS.length);
 if (result.kind === "superseded") return result;
 }
 if (result.kind === "done") finalizeRun(sessionId, runId, result.done);
 else if (result.kind === "ended") finalizeRun(sessionId, runId, null);
 else if (result.kind === "unreachable") updateRunMessage(sessionId, runId, (m) => ({ ...m, streaming: false, outcome: "disconnected" }));
 else updateRunMessage(sessionId, runId, (m) => ({ ...m, streaming: false, outcome: "error" }));
 return { kind: "settled" };
 },
 [finalizeRun, followRun, readRunStream, updateRunMessage],
 );

 const send = useCallback(
 async (raw: string) => {
 const sessionId = activeIdRef.current;
 if (!sessionId || abortRef.current.has(sessionId)) return;
 const text = raw.trim();
 if (!text) return;
 const session = sessions.find((s) => s.id === sessionId);
 const resumeId = session?.claudeSessionId || null;
 const images = attachmentsRef.current.map((a) => a.path);
 setInput("");
 setAttachments([]);
 setAttachError(null);
 try { window.localStorage.removeItem(draftKey(skey, sessionId)); } catch { /* ignore */ }
 setLastFailed(sessionId, null);
 const runId = newRunId();
 const turn = beginTurn(sessionId, runId);
 const shownText = images.length ? text + "\n\n📎 " + images.map((p) => p.split("/").pop()).join(", ") : text;
 updateSession(sessionId, (s) => ({
 ...s,
 title: s.messages.length === 0 ? text.slice(0, 42) : s.title,
 messages: [
 ...s.messages,
 { role: "user", text: shownText, tools: [] },
 { role: "assistant", text: "", tools: [], streaming: true, runId },
 ],
 }));
 const followIfOpen = (force?: boolean) => {
 if (activeIdRef.current === sessionId) scrollDown(force);
 };
 stickToBottomRef.current = true; // a fresh send re-engages following
 followIfOpen(true);

 const post = (signal: AbortSignal) => fetch(`${boxUrl.replace(/\/$/, "")}/api/chat`, {
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
 // `detach` asks the box to keep the run going when this page goes away
 // (closed tab, sleeping laptop, dropped network). Only Stop ends it.
 body: JSON.stringify({ message: text, sessionId: resumeId, detach: true, runId, clientRef: sessionId, ...(images.length ? { images } : {}), ...(thinkRef.current ? { reasoning: true } : {}) }),
 signal,
 });
 // agent_first_message_sent — the funnel's Hivra-lane activation event.
 // Fires once per box (localStorage guard keyed on the stable storage
 // key); the $insert_id makes PostHog dedupe any double-fire across
 // devices/reinstalls best-effort. Analytics must never break the chat.
 const onAccepted = () => {
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
 };

 const end = await driveTurn(sessionId, runId, turn, post, onAccepted);
 if (end.kind === "superseded") return;
 if (end.kind === "aborted") {
 updateRunMessage(sessionId, runId, (m) => ({ ...m, streaming: false, outcome: "error" }));
 } else if (end.kind !== "settled") {
 const note = end.kind === "unreachable" ? "⚠ Couldn't reach your agent. It may be starting up — try again in a moment."
 : end.reason ? "⚠ " + end.reason : "⚠ Your agent hit an error (HTTP " + end.status + "). Try again.";
 updateRunMessage(sessionId, runId, (m) => ({ ...m, text: note, streaming: false, outcome: "error" }));
 setLastFailed(sessionId, text);
 }
 turn.finish();
 if (end.kind === "settled") followIfOpen();
 },
 [agentKind, beginTurn, boxUrl, driveTurn, scrollDown, sessions, setLastFailed, updateSession, updateRunMessage, token, skey],
 );

 // The agent opens a new computer's first chat on its own: a hidden prompt
 // asks it to introduce itself or, when the owner gave a first task at launch,
 // to DO that task and return the result ("do, don't show"). It is a detached
 // run like any send: a reload, a closed tab or a dropped network re-attaches
 // to it (resumeDetachedRuns), Stop ends it, and the conversation it starts is
 // the owner's to continue. Only the reply shows; the prompt never does.
 useEffect(() => {
 if (!boxHistoryChecked || hasBoxHistory || anyBusy || autoWelcomeAttemptedRef.current) return;
 if (!active || active.messages.length > 0) return;
 const welcomeSessionId = active.id;
 const flagKey = `hivra:first-welcome:${skey}`;
 try {
 if (window.localStorage.getItem(flagKey) === "1") return;
 } catch {
 // Storage is only a duplicate guard; the chat still works without it.
 }
 // Marked before the turn starts, not when it ends: the run outlives this
 // page, so a reload must re-attach to it instead of starting another.
 const markWelcomed = (welcomed: boolean) => {
 try {
 if (welcomed) window.localStorage.setItem(flagKey, "1");
 else window.localStorage.removeItem(flagKey);
 } catch {
 // Best-effort duplicate guard only.
 }
 };

 autoWelcomeAttemptedRef.current = true;
 markWelcomed(true);
 const hasFirstTask = Boolean((firstTask || "").trim());
 const runId = newRunId();
 const turn = beginTurn(welcomeSessionId, runId);
 updateSession(welcomeSessionId, (s) => ({
 ...s,
 title: s.title === "New chat" ? "Welcome" : s.title,
 messages: [{ role: "assistant", text: "", tools: [], streaming: true, runId }],
 }));

 // Fire the activation event once per box (the localStorage guard above
 // makes this run at most once). Analytics must never break the chat.
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

 const post = (signal: AbortSignal) => startAgentWelcomeRun({
 boxUrl,
 token,
 agentName,
 goal,
 context,
 firstTask,
 channel: "chat",
 runId,
 clientRef: welcomeSessionId,
 signal,
 });
 void driveTurn(welcomeSessionId, runId, turn, post).then((end) => {
 if (end.kind === "superseded") return;
 if (end.kind !== "settled") {
 clientLog.warn("agent first message generation failed", {
 source: "hivra-chat",
 failureType: "hivra_chat_welcome_generation_failed",
 agentKind,
 agentName,
 reason: end.kind,
 ...(end.kind === "refused" ? { status: end.status } : {}),
 });
 // The turn never got going: fall back to the starter suggestions, and
 // let the next visit try the welcome again.
 markWelcomed(false);
 updateSession(welcomeSessionId, (s) => ({ ...s, messages: s.messages.filter((m) => m.runId !== runId) }));
 } else {
 // A turn that finished without a word (an older runtime's empty
 // stream) falls back to the starter suggestions, as it always has.
 updateSession(welcomeSessionId, (s) => ({
 ...s,
 messages: s.messages.filter((m) => !(m.runId === runId && m.outcome === "complete" && !m.text.trim() && m.tools.length === 0)),
 }));
 }
 turn.finish();
 if (activeIdRef.current === welcomeSessionId) scrollDown();
 });
 }, [agentKind, agentName, active, anyBusy, beginTurn, boxHistoryChecked, boxUrl, context, driveTurn, firstTask, goal, hasBoxHistory, scrollDown, skey, token, updateSession]);

 // Stop a session's in-flight turn. The box keeps a detached run going without
 // this page, so Stop asks the box to end it; aborting the fetch also stops
 // older runtimes, which end a turn when the client disconnects. Other sessions
 // keep running.
 const stopSession = useCallback((sessionId: string) => {
 const controller = abortRef.current.get(sessionId);
 if (!controller) return;
 const runId = runRef.current.get(sessionId);
 abortRef.current.delete(sessionId);
 runRef.current.delete(sessionId);
 turnStateRef.current.delete(sessionId);
 if (runId) {
 void stopBoxChatRun(boxUrl, runId, token).then((stopped) => {
 if (!stopped && runsSupportedRef.current) {
 clientLog.warn("chat run stop was not confirmed by the computer", { source: "hivra-chat", failureType: "hivra_chat_run_stop_unconfirmed", agentKind });
 }
 });
 }
 controller.abort();
 updateSession(sessionId, (s) => ({
 ...s,
 messages: s.messages.map((m) => (m.streaming ? { ...m, streaming: false, outcome: "stopped" } : m)),
 }));
 setSessionBusy(sessionId, false);
 }, [agentKind, boxUrl, setSessionBusy, token, updateSession]);

 // Pick a reply back up from the box: follow it live if it is still running,
 // or rebuild it from the run's log if it finished while this page was away.
 const resumeRun = useCallback(async (sessionId: string, runId: string) => {
 if (abortRef.current.has(sessionId)) return;
 const turn = beginTurn(sessionId, runId);
 const result = await followRun(sessionId, runId, turn.isCurrent, turn.controller.signal, 3);
 if (result.kind === "superseded") return;
 if (result.kind === "done") finalizeRun(sessionId, runId, result.done);
 else if (result.kind === "missing") updateRunMessage(sessionId, runId, settleMissingRun);
 else updateRunMessage(sessionId, runId, (m) => ({ ...m, streaming: false, outcome: "disconnected" }));
 turn.finish();
 }, [beginTurn, finalizeRun, followRun, updateRunMessage]);

 // Runs adopted from the box's list since this chat opened, so a wake-up that
 // lands before an adopted reply is in state never follows it twice.
 const adoptedRunsRef = useRef(new Set<string>());
 useEffect(() => {
 adoptedRunsRef.current = new Set();
 }, [boxUrl, skey]);

 // Show a turn this page did not start (another device, or a save that never
 // landed): attach its reply to the conversation it belongs to, or open it as a
 // chat of its own, and follow it live.
 const adoptRun = useCallback(async (run: BoxChatRun) => {
 adoptedRunsRef.current.add(run.runId);
 const generation = requestGenerationRef.current;
 const findTarget = () => sessionsRef.current.find((s) => s.id === run.clientRef)
 ?? (run.agentSessionId ? sessionsRef.current.find((s) => s.claudeSessionId === run.agentSessionId) : undefined);
 const unloaded = (s: Session | undefined) => !s || (s.loaded === false && s.messages.length === 0);
 // A welcome turn's title is its hidden prompt, which never shows.
 const welcome = isHiddenWelcomeTitle(run.title);
 const prompt = welcome ? null : promptFromRunTitle(run.title);
 const asked: ChatMessage[] = prompt ? [{ role: "user", text: prompt, tools: [] }] : [];
 const reply: ChatMessage = { role: "assistant", text: "", tools: [], streaming: true, runId: run.runId, started: true };
 // A conversation this page has not loaded shows its earlier turns too.
 let before = welcome ? [] : asked;
 if (run.agentSessionId && unloaded(findTarget())) {
 const history = boxHistoryToChat(await readBoxSession(boxUrl, run.agentSessionId, token));
 if (requestGenerationRef.current !== generation) return;
 before = historyBeforeRunningTurn(history, prompt, welcome);
 }
 const target = findTarget();
 if (target && abortRef.current.has(target.id)) {
 // That chat is busy with a turn of its own: look again on the next wake-up.
 adoptedRunsRef.current.delete(run.runId);
 return;
 }
 let sessionId: string;
 if (target) {
 sessionId = target.id;
 updateSession(target.id, (s) => {
 if (unloaded(s)) return { ...s, messages: [...before, reply], loaded: true };
 // A chat that already shows the prompt keeps one copy.
 const last = s.messages[s.messages.length - 1];
 const shown = last?.role === "user" && Boolean(prompt) && last.text.startsWith((prompt || "").replace(/…$/, ""));
 return { ...s, messages: [...s.messages, ...(shown ? [] : asked), reply] };
 });
 } else {
 const created: Session = {
 id: newId(),
 title: welcome ? "Welcome" : (prompt || "Chat").slice(0, 42),
 claudeSessionId: run.agentSessionId,
 createdAt: Date.parse(run.createdAt) || Date.now(),
 messages: [...before, reply],
 ...(run.agentSessionId ? { loaded: true } : {}),
 };
 sessionId = created.id;
 // The box-history pull runs alongside this and may have listed the
 // conversation meanwhile; this chat, with its history loaded, replaces it.
 setSessions((prev) => [created, ...prev.filter((s) => s.id === activeIdRef.current || !isUnopenedStubOf(s, run.agentSessionId))]);
 }
 void resumeRun(sessionId, run.runId);
 }, [boxUrl, resumeRun, token, updateSession]);

 // When the chat opens or comes back into view, catch up with the box: replies
 // this page last saw unfinished (tab closed, laptop asleep, network lost) are
 // resumed, and turns still running that this page does not know about (started
 // on another device) are adopted.
 const resumingRef = useRef(false);
 const resumeDetachedRuns = useCallback(async () => {
 if (resumingRef.current) return;
 resumingRef.current = true;
 const generation = requestGenerationRef.current;
 try {
 const runs = await listBoxChatRuns(boxUrl, token);
 // An older runtime or an unreachable box: try again on the next wake-up.
 if (!runs || requestGenerationRef.current !== generation) return;
 runsSupportedRef.current = true;
 const known = new Set(runs.map((run) => run.runId));
 const tracked = new Set<string>([...runRef.current.values(), ...adoptedRunsRef.current]);
 for (const s of sessionsRef.current) {
 for (const m of s.messages) if (m.runId) tracked.add(m.runId);
 if (abortRef.current.has(s.id)) continue;
 const m = s.messages.find((msg) => msg.role === "assistant" && msg.runId && !msg.streaming && (msg.outcome === undefined || msg.outcome === "disconnected"));
 if (!m?.runId) continue;
 if (known.has(m.runId)) void resumeRun(s.id, m.runId);
 else updateRunMessage(s.id, m.runId, settleMissingRun);
 }
 for (const run of runs) {
 if (run.state === "running" && !tracked.has(run.runId)) void adoptRun(run);
 }
 } finally {
 resumingRef.current = false;
 }
 }, [adoptRun, boxUrl, resumeRun, token, updateRunMessage]);

 // A reply whose run log aged out ("unknown") is complete in the box's own
 // history of the conversation: show that history in place of this chat's copy.
 const showBoxHistory = useCallback((sessionId: string) => {
 const session = sessionsRef.current.find((s) => s.id === sessionId);
 if (!session?.claudeSessionId || abortRef.current.has(sessionId)) return;
 const generation = requestGenerationRef.current;
 void readBoxSession(boxUrl, session.claudeSessionId, token).then((msgs) => {
 if (requestGenerationRef.current !== generation) return;
 if (msgs.length === 0) {
 clientLog.warn("chat history could not be read from the computer", { source: "hivra-chat", failureType: "hivra_chat_history_read_failed", agentKind });
 return;
 }
 // A turn started meanwhile keeps its live reply; try again once it ends.
 if (abortRef.current.has(sessionId)) return;
 setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, messages: boxHistoryToChat(msgs), loaded: true } : s)));
 });
 }, [agentKind, boxUrl, token]);
 useEffect(() => {
 if (loadedKey !== skey) return;
 void resumeDetachedRuns();
 const onWake = () => {
 if (document.visibilityState !== "hidden") void resumeDetachedRuns();
 };
 window.addEventListener("focus", onWake);
 window.addEventListener("online", onWake);
 document.addEventListener("visibilitychange", onWake);
 return () => {
 window.removeEventListener("focus", onWake);
 window.removeEventListener("online", onWake);
 document.removeEventListener("visibilitychange", onWake);
 };
 }, [loadedKey, resumeDetachedRuns, skey]);
 const stop = useCallback(() => stopSession(activeIdRef.current), [stopSession]);

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
 const s = emptySession();
 // Never trim a conversation that is still working off the end of the list.
 setSessions((prev) => {
 const next = [s, ...prev];
 while (next.length > MAX_SESSIONS) {
 let idle = next.length - 1;
 while (idle > 0 && abortRef.current.has(next[idle].id)) idle -= 1;
 if (idle <= 0) break;
 next.splice(idle, 1);
 }
 return next;
 });
 setActiveId(s.id);
 setInput("");
 if (matchesMedia(NARROW_QUERY)) setShowRail(false);
 }, []);

 const deleteChat = useCallback(
 (id: string) => {
 stopSession(id);
 setLastFailed(id, null);
 setSessions((prev) => {
 const next = prev.filter((s) => s.id !== id);
 const final = next.length ? next : [emptySession()];
 if (id === activeIdRef.current) setActiveId(final[0].id);
 return final;
 });
 },
 [setLastFailed, stopSession],
 );

 // Deleting has no undo, so it takes two taps: the first arms a red
 // "Delete?" for 3s, the second deletes.
 const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
 const confirmDeleteTimerRef = useRef<number | null>(null);
 useEffect(() => () => {
 if (confirmDeleteTimerRef.current !== null) window.clearTimeout(confirmDeleteTimerRef.current);
 }, []);
 const requestDeleteChat = useCallback((id: string) => {
 if (confirmDeleteTimerRef.current !== null) {
 window.clearTimeout(confirmDeleteTimerRef.current);
 confirmDeleteTimerRef.current = null;
 }
 if (confirmDeleteId === id) {
 setConfirmDeleteId(null);
 deleteChat(id);
 return;
 }
 setConfirmDeleteId(id);
 confirmDeleteTimerRef.current = window.setTimeout(() => {
 confirmDeleteTimerRef.current = null;
 setConfirmDeleteId(null);
 }, 3000);
 }, [confirmDeleteId, deleteChat]);

 useEffect(() => {
 scrollDown();
 }, [active?.messages, scrollDown]);

 const messages = active?.messages || [];
 // The open chat's conversation on the box, when it has one to reload from.
 const historySessionId = active?.claudeSessionId ? active.id : null;
 // Welcome suggestions: the chosen goal's three concrete starters (falls back to
 // the general-purpose goal so there's always something to tap). Tapping one
 // sends it as the first message — the seeded agent answers in character.
 const goalDef = goal ? getGoal(goal) : null;
 const starters = (goalDef ?? getGoal(undefined)).starters;

 return (
 <div className="hivra-chat-root" style={{ display: "flex", height: "100%", minHeight: 0, background: "var(--bg-surface)", position: "relative" }}>
 {/* Sessions sidebar: an overlay drawer below md, an inline column from md up. */}
 {showRail ? (
 <>
 <button
 type="button"
 aria-hidden="true"
 tabIndex={-1}
 onClick={() => setShowRail(false)}
 className="absolute inset-0 z-10 bg-black/40 md:hidden"
 />
 <div
 ref={drawerRef}
 id={drawerId}
 role={drawerOpen ? "dialog" : undefined}
 aria-modal={drawerOpen ? true : undefined}
 aria-label={drawerOpen ? "Chats" : undefined}
 onKeyDown={drawerOpen ? trapDrawerFocus : undefined}
 className="absolute inset-y-0 left-0 z-20 flex w-[min(85vw,300px)] shrink-0 flex-col border-r border-[var(--etched-border)] bg-[var(--bg-surface)] md:static md:z-auto md:w-[232px]"
 >
 <div className="mx-3 mt-3 flex gap-2">
 <button
 type="button"
 onClick={newChat}
 className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 border border-[var(--etched-border)] text-[13px] font-semibold text-[var(--ink-black)] transition-colors hover:border-[var(--hivra-red-line)] hover:bg-[var(--bg-elevated)] md:min-h-[40px]"
 >
 <Plus size={15} /> New chat
 </button>
 <button
 type="button"
 aria-label="Close chats"
 onClick={() => setShowRail(false)}
 className="inline-flex h-[44px] w-[44px] shrink-0 items-center justify-center border border-[var(--etched-border)] text-[var(--text-muted)] transition-colors hover:text-[var(--ink-black)] md:hidden"
 >
 <X size={15} />
 </button>
 </div>
 <div className="flex-1 overflow-y-auto p-2">
 {sessions.map((s) => {
 const isActive = s.id === activeId;
 const armed = confirmDeleteId === s.id;
 const running = busyIds.has(s.id);
 return (
 <div
 key={s.id}
 className={[
 "group mb-0.5 flex items-center",
 isActive
 ? "bg-[var(--hivra-red-soft)]"
 : "hover:bg-[var(--bg-elevated)]",
 ].join(" ")}
 >
 <button
 type="button"
 aria-current={isActive ? "true" : undefined}
 onClick={() => selectSession(s)}
 className="flex min-h-[44px] min-w-0 flex-1 cursor-pointer items-center gap-2 px-2.5 py-2 text-left md:min-h-0"
 >
 {running ? (
 <Loader2 size={13} className="hivra-chat-spinner shrink-0 text-[var(--gold-leaf)]" aria-label="Working" />
 ) : (
 <MessageSquare size={13} className="shrink-0 text-[var(--text-muted)]" />
 )}
 <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--ink-black)]">
 {s.title || "New chat"}
 </span>
 </button>
 {sessions.length > 1 ? (
 armed ? (
 <button
 type="button"
 aria-label="Confirm delete chat"
 onClick={() => requestDeleteChat(s.id)}
 className="mono mr-1.5 inline-flex min-h-[24px] shrink-0 items-center justify-center bg-[var(--hivra-red)] px-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-white pointer-coarse:min-h-[40px]"
 >
 Delete?
 </button>
 ) : (
 <button
 type="button"
 aria-label={running ? "Stop and delete chat" : "Delete chat"}
 onClick={() => requestDeleteChat(s.id)}
 className="mr-2.5 inline-flex shrink-0 items-center justify-center p-0.5 text-[var(--text-muted)] opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:min-h-[40px] pointer-coarse:min-w-[40px] [@media(hover:none)]:opacity-100"
 >
 <Trash2 size={12} />
 </button>
 )
 ) : null}
 </div>
 );
 })}
 </div>
 </div>
 </>
 ) : null}

 {/* Chat column */}
 <div inert={drawerOpen} style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, position: "relative" }}>
 {instanceId ? <MemoryUsageBanner instanceId={instanceId} /> : null}
 {/* Below md an in-flow row under the banner; from md up the floating pair.
 Pixel sizes: the 14px root makes rem spacing 3.5px a step. */}
 <div className="flex h-[48px] shrink-0 items-center gap-1 border-b border-[var(--etched-border)] px-2 md:absolute md:left-2 md:top-2 md:z-[5] md:h-auto md:gap-1.5 md:border-0 md:px-0">
 <button
 ref={railToggleRef}
 type="button"
 aria-label={showRail ? "Hide chats" : "Show chats"}
 aria-expanded={showRail}
 aria-controls={showRail ? drawerId : undefined}
 title={showRail ? "Hide chats" : "Show chats"}
 onClick={() => setShowRail((v) => !v)}
 className="inline-flex h-[44px] w-[44px] items-center justify-center border border-[var(--etched-border)] bg-[var(--bg-surface)] text-[var(--text-muted)] transition-colors hover:text-[var(--ink-black)] md:h-auto md:w-auto md:p-1.5"
 >
 <PanelLeft size={13} />
 </button>
 {!showRail ? (
 <button
 type="button"
 aria-label="New chat"
 title="New chat — runs alongside the others"
 onClick={newChat}
 className="inline-flex h-[44px] items-center justify-center gap-1.5 border border-[var(--etched-border)] bg-[var(--bg-surface)] px-3 text-[var(--text-muted)] transition-colors hover:text-[var(--ink-black)] md:h-auto md:gap-0 md:p-1.5"
 >
 <Plus size={13} />
 <span className="mono text-[11px] uppercase tracking-[0.06em] md:hidden">New chat</span>
 </button>
 ) : null}
 {!showRail && busyIds.size > (busy ? 1 : 0) ? (
 <button
 type="button"
 onClick={() => setShowRail(true)}
 className="mono inline-flex h-[44px] items-center gap-1.5 border border-[var(--etched-border)] bg-[var(--bg-surface)] px-2 text-[11px] uppercase tracking-[0.06em] text-[var(--text-muted)] hover:text-[var(--ink-black)] md:h-auto md:py-1"
 >
 <Loader2 size={11} className="hivra-chat-spinner" aria-hidden /> {busyIds.size - (busy ? 1 : 0)} other{busyIds.size - (busy ? 1 : 0) === 1 ? "" : "s"} working
 </button>
 ) : null}
 </div>
 <div ref={scrollRef} role="region" aria-label="Conversation" data-empty={messages.length === 0 ? "true" : undefined} onScroll={onScrollPane} style={{ flex: 1, overflowY: "auto", padding: "28px 0" }}>
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
 <div key={i} className="hivra-chat-message" style={{ display: "flex", gap: 12, marginBottom: 22, flexDirection: isUser ? "row-reverse" : "row" }}>
 {/* The user bubble is already tinted, so its avatar is dropped below md. */}
 <div
 className={isUser ? "hidden md:flex" : "flex"}
 style={{
 width: 26,
 height: 26,
 flexShrink: 0,
 borderRadius: "50%",
 border: "1px solid var(--etched-border)",
 background: isUser ? "var(--bg-elevated)" : accent,
 color: isUser ? "var(--ink-black)" : "#fff",
 alignItems: "center",
 justifyContent: "center",
 fontSize: 11,
 fontWeight: 700,
 fontFamily: "var(--font-mono)",
 }}
 >
 {isUser ? "YOU" : (agentName.trim().charAt(0).toUpperCase() || "A")}
 </div>
 <div style={{ flex: isUser ? "0 1 auto" : 1, minWidth: 0, maxWidth: isUser ? "80%" : undefined }}>
 {m.role === "assistant" ? <AssistantActivity tools={m.tools} streaming={m.streaming} outcome={m.outcome} text={m.text} /> : null}
 <div className={`hivra-md ${styles.markdown}`} style={{ fontSize: 14.5, lineHeight: 1.6, color: "var(--ink-black)", wordBreak: "break-word", ...(isUser ? { background: "var(--hivra-red-soft)", border: "1px solid var(--hivra-red-line)", padding: "9px 13px" } : null) }}>
 {m.role === "assistant" ? (
 <ReactMarkdown remarkPlugins={[remarkGfm]} components={CHAT_MARKDOWN_COMPONENTS}>{m.text}</ReactMarkdown>
 ) : (
 <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
 )}
 </div>
 {m.role === "assistant" ? <ToolHistory message={m} /> : null}
 {m.role === "assistant" && !m.streaming && m.outcome === "unknown" ? (
 <div className="hivra-chat-turn-state" role="status" aria-label="Finished while you were away">
 {historySessionId ? "Finished while you were away — open the history to see the full reply" : "Finished while you were away"}
 </div>
 ) : null}
 {m.role === "assistant" && !m.streaming && m.outcome === "unknown" && historySessionId ? (
 <button
 type="button"
 onClick={() => showBoxHistory(historySessionId)}
 className={`mono ${styles.msgAction}`}
 style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5, border: "1px solid var(--etched-border)", background: "transparent", color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", padding: "3px 8px", cursor: "pointer", marginTop: 6, marginRight: 8 }}
 >
 <MessageSquare size={11} /> Open the history
 </button>
 ) : null}
 {m.role === "assistant" && !m.streaming && (m.outcome === "stopped" || m.outcome === "error" || m.outcome === "disconnected") ? (
 <div className="hivra-chat-turn-state" role="status" aria-label={m.outcome === "stopped" ? "Response stopped" : m.outcome === "disconnected" ? "Reconnecting to the agent" : "Response failed"}>
 {m.outcome === "stopped" ? "Stopped" : m.outcome === "disconnected" ? "Connection lost. Your agent keeps working; this reply fills in when it reconnects." : "Could not complete response"}
 </div>
 ) : null}
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

 <div ref={composerDockRef} className={`relative border-t border-[var(--etched-border)] bg-[var(--bg-surface)] ${styles.composerDock}`}>
 {showLatest && messages.length > 0 ? (
 <button type="button" onClick={() => scrollDown(true)} className="hivra-chat-latest">
 <ChevronDown size={14} aria-hidden /> Return to latest
 </button>
 ) : null}
 {lastFailed && !busy ? (
 <div className="mx-auto mb-2 w-full max-w-[760px]">
 <button
 type="button"
 onClick={() => {
 const t = lastFailed;
 setLastFailed(activeId, null);
 void send(t);
 }}
 className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 border border-[var(--etched-border)] bg-[var(--bg-elevated)] px-3 py-1.5 text-[12.5px] text-[var(--ink-black)] transition-colors hover:border-[var(--hivra-red-line)] md:min-h-[34px] md:min-w-0"
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
 ref={composerRef}
 aria-label={`Message ${agentName}`}
 value={input}
 onChange={(e) => setInput(e.target.value)}
 onKeyDown={(e) => {
 if (coarsePointer) return;
 if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
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
 enterKeyHint={coarsePointer ? "enter" : "send"}
 autoCapitalize="sentences"
 className="hivra-chat-composer block w-full resize-none bg-transparent px-3.5 pt-3 text-[16px] text-[var(--ink-black)] outline-none placeholder:text-[var(--text-muted)] md:text-[14px]"
 style={{ minHeight: 44, maxHeight: composerCap, fontFamily: "inherit" }}
 />
 <div className="flex flex-wrap items-center gap-1.5 px-2 pb-2">
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
 className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center px-2.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--ink-black)] disabled:opacity-40 md:min-h-[34px] md:min-w-0"
 >
 {uploading ? <Loader2 size={15} className="hivra-chat-spinner" /> : <Paperclip size={15} />}
 </button>
 </>
 ) : null}
 <span
 className="mono hidden min-w-0 max-w-full items-center gap-1.5 px-1 text-[11px] uppercase tracking-[0.06em] text-[var(--text-muted)] md:inline-flex"
 title="The model this agent is currently running"
 >
 <Cpu size={11} className="shrink-0" /> <span className="truncate">{shownModel}</span>
 </span>
 {/* Hidden below md until the box confirms it reads the reasoning flag. */}
 <button
 type="button"
 role="switch"
 aria-checked={think}
 aria-label="Toggle extended reasoning"
 title="Think — let the agent reason for longer before answering"
 onClick={toggleThink}
 className={[
 "mono hidden items-center gap-1.5 border px-2.5 py-1 text-[11px] uppercase tracking-[0.06em] transition-colors md:inline-flex",
 think
 ? "border-transparent bg-[var(--ink-black)] text-[var(--bg-surface)]"
 : "border-[var(--etched-border)] text-[var(--text-muted)] hover:text-[var(--ink-black)]",
 ].join(" ")}
 >
 <Brain size={11} /> Think{think ? " · On" : ""}
 </button>
 {busy ? (
 <button
 type="button"
 onClick={stop}
 aria-label="Stop response"
 title="Stop the agent"
 className="ml-auto inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 border border-[var(--ink-black)] px-3 text-[12.5px] font-semibold text-[var(--ink-black)] transition-colors hover:bg-[var(--bg-elevated)] md:min-h-[34px] md:min-w-0"
 >
 <Square size={13} fill="currentColor" /> Stop response
 </button>
 ) : (
 <button
 type="submit"
 disabled={!input.trim()}
 aria-label="Send message"
 className="ml-auto inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 bg-[var(--ink-black)] px-3 text-[12.5px] font-semibold text-[var(--bg-surface)] transition-opacity disabled:opacity-40 md:min-h-[34px] md:min-w-0"
 >
 <Send size={14} />
 <span className="hidden md:inline">Send message</span>
 </button>
 )}
 </div>
 </form>
 {attachError ? (
 <p role="alert" className="mono mx-auto mt-2 w-full max-w-[760px] text-[12px] text-[var(--hivra-red)]">
 {attachError}
 </p>
 ) : null}
 {attachments.length > 0 ? (
 <div className="mx-auto mt-2 flex w-full max-w-[760px] flex-wrap gap-1.5">
 {attachments.map((a) => (
 <span key={a.path} className="mono inline-flex min-w-0 max-w-full items-center gap-1.5 border border-[var(--etched-border)] bg-[var(--bg-elevated)] py-1 pl-2.5 pr-2.5 text-[11px] text-[var(--text-secondary)]">
 <Paperclip size={10} className="shrink-0" />
 <span className="min-w-0 truncate">{a.name}</span>
 <button type="button" aria-label={`Remove ${a.name}`} onClick={() => setAttachments((prev) => prev.filter((x) => x.path !== a.path))} className="-my-[11px] -mr-[8px] inline-flex h-[40px] w-[40px] shrink-0 items-center justify-center text-[var(--text-muted)] transition-colors hover:text-[var(--ink-black)]">
 <X size={11} />
 </button>
 </span>
 ))}
 </div>
 ) : null}
 <p className="mx-auto mt-2 hidden w-full max-w-[760px] text-center text-[11px] text-[var(--text-muted)] md:block">
 Runs the official agent CLI on this computer{coarsePointer ? "" : " · Enter to send, Shift+Enter for newline"}
 </p>
 </div>
 </div>
 </div>
 );
}

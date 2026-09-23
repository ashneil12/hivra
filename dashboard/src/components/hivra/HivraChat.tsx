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

import { listBoxSessions, readBoxSession, stampAgentFirstUsage, uploadBoxFile, type BoxMessage } from "@/lib/hivra/agent-api";
import { getGoal } from "@/lib/hivra/agent-identity";
import { requestAgentWelcomeMessage, isHiddenWelcomeTitle } from "@/lib/hivra/agent-welcome";
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
  outcome?: "complete" | "error" | "stopped";
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
    : outcome === "stopped" ? "Activity stopped"
    : outcome === "error" ? "Response failed"
    : unconfirmed ? "Completion unconfirmed" : failed ? "Actions include failures" : "Completed";
  const detail = running ? `${runningTools.length > 1 ? `${runningTools.length} actions running · ` : ""}${running.name}${running.detail ? ` · ${running.detail}` : ""}` : tools.length ? `${tools.length} action${tools.length === 1 ? "" : "s"}` : "";
  const dot = streaming ? "is-running" : outcome === "error" || failed ? "is-error" : unconfirmed || outcome === "stopped" ? "is-muted" : "is-done";
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
 if (matchesMedia(NARROW_QUERY)) setShowRail(false);
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
 appendWarning: (t) => updateAssistant((m) => ({ ...m, text: m.text + "\n\n⚠ " + t, outcome: "error" })),
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
 setAttachError(null);
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
 // User stops invalidate this request before aborting. Any current failure
 // here is an unexpected transport error.
 if ((e as Error).name === "AbortError") {
      updateAssistant((m) => ({ ...m, streaming: false, outcome: "error" }));
    } else {
      updateAssistant((m) => ({ ...m, text: "⚠ Couldn't reach your agent. It may be starting up — try again in a moment.", streaming: false, outcome: "error" }));
 setLastFailed(text);
 }
 setBusy(false);
 return;
 }
 if (!isCurrentRequest()) return;
 if (!resp.ok || !resp.body) {
 abortRef.current = null;
    updateAssistant((m) => ({ ...m, text: "⚠ Your agent hit an error (HTTP " + resp.status + "). Try again.", streaming: false, outcome: "error" }));
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
    abortRef.current = null;
    updateActive((s) => ({ ...s, messages: s.messages.map((m) => (m.streaming ? { ...m, streaming: false, outcome: "error" } : m)) }));
    setBusy(false);
    return;
  }
  if (!isCurrentRequest()) return;
  abortRef.current = null;
  updateAssistant((m) => ({ ...m, streaming: false, outcome: m.outcome || "complete" }));
  updateActive((s) => ({ ...s, messages: s.messages.map((m) => (m.streaming ? { ...m, streaming: false, outcome: m.outcome || "complete" } : m)) }));
 setBusy(false);
 scrollDown();
 },
 [agentKind, boxUrl, busy, handleEvent, scrollDown, sessions, updateActive, updateAssistant, token, skey],
 );

 // Stop the in-flight turn. Aborting the fetch disconnects from the box, which
 // kills the underlying CLI process — a real interrupt, not just a UI reset.
  const stop = useCallback(() => {
    const controller = abortRef.current;
    if (!controller) return;
    requestGenerationRef.current += 1;
    abortRef.current = null;
    controller.abort();
    updateActive((s) => ({
      ...s,
      messages: s.messages.map((m) => (m.streaming ? { ...m, streaming: false, outcome: "stopped" } : m)),
    }));
    setBusy(false);
  }, [updateActive]);

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
 if (matchesMedia(NARROW_QUERY)) setShowRail(false);
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
 disabled={busy}
 className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 border border-[var(--etched-border)] text-[13px] font-semibold text-[var(--ink-black)] transition-colors hover:border-[var(--hivra-red-line)] hover:bg-[var(--bg-elevated)] disabled:opacity-50 md:min-h-[40px]"
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
 aria-disabled={busy || undefined}
 onClick={() => {
 if (!busy) selectSession(s);
 }}
 className={[
 "flex min-h-[44px] min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left md:min-h-0",
 busy ? "cursor-default" : "cursor-pointer",
 ].join(" ")}
 >
 <MessageSquare size={13} className="shrink-0 text-[var(--text-muted)]" />
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
 aria-label="Delete chat"
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
 title="New chat"
 onClick={newChat}
 disabled={busy}
 className="inline-flex h-[44px] items-center justify-center gap-1.5 border border-[var(--etched-border)] bg-[var(--bg-surface)] px-3 text-[var(--text-muted)] transition-colors hover:text-[var(--ink-black)] disabled:opacity-40 md:h-auto md:gap-0 md:p-1.5"
 >
 <Plus size={13} />
 <span className="mono text-[11px] uppercase tracking-[0.06em] md:hidden">New chat</span>
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
 {m.role === "assistant" && !m.streaming && (m.outcome === "stopped" || m.outcome === "error") ? (
 <div className="hivra-chat-turn-state" role="status" aria-label={m.outcome === "stopped" ? "Response stopped" : "Response failed"}>
 {m.outcome === "stopped" ? "Stopped" : "Could not complete response"}
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
 setLastFailed(null);
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

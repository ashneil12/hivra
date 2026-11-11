"use client";

// Hivra agent chat: a streaming chat with a list of conversations. Talks to a
// deployed runtime (a box running the official `claude` CLI) over its NDJSON
// stream-json, directly browser->box. Sessions persist per box in
// localStorage; each session resumes its own Claude session_id.
//
// This file is the chat's state and wiring: sessions, streaming, runs, storage,
// retry and the welcome. How the chat looks lives in ./chat (the turn, the
// work trail, the composer, the chat list), after MonoCode's transcript.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { matchesMedia, useMediaQuery } from "@/lib/client/media-query";
import posthog from "posthog-js";
import { PanelLeft, Plus, RotateCcw } from "lucide-react";

import { boxChatRunEventsUrl, listBoxChatRuns, listBoxSessions, readBoxSession, stampAgentFirstUsage, stopBoxChatRun, uploadBoxFile, type BoxChatRun, type BoxMessage } from "@/lib/hivra/agent-api";
import { getGoal } from "@/lib/hivra/agent-identity";
import { startAgentWelcomeRun, isHiddenWelcomeTitle } from "@/lib/hivra/agent-welcome";
import { getAdapter, type AgentKind, type ChatSink, type TurnOutcome } from "@/lib/hivra/agent-adapters";
import { clientLog } from "@/lib/client/logger";
import { captureClient } from "@/lib/telemetry/posthog-client";
import { MemoryUsageBanner } from "@/components/memory/MemoryUsageBanner";
import { useAgentChatListSlot } from "@/components/hivra/agent-shell/AgentChatListSlot";
import { AgentTurn } from "./chat/AgentTurn";
import { ChatComposer, MAX_ATTACHMENTS, type ComposerAttachment } from "./chat/ChatComposer";
import { ChatEmpty } from "./chat/ChatEmpty";
import { ChatList } from "./chat/ChatList";
import { JumpToLatest } from "./chat/JumpToLatest";
import type { QueuedMessage } from "./chat/MessageQueue";
import { PromptOutline } from "./chat/PromptOutline";
import { TranscriptFind } from "./chat/TranscriptFind";
import { contextUsageOf, mergeContextUsage } from "./chat/contextUsage";
import { useBottomChatMotion, type MotionBlock } from "./chat/useBottomChatMotion";
import { useBoxChatControls } from "./chat/useBoxChatControls";
import { useFileDrop } from "./chat/useFileDrop";
import type { ChatMessage, Session, ToolChip } from "./chat/types";
import chatStyles from "./chat/chat.module.css";
import styles from "./HivraChat.module.css";

export { CHAT_MARKDOWN_COMPONENTS } from "./chat/AgentMarkdown";


// Session saves: wait this long after the last change while a reply streams,
// but never longer than the max wait, so a long stream still saves as it goes.
const CHAT_SAVE_IDLE_MS = 1000;
const CHAT_SAVE_MAX_WAIT_MS = 2500;

const COARSE_POINTER_QUERY = "(hover: none) and (pointer: coarse)";
const NARROW_QUERY = "(max-width: 767px)";

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

export interface HivraChatProps {
 boxUrl: string;
 agentName?: string;
 /** Kept for callers; the chat is monochrome now and no longer tints itself. */
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
 /** The computer this chat talks to, for the effort update the model picker offers (the same
 * in-place connection-service update as Manage's). Without it the picker points to Manage. */
 computerId?: string;
 /** The effort update restarted the computer's connection service. */
 onConnectionServiceRestarted?: () => void;
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
// going: its history (from the box, or this device's copy) up to and including
// that turn's prompt. The box may already hold the turn's output so far, which
// the reply replays in full. A welcome is its conversation's first turn, and
// its prompt is hidden.
function historyBeforeRunningTurn(history: ChatMessage[], prompt: string | null, welcome: boolean): ChatMessage[] {
 if (welcome) return [];
 const asked: ChatMessage[] = prompt ? [{ role: "user", text: prompt, tools: [] }] : [];
 const lastUser = history.map((m) => m.role).lastIndexOf("user");
 const head = (prompt || "").replace(/…$/, "");
 if (lastUser >= 0 && head && history[lastUser].text.startsWith(head)) return history.slice(0, lastUser + 1);
 // The box has not recorded this turn's prompt yet.
 return [...history, ...asked];
}

// Any sign the computer took up the reply's run: its `_run` line, text, a tool
// or a warning.
function replyStarted(m: ChatMessage): boolean {
 return Boolean(m.started || m.text.trim() || m.tools.length || m.warnings?.length);
}


// How a run ended when its agent reported nothing of its own (a generic CLI,
// or one that died before its final event): exit 0 is success; any other code,
// or none (killed by a signal, or never started), is a failure.
//
// With no `_done` there is no exit to go on. That stream comes from a computer
// on the chat gateway from before detached runs, which writes `_done` whenever
// the agent's process closes; it ends a stream without one when the agent
// could not start at all (its "spawn error: …" stderr is the only line), or
// when the connection closed under the turn. A reply the agent wrote is kept
// as finished; one with nothing but warnings, or nothing at all, failed.
function exitOutcome(m: ChatMessage, done: Record<string, unknown> | null): TurnOutcome {
 if (done) return !("code" in done) || done.code === 0 ? "complete" : "error";
 return m.text.trim() || m.tools.length ? "complete" : "error";
}

// A pending reply whose run log the computer no longer keeps. Finished runs are
// kept for a week, so a run that started and then aged out finished while no
// page watched it: keep what arrived and say so, not that it failed. A reply
// with no sign its run ever started may never have reached the computer, and
// keeps the failure state.
function settleMissingRun(m: ChatMessage): ChatMessage {
 return { ...m, streaming: false, outcome: replyStarted(m) ? "unknown" : "error" };
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
const NO_MESSAGES: ChatMessage[] = [];
// Autoscroll: within this many px of the bottom counts as at the bottom; this far
// above it, with no scroll-up observed, counts as not following.
const AT_BOTTOM_PX = 2;
const FAR_FROM_BOTTOM_PX = 80;

// Per-session draft key — the half-typed message survives reloads + session switches.
function draftKey(sk: string, sessionId: string): string {
 return "hivra_draft_" + sk.replace(/[^a-z0-9]/gi, "").slice(-32) + "_" + sessionId;
}

function keyFor(boxUrl: string): string {
 return "hivra_sessions_" + boxUrl.replace(/[^a-z0-9]/gi, "").slice(-32);
}

// Set once a computer's first-contact welcome has started (here, on another
// device or in another view), so no view of that computer starts another. It
// is keyed like keyFor: the agent page and the workspace name the same
// computer differently but share its chats, and must share this too.
function welcomeFlagKey(sk: string): string {
 return "hivra:first-welcome:" + sk.replace(/[^a-z0-9]/gi, "").slice(-32);
}
function readWelcomed(sk: string): boolean {
 try {
 // Each view kept its own flag, under its raw key, before the two shared one.
 return window.localStorage.getItem(welcomeFlagKey(sk)) === "1" || window.localStorage.getItem("hivra:first-welcome:" + sk) === "1";
 } catch {
 // Storage is only a duplicate guard; the chat still works without it.
 return false;
 }
}
function writeWelcomed(sk: string, welcomed: boolean) {
 try {
 if (welcomed) {
 window.localStorage.setItem(welcomeFlagKey(sk), "1");
 } else {
 window.localStorage.removeItem(welcomeFlagKey(sk));
 window.localStorage.removeItem("hivra:first-welcome:" + sk);
 }
 } catch {
 // Best-effort duplicate guard only.
 }
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
// While the computer swaps its agent CLI for the vetted version it answers a new
// run with 503 agent_updating for a few seconds. Keep the message and send it
// again, for about two minutes before giving up.
const AGENT_UPDATING_RETRY_MS = [3000, 5000, 5000, 10000, 10000, 15000, 15000, 20000, 20000, 20000];
function waitUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = window.setTimeout(done, ms);
    function done() { window.clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
    signal.addEventListener("abort", done);
  });
}

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

// What a reply says when its turn could not start (null: say nothing more).
function turnFailureNote(end: TurnEnd): string | null {
 if (end.kind === "unreachable") return "⚠ Couldn't reach your agent. It may be starting up — try again in a moment.";
 if (end.kind === "refused") return end.reason ? "⚠ " + end.reason : "⚠ Your agent hit an error (HTTP " + end.status + "). Try again.";
 return null;
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

export function HivraChat({ boxUrl, agentName = "Claude Code", agentKind = "claude", storageKey, token, goal, context, firstTask, emoji, instanceId, modelLabel, computerId, onConnectionServiceRestarted }: HivraChatProps) {
 const skey = storageKey || boxUrl;
 // What the composer's pickers change on the computer: its model, its effort
 // levels and its access. The effort picked is sent with each turn.
 const controls = useBoxChatControls({ boxUrl, token, agentKind, storageKey: skey, modelLocked: Boolean((modelLabel || "").trim()), lockedModelName: (modelLabel || "").trim(), computerId, onConnectionServiceRestarted });
 const effortRef = useRef<string | null>(null);
 useEffect(() => { effortRef.current = controls.effort; }, [controls.effort]);
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
 // What was sent while a conversation's agent was still working. Each goes out,
 // in order, once the reply ends; Stop pauses the conversation's queue.
 const [queues, setQueues] = useState<Record<string, QueuedMessage[]>>({});
 const [pausedQueues, setPausedQueues] = useState<ReadonlySet<string>>(() => new Set());
 const queuesRef = useRef(queues);
 useEffect(() => { queuesRef.current = queues; }, [queues]);
 const setQueuePaused = useCallback((sessionId: string, paused: boolean) => {
 setPausedQueues((prev) => {
 if (prev.has(sessionId) === paused) return prev;
 const next = new Set(prev);
 if (paused) next.add(sessionId); else next.delete(sessionId);
 return next;
 });
 }, []);
 const [boxHistoryChecked, setBoxHistoryChecked] = useState(false);
 const [hasBoxHistory, setHasBoxHistory] = useState(false);
 const hasBoxHistoryRef = useRef(false);
 useEffect(() => { hasBoxHistoryRef.current = hasBoxHistory; }, [hasBoxHistory]);
 // What the computer's run list says about the first-contact welcome: nothing
 // yet ("pending"), no welcome run ("none"), or one started elsewhere ("seen").
 const [welcomeOnBox, setWelcomeOnBox] = useState<"pending" | "none" | "seen">("pending");
 const activeIdRef = useRef<string>("");
 const scrollRef = useRef<HTMLDivElement>(null);
 // The transcript scroller as an element too, which the bottom motion follows.
 const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
 const scrollerRef = useCallback((el: HTMLDivElement | null) => {
 scrollRef.current = el;
 setScroller(el);
 }, []);
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
 // The same ratings, read by rateMessage outside the state updater (rateMessage is the only writer).
 const feedbackRef = useRef<Record<string, "up" | "down">>({});
 // Pending attachments (already uploaded to the box; sent with the next message).
 const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
 const attachmentsRef = useRef<ComposerAttachment[]>([]);
 // Written with the state, so an upload that finishes before the next render still counts.
 const changeAttachments = useCallback((fn: (prev: ComposerAttachment[]) => ComposerAttachment[]) => {
 const next = fn(attachmentsRef.current);
 attachmentsRef.current = next;
 setAttachments(next);
 }, []);
 // An image attached shows as a small picture from an object URL; it is let go once the file leaves the composer.
 const releasePreviews = useCallback((list: readonly ComposerAttachment[]) => {
 for (const a of list) if (a.preview) { try { URL.revokeObjectURL(a.preview); } catch { /* nothing to release */ } }
 }, []);
 useEffect(() => () => releasePreviews(attachmentsRef.current), [releasePreviews]);
 const [uploading, setUploading] = useState(false);
 const uploadCountRef = useRef(0);
 const uploadChainRef = useRef<Promise<void>>(Promise.resolve());
 const [attachError, setAttachError] = useState<string | null>(null);
 const composerRef = useRef<HTMLTextAreaElement>(null);
 const composerDockRef = useRef<HTMLDivElement>(null);
 // Touch keyboards have no Shift+Enter, so there Return inserts a newline and
 // only the Send button sends.
 const coarsePointer = useMediaQuery(COARSE_POINTER_QUERY);
 const narrow = useMediaQuery(NARROW_QUERY);
 const composerCap = narrow ? 120 : 160;
 // Where the chat list lives. The agent view's sidebar provides an element for
 // it (the list is portalled there); anywhere else the chat keeps its own
 // inline list, which is an overlay drawer below md and closed by default.
 const listSlot = useAgentChatListSlot();
 const slotElement = listSlot?.element ?? null;
 const onChatOpened = listSlot?.onChatOpened;
 const [railRequested, setShowRail] = useState(false);
 const showRail = railRequested && !slotElement;
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
 setWelcomeOnBox("pending");
 setBusyIds(new Set());
 setFailedBySession({});
 setQueues({});
 setPausedQueues(new Set());

 return abortAll;
 }, [boxUrl, skey]);

 const uploadOne = useCallback(async (file: File) => {
 if (!token) return;
 if (attachmentsRef.current.length >= MAX_ATTACHMENTS) {
 setAttachError(`You can attach up to ${MAX_ATTACHMENTS} files to a message`);
 return;
 }
 setAttachError(null);
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
 let preview: string | undefined;
 if (blob.type.startsWith("image/") && typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
 try { preview = URL.createObjectURL(blob); } catch { preview = undefined; }
 }
 changeAttachments((prev) => [...prev, { name, path: r.path!, ...(preview ? { preview } : {}) }]);
 } else {
 clientLog.warn("chat attachment upload rejected", { source: "hivra-chat", failureType: "hivra_chat_attachment_upload_failed", agentKind, reason: r.error });
 setAttachError("Upload failed — try again");
 }
 } catch (err) {
 clientLog.warn("chat attachment upload failed", { source: "hivra-chat", failureType: "hivra_chat_attachment_upload_failed", agentKind }, err);
 setAttachError("Upload failed — try again");
 }
 }, [agentKind, boxUrl, changeAttachments, token]);
 // Files come one after another (a multi-file pick or a drop), each in turn.
 const uploadAttachment = useCallback((file: File) => {
 if (!token) return;
 uploadCountRef.current += 1;
 setUploading(true);
 uploadChainRef.current = uploadChainRef.current
 .then(() => uploadOne(file))
 .catch(() => undefined)
 .then(() => {
 uploadCountRef.current -= 1;
 if (uploadCountRef.current === 0) setUploading(false);
 });
 }, [token, uploadOne]);
 const removeAttachment = useCallback((path: string) => {
 releasePreviews(attachmentsRef.current.filter((x) => x.path === path));
 changeAttachments((prev) => prev.filter((x) => x.path !== path));
 }, [changeAttachments, releasePreviews]);
 // Files dropped anywhere on the chat attach to the composer.
 const columnRef = useRef<HTMLDivElement>(null);
 const rootRef = useRef<HTMLDivElement>(null);
 const fileDrag = useFileDrop({ root: columnRef, enabled: Boolean(token), onFiles: (files) => files.forEach(uploadAttachment) });

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

 const pendingSinceRef = useRef<number | null>(null);
 // Persist on a short debounce (avoid thrashing localStorage on every token).
 // With parallel chats some session is often streaming, so the debounce has a
 // max wait: while a reply streams, a save happens at least every
 // CHAT_SAVE_MAX_WAIT_MS even though the sessions keep changing; loadSessions
 // clears stale streaming. Nothing is saved until this box's sessions are in
 // state: saving the placeholder chat (or the previous box's chats) would
 // overwrite its history.
 useEffect(() => {
 if (loadedKey !== skey) return;
 const now = Date.now();
 if (pendingSinceRef.current === null) pendingSinceRef.current = now;
 const waited = now - pendingSinceRef.current;
 const delay = anyBusy ? Math.max(0, Math.min(CHAT_SAVE_IDLE_MS, CHAT_SAVE_MAX_WAIT_MS - waited)) : 0;
 const timer = window.setTimeout(() => {
 pendingSinceRef.current = null;
 saveSessions(skey, sessions);
 }, delay);
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
 onChatOpened?.();
 if (s.claudeSessionId && !s.loaded && s.messages.length === 0) {
 void readBoxSession(boxUrl, s.claudeSessionId, token).then((msgs) => {
 setSessions((prev) => prev.map((x) => (x.id === s.id && !x.loaded ? { ...x, messages: boxHistoryToChat(msgs), loaded: true } : x)));
 });
 }
 },
 [boxUrl, onChatOpened, token],
 );

 // Smart autoscroll: follow the stream only while the user is at the bottom.
 // Any scroll-up unsticks at once, whatever caused it (wheel, touch, keys, a
 // scrollbar drag, browser Find, a screen-reader cursor). We only ever scroll
 // down ourselves, so a scrollTop decrease is never ours. Only returning to the
 // bottom re-engages following. `force` is for user-initiated sends and
 // "Return to latest".
 const stickToBottomRef = useRef(true);
 const scrollFrameRef = useRef<number | null>(null);
 const lastScrollTopRef = useRef(0);
 const [showLatest, setShowLatest] = useState(false);
 const onScrollPane = useCallback(() => {
 const el = scrollRef.current;
 if (!el) return;
 const top = el.scrollTop;
 const previous = lastScrollTopRef.current;
 lastScrollTopRef.current = top;
 const distance = el.scrollHeight - el.clientHeight - top;
 if (distance <= AT_BOTTOM_PX) {
 // Also covers the browser clamping scrollTop when content shrinks.
 stickToBottomRef.current = true;
 } else if (top < previous - 1 || distance >= FAR_FROM_BOTTOM_PX) {
 stickToBottomRef.current = false;
 } else if (top > previous) {
 stickToBottomRef.current = true;
 }
 setShowLatest(!stickToBottomRef.current);
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
 if (el && el.dataset.empty !== "true") {
 el.scrollTop = el.scrollHeight;
 lastScrollTopRef.current = el.scrollTop;
 }
 });
 }, []);
 useEffect(() => {
 scrollDown(true);
 const pane = scrollRef.current;
 if (pane?.dataset.empty === "true") {
 pane.scrollTop = 0;
 lastScrollTopRef.current = 0;
 }
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
 const runSink = useCallback(
 (sessionId: string, runId: string | undefined): ChatSink => ({
 // A box-history stub listed for this conversation before this chat knew
 // its id (a reply adopted from another device) is the same chat: drop it.
 setSessionId: (id) => setSessions((prev) => prev
 .filter((s) => s.id === sessionId || s.id === activeIdRef.current || !isUnopenedStubOf(s, id))
 .map((s) => (s.id === sessionId ? { ...s, claudeSessionId: id } : s))),
 appendText: (t) => updateRunMessage(sessionId, runId, (m) => ({ ...m, text: m.text + t })),
 setText: (t) => updateRunMessage(sessionId, runId, (m) => ({ ...m, text: t })),
 upsertTool: (id, patch) => upsertTool(sessionId, runId, id, patch),
 appendWarning: (t) => updateRunMessage(sessionId, runId, (m) => ({ ...m, warnings: [...(m.warnings || []), t] })),
 reportOutcome: (outcome) => updateRunMessage(sessionId, runId, (m) => ({ ...m, reported: outcome })),
 reportUsage: (usage) => updateRunMessage(sessionId, runId, (m) => ({ ...m, usage: mergeContextUsage(m.usage, usage) })),
 }),
 [updateRunMessage, upsertTool],
 );
 const handleEvent = useCallback(
 (sessionId: string, ev: Record<string, unknown>, runId?: string) => {
 let turnState = turnStateRef.current.get(sessionId);
 const adapter = getAdapter(agentKind);
 if (!turnState) { turnState = adapter.createTurnState(); turnStateRef.current.set(sessionId, turnState); }
 adapter.parseEvent(ev, runSink(sessionId, runId), turnState);
 },
 [agentKind, runSink],
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
 updateRunMessage(sessionId, runId, (m) => ({ ...m, text: "", tools: [], warnings: undefined, reported: undefined, usage: undefined, outcome: undefined, streaming: true, started: true }));
 const result = await readRunStream(resp.body, sessionId, runId, isCurrent);
 if (result.kind === "done" || result.kind === "superseded") return result;
 }
 return { kind: "unreachable" };
 },
 [agentKind, boxUrl, readRunStream, token, updateRunMessage],
 );

 // Close a reply from the box's `_done` line (null: a stream from the older
 // gateway that ended without one; see exitOutcome). The agent's parser first
 // emits what it held back for more of the stream. How the run ended decides
 // the outcome, never a warning raised on the way.
 const finalizeRun = useCallback(
 (sessionId: string, runId: string | undefined, done: Record<string, unknown> | null) => {
 const turnState = turnStateRef.current.get(sessionId);
 if (turnState) getAdapter(agentKind).endTurn(runSink(sessionId, runId), turnState);
 updateRunMessage(sessionId, runId, (m) => {
 if (done?.interrupted) {
 return { ...m, streaming: false, outcome: "error", warnings: [...(m.warnings || []), "The run was interrupted before it finished because the agent's computer restarted."] };
 }
 if (done?.stopped) return { ...m, streaming: false, outcome: "stopped" };
 return { ...m, streaming: false, outcome: m.reported ?? exitOutcome(m, done) };
 });
 },
 [agentKind, runSink, updateRunMessage],
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
 let updatingDetail: { error?: unknown } | null = null;
 for (let attempt = 0; ; attempt += 1) {
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
 if (resp.status !== 503) break;
 // The computer is moving its agent CLI to a new version: the message waits
 // (the same runId, so a retry can never start it twice) and goes out again.
 const detail = (await resp.json().catch(() => null)) as { error?: unknown; code?: unknown } | null;
 if (!turn.isCurrent()) return { kind: "superseded" };
 if (detail?.code !== "agent_updating" || attempt >= AGENT_UPDATING_RETRY_MS.length) { updatingDetail = detail; break; }
 const cli = agentKind === "codex" ? "Codex" : "Claude Code";
 updateRunMessage(sessionId, runId, (m) => ({ ...m, pending: `Your computer is updating ${cli} to a new version. Your message will send in a moment.` }));
 await waitUnlessAborted(AGENT_UPDATING_RETRY_MS[attempt], turn.controller.signal);
 if (!turn.isCurrent()) return { kind: "superseded" };
 if (turn.controller.signal.aborted) return { kind: "aborted" };
 }
 updateRunMessage(sessionId, runId, (m) => (m.pending ? { ...m, pending: undefined } : m));
 if (!resp.ok || !resp.body) {
 // 409 (this conversation is still working), 429 (too many runs) and a 503
 // whose update outlasted the wait carry a reason worth showing as-is.
 const detail = updatingDetail ?? (resp.status === 409 || resp.status === 429 ? (await resp.json().catch(() => null)) as { error?: unknown } | null : null);
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
 [agentKind, finalizeRun, followRun, readRunStream, updateRunMessage],
 );

 // `from` names a queued message going out: it goes to its own conversation with
 // its own files, and leaves what is being typed now alone.
 const send = useCallback(
 async (raw: string, from?: { sessionId: string; images: string[] }) => {
 const sessionId = from?.sessionId ?? activeIdRef.current;
 if (!sessionId || abortRef.current.has(sessionId)) return;
 const text = raw.trim();
 if (!text) return;
 const session = sessionsRef.current.find((s) => s.id === sessionId);
 const resumeId = session?.claudeSessionId || null;
 const images = from ? from.images : attachmentsRef.current.map((a) => a.path);
 if (!from) {
 setInput("");
 releasePreviews(attachmentsRef.current);
 changeAttachments(() => []);
 setAttachError(null);
 try { window.localStorage.removeItem(draftKey(skey, sessionId)); } catch { /* ignore */ }
 }
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
 // `effort` is the level picked in the composer (only one the computer
 // offers); without one the agent keeps its own default. `detach` asks the box to keep the run going when this page goes away
 // (closed tab, sleeping laptop, dropped network). Only Stop ends it.
 body: JSON.stringify({ message: text, sessionId: resumeId, detach: true, runId, clientRef: sessionId, ...(images.length ? { images } : {}), ...(effortRef.current ? { effort: effortRef.current } : {}) }),
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
 const note = turnFailureNote(end) ?? "";
 updateRunMessage(sessionId, runId, (m) => ({ ...m, text: note, streaming: false, outcome: "error" }));
 setLastFailed(sessionId, text);
 }
 // A turn that could not start holds back what was queued behind it.
 if (end.kind !== "settled" && (queuesRef.current[sessionId]?.length ?? 0) > 0) setQueuePaused(sessionId, true);
 turn.finish();
 if (end.kind === "settled") followIfOpen();
 },
 [agentKind, beginTurn, boxUrl, changeAttachments, driveTurn, releasePreviews, scrollDown, setLastFailed, setQueuePaused, updateSession, updateRunMessage, token, skey],
 );

 // Take back a welcome reply that never got going: the chat falls back to the
 // starter suggestions, and the welcome may start again.
 const retractWelcome = useCallback((sessionId: string, runId: string) => {
 writeWelcomed(skey, false);
 updateSession(sessionId, (s) => {
 const messages = s.messages.filter((m) => m.runId !== runId);
 return { ...s, messages, title: messages.length === 0 && s.title === "Welcome" ? "New chat" : s.title };
 });
 }, [skey, updateSession]);

 // The agent opens a new computer's first chat on its own: a hidden prompt
 // asks it to introduce itself or, when the owner gave a first task at launch,
 // to DO that task and return the result ("do, don't show"). It is a detached
 // run like any send: a reload, a closed tab or a dropped network re-attaches
 // to it (resumeDetachedRuns), Stop ends it, and the conversation it starts is
 // the owner's to continue. Only the reply shows; the prompt never does, so a
 // welcome that fails keeps its reply with Retry, which carries on the failed
 // attempt's conversation (`resumeSessionId`) as Retry does for a message.
 const startWelcome = useCallback((sessionId: string, retry: boolean) => {
 if (abortRef.current.has(sessionId)) return;
 const resumeSessionId = retry ? sessionsRef.current.find((s) => s.id === sessionId)?.claudeSessionId ?? null : null;
 // Marked before the turn starts, not when it ends: the run outlives this
 // page, so a reload must re-attach to it instead of starting another.
 writeWelcomed(skey, true);
 const runId = newRunId();
 const turn = beginTurn(sessionId, runId);
 updateSession(sessionId, (s) => ({
 ...s,
 title: s.title === "New chat" ? "Welcome" : s.title,
 messages: [...s.messages.filter((m) => !m.welcome), { role: "assistant", text: "", tools: [], streaming: true, runId, welcome: true }],
 }));
 const post = (signal: AbortSignal) => startAgentWelcomeRun({
 boxUrl,
 token,
 agentName,
 goal,
 context,
 firstTask,
 channel: "chat",
 runId,
 clientRef: sessionId,
 resumeSessionId,
 signal,
 });
 void driveTurn(sessionId, runId, turn, post).then((end) => {
 if (end.kind === "superseded") return;
 if (end.kind !== "settled") {
 clientLog.warn("agent first message generation failed", {
 source: "hivra-chat",
 failureType: "hivra_chat_welcome_generation_failed",
 agentKind,
 agentName,
 reason: end.kind,
 retry,
 ...(end.kind === "refused" ? { status: end.status } : {}),
 });
 if (retry) {
 // The owner asked for this one: say why it failed, and keep Retry.
 const note = turnFailureNote(end);
 updateRunMessage(sessionId, runId, (m) => ({ ...m, text: note ?? m.text, streaming: false, outcome: "error" }));
 } else {
 // The turn never got going: fall back to the starter suggestions, and
 // let the next visit try the welcome again.
 retractWelcome(sessionId, runId);
 }
 } else {
 // A welcome that ends without a word failed as surely as one that
 // errored, and its reply is the only place left to try it again.
 updateRunMessage(sessionId, runId, (m) => (m.outcome === "complete" && !m.text.trim() && m.tools.length === 0
 ? { ...m, text: "⚠ Your agent finished without replying.", outcome: "error" }
 : m));
 }
 turn.finish();
 if (activeIdRef.current === sessionId) scrollDown();
 });
 }, [agentKind, agentName, beginTurn, boxUrl, context, driveTurn, firstTask, goal, retractWelcome, scrollDown, skey, token, updateRunMessage, updateSession]);

 // The welcome starts once per computer, only once the chat knows it is new:
 // no conversation on the computer or in this browser, and no welcome in the
 // computer's run list (started on another device or in another view).
 const anyChatStarted = useMemo(() => sessions.some((s) => s.messages.length > 0 || Boolean(s.claudeSessionId)), [sessions]);
 useEffect(() => {
 if (loadedKey !== skey || !boxHistoryChecked || hasBoxHistory || welcomeOnBox !== "none") return;
 if (anyBusy || autoWelcomeAttemptedRef.current || anyChatStarted || !active) return;
 if (readWelcomed(skey)) return;
 autoWelcomeAttemptedRef.current = true;
 // Fire the activation event once per box (the flag above makes this run at
 // most once). Analytics must never break the chat.
 try {
 captureClient("agent_initiated_message_sent", {
 agent_id: skey,
 agent_kind: agentKind,
 lane: "hivra",
 has_first_task: Boolean((firstTask || "").trim()),
 $insert_id: `auto_first_task_${skey}`,
 });
 } catch {
 // Best-effort analytics only.
 }
 startWelcome(active.id, false);
 }, [active, agentKind, anyBusy, anyChatStarted, boxHistoryChecked, firstTask, hasBoxHistory, loadedKey, skey, startWelcome, welcomeOnBox]);

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
 // Stopping a reply must not start the next queued message on its own.
 if ((queuesRef.current[sessionId]?.length ?? 0) > 0) setQueuePaused(sessionId, true);
 setSessionBusy(sessionId, false);
 }, [agentKind, boxUrl, setQueuePaused, setSessionBusy, token, updateSession]);

 // A reply whose run the computer has no log of. A welcome with no sign it
 // ever started never reached the computer (a reload while the computer was
 // still starting). While nothing else has happened on the computer, take it
 // back and let the welcome start again, as if it never began. Otherwise it
 // cannot start on its own any more, so it settles as a failed welcome, which
 // keeps Retry; so does any other reply, as settleMissingRun says.
 const settleMissingReply = useCallback((sessionId: string, runId: string) => {
 const reply = sessionsRef.current.find((s) => s.id === sessionId)?.messages.find((m) => m.runId === runId);
 const untouched = !hasBoxHistoryRef.current && !sessionsRef.current.some((s) => Boolean(s.claudeSessionId) || s.messages.some((m) => m.runId !== runId));
 if (reply?.welcome && !replyStarted(reply)) {
 clientLog.warn("agent first message never reached the computer", { source: "hivra-chat", failureType: "hivra_chat_welcome_lost", agentKind, restarting: untouched });
 if (untouched) {
 retractWelcome(sessionId, runId);
 autoWelcomeAttemptedRef.current = false;
 return;
 }
 }
 updateRunMessage(sessionId, runId, settleMissingRun);
 }, [agentKind, retractWelcome, updateRunMessage]);

 // Pick a reply back up from the box: follow it live if it is still running,
 // or rebuild it from the run's log if it finished while this page was away.
 const resumeRun = useCallback(async (sessionId: string, runId: string) => {
 if (abortRef.current.has(sessionId)) return;
 const turn = beginTurn(sessionId, runId);
 const result = await followRun(sessionId, runId, turn.isCurrent, turn.controller.signal, 3);
 if (result.kind === "superseded") return;
 if (result.kind === "done") finalizeRun(sessionId, runId, result.done);
 else if (result.kind === "missing") settleMissingReply(sessionId, runId);
 else updateRunMessage(sessionId, runId, (m) => ({ ...m, streaming: false, outcome: "disconnected" }));
 turn.finish();
 }, [beginTurn, finalizeRun, followRun, settleMissingReply, updateRunMessage]);

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
 // A welcome turn's title is its hidden prompt, which never shows.
 const welcome = isHiddenWelcomeTitle(run.title);
 // A welcome opens in the chat on screen while that chat is still blank, so
 // a device that opens a new computer mid-welcome watches the first task land.
 const blankOpenChat = () => sessionsRef.current.find((s) => s.id === activeIdRef.current && s.messages.length === 0 && !s.claudeSessionId && s.loaded !== false);
 const findTarget = () => sessionsRef.current.find((s) => s.id === run.clientRef)
 ?? (run.agentSessionId ? sessionsRef.current.find((s) => s.claudeSessionId === run.agentSessionId) : undefined)
 ?? (welcome ? blankOpenChat() : undefined);
 const unloaded = (s: Session | undefined) => !s || (s.loaded === false && s.messages.length === 0);
 const prompt = welcome ? null : promptFromRunTitle(run.title);
 const asked: ChatMessage[] = prompt ? [{ role: "user", text: prompt, tools: [] }] : [];
 const reply: ChatMessage = { role: "assistant", text: "", tools: [], streaming: true, runId: run.runId, started: true, ...(welcome ? { welcome: true } : {}) };
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
 // A chat that already holds this conversation (its history opened
 // meanwhile, or this device's own copy) keeps its turns up to this one's
 // prompt, shown once: the reply replays the turn's output in full.
 return {
 ...s,
 title: welcome && s.title === "New chat" ? "Welcome" : s.title,
 claudeSessionId: s.claudeSessionId ?? run.agentSessionId,
 messages: [...historyBeforeRunningTurn(s.messages, prompt, welcome), reply],
 };
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
 // The generation (box and chat identity) whose catch-up is in flight: a
 // wake-up joins it, and a new box or chat identity starts its own.
 const resumingRef = useRef<number | null>(null);
 const resumeDetachedRuns = useCallback(async () => {
 const generation = requestGenerationRef.current;
 if (resumingRef.current === generation) return;
 resumingRef.current = generation;
 try {
 const runs = await listBoxChatRuns(boxUrl, token);
 if (requestGenerationRef.current !== generation) return;
 // The first-contact welcome waits for this answer, so it never starts
 // while the computer runs, or has run, one begun elsewhere.
 if (runs?.some((run) => isHiddenWelcomeTitle(run.title))) {
 writeWelcomed(skey, true);
 setWelcomeOnBox("seen");
 } else {
 setWelcomeOnBox((prev) => (prev === "pending" ? "none" : prev));
 }
 // An older runtime or an unreachable box: try again on the next wake-up.
 if (!runs) return;
 runsSupportedRef.current = true;
 const tracked = new Set<string>([...runRef.current.values(), ...adoptedRunsRef.current]);
 for (const s of sessionsRef.current) {
 for (const m of s.messages) if (m.runId) tracked.add(m.runId);
 if (abortRef.current.has(s.id)) continue;
 const m = s.messages.find((msg) => msg.role === "assistant" && msg.runId && !msg.streaming && (msg.outcome === undefined || msg.outcome === "disconnected"));
 // The list holds only the newest runs, and the computer keeps logs for
 // more: ask for the run's log whether or not it is listed.
 if (m?.runId) void resumeRun(s.id, m.runId);
 }
 for (const run of runs) {
 if (run.state === "running" && !tracked.has(run.runId)) void adoptRun(run);
 }
 } finally {
 if (resumingRef.current === generation) resumingRef.current = null;
 }
 }, [adoptRun, boxUrl, resumeRun, skey, token]);

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

 // Send what was typed: now, or, while the agent is working, into the queue.
 const submit = useCallback((raw: string) => {
 const sessionId = activeIdRef.current;
 const text = raw.trim();
 if (!sessionId || !text) return;
 if (!abortRef.current.has(sessionId)) {
 void send(text);
 return;
 }
 const item: QueuedMessage = { id: newId(), text, attachments: attachmentsRef.current.map(({ name, path }) => ({ name, path })) };
 setQueues((prev) => ({ ...prev, [sessionId]: [...(prev[sessionId] ?? []), item] }));
 setInput("");
 releasePreviews(attachmentsRef.current);
 changeAttachments(() => []);
 setAttachError(null);
 try { window.localStorage.removeItem(draftKey(skey, sessionId)); } catch { /* ignore */ }
 }, [changeAttachments, releasePreviews, send, skey]);
 const deleteQueued = useCallback((id: string) => {
 const sessionId = activeIdRef.current;
 const rest = (queuesRef.current[sessionId] ?? []).filter((q) => q.id !== id);
 setQueues((prev) => ({ ...prev, [sessionId]: rest }));
 if (rest.length === 0) setQueuePaused(sessionId, false);
 }, [setQueuePaused]);
 const editQueued = useCallback((id: string, text: string) => {
 const sessionId = activeIdRef.current;
 setQueues((prev) => ({ ...prev, [sessionId]: (prev[sessionId] ?? []).map((q) => (q.id === id ? { ...q, text: text.trim() } : q)) }));
 }, []);
 const resumeQueue = useCallback(() => setQueuePaused(activeIdRef.current, false), [setQueuePaused]);
 // The next queued message goes out once its conversation's reply is over.
 useEffect(() => {
 if (loadedKey !== skey) return;
 for (const [sessionId, items] of Object.entries(queues)) {
 if (items.length === 0 || pausedQueues.has(sessionId) || busyIds.has(sessionId) || abortRef.current.has(sessionId)) continue;
 const [next, ...rest] = items;
 setQueues((prev) => ({ ...prev, [sessionId]: rest }));
 void send(next.text, { sessionId, images: next.attachments.map((a) => a.path) });
 }
 }, [busyIds, loadedKey, pausedQueues, queues, send, skey]);
 const openQueue = queues[activeId] ?? [];

 // Record a thumbs up/down on an assistant message and fire the funnel event.
 // Toggling the same thumb clears it (and emits rating "none"); the capture goes
 // through the init-safe helper so analytics can never break the chat.
 const rateMessage = useCallback(
 (index: number, rating: "up" | "down") => {
 const key = activeIdRef.current + ":" + index;
 // The next ratings are worked out here, not inside the state updater: React may
 // run an updater more than once, which would send the event more than once.
 const cleared = feedbackRef.current[key] === rating;
 const next = { ...feedbackRef.current };
 if (cleared) delete next[key];
 else next[key] = rating;
 feedbackRef.current = next;
 setFeedback(next);
 captureClient("chat_feedback", {
 rating: cleared ? "none" : rating,
 agent_id: skey,
 ...(instanceId ? { instance_id: instanceId } : {}),
 message_id: activeIdRef.current + ":" + index,
 agent_kind: agentKind,
 lane: "hivra",
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
 onChatOpened?.();
 }, [onChatOpened]);

 const deleteChat = useCallback(
 (id: string) => {
 stopSession(id);
 // A reply this page is not following (the connection was lost, or it never
 // re-attached) may still be running on the box. Deleting its chat ends it
 // too, and it is never adopted back as another device's run.
 const session = sessionsRef.current.find((s) => s.id === id);
 for (const m of session?.messages || []) {
 if (!m.runId || adoptedRunsRef.current.has(m.runId)) continue;
 adoptedRunsRef.current.add(m.runId);
 if (m.role === "assistant" && !m.streaming && (m.outcome === undefined || m.outcome === "disconnected")) void stopBoxChatRun(boxUrl, m.runId, token);
 }
 setLastFailed(id, null);
 setQueues((prev) => {
 if (!(id in prev)) return prev;
 const next = { ...prev };
 delete next[id];
 return next;
 });
 setQueuePaused(id, false);
 // The chat that opens next is worked out here, from the sessions as they are, so
 // the state updater below has no side effects (React may run it more than once).
 const remaining = sessionsRef.current.filter((s) => s.id !== id);
 const fallback = emptySession();
 if (id === activeIdRef.current) setActiveId((remaining[0] ?? fallback).id);
 setSessions((prev) => {
 const next = prev.filter((s) => s.id !== id);
 return next.length ? next : [fallback];
 });
 },
 [boxUrl, setLastFailed, setQueuePaused, stopSession, token],
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

 const messages = active?.messages ?? NO_MESSAGES;
 // A first-contact welcome that failed: its prompt is hidden, so Retry on its
 // reply is the only way to ask again. It lasts across reloads.
 const lastMessage = messages[messages.length - 1];
 const welcomeFailed = Boolean(lastMessage?.welcome && !lastMessage.streaming && lastMessage.outcome === "error");
 // The open chat's conversation on the box, when it has one to reload from.
 const historySessionId = active?.claudeSessionId ? active.id : null;
 // Welcome suggestions: the chosen goal's three concrete starters (falls back to
 // the general-purpose goal so there's always something to tap). Tapping one
 // sends it as the first message — the seeded agent answers in character.
 const goalDef = goal ? getGoal(goal) : null;
 const starters = (goalDef ?? getGoal(undefined)).starters;

 // How full the model's context is, once the stream has said.
 const contextUsage = useMemo(() => contextUsageOf(messages), [messages]);

 // The transcript's motion: new rows ease in and the view follows the stream.
 // It starts only once a chat's turns are in place, so opening a chat never
 // animates its history. Without ResizeObserver the plain autoscroll stays.
 const [motionSessionId, setMotionSessionId] = useState("");
 useEffect(() => { setMotionSessionId(activeId); }, [activeId]);
 const motionBlocks = useMemo<MotionBlock[]>(() => messages.map((m, i) => ({ id: String(i), role: m.role })), [messages]);
 const settleScrollTop = useCallback((el: HTMLDivElement) => { lastScrollTopRef.current = el.scrollTop; }, []);
 const rejoinMotion = useBottomChatMotion(
 scroller,
 typeof ResizeObserver === "function" && loadedKey === skey && motionSessionId === activeId && messages.length > 0,
 stickToBottomRef,
 motionBlocks,
 false,
 busy,
 undefined,
 busy,
 undefined,
 false,
 settleScrollTop,
 );

 const list = (extra?: { onClose?: () => void }) => (
 <ChatList
 sessions={sessions}
 activeId={activeId}
 busyIds={busyIds}
 armedId={confirmDeleteId}
 onSelect={selectSession}
 onNewChat={newChat}
 onDelete={requestDeleteChat}
 onClose={extra?.onClose}
 />
 );

 return (
 <div ref={rootRef} className={`hivra-chat-root ${styles.root}`}>
 {/* The chat list lives in the agent sidebar when it provides a place for it. */}
 {slotElement ? createPortal(list(), slotElement) : null}
 {/* Anywhere else: an overlay drawer below md, an inline column from md up. */}
 {showRail ? (
 <>
 <button
 type="button"
 aria-hidden="true"
 tabIndex={-1}
 onClick={() => setShowRail(false)}
 className={styles.railBackdrop}
 />
 <div
 ref={drawerRef}
 id={drawerId}
 role={drawerOpen ? "dialog" : undefined}
 aria-modal={drawerOpen ? true : undefined}
 aria-label={drawerOpen ? "Chats" : undefined}
 onKeyDown={drawerOpen ? trapDrawerFocus : undefined}
 className={styles.rail}
 >
 {list({ onClose: narrow ? () => setShowRail(false) : undefined })}
 </div>
 </>
 ) : null}

 {/* Chat column */}
 <div ref={columnRef} inert={drawerOpen} className={styles.column}>
 {instanceId ? <MemoryUsageBanner instanceId={instanceId} /> : null}
 {!slotElement ? (
 <div className={styles.listBar}>
 <button
 ref={railToggleRef}
 type="button"
 aria-label={showRail ? "Hide chats" : "Show chats"}
 aria-expanded={showRail}
 aria-controls={showRail ? drawerId : undefined}
 title={showRail ? "Hide chats" : "Show chats"}
 onClick={() => setShowRail((v) => !v)}
 className={styles.listBarButton}
 >
 <PanelLeft size={15} aria-hidden />
 </button>
 {!showRail ? (
 <button type="button" aria-label="New chat" title="New chat" onClick={newChat} className={styles.listBarButton}>
 <Plus size={15} aria-hidden />
 </button>
 ) : null}
 </div>
 ) : null}
 <div ref={scrollerRef} role="region" aria-label="Conversation" tabIndex={0} data-empty={messages.length === 0 ? "true" : undefined} onScroll={onScrollPane} className={styles.scroll}>
 <div className={styles.clip}>
 <div className={styles.transcript} data-transcript-content>
 {messages.length === 0 ? (
 <ChatEmpty
 agentName={agentName}
 emoji={emoji}
 intro={goalDef ? `I'm set up to help you ${goalDef.label.toLowerCase()}. Want to start with one of these?` : "Tell me what you need, or start with one of these."}
 starters={starters}
 disabled={busy}
 onPick={(starter) => void send(starter)}
 />
 ) : null}
 {messages.map((m, i) => (
 <AgentTurn key={i} m={m} index={i} agentName={agentName} emoji={emoji} historySessionId={historySessionId}
 rating={feedback[activeId + ":" + i]} onRate={rateMessage} onOpenHistory={showBoxHistory}
 busy={busy} onBuildPlan={(message) => void send(message)} />
 ))}
 </div>
 </div>
 </div>
 <TranscriptFind messages={messages} scrollRef={scrollRef} rootRef={rootRef} />
 <PromptOutline messages={messages} scrollRef={scrollRef} onJump={() => { stickToBottomRef.current = false; }} />

 <ChatComposer
 agentName={agentName}
 input={input}
 onInputChange={setInput}
 onSend={submit}
 onStop={stop}
 busy={busy}
 coarsePointer={coarsePointer}
 composerCap={composerCap}
 modelLabel={shownModel}
 controls={controls}
 context={contextUsage}
 queued={openQueue}
 queuePaused={pausedQueues.has(activeId)}
 onQueueDelete={deleteQueued}
 onQueueEdit={editQueued}
 onQueueResume={resumeQueue}
 fileDrag={fileDrag}
 canUpload={Boolean(token)}
 attachments={attachments}
 onRemoveAttachment={removeAttachment}
 uploading={uploading}
 attachError={attachError}
 onUploadFile={(file) => void uploadAttachment(file)}
 textareaRef={composerRef}
 dockRef={composerDockRef}
 >
 {showLatest && messages.length > 0 ? (
 <JumpToLatest
 onJump={() => {
 scrollDown(true);
 rejoinMotion();
 // This button unmounts on activation; keep focus in the chat, on the
 // conversation the user asked to see.
 scrollRef.current?.focus({ preventScroll: true });
 }}
 />
 ) : null}
 {(lastFailed || welcomeFailed) && !busy ? (
 <div className={chatStyles.retryRow}>
 <button
 type="button"
 onClick={() => {
 if (!lastFailed) {
 startWelcome(activeId, true);
 return;
 }
 const t = lastFailed;
 setLastFailed(activeId, null);
 void send(t);
 }}
 className={chatStyles.softButton}
 >
 <RotateCcw size={13} aria-hidden /> Retry
 </button>
 </div>
 ) : null}
 </ChatComposer>
 </div>
 </div>
 );
}

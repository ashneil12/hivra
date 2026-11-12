"use client";

import {
  useCallback, useEffect, useId, useRef, useState,
  type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode,
} from "react";
import { ArrowLeftRight, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Download, PanelLeft, PanelLeftClose, X } from "lucide-react";
import { StatusText } from "@/components/ui/StatusText";
import { ThinkingOrb } from "@/components/ui/ThinkingOrb";
import { statusTone } from "@/components/hivra/ResourceSwitcher";
import { SurfaceActions } from "@/components/hivra/SurfaceActions";
import styles from "./AgentPill.module.css";

const OFFSET_KEY = "hivra:agent-pill-offset";
const INTRO_KEY = "hivra:agent-pill-intro-seen";
const INTRO_DELAY_MS = 700;
const READY_MS = 4000;
const DRAG_THRESHOLD = 4;
const EDGE = 8;
const MENU_WIDTH = 380;

/** One quick button: a view the pill opens in one tap. */
export interface AgentPillView {
  key: string;
  label: string;
  icon: ReactNode;
  active: boolean;
  onSelect: () => void;
}

/** What a setting's pop-up is given to move around inside the dropdown. */
export interface AgentPillSettingContext {
  /** Back to the menu. */
  back: () => void;
  /** Close the whole dropdown. */
  close: () => void;
}

/** One row of "Quick settings". Its pop-up opens inside the same dropdown. */
export interface AgentPillSetting {
  id: string;
  icon: ReactNode;
  label: string;
  /** A muted word beside the label ("Up to date"). */
  value?: string;
  render: (ctx: AgentPillSettingContext) => ReactNode;
  /** Called when the pop-up is left, so it can drop an outcome that is no longer news. */
  onLeave?: () => void;
}

/** One suggested next step, shown as a card above Quick settings. */
export interface AgentPillSuggestion {
  id: string;
  title: string;
  body: string;
  actionLabel: string;
  onAction: () => void;
  onDismiss: () => void;
}

export interface AgentPillProps {
  /** The agent's name, with its emoji where it has one. */
  name: string;
  /** The status as a plain word ("running", "setting up"). */
  status: string;
  /** A tooltip on the name: where the agent's computer runs and how big it is. */
  nameTitle?: string;
  /** A short action word while something runs ("Updating"). */
  busy?: string | null;
  /** A small muted note beside the status, e.g. "View only". */
  note?: string;
  /** Beside the status in the dropdown header (the software update chip). */
  extras?: ReactNode;
  views: AgentPillView[];
  /** The element the views render into, for aria-controls on the open one. */
  panelId?: string;
  quickSettings?: AgentPillSetting[];
  suggestion?: AgentPillSuggestion | null;
  /** Whose lifted actions (Open in new tab) show in the footer. */
  actionSurface: string;
  exportHref?: string;
  sidebar?: { shown: boolean; onToggle: () => void; controlsId: string };
  /** Opens the global agent switcher. Left out where there is none. */
  onSwitchAgent?: () => void;
  /** The way back to the agent's own view, a second small pill beside the main one. */
  back?: { label: string; onClick: () => void };
}

const FOCUSABLE = "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])";

function readOffset(): number {
  try {
    const value = Number.parseFloat(window.localStorage.getItem(OFFSET_KEY) ?? "");
    return Number.isFinite(value) && Math.abs(value) <= 0.5 ? value : 0;
  } catch {
    return 0; // A display preference cannot block the page.
  }
}

function writeOffset(value: number): void {
  try {
    window.localStorage.setItem(OFFSET_KEY, String(value));
  } catch { /* Keep the current view usable. */ }
}

function clamp(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value));
}

/**
 * The agent page's one floating control: a small pill at the top middle of the
 * work column that opens a glass dropdown with the agent's status, every view,
 * quick settings and the shell's own buttons. It knows nothing about agents;
 * the page hands it what to show.
 */
export function AgentPill({
  name, status, nameTitle, busy = null, note, extras, views, panelId, quickSettings = [], suggestion = null,
  actionSurface, exportHref, sidebar, onSwitchAgent, back,
}: AgentPillProps) {
  const dropId = useId();
  const anchorRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState({ left: EDGE, origin: 50 });
  const [sub, setSub] = useState<string | null>(null);
  const [frac, setFrac] = useState(0);
  const [box, setBox] = useState({ col: 0, group: 0 });
  const [dragging, setDragging] = useState(false);

  const tone = busy ? "busy" : statusTone(status);
  const working = tone === "busy";
  const word = busy ?? status;

  // "Ready" for a few seconds after the agent finishes starting or updating.
  const [prevWorking, setPrevWorking] = useState(working);
  const [ready, setReady] = useState(false);
  if (prevWorking !== working) {
    setPrevWorking(working);
    setReady(!working && tone === "ok");
  }
  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => setReady(false), READY_MS);
    return () => window.clearTimeout(timer);
  }, [ready]);

  // The saved sideways position is browser state: read it once the page is on screen.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFrac(readOffset());
  }, []);

  // Keep the column's and the pill's widths, so the saved position stays on screen.
  useEffect(() => {
    const measure = () => {
      const col = anchorRef.current?.clientWidth ?? 0;
      const group = groupRef.current?.offsetWidth ?? 0;
      setBox((current) => (current.col === col && current.group === group ? current : { col, group }));
    };
    measure();
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    if (observer) {
      if (anchorRef.current) observer.observe(anchorRef.current);
      if (groupRef.current) observer.observe(groupRef.current);
    }
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, []);

  const limit = Math.max(0, box.col / 2 - box.group / 2 - EDGE);
  const shiftPx = box.col > 0 ? clamp(frac * box.col, limit) : 0;

  // ----- Opening and closing -----
  const [returnFocus, setReturnFocus] = useState(false);

  const openMenu = useCallback(() => {
    const handle = handleRef.current;
    const column = anchorRef.current?.parentElement;
    let left = EDGE;
    let origin = 50;
    if (handle && column) {
      const h = handle.getBoundingClientRect();
      const c = column.getBoundingClientRect();
      const width = Math.min(MENU_WIDTH, Math.max(0, c.width - EDGE * 2));
      const center = h.left + h.width / 2 - c.left;
      left = Math.max(EDGE, Math.min(center - width / 2, c.width - width - EDGE));
      origin = center - left;
    }
    setPlace({ left, origin });
    setSub(null);
    setOpen(true);
  }, []);

  const closeMenu = useCallback((focusHandle: boolean) => {
    setReturnFocus(focusHandle);
    setOpen(false);
    setSub(null);
  }, []);

  // Focus moves to the active view on open and back to the pill on close.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      const drop = dropRef.current;
      (drop?.querySelector<HTMLElement>('[aria-current="page"]') ?? drop?.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    }
    if (!open && wasOpen.current && returnFocus) handleRef.current?.focus();
    wasOpen.current = open;
  }, [open, returnFocus]);

  // A setting's pop-up gets focus on its back button; the menu gets it back on the row.
  const prevSub = useRef<string | null>(null);
  const settingsRef = useRef(quickSettings);
  useEffect(() => { settingsRef.current = quickSettings; });
  useEffect(() => {
    const previous = prevSub.current;
    prevSub.current = sub;
    if (previous === sub) return;
    if (previous) settingsRef.current.find((setting) => setting.id === previous)?.onLeave?.();
    const drop = dropRef.current;
    if (!drop) return;
    if (sub) drop.querySelector<HTMLElement>("[data-pill-back]")?.focus();
    else if (previous) Array.from(drop.querySelectorAll<HTMLElement>("[data-setting]")).find((row) => row.dataset.setting === previous)?.focus();
  }, [sub]);

  // First time this browser shows the pill for a running agent, open it once by itself.
  const introTried = useRef(false);
  const running = tone === "ok" && !busy;
  useEffect(() => {
    if (!running || introTried.current) return;
    let seen: boolean;
    try {
      seen = window.localStorage.getItem(INTRO_KEY) === "1";
    } catch {
      introTried.current = true;
      return; // Without storage it could repeat on every visit, so it does not open at all.
    }
    if (seen) { introTried.current = true; return; }
    const timer = window.setTimeout(() => {
      introTried.current = true;
      try {
        window.localStorage.setItem(INTRO_KEY, "1");
        if (window.localStorage.getItem(INTRO_KEY) !== "1") return;
      } catch {
        return;
      }
      openMenu();
    }, INTRO_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [running, openMenu]);

  // Escape (a pop-up goes back to the menu first), a press outside, and focus moving into an iframe.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (sub) setSub(null);
      else closeMenu(true);
    };
    const onPointerDown = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (dropRef.current?.contains(target) || groupRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest("[data-agent-pill-keep]")) return;
      closeMenu(false);
    };
    // Hermes, Terminal and Desktop are iframes: a press inside one never reaches the document.
    const onBlur = () => {
      if (document.activeElement?.tagName === "IFRAME") closeMenu(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("blur", onBlur);
    };
  }, [open, sub, closeMenu]);

  // ----- Dragging along the top edge; a press that barely moves is a tap -----
  const drag = useRef<{ x: number; from: number; moved: boolean } | null>(null);
  const handledAt = useRef(0);

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    drag.current = { x: event.clientX, from: shiftPx, moved: false };
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* A synthetic press has no pointer to capture. */ }
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = drag.current;
    if (!state) return;
    const dx = event.clientX - state.x;
    if (!state.moved && Math.abs(dx) < DRAG_THRESHOLD) return;
    state.moved = true;
    setDragging(true);
    if (box.col > 0) setFrac(clamp(state.from + dx, limit) / box.col);
  };
  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = drag.current;
    drag.current = null;
    if (!state?.moved) return;
    // The click that follows a drag is not a tap.
    handledAt.current = Date.now();
    setDragging(false);
    if (box.col > 0) writeOffset(clamp(state.from + (event.clientX - state.x), limit) / box.col);
  };
  // Taps, clicks and keyboard presses all open it here. Opening on release
  // instead let a touch's own click land on the freshly opened dropdown.
  const onClick = () => {
    // A drag's own click arrives at once; anything later is a real tap.
    if (Date.now() - handledAt.current < 150) return;
    openMenu();
  };

  // ----- What the dropdown shows -----
  const subSetting = sub ? quickSettings.find((setting) => setting.id === sub) ?? null : null;
  const ctx: AgentPillSettingContext = { back: () => setSub(null), close: () => closeMenu(true) };

  const onDropKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    // Keep Tab inside the dropdown while it is open.
    const items = Array.from(dropRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const showReady = ready && tone === "ok";
  const label = `${name}, ${word}. Show controls`;

  return (
    <>
      <div ref={anchorRef} className={styles.anchor}>
        <div
          ref={groupRef}
          className={styles.group}
          data-open={open || undefined}
          data-dragging={dragging || undefined}
          style={{ transform: shiftPx ? `translateX(${shiftPx}px)` : undefined }}
        >
          {back ? (
            <button type="button" className={styles.back} onClick={back.onClick} aria-label={`Back to ${back.label}`} title={`Back to ${back.label}`}>
              <ChevronLeft aria-hidden="true" /><span>{back.label}</span>
            </button>
          ) : null}
          <button
            ref={handleRef}
            type="button"
            className={styles.pill}
            data-dragging={dragging || undefined}
            aria-label={label}
            aria-expanded={open}
            aria-controls={dropId}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onClick={onClick}
          >
            {working ? (
              <>
                <span className={styles.orb} aria-hidden="true"><ThinkingOrb size={20} /></span>
                <span className={styles.word}>{busy ?? <StatusText value={status} />}</span>
              </>
            ) : tone === "ok" ? (
              <>
                <span className={styles.dot} data-tone="ok" aria-hidden="true" />
                {showReady ? <span className={styles.word}>Ready</span> : null}
                <ChevronDown aria-hidden="true" />
              </>
            ) : (
              <>
                <span className={styles.dot} data-tone={tone} aria-hidden="true" />
                <span className={styles.word}><StatusText value={status} /></span>
              </>
            )}
            {suggestion ? <span className={styles.badge} data-testid="agent-pill-badge" aria-hidden="true" /> : null}
          </button>
        </div>
      </div>

      {open ? (
        <div
          ref={dropRef}
          id={dropId}
          role="dialog"
          aria-label={`${name} controls`}
          className={styles.drop}
          style={{ left: place.left, transformOrigin: `${place.origin}px 0` }}
          onKeyDown={onDropKeyDown}
        >
          {subSetting ? (
            <section className={styles.sub} aria-label={subSetting.label}>
              <div className={styles.subHead}>
                <button type="button" className={styles.iconButton} data-pill-back="" aria-label="Back" title="Back" onClick={() => setSub(null)}>
                  <ChevronLeft aria-hidden="true" />
                </button>
                <b className={styles.subTitle}>{subSetting.label}</b>
                <span className={styles.spacer} />
                <button type="button" className={styles.iconButton} aria-label="Close controls" title="Close" onClick={() => closeMenu(true)}>
                  <X aria-hidden="true" />
                </button>
              </div>
              <div className={styles.subBody}>{subSetting.render(ctx)}</div>
            </section>
          ) : (
            <>
              <div className={styles.head}>
                <span className={styles.dot} data-tone={tone} aria-hidden="true" />
                <b className={styles.name} title={nameTitle}>{name}</b>
                <span className={styles.status} data-tone={tone}>{word}</span>
                {note ? <span className={styles.note}>{note}</span> : null}
                {extras ? (
                  // Whatever the extras offer (the update chip opens Settings) is an answer: the dropdown steps aside.
                  <span className={styles.extras} onClick={(event) => { if ((event.target as Element).closest("button, a")) closeMenu(false); }}>{extras}</span>
                ) : null}
                <span className={styles.spacer} />
                <button type="button" className={styles.iconButton} aria-label="Close controls" title="Close" onClick={() => closeMenu(true)}>
                  <ChevronUp aria-hidden="true" />
                </button>
              </div>

              <nav aria-label="Views" className={styles.views}>
                {views.map((view) => (
                  <button
                    key={view.key}
                    type="button"
                    className={styles.view}
                    aria-current={view.active ? "page" : undefined}
                    aria-controls={view.active ? panelId : undefined}
                    // Focus is not sent back to the pill here: the page treats a focus arriving in the window as a reason to re-check the computer.
                    onClick={() => { view.onSelect(); closeMenu(false); }}
                  >
                    <span className={styles.viewIcon} aria-hidden="true">{view.icon}</span>
                    <span className={styles.viewLabel}>{view.label}</span>
                  </button>
                ))}
              </nav>

              {suggestion ? (
                <section className={styles.suggestion} aria-label={`Suggestion: ${suggestion.title}`}>
                  <p className={styles.suggestionTitle}>{suggestion.title}</p>
                  <p className={styles.suggestionBody}>{suggestion.body}</p>
                  <div className={styles.buttons}>
                    <button type="button" className={styles.primary} onClick={() => { suggestion.onAction(); closeMenu(true); }}>{suggestion.actionLabel}</button>
                    <button type="button" className={styles.secondary} onClick={suggestion.onDismiss}>Not now</button>
                  </div>
                </section>
              ) : null}

              {quickSettings.length > 0 ? (
                <section aria-label="Quick settings" style={{ display: "grid", gap: 6 }}>
                  <p className={styles.label}>Quick settings</p>
                  <div className={styles.list}>
                    {quickSettings.map((setting) => (
                      <button key={setting.id} type="button" className={styles.row} data-setting={setting.id} onClick={() => setSub(setting.id)}>
                        {setting.icon}
                        <span className={styles.rowLabel}>{setting.label}</span>
                        {setting.value ? <span className={styles.rowValue}>{setting.value}</span> : null}
                        <ChevronRight className={styles.chevron} aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}

              <div className={styles.foot}>
                {sidebar ? (
                  <button
                    type="button"
                    className={styles.footButton}
                    aria-controls={sidebar.controlsId}
                    aria-expanded={sidebar.shown}
                    onClick={() => { sidebar.onToggle(); closeMenu(false); }}
                  >
                    {sidebar.shown ? <PanelLeftClose aria-hidden="true" /> : <PanelLeft aria-hidden="true" />}
                    <span>{sidebar.shown ? "Hide sidebar" : "Show sidebar"}</span>
                  </button>
                ) : null}
                <div className={styles.footActions} onClick={(event) => { if ((event.target as Element).closest("button")) closeMenu(false); }}>
                  <SurfaceActions surfaceId={actionSurface} className={styles.footActions} buttonClassName={`${styles.footButton} ${styles.footIcon}`} />
                </div>
                {exportHref ? (
                  <a href={exportHref} className={styles.footButton} title="Download chats and memory as JSON">
                    <Download aria-hidden="true" /><span>Download</span>
                  </a>
                ) : null}
                {onSwitchAgent ? (
                  <button type="button" className={styles.footButton} onClick={() => { closeMenu(false); onSwitchAgent(); }}>
                    <ArrowLeftRight aria-hidden="true" /><span>Switch agent</span>
                  </button>
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : null}
    </>
  );
}

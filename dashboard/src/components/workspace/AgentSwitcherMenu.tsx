"use client";

import { BookOpenCheck, Check, Plus, RotateCcw, Search } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";

import { SafePortal } from "@/components/ui/SafePortal";
import type { UnifiedAgent } from "@/lib/hivra/unified-agent";
import { unifiedStateLabel } from "@/lib/hivra/unified-agent";

const MENU_MIN_WIDTH = 320;
const MENU_VIEWPORT_MARGIN = 8;
const MENU_OFFSET = 4;
const MENU_MAX_HEIGHT = 420;
const MENU_MIN_HEIGHT = 180;
const LISTBOX_ID = "agent-switcher-listbox";

export interface AgentSwitcherMenuProps {
  open: boolean;
  agents: readonly UnifiedAgent[];
  selectedUid: string | null;
  loading: boolean;
  hermesError: string | null;
  hivraError: string | null;
  anchorRef: RefObject<HTMLButtonElement | null>;
  onSelect: (agent: UnifiedAgent, keyboardOrigin: boolean) => void;
  /**
   * `restoreFocus: false` means focus already went somewhere the person chose
   * (a Terminal, Desktop or Browser frame), so the host must not pull it back
   * to the trigger.
   */
  onClose: (options?: { restoreFocus?: boolean }) => void;
  onRetryHermes: () => void;
  onRetryHivra: () => void;
  onOpenTestGuide?: () => void;
}

function agentMeta(agent: UnifiedAgent): string {
  return `${agent.typeLabel} · ${unifiedStateLabel(agent.state)}`;
}

function optionId(uid: string): string {
  return `agent-switcher-option-${uid}`;
}

/** On touch, focusing the search raises a keyboard that hides the list. */
function coarsePointer(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

/**
 * The fleet switcher: a searchable menu anchored under the header, replacing the
 * 264px rail that used to hold the fleet list permanently open.
 *
 * The rail's own affordances are preserved here rather than dropped — the
 * Agents/Computers grouping, the per-source failure rows with retry, the
 * duplicate-name disambiguator, and the add link — because the rail was the only
 * place those lived. What changes is that it now costs no layout space at all
 * and closes on a click anywhere outside it.
 *
 * It serves BOTH resource families, so its own copy says "runtimes" rather than
 * "agents": the menu returns computers, and a search field promising agents
 * would contradict the rows directly beneath it. That is the same word the Chat
 * control pane and the owner use for the set, so one noun covers both families
 * everywhere. The per-group headings still name each family, which is where that
 * distinction belongs.
 */
export function AgentSwitcherMenu(props: AgentSwitcherMenuProps) {
  // Mounted only while open, so the query and highlight start fresh every time
  // without an effect to reset them.
  if (!props.open) return null;
  return <AgentSwitcherPanel {...props} />;
}

function AgentSwitcherPanel({
  agents,
  selectedUid,
  loading,
  hermesError,
  hivraError,
  anchorRef,
  onSelect,
  onClose,
  onRetryHermes,
  onRetryHivra,
  onOpenTestGuide,
}: AgentSwitcherMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [query, setQuery] = useState("");
  // Seeded from the current agent at mount. Deliberately not re-seeded when the
  // agent list refreshes — that would move the selection out from under someone
  // who is arrowing through it.
  const [activeIndex, setActiveIndex] = useState(() => {
    const index = agents.findIndex((agent) => agent.uid === selectedUid);
    return index >= 0 ? index : 0;
  });

  // Position is written straight to the element rather than held in state: it
  // is a pure function of the anchor rect, and re-rendering the whole menu on
  // every scroll frame to move it would be wasted work.
  const place = useCallback(() => {
    const menu = menuRef.current;
    const anchor = anchorRef.current;
    if (!menu || !anchor || typeof window === "undefined") return;
    const rect = anchor.getBoundingClientRect();
    // A hidden anchor measures 0x0; keep the last good position instead of
    // jumping to the viewport corner.
    if (rect.width === 0 && rect.height === 0) return;
    const available = window.innerWidth - MENU_VIEWPORT_MARGIN * 2;
    const width = Math.max(MENU_MIN_WIDTH, Math.min(rect.width, available));
    const left = Math.max(
      MENU_VIEWPORT_MARGIN,
      Math.min(rect.left, window.innerWidth - width - MENU_VIEWPORT_MARGIN),
    );
    // The visual viewport excludes an open on-screen keyboard; innerHeight
    // does not, which put the lower rows and footer under the iOS keyboard.
    const viewport = window.visualViewport;
    const visibleTop = viewport?.offsetTop ?? 0;
    const visibleBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
    const spaceBelow =
      visibleBottom - rect.bottom - MENU_OFFSET - MENU_VIEWPORT_MARGIN;
    const spaceAbove = rect.top - visibleTop - MENU_OFFSET - MENU_VIEWPORT_MARGIN;
    const placeAbove = spaceBelow < MENU_MIN_HEIGHT && spaceAbove > spaceBelow;
    const room = Math.max(placeAbove ? spaceAbove : spaceBelow, MENU_MIN_HEIGHT);
    const maxHeight = Math.min(MENU_MAX_HEIGHT, room);
    menu.style.top = `${
      placeAbove
        ? Math.max(visibleTop + MENU_VIEWPORT_MARGIN, rect.top - MENU_OFFSET - maxHeight)
        : rect.bottom + MENU_OFFSET
    }px`;
    menu.style.left = `${left}px`;
    menu.style.width = `${width}px`;
    menu.style.setProperty("--agent-menu-max-height", `${maxHeight}px`);
  }, [anchorRef]);

  const close = useCallback(() => onClose(), [onClose]);

  // A callback ref, not an effect: SafePortal creates its mount node in its own
  // effect and renders nothing until it exists, so on the first commit the menu
  // element is not in the tree yet. An effect keyed on `place` would run once
  // against a null ref, do nothing, and never re-run — leaving the menu at the
  // viewport origin. A callback ref fires when the node actually attaches, which
  // is the first moment there is anything to measure.
  const attachMenu = useCallback(
    (node: HTMLDivElement | null) => {
      menuRef.current = node;
      if (!node) return;
      place();
      if (!coarsePointer()) {
        searchRef.current?.focus();
        return;
      }
      // Touch: keep the keyboard down and land on the current runtime.
      const selected = optionRefs.current.find((option) => option?.getAttribute("aria-selected") === "true");
      (selected ?? node).focus({ preventScroll: true });
    },
    [place],
  );

  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    viewport?.addEventListener("resize", place);
    viewport?.addEventListener("scroll", place);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      viewport?.removeEventListener("resize", place);
      viewport?.removeEventListener("scroll", place);
    };
  }, [place]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      // The trigger owns its own toggle, so a click there must not close-then-reopen.
      if (anchorRef.current?.contains(target)) return;
      close();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        close();
      }
    };
    // Fires when an iframe (terminal, desktop, browser) takes focus, where a
    // tap never reaches this document's pointer listener. Focus stays there.
    const handleBlur = () => onClose({ restoreFocus: false });
    document.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("blur", handleBlur);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("blur", handleBlur);
    };
  }, [anchorRef, close, onClose]);

  const normalizedQuery = query.trim().toLowerCase();
  const sections = useMemo(() => {
    const matching = agents.filter(
      (agent) =>
        !normalizedQuery ||
        agent.name.toLowerCase().includes(normalizedQuery) ||
        agent.typeLabel.toLowerCase().includes(normalizedQuery) ||
        agent.vendor.toLowerCase().includes(normalizedQuery),
    );
    return [
      {
        key: "agent",
        label: "Agents",
        items: matching.filter((agent) => agent.resourceKind !== "computer"),
      },
      {
        key: "computer",
        label: "Computers",
        items: matching.filter((agent) => agent.resourceKind === "computer"),
      },
    ].filter((section) => section.items.length > 0);
  }, [agents, normalizedQuery]);

  // The arrow keys walk this flat order, so it has to match the DOM order the
  // sections render in — not the raw agent array, which interleaves the two.
  const flat = useMemo(
    () => sections.flatMap((section) => section.items),
    [sections],
  );

  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const agent of flat) {
      counts.set(agent.name, (counts.get(agent.name) ?? 0) + 1);
    }
    return new Set(
      [...counts.entries()]
        .filter(([, count]) => count > 1)
        .map(([name]) => name),
    );
  }, [flat]);

  // Keep the highlight inside the filtered list, and keep the highlighted row
  // visible. Both are DOM-level concerns, so neither goes through an effect.
  const clampedIndex = activeIndex < flat.length ? activeIndex : 0;

  useEffect(() => {
    const element = optionRefs.current[clampedIndex];
    if (element && typeof element.scrollIntoView === "function") {
      element.scrollIntoView({ block: "nearest" });
    }
  }, [clampedIndex]);

  // On the dialog, not just the search field: on touch, focus starts on the
  // current option, and a hardware keyboard must still walk the list.
  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    const fromSearch = target === searchRef.current;
    const fromOption = target.getAttribute("role") === "option";
    if (!fromSearch && !fromOption && target !== menuRef.current) return;
    if (flat.length === 0) return;
    const next =
      event.key === "ArrowDown" ? (clampedIndex + 1) % flat.length
        : event.key === "ArrowUp" ? (clampedIndex - 1 + flat.length) % flat.length
          : event.key === "Home" ? 0
            : event.key === "End" ? flat.length - 1
              : null;
    if (next !== null) {
      event.preventDefault();
      setActiveIndex(next);
      // The combobox tracks the highlight with aria-activedescendant; off the
      // search field, DOM focus follows it instead.
      if (!fromSearch) optionRefs.current[next]?.focus();
      return;
    }
    // A focused option activates itself as a button.
    if (event.key === "Enter" && !fromOption) {
      const active = flat[clampedIndex];
      if (!active) return;
      event.preventDefault();
      onSelect(active, true);
    }
  }

  const activeAgent = flat[clampedIndex];
  let optionIndex = -1;

  return (
    <SafePortal>
      <div
        ref={attachMenu}
        role="dialog"
        aria-label="Switch runtime"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        style={{ position: "fixed", zIndex: 10050, maxHeight: "var(--agent-menu-max-height, 420px)", outline: "none" }}
        className="flex max-w-[calc(100vw-16px)] flex-col overflow-hidden border border-[var(--etched-border)] bg-[var(--bg-surface)] shadow-[0_12px_32px_rgba(0,0,0,0.16)]"
      >
        {/* A label, so a tap anywhere on the row focuses the field. */}
        <label className="flex shrink-0 cursor-text items-center gap-2 border-b border-[var(--etched-border)] px-2.5 py-2 pointer-coarse:py-0">
          <Search
            aria-hidden="true"
            size={14}
            className="shrink-0 text-[var(--text-muted)]"
          />
          <input
            ref={searchRef}
            role="combobox"
            aria-expanded="true"
            aria-controls={LISTBOX_ID}
            aria-autocomplete="list"
            aria-activedescendant={activeAgent ? optionId(activeAgent.uid) : undefined}
            aria-label="Search your runtimes"
            placeholder="Search runtimes"
            value={query}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
            onChange={(event) => setQuery(event.target.value)}
            className="mono min-w-0 flex-1 bg-transparent text-[13px] text-[var(--ink-black)] outline-none placeholder:text-[var(--text-muted)] pointer-coarse:min-h-[44px] max-md:text-[16px]"
          />
        </label>

        {hermesError ? (
          <SourceFailure source="Hermes" onRetry={onRetryHermes} />
        ) : null}
        {hivraError ? (
          <SourceFailure source="Hivra" onRetry={onRetryHivra} />
        ) : null}

        <div
          id={LISTBOX_ID}
          role="listbox"
          aria-label="Your runtimes"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
        >
          {loading ? (
            <p className="px-2.5 py-3 text-[13px] text-[var(--text-muted)]">
              Loading your runtimes…
            </p>
          ) : flat.length === 0 ? (
            <p className="px-2.5 py-3 text-[13px] text-[var(--text-muted)]">
              {query.trim()
                ? "Nothing in your runtimes matches that search."
                : "No runtimes yet. Launch one to get started."}
            </p>
          ) : (
            sections.map((section) => (
              <div key={section.key} role="group" aria-label={section.label}>
                <p className="mono px-2.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)] max-md:text-[11px] pointer-coarse:text-[11px]">
                  {section.label}
                </p>
                {section.items.map((agent) => {
                  optionIndex += 1;
                  const index = optionIndex;
                  const selected = agent.uid === selectedUid;
                  const active = index === clampedIndex;
                  return (
                    <button
                      key={agent.uid}
                      id={optionId(agent.uid)}
                      ref={(element) => {
                        optionRefs.current[index] = element;
                      }}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      title={`${agent.name} — ${agentMeta(agent)}`}
                      onMouseEnter={() => setActiveIndex(index)}
                      onFocus={() => setActiveIndex(index)}
                      onClick={(event) => onSelect(agent, event.detail === 0)}
                      className={[
                        "flex min-h-[44px] w-full min-w-0 items-center gap-2 border-l-2 px-2.5 py-2 text-left outline-none",
                        "motion-reduce:transition-none",
                        selected
                          ? "border-l-[var(--hivra-red)] bg-[var(--bg-elevated)]"
                          : active
                            ? "border-l-transparent bg-[var(--bg-elevated)]"
                            : "border-l-transparent",
                        "focus-visible:ring-2 focus-visible:ring-[var(--hivra-red)] focus-visible:ring-offset-2",
                      ].join(" ")}
                    >
                      <span
                        aria-hidden="true"
                        className="h-2 w-2 shrink-0"
                        style={{ backgroundColor: agent.dot }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] font-medium leading-[1.45]">
                          {agent.emoji ? `${agent.emoji} ` : ""}
                          {agent.name}
                          {duplicateNames.has(agent.name) ? (
                            <span className="ml-1.5 text-[11px] font-normal text-[var(--text-muted)]">
                              #{agent.id.slice(-4)}
                            </span>
                          ) : null}
                        </span>
                        <span className="mono block truncate text-[11.5px] font-normal leading-[1.35] text-[var(--text-muted)]">
                          {agentMeta(agent)}
                        </span>
                      </span>
                      {selected ? (
                        <Check
                          aria-hidden="true"
                          size={14}
                          className="shrink-0 text-[var(--hivra-red)]"
                        />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <a href="/dashboard?runtimes=1" className="mono flex min-h-[40px] items-center border-t border-[var(--etched-border)] px-2.5 text-[12px] text-[var(--text-secondary)] outline-none hover:text-[var(--ink-black)] focus-visible:ring-2 focus-visible:ring-[var(--hivra-red)]">
          All agents and computers
        </a>

        <div className="flex shrink-0 items-center gap-1 border-t border-[var(--etched-border)]">
          <a
            href="/dashboard/launch"
            className="mono flex min-h-[40px] min-w-0 flex-1 items-center gap-2 px-2.5 text-[12px] font-semibold text-[var(--text-muted)] outline-none hover:text-[var(--ink-black)] focus-visible:ring-2 focus-visible:ring-[var(--hivra-red)] focus-visible:ring-offset-2"
          >
            <Plus aria-hidden="true" size={14} />
            Launch a runtime
          </a>
          {/* The test guide used to be an unlabelled book glyph in the header.
              It is a contributor-facing panel, not a per-task tool, so it is
              written out and kept in the menu's footer rather than the bar. */}
          {onOpenTestGuide && <button
            type="button"
            onClick={onOpenTestGuide}
            className="mono flex min-h-[40px] shrink-0 items-center gap-1.5 px-2.5 text-[12px] font-semibold text-[var(--text-muted)] outline-none hover:text-[var(--ink-black)] focus-visible:ring-2 focus-visible:ring-[var(--hivra-red)] focus-visible:ring-offset-2"
          >
            <BookOpenCheck aria-hidden="true" size={13} />
            Test guide
          </button>}
        </div>
      </div>
    </SafePortal>
  );
}

function SourceFailure({
  source,
  onRetry,
}: {
  source: "Hermes" | "Hivra";
  onRetry: () => void;
}) {
  return (
    <div className="shrink-0 border-b border-[var(--etched-border)] px-2.5 py-2">
      <p className="text-[11.5px] leading-[1.4] text-[var(--yellow)]">
        {source} agents are unavailable. Your other agents are still listed.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mono mt-1 inline-flex min-h-[32px] items-center gap-1.5 text-[11.5px] font-semibold text-[var(--yellow)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--hivra-red)] focus-visible:ring-offset-2"
      >
        <RotateCcw aria-hidden="true" size={13} />
        Retry {source}
      </button>
    </div>
  );
}

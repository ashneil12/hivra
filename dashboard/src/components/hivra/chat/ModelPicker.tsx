"use client";

// Adapted from MonoCode (MIT License, Copyright (c) 2026 Nick); see THIRD_PARTY_LICENSES/monocode.txt.
//
// MonoCode's model picker, for one computer's agent. The trigger pill names the
// model and its effort. Its menu lists the model's settings (Effort first) and
// a Model row; each opens a submenu to the right, the effort levels with
// MonoCode's tile shimmer on the strongest ones, and the models in a flyout
// with a provider rail (Favorites and the agent), a search field and favourite
// stars. Right-click (or Mod+. with `hotkeys`) opens the recently used models.
// With `controlsBeside` the settings leave the menu and sit beside the trigger
// as their own pills (ModelControlPills), and the trigger opens the models.
//
// What MonoCode has and this leaves out, because a Hivra computer has no use
// for it: the other agent providers and their availability probes, custom
// local model providers ("Other models", Add model), the Grok bridge, project
// provider filtering, older-version folding, per-model fast and toggle
// settings, and the details-panel and text variants. Effort levels are always
// listed for an agent that has them; one a computer does not take yet (its
// connection service predates `chatEffort`) says so in the menu, with an
// Update now button.

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Check, ChevronDown, ChevronRight, Gauge, Search, Sparkles, Star, Terminal } from "lucide-react";
import { ThinkingOrb } from "@/components/ui/ThinkingOrb";
import { cliTitle, effortLabel, isEffortLevel, type BoxModelOption, type EffortLevel } from "@/lib/hivra/agent-models";
import { Popover, type PopoverAnchor } from "./Popover";
import {
  buildModelSource,
  effortSetting,
  effortSettingOf,
  loadFavoriteModels,
  loadRecentModels,
  modelKey,
  saveFavoriteModels,
  saveRecentModel,
  type ChatModel,
  type ModelSetting,
} from "./modelSource";
import type { EffortUpdateState } from "./useBoxChatControls";
import chat from "./chat.module.css";
import styles from "./ModelPicker.module.css";

const MENU_WIDTH = 250;
const MODEL_MENU_WIDTH = 310;
const MODEL_MENU_HEIGHT = 268;
const SETTING_MENU_WIDTH = 210;
const SUBMENU_OVERLAP = -4;
const SUBMENU_LAYER = 91;
/** A press inside any picker surface is not an outside press for the others. */
const SELF = "[data-model-picker]";

export type EffortUpdate = { state: EffortUpdateState; message: string | null; available: boolean };
const NO_UPDATE: EffortUpdate = { state: "idle", message: null, available: false };

type EffortProps = {
  /** The levels to list; empty for an agent with no effort. */
  effortLevels: readonly EffortLevel[];
  /** The level picked, or null for the agent's own default. */
  effort: EffortLevel | null;
  onEffortChange: (level: EffortLevel | null) => void;
  /** The computer takes effort. False: it needs an update, said in the menu when a level is picked. */
  effortReady?: boolean;
  effortUpdate?: EffortUpdate;
  onEffortUpdate?: () => void;
};

export interface ModelPickerProps extends EffortProps {
  /** The agent's CLI ("claude", "codex"): names its tab and scopes favourites. */
  cliKind: string;
  /** What the pill says when the model is not in the list (a custom id) or is the CLI default. */
  modelName: string;
  /** The current model id, "" for the CLI's default. */
  model: string;
  /** The models Settings offers for this CLI. Empty: the model cannot be changed from the chat. */
  models: readonly BoxModelOption[];
  onModelChange: (value: string) => void;
  /** A change is being applied. */
  pending?: boolean;
  /** A turn is running: a change applies from the next one. */
  busy?: boolean;
  /** Settings leave the menu and sit beside the picker (ModelControlPills); the trigger opens the models. */
  controlsBeside?: boolean;
  /** Mod+. opens the recently used models while focus is in the same composer. */
  hotkeys?: boolean;
  /** Which way the menus open; the composer sits low, so they open up. */
  side?: "top" | "bottom";
  onClose?: () => void;
}

type MenuEntry = { kind: "setting"; setting: ModelSetting } | { kind: "model" };
type Submenu = { kind: "setting"; setting: ModelSetting } | { kind: "models" };
type Tab = "favorites" | "agent";

// ---- effort tiles ------------------------------------------------------------

/** The strongest levels light up when hovered or highlighted. */
function effortTileTone(setting: ModelSetting, value: string): "strong" | "max" | undefined {
  if (setting.id !== "effort") return undefined;
  return value === "max" ? "max" : value === "xhigh" ? "strong" : undefined;
}

const EFFORT_TILE_COLUMNS = 32;
const EFFORT_TILE_ROWS = 5;

function EffortTileShimmer() {
  return (
    <span className={styles.effortTiles} aria-hidden="true">
      {Array.from({ length: EFFORT_TILE_COLUMNS * EFFORT_TILE_ROWS }, (_, index) => {
        const column = index % EFFORT_TILE_COLUMNS;
        const row = Math.floor(index / EFFORT_TILE_COLUMNS);
        const centerColumn = (EFFORT_TILE_COLUMNS - 1) / 2;
        const centerRow = (EFFORT_TILE_ROWS - 1) / 2;
        const distance = Math.hypot((column - centerColumn) / centerColumn, (row - centerRow) / centerRow);
        const filled = (index * 73 + index * index * 19 + 23) % 101 < 65;
        return <span key={index} className={`${styles.effortTile} ${filled ? styles.effortTileFilled : ""}`} style={{ "--tile-distance": distance } as CSSProperties} />;
      })}
    </span>
  );
}

// ---- helpers -----------------------------------------------------------------

function settingValueLabel(setting: ModelSetting): string {
  return setting.options.find((option) => option.value === setting.value)?.label ?? setting.value;
}

/** The effort pill's wording: the level, or nothing for the agent's own default. */
function effortText(effort: EffortLevel | null): string | null {
  return effort ? effortLabel(effort) : null;
}

/** The level a row's value stands for: "" is the agent's own default. */
function levelOf(value: string): EffortLevel | null {
  return isEffortLevel(value) ? value : null;
}

/** The effort pick, shared by the menu and the beside pill: what it tells the computer and whether the note shows. */
function useEffortPick({ effortReady = true, effortUpdate = NO_UPDATE, onEffortChange }: Pick<EffortProps, "effortReady" | "effortUpdate" | "onEffortChange">) {
  const [noteOpen, setNoteOpen] = useState(false);
  /** True when the menu should close: the level was taken, or held quietly until the computer answers. */
  const pick = (value: string): boolean => {
    const level = levelOf(value);
    onEffortChange(level);
    if (effortReady || level === null || effortUpdate.state === "checking") return true;
    setNoteOpen(true);
    return false;
  };
  return { noteOpen, pick, closeNote: () => setNoteOpen(false) };
}

/**
 * What a computer without effort says when a level is picked: it needs a quick
 * update, with the button that starts it, then its progress and outcome.
 */
function EffortUpdateNote({ effortReady, update, noteOpen, onUpdate, autoFocus = false }: { effortReady: boolean; update: EffortUpdate; noteOpen: boolean; onUpdate?: () => void; autoFocus?: boolean }) {
  const button = useRef<HTMLButtonElement>(null);
  const shown = update.state === "ready" || (!effortReady && update.state !== "checking" && (noteOpen || update.state === "updating" || update.state === "failed"));
  useEffect(() => {
    if (shown && autoFocus && update.state === "idle") button.current?.focus({ preventScroll: true });
  }, [shown, autoFocus, update.state]);
  if (!shown) return null;
  const canUpdate = update.available && Boolean(onUpdate);
  return (
    <div className={styles.note} role="status" aria-live="polite" data-effort-note data-effort-update-state={update.state}>
      {update.state === "updating" ? (
        <p className={styles.noteText}>
          <span className={styles.noteOrb} aria-hidden="true"><ThinkingOrb size={16} state="working" /></span>
          Updating this computer. Effort levels turn on as soon as it is back.
        </p>
      ) : update.state === "ready" ? (
        <p className={styles.noteText}>Effort levels are on for this computer.</p>
      ) : (
        <>
          <p className={styles.noteText}>
            {update.state === "failed" && update.message
              ? update.message
              : canUpdate
                ? "This computer needs a quick update to use effort levels."
                : "This computer needs a quick update to use effort levels. Open Manage and choose Update connection service."}
          </p>
          {canUpdate ? (
            <button ref={button} type="button" data-effort-update onMouseDown={(event) => event.preventDefault()} onClick={onUpdate} className={styles.noteButton}>
              {update.state === "failed" ? "Try again" : "Update now"}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

function CliIcon({ cliKind, size = 14 }: { cliKind: string; size?: number }) {
  return cliKind === "codex" ? <Terminal size={size} strokeWidth={1.75} aria-hidden /> : <Sparkles size={size} strokeWidth={1.75} aria-hidden />;
}

/** The model after `currentId` in `models`, wrapping to the first. */
export function nextModel<T extends { id: string }>(models: readonly T[], currentId: string): T | undefined {
  if (!models.length) return undefined;
  const at = models.findIndex((item) => item.id === currentId);
  return models[(at + 1 + models.length) % models.length];
}

// ---- the picker --------------------------------------------------------------

export function ModelPicker({
  cliKind,
  modelName,
  model,
  models,
  onModelChange,
  effortLevels,
  effort,
  onEffortChange,
  effortReady = true,
  effortUpdate = NO_UPDATE,
  onEffortUpdate,
  pending = false,
  busy = false,
  controlsBeside = false,
  hotkeys = false,
  side = "top",
  onClose,
}: ModelPickerProps) {
  const title = cliTitle(cliKind);
  const hasModels = models.length > 0;
  const setting = useMemo(() => effortSetting(effortLevels, effort), [effortLevels, effort]);
  const source = useMemo(() => buildModelSource(models, setting, modelName), [models, setting, modelName]);
  const current = source.resolve(model);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("agent");
  const [active, setActive] = useState(0);
  const [activeModel, setActiveModel] = useState(0);
  const [activeSetting, setActiveSetting] = useState(0);
  const [recentMenu, setRecentMenu] = useState<{ models: ChatModel[] } | null>(null);
  const [recentActive, setRecentActive] = useState(0);
  const [submenu, setSubmenu] = useState<Submenu | null>(null);
  const [activeRow, setActiveRow] = useState<HTMLButtonElement | null>(null);
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState<string[]>([]);
  const recentMenuId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  const openRef = useRef(open);
  const recentOpenRef = useRef(false);
  const lastHotkey = useRef(0);
  const { noteOpen, pick: pickEffort, closeNote } = useEffortPick({ effortReady, effortUpdate, onEffortChange });
  useEffect(() => {
    onCloseRef.current = onClose;
    openRef.current = open;
    recentOpenRef.current = recentMenu != null;
  });

  const settings = useMemo(() => (controlsBeside ? [] : current.settings), [controlsBeside, current]);
  const entries = useMemo<MenuEntry[]>(
    () => [...settings.map((item) => ({ kind: "setting" as const, setting: item })), ...(hasModels ? [{ kind: "model" as const }] : [])],
    [settings, hasModels],
  );
  const triggerEffort = controlsBeside ? undefined : effortSettingOf(current);
  const triggerEffortText = triggerEffort ? effortText(effort) : null;

  const modelKeyOf = (id: string) => modelKey(cliKind, id);
  const visibleModels = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const pool: ChatModel[] =
      tab === "favorites"
        ? favorites.map((key) => source.models.find((item) => modelKey(cliKind, item.id) === key)).filter((item): item is ChatModel => item != null)
        : // A model id Settings holds that the list does not (a custom id typed there) is shown too, so it can be seen as the current one.
          source.find(model) ? [...source.models] : [...source.models, current];
    return needle ? pool.filter((item) => `${item.name} ${title}`.toLowerCase().includes(needle)) : pool;
    // The list is rebuilt when what it is made from changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, favorites, query, tab, model, cliKind, title]);

  const dismiss = (restore: boolean) => {
    setOpen(false);
    setRecentMenu(null);
    setSubmenu(null);
    closeNote();
    if (restore) onCloseRef.current?.();
  };
  const togglePicker = () => {
    if (openRef.current) dismiss(true);
    else {
      setRecentMenu(null);
      setOpen(true);
    }
  };

  const openRecentMenu = () => {
    if (!hasModels) return;
    const remembered = loadRecentModels()
      .flatMap((key) => {
        const item = source.models.find((candidate) => modelKey(cliKind, candidate.id) === key);
        return item ? [item] : [];
      });
    const list = remembered.some((item) => item.id === current.id) ? remembered : [...remembered, current].slice(0, 6);
    const selectedIndex = list.findIndex((item) => item.id === current.id);
    setOpen(false);
    setSubmenu(null);
    setRecentActive(selectedIndex >= 0 ? selectedIndex : 0);
    setRecentMenu({ models: list });
  };
  const toggleRecentMenu = () => {
    if (recentOpenRef.current) {
      setRecentMenu(null);
      onCloseRef.current?.();
    } else {
      openRecentMenu();
    }
  };

  // Opening starts on the agent's tab, with a fresh search and the stars as last saved.
  useEffect(() => {
    if (!open) return;
    setTab("agent");
    setActive(0);
    // Beside the picker only the models are left: open their list directly instead of one more hover step.
    setSubmenu(controlsBeside ? { kind: "models" } : null);
    setQuery("");
    setFavorites(loadFavoriteModels());
  }, [open, controlsBeside]);

  useEffect(() => {
    if (!open) return;
    setActive((index) => Math.min(index, Math.max(0, entries.length - 1)));
  }, [entries.length, open]);

  useEffect(() => {
    if (!open || submenu?.kind !== "models") return;
    const index = visibleModels.findIndex((item) => item.id === current.id);
    setActiveModel(index >= 0 ? index : 0);
  }, [open, submenu?.kind, query, visibleModels, current.id]);

  useEffect(() => {
    if (submenu?.kind !== "setting") return;
    const index = submenu.setting.options.findIndex((option) => option.value === submenu.setting.value);
    setActiveSetting(index >= 0 ? index : 0);
  }, [submenu]);

  // Mod+. toggles the recent models, but only from the composer the picker is in, so several chats on a page do not all open.
  useEffect(() => {
    if (!hotkeys) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const mod = event.metaKey || event.ctrlKey;
      if (!mod || event.altKey || event.shiftKey || !(event.key === "." || event.code === "Period")) return;
      const scope = button.current?.closest("form") ?? button.current?.parentElement;
      const target = event.target instanceof Node ? event.target : null;
      const inMenu = target instanceof Element && target.closest(SELF);
      if (!openRef.current && !recentOpenRef.current && !(scope && target && scope.contains(target))) return;
      if (!openRef.current && !recentOpenRef.current && inMenu) return;
      event.preventDefault();
      event.stopPropagation();
      const now = performance.now();
      if (now - lastHotkey.current < 80) return;
      lastHotkey.current = now;
      toggleRecentMenu();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // toggleRecentMenu reads current values through refs and the model list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hotkeys, source, model, hasModels]);

  const pickModel = (item: ChatModel) => {
    saveRecentModel(modelKeyOf(item.id));
    if (item.id !== model) onModelChange(item.id);
    dismiss(true);
  };

  const pickSetting = (item: ModelSetting, value: string) => {
    if (item.id !== "effort") return;
    if (value === item.value || pickEffort(value)) dismiss(true);
  };

  useEffect(() => {
    if (!recentMenu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setRecentActive((index) => (index + direction + recentMenu.models.length) % recentMenu.models.length);
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      const item = recentMenu.models[recentActive];
      if (item) pickModel(item);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // pickModel only reads what the menu is already keyed on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentActive, recentMenu]);

  const toggleFavorite = (id: string) => {
    const key = modelKeyOf(id);
    setFavorites((previous) => {
      const next = previous.includes(key) ? previous.filter((item) => item !== key) : [...previous, key];
      saveFavoriteModels(next);
      return next;
    });
  };
  const selectTab = (next: Tab) => {
    setTab(next);
    setQuery("");
    setActiveModel(0);
  };

  const showEntrySubmenu = (entry: MenuEntry) => setSubmenu(entry.kind === "model" ? { kind: "models" } : { kind: "setting", setting: entry.setting });
  const moveEntry = (direction: 1 | -1) => {
    setSubmenu(null);
    setActive((index) => (index + direction + entries.length) % entries.length);
  };

  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement) return;
    // The update note's button keeps its own keys.
    if (event.target instanceof Element && event.target.closest("[data-effort-note]")) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (submenu?.kind === "models") setActiveModel((index) => Math.min(visibleModels.length - 1, index + 1));
      else if (submenu?.kind === "setting") setActiveSetting((index) => Math.min(submenu.setting.options.length - 1, index + 1));
      else moveEntry(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (submenu?.kind === "models") setActiveModel((index) => Math.max(0, index - 1));
      else if (submenu?.kind === "setting") setActiveSetting((index) => Math.max(0, index - 1));
      else moveEntry(-1);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      const entry = entries[active];
      if (entry) showEntrySubmenu(entry);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setSubmenu(null);
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (submenu?.kind === "models") {
      const item = visibleModels[activeModel];
      if (item) pickModel(item);
      return;
    }
    if (submenu?.kind === "setting") {
      const option = submenu.setting.options[activeSetting];
      if (option) pickSetting(submenu.setting, option.value);
      return;
    }
    const entry = entries[active];
    if (entry) showEntrySubmenu(entry);
  };

  const showSubmenu = open && submenu != null && activeRow != null && activeRow.dataset.modelControlIndex === String(active);

  // Nothing to choose: the pill just names the model.
  if (!hasModels && effortLevels.length === 0) {
    return <span className={chat.modelStatic} title="The model this agent is currently running">{modelName}</span>;
  }
  // Beside the picker with the model fixed: the name, and the effort pill beside it.
  if (!hasModels && controlsBeside) {
    return <span className={chat.modelStatic} title="The model this agent is currently running">{modelName}</span>;
  }

  const triggerTitle = [title, current.name, triggerEffort ? `Effort: ${effortText(effort) ?? "Default"}` : null, busy ? "Changes apply to the next message." : null].filter(Boolean).join(" · ");
  const flyout = (anchor: PopoverAnchor, flyoutSide: "right" | "top" | "bottom", onDismiss?: (reason: "outside" | "escape") => void) => (
    <ModelFlyout
      anchor={anchor}
      side={flyoutSide}
      onDismiss={onDismiss}
      cliKind={cliKind}
      tab={tab}
      models={visibleModels}
      currentId={current.id}
      active={activeModel}
      query={query}
      favorites={favorites}
      searchRef={search}
      onQuery={setQuery}
      onSelectTab={selectTab}
      onActive={setActiveModel}
      onPick={pickModel}
      onToggleFavorite={toggleFavorite}
    />
  );

  return (
    <>
      <button
        ref={button}
        type="button"
        data-model-picker-trigger
        title={`${triggerTitle}${hasModels ? " · Recent models: right-click" : ""}`}
        aria-label={`Model: ${current.name}${triggerEffortText ? `, ${triggerEffortText} effort` : ""}`}
        aria-haspopup={controlsBeside ? "dialog" : "menu"}
        aria-expanded={open || recentMenu != null}
        disabled={pending}
        onMouseDown={(event) => event.preventDefault()}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          openRecentMenu();
        }}
        onClick={() => togglePicker()}
        className={`${chat.pill} ${open ? chat.pillOpen : ""}`}
      >
        <CliIcon cliKind={cliKind} />
        <span className={chat.pillLabel}>{current.name}</span>
        {triggerEffortText ? (
          <span className={chat.pillEffort}>{triggerEffortText}</span>
        ) : triggerEffort ? (
          <Gauge size={13} strokeWidth={1.75} aria-hidden className={chat.pillEffort} data-pill-effort-default />
        ) : null}
        <ChevronDown size={12} strokeWidth={1.75} aria-hidden className={`${chat.pillChevron} ${open ? chat.pillChevronOpen : ""}`} />
      </button>

      {open && controlsBeside ? flyout(button, side, (reason) => dismiss(reason === "escape")) : null}

      {open && !controlsBeside ? (
        <>
          <Popover
            anchor={button}
            side={side}
            width={MENU_WIDTH}
            autoFocus
            ignore={SELF}
            onDismiss={(reason) => dismiss(reason === "escape")}
            role="menu"
            aria-label="Model and effort"
            tabIndex={-1}
            onKeyDown={onMenuKey}
            data-model-picker
            className={styles.menu}
          >
            {entries.map((entry, index) => {
              const highlighted = index === active;
              const isModel = entry.kind === "model";
              return (
                <button
                  key={isModel ? "model" : entry.setting.id}
                  ref={highlighted ? setActiveRow : undefined}
                  data-model-control-index={index}
                  type="button"
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={highlighted && showSubmenu}
                  title={isModel ? undefined : entry.setting.description}
                  data-active={highlighted || undefined}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => {
                    setActive(index);
                    showEntrySubmenu(entry);
                  }}
                  onClick={() => showEntrySubmenu(entry)}
                  className={`${styles.row} ${highlighted ? styles.rowOn : ""}`}
                >
                  <span className={styles.rowLabel}>{isModel ? "Model" : entry.setting.label}</span>
                  <span className={styles.rowValue}>
                    {isModel ? (
                      <>
                        <CliIcon cliKind={cliKind} />
                        <span className={styles.truncate}>{current.name}</span>
                      </>
                    ) : (
                      settingValueLabel(entry.setting)
                    )}
                  </span>
                  <ChevronRight size={14} strokeWidth={1.75} aria-hidden className={styles.rowChevron} />
                </button>
              );
            })}
            <EffortUpdateNote effortReady={effortReady} update={effortUpdate} noteOpen={noteOpen} onUpdate={onEffortUpdate} autoFocus />
            {busy ? <p className={styles.footNote}>Changes apply to the next message.</p> : null}
          </Popover>

          {showSubmenu && submenu.kind === "setting" ? (
            <Popover
              key={submenu.setting.id}
              anchor={activeRow}
              side="right"
              gap={SUBMENU_OVERLAP}
              width={SETTING_MENU_WIDTH}
              layer={SUBMENU_LAYER}
              role="menu"
              aria-label={submenu.setting.label}
              onMouseEnter={() => setSubmenu(submenu)}
              data-model-picker
              className={styles.menu}
            >
              {submenu.setting.options.map((option, index) => {
                const selected = option.value === submenu.setting.value;
                const tileTone = effortTileTone(submenu.setting, option.value);
                return (
                  <button
                    key={option.value || "default"}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    title={option.description}
                    data-active={index === activeSetting || undefined}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActiveSetting(index)}
                    onClick={() => pickSetting(submenu.setting, option.value)}
                    className={`${styles.option} ${index === activeSetting ? styles.rowOn : ""} ${tileTone ? styles.effortOption : ""} ${tileTone && index === activeSetting ? styles.effortActive : ""}`}
                    data-effort-tone={tileTone}
                  >
                    {tileTone ? <EffortTileShimmer /> : null}
                    <span className={`${styles.rowLabel} ${styles.truncate}`}>{option.label}</span>
                    {selected ? <Check size={14} strokeWidth={2} aria-hidden className={styles.check} /> : null}
                  </button>
                );
              })}
            </Popover>
          ) : null}

          {showSubmenu && submenu.kind === "models" ? flyout(activeRow, "right") : null}
        </>
      ) : null}

      {recentMenu ? (
        <Popover
          anchor={button}
          side={side}
          width={MENU_WIDTH}
          autoFocus
          ignore={SELF}
          onDismiss={() => setRecentMenu(null)}
          role="menu"
          aria-label="Recently used models"
          aria-activedescendant={`${recentMenuId}-${recentActive}`}
          tabIndex={-1}
          onContextMenu={(event) => event.preventDefault()}
          data-model-picker
          className={styles.menu}
        >
          {recentMenu.models.map((item, index) => {
            const selected = item.id === current.id;
            return (
              <button
                key={item.id || "default"}
                id={`${recentMenuId}-${index}`}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setRecentActive(index)}
                onClick={() => pickModel(item)}
                className={`${styles.recent} ${index === recentActive ? styles.rowOn : ""}`}
              >
                <CliIcon cliKind={cliKind} size={16} />
                <span className={styles.recentText}>
                  <span className={`${styles.recentName} ${styles.truncate}`}>{item.name}</span>
                  <span className={`${styles.recentSub} ${styles.truncate}`}>{title}</span>
                </span>
                {selected ? <Check size={14} strokeWidth={2} aria-hidden className={styles.check} /> : null}
              </button>
            );
          })}
        </Popover>
      ) : null}
    </>
  );
}

/**
 * The model's settings as pills beside the picker (MonoCode's "beside" layout):
 * the effort level, which opens a small menu of the levels.
 */
export function ModelControlPills({ effortLevels, effort, onEffortChange, effortReady = true, effortUpdate, onEffortUpdate, side = "top", pending = false, onClose }: EffortProps & { side?: "top" | "bottom"; pending?: boolean; onClose?: () => void }) {
  const setting = useMemo(() => effortSetting(effortLevels, effort), [effortLevels, effort]);
  if (!setting) return null;
  return <EffortSelectPill setting={setting} effort={effort} onEffortChange={onEffortChange} effortReady={effortReady} effortUpdate={effortUpdate} onEffortUpdate={onEffortUpdate} side={side} pending={pending} onClose={onClose} />;
}

function EffortSelectPill({ setting, effort, onEffortChange, effortReady = true, effortUpdate = NO_UPDATE, onEffortUpdate, side = "top", pending = false, onClose }: Pick<EffortProps, "effort" | "onEffortChange" | "effortReady" | "effortUpdate" | "onEffortUpdate"> & { setting: ModelSetting; side?: "top" | "bottom"; pending?: boolean; onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const { noteOpen, pick, closeNote } = useEffortPick({ effortReady, effortUpdate, onEffortChange });
  const valueLabel = settingValueLabel(setting);
  const label = `${setting.label}: ${valueLabel}`;

  const dismiss = (restoreFocus: boolean) => {
    setOpen(false);
    closeNote();
    if (restoreFocus) onClose?.();
  };
  const openPicker = () => {
    const selected = setting.options.findIndex((option) => option.value === setting.value);
    setActive(selected >= 0 ? selected : 0);
    setOpen(true);
  };
  const choose = (value: string) => {
    if (value === setting.value || pick(value)) dismiss(true);
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        title={label}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="menu"
        data-model-control
        disabled={pending}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => (open ? dismiss(true) : openPicker())}
        className={`${chat.pill} ${open ? chat.pillOpen : ""}`}
      >
        <Gauge size={14} strokeWidth={1.75} aria-hidden />
        <span className={chat.pillLabel}>{valueLabel}</span>
        <ChevronDown size={12} strokeWidth={1.75} aria-hidden className={`${chat.pillChevron} ${open ? chat.pillChevronOpen : ""}`} />
      </button>
      {open ? (
        <Popover
          anchor={button}
          side={side}
          width={SETTING_MENU_WIDTH}
          autoFocus
          ignore={SELF}
          onDismiss={(reason) => dismiss(reason === "escape")}
          role="menu"
          aria-label={setting.label}
          aria-activedescendant={`${menuId}-${active}`}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.target instanceof Element && event.target.closest("[data-effort-note]")) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const direction = event.key === "ArrowDown" ? 1 : -1;
              setActive((index) => (index + direction + setting.options.length) % setting.options.length);
              return;
            }
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            const option = setting.options[active];
            if (option) choose(option.value);
          }}
          data-model-control
          data-model-picker
          className={styles.menu}
        >
          {setting.options.map((option, index) => {
            const selected = option.value === (effort ?? "");
            const tileTone = effortTileTone(setting, option.value);
            return (
              <button
                key={option.value || "default"}
                id={`${menuId}-${index}`}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                title={option.description}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(option.value)}
                className={`${styles.option} ${index === active ? styles.rowOn : ""} ${tileTone ? styles.effortOption : ""} ${tileTone && index === active ? styles.effortActive : ""}`}
                data-effort-tone={tileTone}
              >
                {tileTone ? <EffortTileShimmer /> : null}
                <span className={`${styles.rowLabel} ${styles.truncate}`}>{option.label}</span>
                {selected ? <Check size={14} strokeWidth={2} aria-hidden className={styles.check} /> : null}
              </button>
            );
          })}
          <EffortUpdateNote effortReady={effortReady} update={effortUpdate} noteOpen={noteOpen} onUpdate={onEffortUpdate} autoFocus />
        </Popover>
      ) : null}
    </>
  );
}

// ---- the model flyout --------------------------------------------------------

function ModelFlyout({
  anchor,
  side,
  onDismiss,
  cliKind,
  tab,
  models,
  currentId,
  active,
  query,
  favorites,
  searchRef,
  onQuery,
  onSelectTab,
  onActive,
  onPick,
  onToggleFavorite,
}: {
  anchor: PopoverAnchor;
  side: "right" | "top" | "bottom";
  onDismiss?: (reason: "outside" | "escape") => void;
  cliKind: string;
  tab: Tab;
  models: ChatModel[];
  currentId: string;
  active: number;
  query: string;
  favorites: string[];
  searchRef: RefObject<HTMLInputElement | null>;
  onQuery: (query: string) => void;
  onSelectTab: (tab: Tab) => void;
  onActive: (index: number) => void;
  onPick: (model: ChatModel) => void;
  onToggleFavorite: (id: string) => void;
}) {
  const activeRef = useRef<HTMLButtonElement>(null);
  const title = cliTitle(cliKind);

  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  // The popover frame starts hidden until its layout effect measures the
  // anchor, and browsers drop focus() on a hidden element, so focus the
  // search field once the flyout is on screen.
  useEffect(() => {
    const frame = requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [searchRef]);

  const onSearchKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      onActive(Math.min(models.length - 1, active + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      onActive(Math.max(0, active - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const item = models[active];
      if (item) onPick(item);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.stopPropagation();
    }
  };

  const row = (item: ChatModel, index: number): ReactNode => {
    const selected = item.id === currentId;
    const highlighted = index === active;
    const favorited = favorites.includes(modelKey(cliKind, item.id));
    return (
      <div key={item.id || "default"} className={`${styles.modelRow} ${highlighted ? styles.rowOn : ""}`} onMouseEnter={() => onActive(index)}>
        <button
          ref={highlighted ? activeRef : undefined}
          type="button"
          role="option"
          aria-selected={selected}
          aria-label={`${item.name}, ${title}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(item)}
          className={styles.modelButton}
        >
          <span className={styles.truncate}>{item.name}</span>
        </button>
        {tab === "favorites" ? <span className={styles.provenance}>{title}</span> : null}
        <button
          type="button"
          title={favorited ? "Remove from favorites" : "Add to favorites"}
          aria-label={favorited ? "Remove from favorites" : "Add to favorites"}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation();
            onToggleFavorite(item.id);
          }}
          className={`${styles.star} ${favorited ? styles.starOn : ""}`}
        >
          <Star size={14} strokeWidth={1.75} fill={favorited ? "currentColor" : "none"} aria-hidden />
        </button>
        {selected ? (
          <span aria-hidden="true" className={styles.starSlot}>
            <Check size={14} strokeWidth={2} className={styles.check} />
          </span>
        ) : null}
      </div>
    );
  };

  return (
    <Popover
      anchor={anchor}
      side={side}
      gap={side === "right" ? SUBMENU_OVERLAP : undefined}
      width={MODEL_MENU_WIDTH}
      minHeight={MODEL_MENU_HEIGHT}
      maxHeight={MODEL_MENU_HEIGHT}
      layer={SUBMENU_LAYER}
      role="dialog"
      aria-label="Models"
      ignore={SELF}
      onDismiss={onDismiss}
      onKeyDown={(event) => {
        // Keyboard nav once focus leaves the search field (which stops its own
        // keys). Scoped to the list so the rail keeps its buttons.
        if (!(event.target instanceof Element) || !event.target.closest('[role="listbox"]')) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          onActive(Math.min(models.length - 1, Math.max(0, active + (event.key === "ArrowDown" ? 1 : -1))));
          return;
        }
        if (event.key !== "Enter") return;
        // Favourite stars keep native activation; model rows activate the highlighted option.
        if (event.target instanceof HTMLButtonElement && event.target.getAttribute("role") !== "option") return;
        event.preventDefault();
        const item = models[active];
        if (item) onPick(item);
      }}
      data-model-picker
      style={{ height: MODEL_MENU_HEIGHT }}
      className={styles.flyout}
    >
      <nav role="tablist" aria-label="Providers" aria-orientation="vertical" className={styles.rail}>
        <ProviderTab title="Favorites" selected={tab === "favorites"} onSelect={() => onSelectTab("favorites")}>
          <Star size={16} strokeWidth={1.75} fill={tab === "favorites" ? "currentColor" : "none"} aria-hidden />
        </ProviderTab>
        <ProviderTab title={title} selected={tab === "agent"} onSelect={() => onSelectTab("agent")}>
          <CliIcon cliKind={cliKind} size={16} />
        </ProviderTab>
      </nav>

      <div className={styles.flyoutMain}>
        <label className={styles.search}>
          <Search size={14} strokeWidth={1.75} aria-hidden className={styles.searchIcon} />
          <input
            ref={searchRef}
            type="text"
            value={query}
            placeholder="Search models"
            aria-label="Search models"
            className={styles.searchInput}
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={onSearchKey}
          />
        </label>
        <div role="listbox" aria-label="Models" className={styles.list}>
          {models.length === 0 ? (
            <div className={styles.empty}>{tab === "favorites" && !query.trim() ? "No favorite models" : "No matching models"}</div>
          ) : (
            models.map((item, index) => row(item, index))
          )}
        </div>
      </div>
    </Popover>
  );
}

function ProviderTab({ title, selected, onSelect, children }: { title: string; selected: boolean; onSelect: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      title={title}
      aria-label={title}
      aria-selected={selected}
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={selected ? undefined : onSelect}
      onClick={onSelect}
      className={`${styles.tab} ${selected ? styles.tabOn : ""}`}
    >
      {children}
    </button>
  );
}

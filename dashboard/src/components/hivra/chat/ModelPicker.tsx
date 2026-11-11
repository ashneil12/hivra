"use client";

// Adapted from MonoCode (MIT License, Copyright (c) 2026 Nick); see THIRD_PARTY_LICENSES/monocode.txt.
//
// MonoCode's model pill: one trigger that names the model (and its effort),
// and a menu with the model list and the effort levels, the stronger levels
// lit with MonoCode's tile shimmer. It replaces the old Think toggle. Models
// are what Settings offers for the agent's CLI and apply from the next turn;
// effort levels are the ones the computer says it takes (`chatEffort`). When
// the model cannot be changed from here the pill still names it, and when the
// computer takes no effort the menu has no effort section.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Check, ChevronDown, Sparkles } from "lucide-react";
import { effortLabel, type BoxModelOption, type EffortLevel } from "@/lib/hivra/agent-models";
import { Popover } from "./Popover";
import styles from "./chat.module.css";

const MENU_WIDTH = 250;
const EFFORT_TILE_COLUMNS = 32;
const EFFORT_TILE_ROWS = 5;

/** The stronger levels light up when picked or hovered. */
function effortTone(level: string): "strong" | "max" | undefined {
  return level === "max" ? "max" : level === "xhigh" ? "strong" : undefined;
}

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

type Entry =
  | { kind: "model"; value: string; label: string }
  | { kind: "effort"; value: EffortLevel | null; label: string };

export interface ModelPickerProps {
  /** What the pill says when the model is not in the list (a custom id) or is the CLI default. */
  modelName: string;
  /** The current model id, "" for the CLI's default. */
  model: string;
  /** The models Settings offers for this CLI. Empty: the model cannot be changed from the chat. */
  models: readonly BoxModelOption[];
  onModelChange: (value: string) => void;
  /** The effort levels the computer takes. Empty: the computer takes no effort. */
  effortLevels: readonly EffortLevel[];
  effort: EffortLevel | null;
  onEffortChange: (level: EffortLevel | null) => void;
  /** A change is being applied. */
  pending?: boolean;
  /** A turn is running: a change applies from the next one. */
  busy?: boolean;
  onClose?: () => void;
}

export function ModelPicker({ modelName, model, models, onModelChange, effortLevels, effort, onEffortChange, pending = false, busy = false, onClose }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const hasModels = models.length > 0;
  const hasEffort = effortLevels.length > 0;

  const entries = useMemo<Entry[]>(() => [
    ...models.map((option) => ({ kind: "model" as const, value: option.value, label: option.label })),
    ...(hasEffort ? [{ kind: "effort" as const, value: null, label: "Default" }, ...effortLevels.map((level) => ({ kind: "effort" as const, value: level, label: effortLabel(level) }))] : []),
  ], [models, hasEffort, effortLevels]);

  const selectedIndex = (entry: Entry) => (entry.kind === "model" ? entry.value === model : entry.value === effort);
  useEffect(() => {
    if (!open) return;
    const at = entries.findIndex(selectedIndex);
    setActive(at >= 0 ? at : 0);
    // Opening is the only moment the highlight follows the selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const dismiss = (restore: boolean) => {
    setOpen(false);
    if (restore) onClose?.();
  };
  const pick = (entry: Entry) => {
    if (entry.kind === "model") {
      if (entry.value !== model) onModelChange(entry.value);
    } else if (entry.value !== effort) {
      onEffortChange(entry.value);
    }
    dismiss(true);
  };
  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(entries.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const entry = entries[active];
      if (entry) pick(entry);
    }
  };

  if (!hasModels && !hasEffort) {
    return <span className={styles.modelStatic} title="The model this agent is currently running">{modelName}</span>;
  }

  const effortText = effort ? effortLabel(effort) : null;
  const title = [modelName, effortText ? `${effortText} effort` : null, busy ? "Changes apply to the next message." : null].filter(Boolean).join(" · ");
  const firstEffort = entries.findIndex((entry) => entry.kind === "effort");

  return (
    <div ref={root} className={styles.pickerRoot}>
      <button
        type="button"
        data-model-picker-trigger
        title={title}
        aria-label={`Model: ${modelName}${effortText ? `, ${effortText} effort` : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={pending}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (open ? dismiss(true) : setOpen(true))}
        className={`${styles.pill} ${open ? styles.pillOpen : ""}`}
      >
        <Sparkles size={14} strokeWidth={1.75} aria-hidden />
        <span className={styles.pillLabel}>{modelName}</span>
        {effortText ? <span className={styles.pillEffort}>{effortText}</span> : null}
        <ChevronDown size={12} strokeWidth={1.75} aria-hidden className={`${styles.pillChevron} ${open ? styles.pillChevronOpen : ""}`} />
      </button>
      {open ? (
        <Popover anchor={root} side="top" width={MENU_WIDTH} autoFocus onDismiss={(reason) => dismiss(reason === "escape")} role="menu" aria-label="Model and effort" data-model-picker tabIndex={-1} onKeyDown={onMenuKey} className={styles.menu}>
          {entries.map((entry, index) => {
            const selected = selectedIndex(entry);
            const tone = entry.kind === "effort" && entry.value ? effortTone(entry.value) : undefined;
            const header = index === 0 ? (hasModels ? "Model" : "Effort") : index === firstEffort && hasModels ? "Effort" : null;
            return (
              <div key={`${entry.kind}:${entry.value ?? "default"}`}>
                {header ? <div className={`${styles.menuHeader} ${index > 0 ? styles.menuHeaderRule : ""}`}>{header}</div> : null}
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  data-effort-tone={tone}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => pick(entry)}
                  className={`${styles.menuItem} ${index === active ? styles.menuItemOn : ""} ${tone ? styles.effortOption : ""} ${tone && index === active ? styles.effortActive : ""}`}
                >
                  {tone ? <EffortTileShimmer /> : null}
                  <span className={styles.menuLabel}>{entry.label}</span>
                  {selected ? <Check size={14} strokeWidth={2} aria-hidden className={styles.menuCheck} /> : null}
                </button>
              </div>
            );
          })}
          {busy ? <p className={styles.menuNote}>Changes apply to the next message.</p> : null}
        </Popover>
      ) : null}
    </div>
  );
}

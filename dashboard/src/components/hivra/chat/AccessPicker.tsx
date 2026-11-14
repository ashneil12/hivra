"use client";

// Adapted from MonoCode (MIT License, Copyright (c) 2026 Nick); see THIRD_PARTY_LICENSES/monocode.txt.
//
// MonoCode's access pill ("Supervised"), wired to the setting Hivra already
// has: the computer's permission preset (GET/POST /api/restrict), the same one
// Settings offers. A pick applies from the agent's next turn.

import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronDown, Lock, Pencil, Shield } from "lucide-react";
import type { BoxRestrict } from "@/lib/hivra/agent-api";
import { Popover } from "./Popover";
import styles from "./chat.module.css";

interface AccessMode {
  value: BoxRestrict;
  label: string;
  hint: (kind: string) => string;
  icon: typeof Lock;
}

export const ACCESS_MODES: readonly AccessMode[] = [
  { value: "readonly", label: "Read-only", hint: () => "Look but don't touch: research and answers only.", icon: Lock },
  { value: "limited", label: "Limited", hint: (kind) => (kind === "codex" ? "Sandboxed to its workspace, no system-wide changes." : "No shell commands; it can still read and edit files."), icon: Pencil },
  { value: "", label: "Full access", hint: () => "Everything: shell, files and the web. The default.", icon: Shield },
];

function modeOf(value: BoxRestrict): AccessMode {
  return ACCESS_MODES.find((mode) => mode.value === value) ?? ACCESS_MODES[2];
}

export function AccessPicker({ value, onChange, busy = false, agentKind, onClose }: {
  value: BoxRestrict;
  onChange: (value: BoxRestrict) => void;
  /** A turn is running: the change applies to the next one. */
  busy?: boolean;
  agentKind: string;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() => Math.max(0, ACCESS_MODES.findIndex((mode) => mode.value === value)));
  const root = useRef<HTMLDivElement>(null);
  const current = modeOf(value);
  const Icon = current.icon;

  const dismiss = (restore: boolean) => {
    setOpen(false);
    if (restore) onClose?.();
  };
  const pick = (mode: AccessMode) => {
    if (mode.value !== value) onChange(mode.value);
    dismiss(true);
  };
  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(ACCESS_MODES.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(ACCESS_MODES[active]);
    }
  };

  return (
    <div ref={root} className={styles.pickerRoot}>
      <button
        type="button"
        data-access-picker-trigger
        title={`${current.hint(agentKind)}${busy ? " Changes apply to the next message." : ""}`}
        aria-label={`Access: ${current.label}`}
        aria-expanded={open}
        aria-haspopup="listbox"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (open) return dismiss(true);
          // Opening is when the highlight follows the current setting.
          setActive(Math.max(0, ACCESS_MODES.findIndex((mode) => mode.value === value)));
          setOpen(true);
        }}
        className={`${styles.pill} ${open ? styles.pillOpen : ""}`}
      >
        <Icon size={14} strokeWidth={1.75} aria-hidden className={value === "" ? styles.pillWarn : undefined} />
        <span className={styles.pillLabel}>{current.label}</span>
        <ChevronDown size={12} strokeWidth={1.75} aria-hidden className={`${styles.pillChevron} ${open ? styles.pillChevronOpen : ""}`} />
      </button>
      {open ? (
        <Popover anchor={root} side="top" width={288} autoFocus onDismiss={(reason) => dismiss(reason === "escape")} role="listbox" aria-label="Access" data-access-picker tabIndex={-1} onKeyDown={onMenuKey} className={styles.menu}>
          {ACCESS_MODES.map((mode, index) => {
            const ModeIcon = mode.icon;
            const selected = mode.value === value;
            return (
              <button
                key={mode.value || "full"}
                type="button"
                role="option"
                aria-selected={selected}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(mode)}
                className={`${styles.menuItem} ${styles.menuItemTall} ${index === active || selected ? styles.menuItemOn : ""}`}
              >
                <ModeIcon size={14} strokeWidth={1.75} aria-hidden className={mode.value === "" ? styles.pillWarn : styles.menuIcon} />
                <span className={styles.menuText}>
                  <span className={styles.menuTitle}>{mode.label}</span>
                  <span className={styles.menuHint}>{mode.hint(agentKind)}</span>
                </span>
              </button>
            );
          })}
          {busy ? <p className={styles.menuNote}>Access changes apply to the next message.</p> : null}
        </Popover>
      ) : null}
    </div>
  );
}

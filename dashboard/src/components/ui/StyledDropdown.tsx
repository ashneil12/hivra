import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { SafePortal } from "@/components/ui/SafePortal";

export interface DropdownOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface StyledDropdownProps {
  value: string;
  onChange: (val: string) => void;
  options: DropdownOption[];
  disabled?: boolean;
  style?: React.CSSProperties;
  placeholder?: string;
  menuMaxHeight?: number | string;
}

const DEFAULT_MENU_MAX_HEIGHT = 320;
const MENU_VIEWPORT_MARGIN = 8;
const MENU_OFFSET = 4;
const MIN_MENU_HEIGHT = 120;
/** Touch devices only get a search row once a list is long enough to need one. */
const TOUCH_SEARCH_MIN_OPTIONS = 9;

function hasFinePointer(): boolean {
  try {
    return window.matchMedia?.("(pointer: fine)").matches ?? false;
  } catch {
    return false;
  }
}

function dedupeOptions(options: DropdownOption[]): DropdownOption[] {
  const seen = new Set<string>();
  return options.filter((option) => {
    const key = String(option.value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveMenuMaxHeight(menuMaxHeight?: number | string): number {
  if (typeof menuMaxHeight === "number" && Number.isFinite(menuMaxHeight)) {
    return menuMaxHeight;
  }

  if (typeof menuMaxHeight === "string") {
    const parsed = Number.parseFloat(menuMaxHeight);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return DEFAULT_MENU_MAX_HEIGHT;
}

export function StyledDropdown({
  value,
  onChange,
  options,
  disabled = false,
  style,
  placeholder = "Select...",
  menuMaxHeight = DEFAULT_MENU_MAX_HEIGHT,
}: StyledDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [finePointer, setFinePointer] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusTimerRef = useRef<number | null>(null);
  const [menuPosition, setMenuPosition] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const resolvedMenuMaxHeight = useMemo(
    () => resolveMenuMaxHeight(menuMaxHeight),
    [menuMaxHeight]
  );

  const closeMenu = useCallback((restoreFocus = false) => {
    setOpen(false);
    setSearchQuery("");
    setMenuPosition(null);

    if (restoreFocus) {
      window.setTimeout(() => {
        buttonRef.current?.focus();
      }, 0);
    }
  }, []);

  const updateMenuPosition = useCallback(() => {
    const trigger = buttonRef.current;
    if (!trigger) {
      return;
    }

    const rect = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    // The visual viewport excludes an open on-screen keyboard; the layout
    // viewport (innerHeight) does not, which put options under the keyboard.
    const visualViewport = window.visualViewport;
    const viewportTop = visualViewport?.offsetTop ?? 0;
    const viewportHeight = visualViewport?.height ?? window.innerHeight;
    const viewportBottom = viewportTop + viewportHeight;
    const viewportMaxHeight = Math.max(
      viewportHeight - MENU_VIEWPORT_MARGIN * 2,
      MIN_MENU_HEIGHT
    );
    const width = Math.min(
      Math.max(rect.width, 160),
      viewportWidth - MENU_VIEWPORT_MARGIN * 2
    );
    const spaceBelow =
      viewportBottom - rect.bottom - MENU_OFFSET - MENU_VIEWPORT_MARGIN;
    const spaceAbove = rect.top - viewportTop - MENU_OFFSET - MENU_VIEWPORT_MARGIN;
    const preferredHeight = Math.min(
      resolvedMenuMaxHeight,
      viewportMaxHeight
    );
    const shouldOpenUpward =
      spaceBelow < Math.min(preferredHeight, 220) && spaceAbove > spaceBelow;
    const availableSpace = shouldOpenUpward ? spaceAbove : spaceBelow;

    let maxHeight = preferredHeight;
    if (availableSpace > 0) {
      maxHeight = Math.min(
        preferredHeight,
        Math.max(
          availableSpace,
          Math.min(MIN_MENU_HEIGHT, viewportMaxHeight)
        )
      );
    }

    let left = rect.left;
    if (left + width > viewportWidth - MENU_VIEWPORT_MARGIN) {
      left = viewportWidth - width - MENU_VIEWPORT_MARGIN;
    }
    left = Math.max(MENU_VIEWPORT_MARGIN, left);

    let top = shouldOpenUpward
      ? rect.top - MENU_OFFSET - maxHeight
      : rect.bottom + MENU_OFFSET;
    top = Math.max(
      viewportTop + MENU_VIEWPORT_MARGIN,
      Math.min(top, viewportBottom - MENU_VIEWPORT_MARGIN - maxHeight)
    );

    setMenuPosition({ top, left, width, maxHeight });
  }, [resolvedMenuMaxHeight]);

  useEffect(() => {
    // pointerdown fires for touch as well as mouse; mousedown is late or
    // missing on touch, so the menu stayed open.
    function handleClickOutside(event: PointerEvent) {
      const target = event.target as Node;
      if (
        (ref.current && ref.current.contains(target)) ||
        (menuRef.current && menuRef.current.contains(target))
      ) {
        return;
      }

      closeMenu();
    }

    document.addEventListener("pointerdown", handleClickOutside);
    return () => document.removeEventListener("pointerdown", handleClickOutside);
  }, [closeMenu]);

  useEffect(() => {
    if (!open) {
      if (focusTimerRef.current !== null) {
        window.clearTimeout(focusTimerRef.current);
        focusTimerRef.current = null;
      }
      return;
    }

    updateMenuPosition();

    // Focus moves into the menu. The search field only takes it with a fine
    // pointer: on touch it raised the keyboard over the list (and zoomed iOS).
    focusTimerRef.current = window.setTimeout(() => {
      const search = finePointer ? inputRef.current : null;
      const target = search
        ?? menuRef.current?.querySelector<HTMLButtonElement>('button[data-selected="true"]:not(:disabled)')
        ?? menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
      target?.focus({ preventScroll: true });
      focusTimerRef.current = null;
    }, 50);

    const handleViewportChange = () => {
      updateMenuPosition();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu(true);
      }
    };

    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    window.visualViewport?.addEventListener("resize", handleViewportChange);
    window.visualViewport?.addEventListener("scroll", handleViewportChange);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      if (focusTimerRef.current !== null) {
        window.clearTimeout(focusTimerRef.current);
        focusTimerRef.current = null;
      }

      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
      window.visualViewport?.removeEventListener("resize", handleViewportChange);
      window.visualViewport?.removeEventListener("scroll", handleViewportChange);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeMenu, finePointer, open, updateMenuPosition]);

  const selectedOption = options.find(
    (o) => String(o.value) === String(value)
  );

  const uniqueOptions = useMemo(() => dedupeOptions(options), [options]);
  const showSearch = finePointer || uniqueOptions.length >= TOUCH_SEARCH_MIN_OPTIONS;

  const filteredOptions = uniqueOptions.filter(
    (o) =>
      o.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
      String(o.value).toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div ref={ref} style={{ position: "relative", width: "100%", ...style }}>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-expanded={open}
        onClick={() => {
          if (open) {
            closeMenu();
            return;
          }

          setSearchQuery("");
          setFinePointer(hasFinePointer());
          updateMenuPosition();
          setOpen(true);
        }}
        style={{
          width: "100%",
          textAlign: "left",
          border: "1px solid var(--etched-border)",
          padding: "12px 40px 12px 14px",
          fontSize: 13,
          fontFamily: "var(--font-mono), monospace",
          background: disabled ? "color-mix(in srgb, var(--ink-black) 2%, var(--bg-surface))" : "var(--bg-surface)",
          outline: "none",
          cursor: disabled ? "not-allowed" : "pointer",
          color: "var(--ink-black)",
          transition: "border-color 0.2s ease",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          opacity: disabled ? 0.6 : 1,
        }}
        onFocus={(e) => (e.currentTarget.style.borderColor = "var(--ink-black)")}
        onBlur={(e) => (e.currentTarget.style.borderColor = "var(--etched-border)")}
      >
        <span
          style={{
            textOverflow: "ellipsis",
            overflow: "hidden",
            whiteSpace: "nowrap",
          }}
        >
          {selectedOption
            ? selectedOption.label
            : value
              ? value
              : placeholder}
        </span>
        <ChevronDown
          size={14}
          style={{
            opacity: 0.5,
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 0.2s ease",
            flexShrink: 0,
          }}
          />
        </button>
      {open && !disabled && menuPosition && (
        <SafePortal>
          <div
            ref={menuRef}
            style={{
              position: "fixed",
              zIndex: 10050,
              top: menuPosition.top,
              left: menuPosition.left,
              width: menuPosition.width,
            }}
          >
            <div
              style={{
                background: "var(--bg-surface)",
                border: "1px solid var(--etched-border)",
                boxShadow: "0 12px 32px rgba(0,0,0,0.16)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  overflowY: "auto",
                  maxHeight: menuPosition.maxHeight,
                }}
              >
                {showSearch && <div
                  style={{
                    padding: "8px 10px",
                    borderBottom: "1px solid var(--etched-border)",
                    position: "sticky",
                    top: 0,
                    background: "var(--bg-surface)",
                    zIndex: 1,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <Search size={14} style={{ opacity: 0.5, flexShrink: 0 }} />
                  <input
                    ref={inputRef}
                    type="search"
                    className="hivra-search-input"
                    enterKeyHint="search"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-label="Search options"
                    placeholder="Search..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    style={{
                      width: "100%",
                      border: "none",
                      background: "transparent",
                      outline: "none",
                      fontSize: 13,
                      fontFamily: "var(--font-mono), monospace",
                      color: "var(--ink-black)",
                    }}
                  />
                </div>}
                {filteredOptions.length === 0 ? (
                  <div
                    style={{
                      padding: "12px 14px",
                      fontSize: 12,
                      opacity: 0.5,
                      textAlign: "center",
                      fontFamily: "var(--font-mono), monospace",
                    }}
                  >
                    No options found.
                  </div>
                ) : (
                  filteredOptions.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      data-selected={String(opt.value) === String(value)}
                      disabled={opt.disabled}
                      onClick={() => {
                        onChange(opt.value);
                        closeMenu();
                      }}
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        padding: "10px 14px",
                        fontSize: 13,
                        fontFamily: "var(--font-mono), monospace",
                        background:
                          String(opt.value) === String(value)
                            ? "var(--bg-elevated)"
                            : "transparent",
                        border: "none",
                        borderLeft:
                          String(opt.value) === String(value)
                            ? "2px solid var(--ink-black)"
                            : "2px solid transparent",
                        cursor: opt.disabled ? "not-allowed" : "pointer",
                        color: opt.disabled
                          ? "var(--border-subtle)"
                          : "var(--ink-black)",
                        opacity: opt.disabled ? 0.5 : 1,
                        transition: "background 0.2s",
                      }}
                      onMouseEnter={(e) => {
                        if (
                          !opt.disabled &&
                          String(opt.value) !== String(value)
                        ) {
                          e.currentTarget.style.background =
                            "color-mix(in srgb, var(--ink-black) 4%, transparent)";
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (
                          String(opt.value) !== String(value) &&
                          !opt.disabled
                        ) {
                          e.currentTarget.style.background = "transparent";
                        }
                      }}
                    >
                      <div
                        style={{
                          fontWeight:
                            String(opt.value) === String(value) ? 700 : 400,
                        }}
                      >
                        {opt.label}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        </SafePortal>
      )}
    </div>
  );
}

"use client";

import React, { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Languages, X } from "lucide-react";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE_NAME,
  MARKETING_COPY,
  SUPPORTED_LOCALES,
  type Locale,
  localeToHtmlLang,
  normalizeLocale,
  resolveAcceptLanguageLocale,
} from "@/lib/i18n";
import { clientLog } from "@/lib/client/logger";

type LocaleContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  copy: (typeof MARKETING_COPY)[Locale];
};

const DEFAULT_CONTEXT: LocaleContextValue = {
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  copy: MARKETING_COPY[DEFAULT_LOCALE],
};

const LocaleContext = createContext<LocaleContextValue>(DEFAULT_CONTEXT);

function readCookieLocale(): Locale | null {
  if (typeof document === "undefined") return null;
  const cookies = document.cookie.split(";").map((item) => item.trim());
  const prefix = `${LOCALE_COOKIE_NAME}=`;
  const match = cookies.find((item) => item.startsWith(prefix));
  if (!match) return null;
  return normalizeLocale(decodeURIComponent(match.slice(prefix.length)));
}

function readStoredLocale(): Locale | null {
  if (typeof window === "undefined") return null;
  try {
    return normalizeLocale(window.localStorage.getItem(LOCALE_COOKIE_NAME));
  } catch {
    return null;
  }
}

function resolveBrowserLocale(): Locale {
  const cookie = readCookieLocale();
  if (cookie) return cookie;

  const stored = readStoredLocale();
  if (stored) return stored;

  if (typeof navigator !== "undefined") {
    const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
    const detected = resolveAcceptLanguageLocale(languages.filter(Boolean).join(","));
    if (detected) return detected;
  }

  return DEFAULT_LOCALE;
}

function persistLocale(locale: Locale) {
  if (typeof document !== "undefined") {
    document.documentElement.lang = localeToHtmlLang(locale);
    document.cookie = `${LOCALE_COOKIE_NAME}=${encodeURIComponent(locale)}; Max-Age=31536000; Path=/; SameSite=Lax`;
  }

  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(LOCALE_COOKIE_NAME, locale);
    } catch (error) {
      clientLog.warn(
        "Failed to persist Hermes locale preference",
        { source: "locale-provider", failureType: "locale_preference_storage_failed", locale },
        error,
      );
    }
  }
}

export function LocaleProvider({
  children,
  initialLocale,
}: {
  children: React.ReactNode;
  initialLocale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(() => initialLocale ?? resolveBrowserLocale());

  useEffect(() => {
    persistLocale(locale);
  }, [locale]);

  const setLocale = useCallback((nextLocale: Locale) => {
    setLocaleState(nextLocale);
  }, []);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      setLocale,
      copy: MARKETING_COPY[locale],
    }),
    [locale, setLocale],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  return useContext(LocaleContext);
}

export function LanguageSwitcher({
  compact = false,
  presentation = "popover",
}: {
  compact?: boolean;
  presentation?: "popover" | "modal";
}) {
  const { locale, setLocale, copy } = useLocale();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const dialogId = useId();
  const selectedLocaleLabel = MARKETING_COPY[locale].localeLabel;
  const isModal = presentation === "modal";

  useEffect(() => {
    if (!isOpen) return;

    const handleDocumentMouseDown = (event: MouseEvent) => {
      if (isModal) return;
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    const handleDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleDocumentMouseDown);
    document.addEventListener("keydown", handleDocumentKeyDown);

    return () => {
      document.removeEventListener("mousedown", handleDocumentMouseDown);
      document.removeEventListener("keydown", handleDocumentKeyDown);
    };
  }, [isModal, isOpen]);

  const chooseLocale = (nextLocale: Locale) => {
    setLocale(nextLocale);
    setIsOpen(false);
  };

  const localeOptions = SUPPORTED_LOCALES.map((localeOption) => {
    const isSelected = localeOption === locale;
    const localeLabel = MARKETING_COPY[localeOption].localeLabel;

    return (
      <button
        key={localeOption}
        type="button"
        role="option"
        aria-selected={isSelected}
        onClick={() => chooseLocale(localeOption)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          minHeight: 36,
          border: 0,
          borderRadius: 6,
          background: isSelected ? "rgba(255,255,255,0.08)" : "transparent",
          color: "inherit",
          padding: "0 10px",
          fontSize: 12,
          fontWeight: 800,
          textTransform: "uppercase",
          letterSpacing: 0,
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <span style={{ width: 16, display: "inline-flex", justifyContent: "center", flexShrink: 0 }}>
          {isSelected && <Check aria-hidden="true" size={15} strokeWidth={3} />}
        </span>
        <span style={{ whiteSpace: "nowrap" }}>{localeLabel}</span>
      </button>
    );
  });

  const modal = isOpen && isModal && typeof document !== "undefined"
    ? createPortal(
        <div
          role="dialog"
          id={dialogId}
          aria-modal="true"
          aria-label={copy.languageSelectorLabel}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 200,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
            background: "rgba(0,0,0,0.42)",
          }}
          onMouseDown={() => setIsOpen(false)}
        >
          <div
            style={{
              width: "min(320px, calc(100vw - 40px))",
              border: "1px solid rgba(255,255,255,0.16)",
              borderRadius: 18,
              background: "rgba(20, 20, 19, 0.94)",
              boxShadow: "0 24px 70px rgba(0,0,0,0.48)",
              backdropFilter: "blur(18px)",
              color: "rgba(255,255,255,0.92)",
              padding: 8,
            }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                minHeight: 34,
                padding: "0 4px 4px 10px",
              }}
            >
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  fontWeight: 800,
                  textTransform: "uppercase",
                  letterSpacing: 0,
                  color: "rgba(255,255,255,0.58)",
                }}
              >
                {copy.languageSelectorLabel}
              </span>
              <button
                type="button"
                aria-label={`Close ${copy.languageSelectorLabel}`}
                onClick={() => setIsOpen(false)}
                style={{
                  width: 30,
                  height: 30,
                  border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: 8,
                  background: "rgba(255,255,255,0.04)",
                  color: "inherit",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                }}
              >
                <X aria-hidden="true" size={15} />
              </button>
            </div>
            <div
              id={listboxId}
              role="listbox"
              aria-label={copy.languageSelectorLabel}
              className="mono"
              style={{
                display: "grid",
                gap: 2,
              }}
            >
              {localeOptions}
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <div
      ref={containerRef}
      title={copy.languageSelectorLabel}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        width: compact ? 32 : undefined,
        height: compact ? 32 : undefined,
        color: "var(--text-secondary)",
      }}
    >
      <button
        type="button"
        aria-label={copy.languageSelectorLabel}
        aria-haspopup={isModal ? "dialog" : "listbox"}
        aria-expanded={isOpen}
        aria-controls={isOpen ? (isModal ? dialogId : listboxId) : undefined}
        className="mono"
        onClick={() => setIsOpen((current) => !current)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: compact ? "center" : "space-between",
          gap: compact ? 0 : 8,
          height: 32,
          minWidth: compact ? 32 : 138,
          width: compact ? 32 : "100%",
          border: "1px solid var(--etched-border)",
          background: compact ? "transparent" : "var(--bg-surface)",
          color: "var(--text-secondary)",
          padding: compact ? 0 : "0 10px",
          fontSize: 10,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: 0,
          cursor: "pointer",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <Languages aria-hidden="true" size={compact ? 16 : 13} style={{ opacity: compact ? 0.45 : 0.7, flexShrink: 0 }} />
          {!compact && (
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {selectedLocaleLabel}
            </span>
          )}
        </span>
        {!compact && <ChevronDown aria-hidden="true" size={13} style={{ opacity: 0.6, flexShrink: 0 }} />}
      </button>

      {modal}

      {isOpen && !isModal && (
        <div
          id={listboxId}
          role="listbox"
          aria-label={copy.languageSelectorLabel}
          className="mono"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            left: compact ? 0 : undefined,
            right: compact ? undefined : 0,
            zIndex: 120,
            minWidth: 176,
            padding: 6,
            border: "1px solid rgba(255,255,255,0.16)",
            borderRadius: 8,
            background: "rgba(20, 20, 19, 0.94)",
            boxShadow: "0 18px 55px rgba(0,0,0,0.42)",
            backdropFilter: "blur(18px)",
            color: "rgba(255,255,255,0.9)",
          }}
        >
          {localeOptions}
        </div>
      )}
    </div>
  );
}

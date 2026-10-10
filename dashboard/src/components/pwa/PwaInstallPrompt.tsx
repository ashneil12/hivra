'use client';

import { AlertTriangle, Download, Share2, X } from "lucide-react";
import { useEffect, useState } from "react";

type InstallMode =
  | "hidden"
  | "prompt"
  | "ios"
  | "mac-safari"
  | "mac-chromium"
  | "manual";

type BeforeInstallPromptEventLike = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

type NavigatorWithStandalone = Navigator & {
  standalone?: boolean;
};

function isStandaloneMode() {
  const navigatorWithStandalone = window.navigator as NavigatorWithStandalone;
  return window.matchMedia("(display-mode: standalone)").matches || Boolean(navigatorWithStandalone.standalone);
}

/** Every iOS browser (Safari, Chrome, Edge, Firefox) installs through Share, then Add to Home Screen. */
function isIosBrowser() {
  const ua = window.navigator.userAgent;
  const isiOS =
    /iPad|iPhone|iPod/i.test(ua) ||
    (/Macintosh/i.test(ua) && /Mobile\//i.test(ua));
  return isiOS && /WebKit/i.test(ua);
}

function isTouchDevice() {
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

/**
 * Browsers that never fire beforeinstallprompt get manual steps after this.
 * Chromium also skips the event once the app is installed, so the copy must not
 * claim that it is missing.
 */
const MANUAL_INSTALL_FALLBACK_MS = 3000;

function macInstallMode(): Extract<InstallMode, "mac-safari" | "mac-chromium"> | null {
  const ua = window.navigator.userAgent;
  if (!/Macintosh|Mac OS X/i.test(ua) || /Mobile\//i.test(ua)) return null;

  const isSafari =
    /Safari/i.test(ua) &&
    !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS/i.test(ua);
  if (isSafari) return "mac-safari";
  return /Chrome|Chromium|Edg|OPR/i.test(ua) ? "mac-chromium" : null;
}

export function PwaInstallPrompt({ expanded = true }: { expanded?: boolean }) {
  // Starts hidden on the server and the client alike; the platform is read after
  // mount so the first client render matches the server HTML.
  const [mode, setMode] = useState<InstallMode>("hidden");
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEventLike | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [installPending, setInstallPending] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  useEffect(() => {
    if (!isStandaloneMode()) {
      const platformMode = isIosBrowser() ? "ios" : macInstallMode();
      // Browser-only platform detection runs once after hydration.
      if (platformMode) setMode((current) => (current === "hidden" ? platformMode : current));
    }

    const handleBeforeInstallPrompt = (event: Event) => {
      if (isStandaloneMode()) return;
      const beforeInstallPromptEvent = event as BeforeInstallPromptEventLike;
      beforeInstallPromptEvent.preventDefault();
      setDeferredPrompt(beforeInstallPromptEvent);
      setMode("prompt");
      setDismissed(false);
      setInstallError(null);
    };

    const handleAppInstalled = () => {
      setDeferredPrompt(null);
      setMode("hidden");
      setDismissed(true);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt as EventListener);
    window.addEventListener("appinstalled", handleAppInstalled);
    const manualFallback = !isStandaloneMode() && isTouchDevice()
      ? window.setTimeout(() => setMode((current) => (current === "hidden" ? "manual" : current)), MANUAL_INSTALL_FALLBACK_MS)
      : undefined;

    return () => {
      window.clearTimeout(manualFallback);
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt as EventListener);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  let content: { title: string; description: string } | null = null;

  if (!dismissed && mode !== "hidden") {
    if (!expanded && (mode === "prompt" || installError)) {
      content = {
        title: "Install Hivra",
        description: installError ?? "Install the workspace as an app.",
      };
    } else if (expanded && mode === "prompt") {
      content = {
        title: "Install Hivra",
        description: "Install the same authenticated Hivra workspace for faster launch and standalone navigation.",
      };
    } else if (expanded && mode === "ios") {
      content = {
        title: "Add Hivra to your Home Screen",
        description: "On iPhone or iPad, tap Share, then Add to Home Screen to launch Hivra like an app.",
      };
    } else if (expanded && mode === "mac-safari") {
      content = {
        title: "Install Hivra",
        description: "On Mac in Safari, open File, choose Add to Dock, then confirm Add.",
      };
    } else if (expanded && mode === "mac-chromium") {
      content = {
        title: "Install Hivra",
        description: "On Mac in Chrome or Edge, open the browser menu and choose Install Hivra or Add to Dock.",
      };
    } else if (mode === "manual") {
      content = {
        title: "Install Hivra",
        description: "If Hivra isn't installed on this device yet, use your browser menu to install it or create a shortcut.",
      };
    }
  }

  if (!content) {
    return null;
  }

  const handleInstall = async () => {
    if (!deferredPrompt || installPending) {
      return;
    }

    setInstallPending(true);
    setInstallError(null);
    try {
      await deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      setDeferredPrompt(null);
      setDismissed(true);
      setMode("hidden");
    } catch {
      setDeferredPrompt(null);
      setMode(isIosBrowser() ? "ios" : macInstallMode() ?? "manual");
      setInstallError(
        "The install prompt is unavailable. Use your browser menu to install Hivra.",
      );
    } finally {
      setInstallPending(false);
    }
  };

  if (!expanded) {
    return (
      <div className="relative">
        <button
          aria-label={installError ? "Install Hivra unavailable" : "Install Hivra"}
          disabled={installPending || !deferredPrompt}
          onClick={() => void handleInstall()}
          className="mx-auto mb-4 flex min-h-[44px] min-w-[44px] items-center justify-center border border-[var(--etched-border)] bg-[var(--bg-surface)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--hivra-red)] focus-visible:ring-offset-2"
          style={{
            cursor: installPending
              ? "wait"
              : deferredPrompt
                ? "pointer"
                : "not-allowed",
            color: installError ? "var(--yellow)" : "var(--ink-black)",
          }}
          title={installError ?? content.title}
        >
          {installError ? (
            <AlertTriangle data-testid="install-prompt-error-icon" size={16} />
          ) : (
            <Download size={16} />
          )}
        </button>
        {installError ? (
          <p role="status" className="sr-only">
            {installError}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mb-6 border border-[var(--etched-border)] bg-[var(--bg-surface)] p-4">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <p
            className="mono"
            style={{
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: 0,
              margin: 0,
              color: "var(--text-muted)",
            }}
          >
            Install app
          </p>
          <h2 className="serif" style={{ fontSize: 20, fontWeight: 600, margin: "4px 0 0" }}>
            {content.title}
          </h2>
        </div>
        <button
          aria-label="Dismiss install prompt"
          onClick={() => setDismissed(true)}
          className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center border border-[var(--etched-border)] text-[var(--text-muted)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--hivra-red)] focus-visible:ring-offset-2"
          style={{
            cursor: "pointer",
          }}
        >
          <X size={14} />
        </button>
      </div>

      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: "var(--text-secondary)" }}>{content.description}</p>

      <div className="mt-4 flex flex-wrap gap-2">
        {mode === "prompt" ? (
          <button
            aria-label="Install Hivra"
            disabled={installPending}
            onClick={() => void handleInstall()}
            className="mono inline-flex min-h-[44px] items-center gap-2 border border-[var(--ink-black)] bg-[var(--ink-black)] px-4 text-[12px] font-semibold text-[var(--bg-surface)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--hivra-red)] focus-visible:ring-offset-2"
            style={{
              cursor: installPending ? "wait" : "pointer",
            }}
          >
            <Download size={14} />
            {installPending ? "Opening install prompt…" : "Install Hivra"}
          </button>
        ) : (
          <div className="mono inline-flex min-h-[44px] items-center gap-2 border border-dashed border-[var(--etched-border)] px-4 text-[12px] font-semibold text-[var(--ink-black)]">
            <Share2 size={14} />
            {mode === "ios"
              ? "Share, then Add to Home Screen"
              : mode === "mac-safari"
                ? "Safari: File, then Add to Dock"
                : mode === "mac-chromium"
                  ? "Chrome or Edge: Install Hivra or Add to Dock"
                  : "Browser menu: Install app or Create shortcut"}
          </div>
        )}
      </div>
      {installError ? (
        <p
          role="status"
          className="mt-4 text-[12px] leading-[1.3] text-[var(--yellow)]"
        >
          {installError}
        </p>
      ) : null}
    </div>
  );
}

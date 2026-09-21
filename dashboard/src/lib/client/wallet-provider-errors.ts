import posthog from "posthog-js";

import { clientLog } from "@/lib/client/logger";
import { toError } from "@/lib/clerk-runtime-errors";

export interface BrowserWalletProvider {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  isConnected?: () => boolean;
  isMetaMask?: boolean;
  isCoinbaseWallet?: boolean;
  isRabby?: boolean;
  isTrust?: boolean;
  on?: (event: "disconnect", handler: (error: unknown) => void) => void;
  removeListener?: (event: "disconnect", handler: (error: unknown) => void) => void;
}

export type WalletProviderConnectionState =
  | { connected: true; reason?: undefined }
  | { connected: false; reason: "provider_disconnected" | "provider_connection_check_failed" };

type WalletRequestContext = {
  source: string;
  route: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readErrorCode(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  if (Object.prototype.hasOwnProperty.call(value, "code")) return value.code;
  return isRecord(value.cause) ? readErrorCode(value.cause) : undefined;
}

function readErrorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (!isRecord(value)) return typeof value === "string" ? value : "";
  if (typeof value.message === "string") return value.message;
  return isRecord(value.cause) ? readErrorMessage(value.cause) : "";
}

export function isWalletProviderDisconnectedError(error: unknown): boolean {
  const code = readErrorCode(error);
  const message = readErrorMessage(error).toLowerCase();

  return (
    code === 4900 ||
    code === "4900" ||
    message.includes("provider is disconnected from all chains") ||
    message.includes("provider disconnected from all chains")
  );
}

export function getWalletProviderConnectionState(
  provider: Pick<BrowserWalletProvider, "isConnected">
): WalletProviderConnectionState {
  if (typeof provider.isConnected !== "function") {
    return { connected: true };
  }

  try {
    return provider.isConnected()
      ? { connected: true }
      : { connected: false, reason: "provider_disconnected" };
  } catch {
    return { connected: false, reason: "provider_connection_check_failed" };
  }
}

export function describeWalletProviderError(error: unknown, fallback: string): string {
  if (isWalletProviderDisconnectedError(error)) {
    return "Wallet disconnected. Please reconnect your wallet to continue.";
  }

  return fallback;
}

function identifyWalletProvider(provider: BrowserWalletProvider): string {
  if (provider.isMetaMask) return "MetaMask";
  if (provider.isCoinbaseWallet) return "Coinbase Wallet";
  if (provider.isRabby) return "Rabby";
  if (provider.isTrust) return "Trust Wallet";
  return "other";
}

async function readWalletChainId(provider: BrowserWalletProvider): Promise<unknown> {
  try {
    return await provider.request({ method: "eth_chainId" });
  } catch {
    return undefined;
  }
}

export async function requestWalletProvider(
  provider: BrowserWalletProvider,
  args: { method: string; params?: unknown[] | Record<string, unknown> },
  context: WalletRequestContext
): Promise<unknown> {
  try {
    return await provider.request(args);
  } catch (err) {
    const error = toError(err, "Wallet provider request failed");
    const chainId = args.method === "eth_chainId" ? undefined : await readWalletChainId(provider);
    const metadata = {
      source: context.source,
      route: context.route,
      failureType: isWalletProviderDisconnectedError(err)
        ? "provider_disconnected"
        : "wallet_provider_request_failed",
      rawErrorCode: readErrorCode(err),
      rawErrorMessage: readErrorMessage(err) || undefined,
      rawErrorMethod: args.method,
      walletProvider: identifyWalletProvider(provider),
      chainId,
    };

    try {
      posthog.captureException(error, metadata);
    } catch {
      // PostHog capture must not mask the wallet failure the UI is handling.
    }

    try {
      clientLog.warn("Wallet provider request failed", metadata, error);
    } catch {
      // Client logging must not mask the wallet failure the UI is handling.
    }

    throw err;
  }
}

/**
 * True when the page has an injected EIP-1193 provider (window.ethereum).
 * In-app browsers (Discord, Instagram, …) and plain mobile browsers with no
 * wallet extension return false — there is nothing to connect to, so a
 * "connect wallet" flow cannot succeed here.
 */
export function hasInjectedWalletProvider(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean((window as unknown as { ethereum?: unknown }).ethereum)
  );
}

/**
 * Best-effort detection of embedded/in-app browsers (e.g. the webview Discord
 * opens links in). These never expose a wallet provider, so the verify/connect
 * flow can't work and the user must reopen the dashboard in a real browser. We
 * match the well-known in-app webview user-agent markers; this is intentionally
 * conservative ("looks like") rather than authoritative.
 */
export function detectInAppBrowser(): { isInApp: boolean; appName: string | null } {
  if (typeof navigator === "undefined") return { isInApp: false, appName: null };
  const ua = navigator.userAgent || "";
  const markers: Array<[RegExp, string]> = [
    [/Discord/i, "Discord"],
    [/FBAN|FBAV|FB_IAB/i, "Facebook"],
    [/Instagram/i, "Instagram"],
    [/\bLine\//i, "LINE"],
    [/Telegram/i, "Telegram"],
    [/Slack/i, "Slack"],
    [/Snapchat/i, "Snapchat"],
    [/; wv\)/i, "an in-app"], // generic Android WebView
  ];
  for (const [pattern, name] of markers) {
    if (pattern.test(ua)) return { isInApp: true, appName: name };
  }
  return { isInApp: false, appName: null };
}

/**
 * The user-facing reason a wallet can't be connected in this environment,
 * tuned for the in-app-browser case (the common one when a link is opened
 * from chat) vs a plain browser with no wallet extension. Always actionable —
 * never a dead-end "nothing happened".
 */
export function describeMissingWalletEnvironment(): string {
  const { isInApp, appName } = detectInAppBrowser();
  if (isInApp) {
    const who = appName === "an in-app" ? "an in-app browser" : `${appName}'s in-app browser`;
    return `This looks like ${who}, which can't connect a crypto wallet. Open the dashboard in your wallet app's built-in browser, or in Chrome/Safari with a Base-compatible wallet, then try again.`;
  }
  return "No browser wallet found. Open this page in a browser with a Base-compatible wallet — or your wallet app's built-in browser — then try again.";
}

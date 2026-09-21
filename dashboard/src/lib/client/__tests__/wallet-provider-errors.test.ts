/** @jest-environment jsdom */
import {
  describeMissingWalletEnvironment,
  describeWalletProviderError,
  detectInAppBrowser,
  getWalletProviderConnectionState,
  hasInjectedWalletProvider,
  isWalletProviderDisconnectedError,
  requestWalletProvider,
} from "../wallet-provider-errors";

import posthog from "posthog-js";
import { clientLog } from "@/lib/client/logger";

jest.mock("posthog-js", () => ({
  __esModule: true,
  default: {
    captureException: jest.fn(),
  },
}));

jest.mock("@/lib/client/logger", () => ({
  clientLog: {
    warn: jest.fn(),
  },
}));

describe("wallet provider error handling", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("detects EIP-1193 provider disconnected errors", () => {
    expect(
      isWalletProviderDisconnectedError({
        code: 4900,
        message: "The provider is disconnected from all chains.",
      })
    ).toBe(true);
  });

  it("detects providers that explicitly report they are disconnected", () => {
    expect(
      getWalletProviderConnectionState({
        isConnected: () => false,
      })
    ).toEqual({ connected: false, reason: "provider_disconnected" });
  });

  it("turns disconnected-provider failures into user-safe copy", () => {
    expect(
      describeWalletProviderError(
        {
          code: 4900,
          message: "The provider is disconnected from all chains.",
        },
        "Wallet verification was not completed. Please try again."
      )
    ).toBe("Wallet disconnected. Please reconnect your wallet to continue.");
  });

  it("captures RPC method, provider, chain id, and raw code when wallet requests fail", async () => {
    const provider = {
      isMetaMask: true,
      request: jest
        .fn()
        .mockRejectedValueOnce({ code: -32603, message: "Internal JSON-RPC error." })
        .mockResolvedValueOnce("0x2105"),
    };

    await expect(
      requestWalletProvider(provider, { method: "eth_call", params: [] }, {
        source: "wallet-page",
        route: "/dashboard/wallet",
      })
    ).rejects.toEqual({ code: -32603, message: "Internal JSON-RPC error." });

    expect(posthog.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        rawErrorCode: -32603,
        rawErrorMessage: "Internal JSON-RPC error.",
        rawErrorMethod: "eth_call",
        walletProvider: "MetaMask",
        chainId: "0x2105",
      })
    );
    expect(clientLog.warn).toHaveBeenCalledWith(
      "Wallet provider request failed",
      expect.objectContaining({
        rawErrorMethod: "eth_call",
        walletProvider: "MetaMask",
      }),
      expect.any(Error)
    );
  });
});

describe("browser wallet environment detection", () => {
  const realUserAgent = window.navigator.userAgent;

  function setUserAgent(value: string) {
    Object.defineProperty(window.navigator, "userAgent", {
      value,
      configurable: true,
    });
  }

  afterEach(() => {
    setUserAgent(realUserAgent);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).ethereum;
  });

  it("reports an injected provider only when window.ethereum exists", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).ethereum;
    expect(hasInjectedWalletProvider()).toBe(false);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).ethereum = { request: jest.fn() };
    expect(hasInjectedWalletProvider()).toBe(true);
  });

  it("flags Discord's in-app browser by user agent", () => {
    setUserAgent(
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36 Discord/200"
    );
    expect(detectInAppBrowser()).toEqual({ isInApp: true, appName: "Discord" });
  });

  it("flags a generic Android in-app webview", () => {
    setUserAgent(
      "Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0 Mobile Safari/537.36"
    );
    expect(detectInAppBrowser().isInApp).toBe(true);
  });

  it("does not flag a normal desktop browser", () => {
    setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    );
    expect(detectInAppBrowser()).toEqual({ isInApp: false, appName: null });
  });

  it("describes the in-app case with the app name and an actionable next step", () => {
    setUserAgent("Mozilla/5.0 Mobile Discord/200");
    const message = describeMissingWalletEnvironment();
    expect(message).toContain("Discord's in-app browser");
    expect(message.toLowerCase()).toContain("try again");
  });

  it("falls back to a generic no-wallet message outside in-app browsers", () => {
    setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    );
    expect(describeMissingWalletEnvironment()).toContain("No browser wallet found");
  });
});

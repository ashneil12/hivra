"use client";

const FINGERPRINT_PRO_SCRIPT_ATTRIBUTE = "data-hivra-fingerprint-pro";
const FINGERPRINT_PRO_TIMEOUT_MS = 4_000;

interface FingerprintProResult {
  requestId?: string;
}

interface FingerprintProAgent {
  get(): Promise<FingerprintProResult>;
}

interface FingerprintProLoader {
  load(): Promise<FingerprintProAgent>;
}

declare global {
  interface Window {
    FingerprintJS?: FingerprintProLoader;
  }
}

let fingerprintLoaderPromise: Promise<FingerprintProLoader> | null = null;
let fingerprintRequestPromise: Promise<string | null> | null = null;

function withTimeout<T>(operation: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = globalThis.setTimeout(
      () => reject(new Error("Fingerprint Pro timed out")),
      FINGERPRINT_PRO_TIMEOUT_MS
    );
    operation.then(
      (value) => {
        globalThis.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        globalThis.clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

function loadHostedFingerprintPro(apiKey: string): Promise<FingerprintProLoader> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.reject(new Error("Fingerprint Pro requires a browser"));
  }

  fingerprintLoaderPromise ??= new Promise<void>((resolve, reject) => {
    let script = document.querySelector<HTMLScriptElement>(
      `script[${FINGERPRINT_PRO_SCRIPT_ATTRIBUTE}]`
    );

    const handleLoad = () => resolve();
    const handleError = () => reject(new Error("Fingerprint Pro CDN failed to load"));

    if (!script) {
      script = document.createElement("script");
      script.async = true;
      script.referrerPolicy = "origin";
      script.src = `https://fpjscdn.net/v3/${encodeURIComponent(apiKey)}/iife.min.js`;
      script.setAttribute(FINGERPRINT_PRO_SCRIPT_ATTRIBUTE, "hosted-opt-in");
      script.addEventListener("load", handleLoad, { once: true });
      script.addEventListener("error", handleError, { once: true });
      document.head.appendChild(script);
      return;
    }

    if (typeof window.FingerprintJS?.load === "function") {
      resolve();
      return;
    }

    script.addEventListener("load", handleLoad, { once: true });
    script.addEventListener("error", handleError, { once: true });
  }).then(() => {
    if (typeof window.FingerprintJS?.load !== "function") {
      throw new Error("Fingerprint Pro CDN loaded without its browser API");
    }
    return window.FingerprintJS;
  });

  return fingerprintLoaderPromise;
}

export async function getFingerprintRequestId(): Promise<string | null> {
  const apiKey = process.env.NEXT_PUBLIC_FINGERPRINT_PUBLIC_KEY?.trim();
  if (!apiKey) return null;

  fingerprintRequestPromise ??= withTimeout(
    loadHostedFingerprintPro(apiKey).then(async (FingerprintJS) => {
      const agent = await FingerprintJS.load();
      return agent.get();
    })
  )
    .then((result) =>
      typeof result.requestId === "string" && result.requestId.trim()
        ? result.requestId
        : null
    )
    .catch(() => null);

  return fingerprintRequestPromise;
}

/** @jest-environment jsdom */

const originalPublicKey = process.env.NEXT_PUBLIC_FINGERPRINT_PUBLIC_KEY;

async function loadSubject() {
  jest.resetModules();
  return import("@/lib/abuse/client-fingerprint");
}

describe("hosted Fingerprint Pro client", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    delete window.FingerprintJS;
    delete process.env.NEXT_PUBLIC_FINGERPRINT_PUBLIC_KEY;
  });

  afterAll(() => {
    if (originalPublicKey === undefined) {
      delete process.env.NEXT_PUBLIC_FINGERPRINT_PUBLIC_KEY;
    } else {
      process.env.NEXT_PUBLIC_FINGERPRINT_PUBLIC_KEY = originalPublicKey;
    }
  });

  it("does not load any third-party code when the hosted key is absent", async () => {
    const { getFingerprintRequestId } = await loadSubject();

    await expect(getFingerprintRequestId()).resolves.toBeNull();
    expect(document.querySelector("script[data-hivra-fingerprint-pro]")).toBeNull();
  });

  it("loads the official CDN only after hosted opt-in and returns its request id", async () => {
    process.env.NEXT_PUBLIC_FINGERPRINT_PUBLIC_KEY = "public/test key";
    const get = jest.fn().mockResolvedValue({ requestId: "fp_req_123" });
    const load = jest.fn().mockResolvedValue({ get });
    const { getFingerprintRequestId } = await loadSubject();

    const request = getFingerprintRequestId();
    const script = document.querySelector<HTMLScriptElement>(
      "script[data-hivra-fingerprint-pro]"
    );
    expect(script?.src).toBe(
      "https://fpjscdn.net/v3/public%2Ftest%20key/iife.min.js"
    );

    window.FingerprintJS = { load };
    script?.dispatchEvent(new Event("load"));

    await expect(request).resolves.toBe("fp_req_123");
    expect(load).toHaveBeenCalledWith();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("fails open without throwing when the hosted script cannot load", async () => {
    process.env.NEXT_PUBLIC_FINGERPRINT_PUBLIC_KEY = "public-key";
    const { getFingerprintRequestId } = await loadSubject();

    const request = getFingerprintRequestId();
    document
      .querySelector<HTMLScriptElement>("script[data-hivra-fingerprint-pro]")
      ?.dispatchEvent(new Event("error"));

    await expect(request).resolves.toBeNull();
  });

  it("fails open within a bounded timeout when the hosted script stalls", async () => {
    jest.useFakeTimers();
    try {
      process.env.NEXT_PUBLIC_FINGERPRINT_PUBLIC_KEY = "public-key";
      const { getFingerprintRequestId } = await loadSubject();

      const request = getFingerprintRequestId();
      expect(document.querySelector("script[data-hivra-fingerprint-pro]")).not.toBeNull();

      await jest.advanceTimersByTimeAsync(4_000);
      await expect(request).resolves.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it("fails open when the CDN script does not expose the expected browser API", async () => {
    process.env.NEXT_PUBLIC_FINGERPRINT_PUBLIC_KEY = "public-key";
    const { getFingerprintRequestId } = await loadSubject();

    const request = getFingerprintRequestId();
    document
      .querySelector<HTMLScriptElement>("script[data-hivra-fingerprint-pro]")
      ?.dispatchEvent(new Event("load"));

    await expect(request).resolves.toBeNull();
  });
});

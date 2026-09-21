import {
  WEBUI_HANDOFF_TTL_MS,
  buildWebuiHandoffPayload,
  createCookieBackedWebuiIframeUrl,
  createDashboardLoginIframeUrl,
  createWebuiLoginUrl,
  normalizeWebuiNextPath,
  signWebuiHandoff,
  verifyWebuiHandoffSignature,
} from "@/lib/webui-handoff";

describe("webui handoff", () => {
  const apiServerKey = "deadbeef".repeat(8); // 64-hex bytes — same shape as a real per-instance key

  describe("normalizeWebuiNextPath", () => {
    it("allows in-gateway paths", () => {
      expect(normalizeWebuiNextPath("/")).toBe("/");
      expect(normalizeWebuiNextPath("/sessions?tab=active")).toBe("/sessions?tab=active");
      expect(normalizeWebuiNextPath()).toBe("/");
    });

    it("rejects scheme-relative paths", () => {
      expect(() => normalizeWebuiNextPath("//evil.example")).toThrow(
        "WebUI iframe redirects must stay on the gateway host",
      );
    });

    it("rejects backslash-containing paths", () => {
      expect(() => normalizeWebuiNextPath("/\\evil.example")).toThrow(
        "WebUI iframe redirects must stay on the gateway host",
      );
    });

    it("rejects paths that don't start with /", () => {
      expect(() => normalizeWebuiNextPath("evil.example")).toThrow();
    });
  });

  describe("signWebuiHandoff + verifyWebuiHandoffSignature", () => {
    it("verifies a valid signature", () => {
      const expiresAt = 1_700_000_000_000;
      const nonce = "abcdef0123456789abcdef0123456789";
      const nextPath = "/";
      const sig = signWebuiHandoff({ apiServerKey, expiresAt, nonce, nextPath });
      expect(
        verifyWebuiHandoffSignature({ apiServerKey, expiresAt, nonce, nextPath, signature: sig }),
      ).toBe(true);
    });

    it("rejects a tampered signature", () => {
      const expiresAt = 1_700_000_000_000;
      const nonce = "abcdef0123456789abcdef0123456789";
      const nextPath = "/";
      const sig = signWebuiHandoff({ apiServerKey, expiresAt, nonce, nextPath });
      const tampered = sig.slice(0, -2) + (sig.endsWith("00") ? "11" : "00");
      expect(
        verifyWebuiHandoffSignature({ apiServerKey, expiresAt, nonce, nextPath, signature: tampered }),
      ).toBe(false);
    });

    it("rejects a signature signed by a different key", () => {
      const expiresAt = 1_700_000_000_000;
      const nonce = "abcdef0123456789abcdef0123456789";
      const nextPath = "/";
      const sig = signWebuiHandoff({ apiServerKey: "wrong-key", expiresAt, nonce, nextPath });
      expect(
        verifyWebuiHandoffSignature({ apiServerKey, expiresAt, nonce, nextPath, signature: sig }),
      ).toBe(false);
    });

    it("rejects a signature with a different nextPath", () => {
      const expiresAt = 1_700_000_000_000;
      const nonce = "abcdef0123456789abcdef0123456789";
      const sig = signWebuiHandoff({ apiServerKey, expiresAt, nonce, nextPath: "/" });
      expect(
        verifyWebuiHandoffSignature({
          apiServerKey,
          expiresAt,
          nonce,
          nextPath: "/sessions",
          signature: sig,
        }),
      ).toBe(false);
    });

    it("rejects malformed hex signatures gracefully", () => {
      expect(
        verifyWebuiHandoffSignature({
          apiServerKey,
          expiresAt: 1_700_000_000_000,
          nonce: "abcdef0123456789abcdef0123456789",
          nextPath: "/",
          signature: "not-hex",
        }),
      ).toBe(false);
    });
  });

  describe("buildWebuiHandoffPayload", () => {
    it("formats payload as expiresAt.nonce.nextPath", () => {
      expect(buildWebuiHandoffPayload(1_700_000_000_000, "abc", "/sessions")).toBe(
        "1700000000000.abc./sessions",
      );
    });
  });

  describe("createWebuiLoginUrl", () => {
    it("creates a sidecar URL with all required query params", () => {
      const { url, expiresAt, nonce } = createWebuiLoginUrl({
        gatewayUrl: "https://agent.example.com",
        apiServerKey,
        now: 1_700_000_000_000,
      });
      const parsed = new URL(url);
      expect(parsed.origin).toBe("https://agent.example.com");
      expect(parsed.pathname).toBe("/_sidecar/webui-login");
      expect(parsed.searchParams.get("exp")).toBe(String(1_700_000_000_000 + WEBUI_HANDOFF_TTL_MS));
      expect(parsed.searchParams.get("nonce")).toMatch(/^[a-f0-9]{32}$/);
      expect(parsed.searchParams.get("next")).toBe("/");
      expect(parsed.searchParams.get("sig")).toMatch(/^[a-f0-9]{64}$/);
      expect(expiresAt).toBe(1_700_000_000_000 + WEBUI_HANDOFF_TTL_MS);
      expect(nonce).toMatch(/^[a-f0-9]{32}$/);
    });

    it("strips trailing slashes from gatewayUrl", () => {
      const { url } = createWebuiLoginUrl({
        gatewayUrl: "https://agent.example.com//",
        apiServerKey,
      });
      expect(url).toContain("https://agent.example.com/_sidecar/webui-login?");
    });

    it("respects custom nextPath", () => {
      const { url } = createWebuiLoginUrl({
        gatewayUrl: "https://agent.example.com",
        apiServerKey,
        nextPath: "/sessions",
      });
      const parsed = new URL(url);
      expect(parsed.searchParams.get("next")).toBe("/sessions");
    });

    it("respects a custom loginPath (gateway-backend /dashboard-login)", () => {
      const { url } = createWebuiLoginUrl({
        gatewayUrl: "https://agent.example.com",
        apiServerKey,
        loginPath: "/_sidecar/dashboard-login",
      });
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/_sidecar/dashboard-login");
    });

    it("rejects malicious nextPath", () => {
      expect(() =>
        createWebuiLoginUrl({
          gatewayUrl: "https://agent.example.com",
          apiServerKey,
          nextPath: "//evil.example",
        }),
      ).toThrow("WebUI iframe redirects must stay on the gateway host");
    });

    it("rejects empty gatewayUrl", () => {
      expect(() =>
        createWebuiLoginUrl({
          gatewayUrl: "",
          apiServerKey,
        }),
      ).toThrow("Gateway URL not configured");
    });

    it("uses ttl that matches OFFICIAL_DASHBOARD_LOGIN_TTL_MS precedent (30s)", () => {
      expect(WEBUI_HANDOFF_TTL_MS).toBe(30_000);
    });

    it("issued URL has a verifiable signature with the same apiServerKey", () => {
      const now = 1_700_000_000_000;
      const { url } = createWebuiLoginUrl({
        gatewayUrl: "https://agent.example.com",
        apiServerKey,
        now,
      });
      const parsed = new URL(url);
      const expiresAt = Number(parsed.searchParams.get("exp"));
      const nonce = parsed.searchParams.get("nonce") ?? "";
      const nextPath = parsed.searchParams.get("next") ?? "";
      const signature = parsed.searchParams.get("sig") ?? "";

      expect(
        verifyWebuiHandoffSignature({
          apiServerKey,
          expiresAt,
          nonce,
          nextPath,
          signature,
        }),
      ).toBe(true);
    });
  });

  describe("createCookieBackedWebuiIframeUrl", () => {
    it("sets up a sidecar cookie handoff that redirects to the hash-token iframe URL", () => {
      const { url } = createCookieBackedWebuiIframeUrl({
        gatewayUrl: "https://agent.example.com",
        apiServerKey,
        now: 1_700_000_000_000,
      });

      const parsed = new URL(url);
      expect(parsed.origin).toBe("https://agent.example.com");
      expect(parsed.pathname).toBe("/_sidecar/webui-login");
      expect(parsed.searchParams.get("next")).toMatch(/^\/webchat#iframe_token=/);
      expect(parsed.searchParams.get("sig")).toMatch(/^[a-f0-9]{64}$/);
    });

    it("preserves locale and appearance inside the signed redirect target", () => {
      const { url } = createCookieBackedWebuiIframeUrl({
        gatewayUrl: "https://agent.example.com",
        apiServerKey,
        locale: "zh-CN",
        appearance: {
          theme: "hermesos-light",
          skin: "hivra",
          colorScheme: "light",
        },
      });

      const parsed = new URL(url);
      const next = parsed.searchParams.get("next") ?? "";
      expect(next).toContain("locale=zh-CN");
      expect(next).toContain("lang=zh-CN");
      expect(next).toContain("theme=hermesos-light");
      expect(next).toContain("skin=hivra");
      expect(next).toContain("#iframe_token=");
    });
  });

  describe("createDashboardLoginIframeUrl (gateway-backend)", () => {
    it("mints the /_sidecar/dashboard-login handoff the base sidecar handles", () => {
      const { url } = createDashboardLoginIframeUrl({
        gatewayUrl: "https://agent.example.com",
        apiServerKey,
        now: 1_700_000_000_000,
      });
      const parsed = new URL(url);
      expect(parsed.origin).toBe("https://agent.example.com");
      expect(parsed.pathname).toBe("/_sidecar/dashboard-login");
      expect(parsed.searchParams.get("next")).toBe("/");
      expect(parsed.searchParams.get("sig")).toMatch(/^[a-f0-9]{64}$/);
    });

    it("does NOT leak the apiServerKey as a hash bearer in the redirect target", () => {
      const { url } = createDashboardLoginIframeUrl({
        gatewayUrl: "https://agent.example.com",
        apiServerKey,
      });
      const next = new URL(url).searchParams.get("next") ?? "";
      expect(next).not.toContain("#iframe_token=");
      expect(next).not.toContain(apiServerKey);
    });

    it("preserves locale and appearance as query params (no hash) in the signed target", () => {
      const { url } = createDashboardLoginIframeUrl({
        gatewayUrl: "https://agent.example.com",
        apiServerKey,
        locale: "zh-CN",
        appearance: {
          theme: "hermesos-light",
          skin: "hivra",
          colorScheme: "light",
        },
      });
      const next = new URL(url).searchParams.get("next") ?? "";
      expect(next).toContain("locale=zh-CN");
      expect(next).toContain("theme=hermesos-light");
      expect(next).toContain("skin=hivra");
      expect(next).not.toContain("#iframe_token=");
    });

    it("issues a signature verifiable with the same apiServerKey", () => {
      const { url } = createDashboardLoginIframeUrl({
        gatewayUrl: "https://agent.example.com",
        apiServerKey,
        now: 1_700_000_000_000,
      });
      const parsed = new URL(url);
      expect(
        verifyWebuiHandoffSignature({
          apiServerKey,
          expiresAt: Number(parsed.searchParams.get("exp")),
          nonce: parsed.searchParams.get("nonce") ?? "",
          nextPath: parsed.searchParams.get("next") ?? "",
          signature: parsed.searchParams.get("sig") ?? "",
        }),
      ).toBe(true);
    });
  });
});

/** @jest-environment node */
import {
  effectiveIngressMode,
  hostWakeProxyEnabled,
  ingressActsFor,
  ingressHostAllowed,
  ingressHostCredentialEnabled,
  ingressNeedsAwake,
  parseAgentIngressMode,
  parseHostIngressMode,
  parseHostRowIngressMode,
} from "../config";

const SERVER = [undefined, "", "off", "canary", "on", "ON", " canary ", "yes", "true"] as const;
const HOST = [undefined, null, "off", "canary", "on", "ON", "observe", 1] as const;
const ROWS = [null, undefined, {}, { mode: "guest" }, { mode: "host" }, { mode: "HOST" }, { mode: "both" }] as const;

const env = (value: string | undefined) => (value === undefined ? {} : { HIVRA_HOST_INGRESS: value });

describe("host ingress switches", () => {
  it("parses the server switch loosely and the host and agent columns exactly", () => {
    expect(parseHostIngressMode(undefined)).toBe("off");
    expect(parseHostIngressMode(" Canary ")).toBe("canary");
    expect(parseHostIngressMode("ON")).toBe("on");
    expect(parseHostIngressMode("true")).toBe("off");
    expect(parseHostRowIngressMode("canary")).toBe("canary");
    expect(parseHostRowIngressMode("ON")).toBe("off");
    expect(parseHostRowIngressMode(undefined)).toBe("off");
    expect(parseAgentIngressMode("host")).toBe("host");
    expect(parseAgentIngressMode("guest")).toBe("guest");
    expect(parseAgentIngressMode("Host")).toBeNull();
    expect(parseAgentIngressMode(null)).toBeNull();
  });

  it("takes the stricter of the server and the host switch", () => {
    expect(effectiveIngressMode({ ingress_mode: "on" }, env("canary"))).toBe("canary");
    expect(effectiveIngressMode({ ingress_mode: "canary" }, env("on"))).toBe("canary");
    expect(effectiveIngressMode({ ingress_mode: "on" }, env("on"))).toBe("on");
    expect(effectiveIngressMode({ ingress_mode: "on" }, env(undefined))).toBe("off");
    expect(effectiveIngressMode(null, env("on"))).toBe("off");
  });

  // Every combination: acts only with both switches on and a known agent row.
  for (const server of SERVER) {
    for (const hostMode of HOST) {
      for (const row of ROWS) {
        const host = hostMode === undefined ? {} : { ingress_mode: hostMode };
        const serverOn = server !== undefined && ["canary", "on"].includes(server.trim().toLowerCase());
        const hostOn = hostMode === "canary" || hostMode === "on";
        const rowKnown = !!row && ((row as { mode?: unknown }).mode === "guest" || (row as { mode?: unknown }).mode === "host");
        const acts = serverOn && hostOn && rowKnown;
        it(`server=${String(server)} host=${String(hostMode)} row=${JSON.stringify(row)} -> acts=${acts}`, () => {
          expect(ingressActsFor(row, host, env(server))).toBe(acts);
          expect(ingressHostAllowed(host, env(server))).toBe(serverOn && hostOn);
          // Kill switch: a row that is not plainly guest stays awake unless ingress acts.
          const mode = (row as { mode?: unknown } | null | undefined)?.mode;
          const needsAwake = !!row && mode !== "guest" && !acts;
          expect(ingressNeedsAwake(row, host, env(server))).toBe(needsAwake);
        });
      }
    }
  }

  it("acts nowhere with the server switch off, whatever the host and row say", () => {
    expect(ingressActsFor({ mode: "host" }, { ingress_mode: "on" }, {})).toBe(false);
    expect(ingressActsFor({ mode: "host" }, { ingress_mode: "on" }, env("off"))).toBe(false);
    expect(ingressNeedsAwake({ mode: "host" }, { ingress_mode: "on" }, env("off"))).toBe(true);
    expect(ingressNeedsAwake({ mode: "guest" }, { ingress_mode: "on" }, env("off"))).toBe(false);
    expect(ingressNeedsAwake(null, { ingress_mode: "on" }, env("off"))).toBe(false);
  });

  it("reads the server env when none is given", () => {
    const previous = process.env.HIVRA_HOST_INGRESS;
    try {
      delete process.env.HIVRA_HOST_INGRESS;
      expect(ingressActsFor({ mode: "host" }, { ingress_mode: "on" })).toBe(false);
      process.env.HIVRA_HOST_INGRESS = "canary";
      expect(ingressActsFor({ mode: "host" }, { ingress_mode: "on" })).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.HIVRA_HOST_INGRESS;
      else process.env.HIVRA_HOST_INGRESS = previous;
    }
  });

  it("keeps the boolean switches off unless plainly true", () => {
    for (const value of [undefined, "", "0", "false", "off", "no", "enabled"]) {
      expect(hostWakeProxyEnabled({ HIVRA_HOST_WAKE_PROXY_ENABLED: value })).toBe(false);
      expect(ingressHostCredentialEnabled({ HIVRA_INGRESS_HOST_CREDENTIAL: value })).toBe(false);
    }
    for (const value of ["true", "1", "YES", " on "]) {
      expect(hostWakeProxyEnabled({ HIVRA_HOST_WAKE_PROXY_ENABLED: value })).toBe(true);
      expect(ingressHostCredentialEnabled({ HIVRA_INGRESS_HOST_CREDENTIAL: value })).toBe(true);
    }
  });
});

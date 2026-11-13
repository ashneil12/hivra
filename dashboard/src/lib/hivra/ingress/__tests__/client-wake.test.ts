/** @jest-environment node */

// Client wakes through the host wake proxy, server side: the route file's
// bearer hash and wake URL, and the nap's server-disarm flag (a Telegram-covered
// nap tells the proxy to send client wakes to Hivra instead of resuming locally).

import { createHash } from "node:crypto";

import { buildSleepHostScript } from "../../agent-sleep-scripts";
import {
  buildIngressRoute,
  ingressBearerSha256,
  ingressWakeUrl,
  isIngressWakeUrl,
  parseIngressRoute,
} from "../route-file";

const AGENT = "11111111-1111-4111-8111-111111111111";
const target = { vmid: 1234, bindingTag: "hivra-agent-abc" };
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const base = {
  vmid: 1107,
  hostname: "box-1107.example.test",
  bindingTag: "hivra-agent-abc",
  guestIp: "10.250.20.7",
  ticketKey: "a".repeat(64),
  generation: 4,
};

describe("route file client-wake fields", () => {
  it("are left out when not given, so the route is unchanged", () => {
    expect(buildIngressRoute(base)).toEqual(buildIngressRoute({ ...base, bearerSha256: null, wakeUrl: null }));
    expect(Object.keys(buildIngressRoute(base))).not.toEqual(expect.arrayContaining(["bearer_sha256"]));
    expect(Object.keys(buildIngressRoute(base))).not.toEqual(expect.arrayContaining(["wake_url"]));
  });

  it("carry a 64-hex bearer hash and an https wake URL", () => {
    const route = buildIngressRoute({ ...base, bearerSha256: "b".repeat(64), wakeUrl: `https://dashboard.example.test/dashboard/agent/${AGENT}` });
    expect(route.bearer_sha256).toBe("b".repeat(64));
    expect(route.wake_url).toBe(`https://dashboard.example.test/dashboard/agent/${AGENT}`);
    expect(parseIngressRoute({ ...route, guest_mac: "02:00:00:00:00:01" })).not.toBeNull();
  });

  it("refuse anything the proxy would refuse", () => {
    expect(() => buildIngressRoute({ ...base, bearerSha256: "B".repeat(64) })).toThrow();
    expect(() => buildIngressRoute({ ...base, bearerSha256: "b".repeat(63) })).toThrow();
    for (const url of [
      "http://dashboard.example.test/x",
      "https://user@dashboard.example.test/",
      "https://dashboard.example.test/?next=x",
      "https://dashboard.example.test/#x",
      `https://dashboard.example.test/${"a".repeat(600)}`,
    ]) {
      expect(isIngressWakeUrl(url)).toBe(false);
      expect(() => buildIngressRoute({ ...base, wakeUrl: url })).toThrow();
    }
  });

  it("hash only a box API token of the usual shape", () => {
    const boxCredential = "c".repeat(64);
    expect(ingressBearerSha256(boxCredential)).toBe(digest(boxCredential));
    expect(ingressBearerSha256(null)).toBeNull();
    expect(ingressBearerSha256("short")).toBeNull();
    expect(ingressBearerSha256("C".repeat(64))).toBeNull();
  });

  it("send a browser to the owner's agent page on the configured https origin", () => {
    expect(ingressWakeUrl(AGENT, { NEXT_PUBLIC_APP_URL: "https://Dashboard.example.test/" }))
      .toBe(`https://dashboard.example.test/dashboard/agent/${AGENT}`);
    expect(ingressWakeUrl(AGENT, {})).toBeNull();
    expect(ingressWakeUrl(AGENT, { NEXT_PUBLIC_APP_URL: "http://dashboard.example.test" })).toBeNull();
    expect(ingressWakeUrl(AGENT, { NEXT_PUBLIC_APP_URL: "not a url" })).toBeNull();
    expect(ingressWakeUrl("not-an-id", { NEXT_PUBLIC_APP_URL: "https://dashboard.example.test" })).toBeNull();
  });
});

describe("nap server-disarm flag", () => {
  const telegramCoverage = { channels: ["hermes:telegram"], fingerprint: "0123456789abcdef" };

  it("is absent without host ingress, so scripts stay byte-identical", () => {
    for (const manual of [true, false]) {
      const covered = buildSleepHostScript({ ...target, tier: "nap", manual, telegramCoverage });
      expect(covered).not.toContain("server-disarm");
      expect(digest(buildSleepHostScript({ ...target, tier: "nap", manual, telegramCoverage, hostIngress: false })))
        .toBe(digest(covered));
    }
  });

  it("is absent for a host-ingress nap with no Telegram coverage", () => {
    const nap = buildSleepHostScript({ ...target, tier: "nap", manual: false, hostIngress: true });
    expect(nap).not.toContain("server-disarm");
    expect(nap).toContain("if ! ingress_ctl 8 napped; then");
    expect(nap).toContain("ingress_mark && ingress_ctl 8 napped >/dev/null 2>&1");
  });

  it("goes with both napped calls of a Telegram-covered host-ingress nap, and never with a hibernate", () => {
    const nap = buildSleepHostScript({ ...target, tier: "nap", manual: false, hostIngress: true, telegramCoverage });
    expect(nap).toContain("if ! ingress_ctl 8 napped server-disarm; then");
    expect(nap).toContain("ingress_mark && ingress_ctl 8 napped server-disarm >/dev/null 2>&1");
    expect(nap.match(/napped server-disarm/g)).toHaveLength(2);
    expect(nap.includes("\u0000")).toBe(false);
    const hibernate = buildSleepHostScript({ ...target, tier: "hibernate", manual: false, hostIngress: true, telegramCoverage });
    expect(hibernate).not.toContain("server-disarm");
  });
});

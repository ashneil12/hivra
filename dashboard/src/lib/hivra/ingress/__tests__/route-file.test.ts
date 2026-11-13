import { createHmac } from "node:crypto";

import {
  buildGuestTokenPayload,
  buildIngressAttachPayload,
  buildIngressRoute,
  deriveIngressTicketKey,
  INGRESS_METRICS_PORT_MAX,
  INGRESS_METRICS_PORT_MIN,
  isPrivateGuestIp,
  parseIngressRoute,
  pickMetricsPort,
  resolveIngressSecret,
} from "../route-file";

const AGENT = "11111111-1111-4111-8111-111111111111";
const TUNNEL = "22222222-2222-4222-8222-222222222222";
const SECRET = "s".repeat(40);
const FAKE_RUN_DOC = "e".repeat(80); // shaped like a run token, not one

describe("ingress ticket key", () => {
  it("is HMAC-SHA256 over the versioned, NUL-separated agent, tunnel and generation", () => {
    const expected = createHmac("sha256", SECRET)
      .update(["hivra-ingress-ticket-v1", AGENT, TUNNEL, "3"].join(String.fromCharCode(0)))
      .digest("hex");
    expect(deriveIngressTicketKey({ secret: SECRET, agentId: AGENT, tunnelId: TUNNEL, generation: 3 })).toBe(expected);
  });

  it("changes with the generation, the agent and the tunnel", () => {
    const base = deriveIngressTicketKey({ secret: SECRET, agentId: AGENT, tunnelId: TUNNEL, generation: 1 });
    expect(deriveIngressTicketKey({ secret: SECRET, agentId: AGENT, tunnelId: TUNNEL, generation: 2 })).not.toBe(base);
    expect(deriveIngressTicketKey({ secret: SECRET, agentId: TUNNEL, tunnelId: TUNNEL, generation: 1 })).not.toBe(base);
    expect(deriveIngressTicketKey({ secret: SECRET, agentId: AGENT, tunnelId: AGENT, generation: 1 })).not.toBe(base);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a short secret and bad ids", () => {
    expect(() => deriveIngressTicketKey({ secret: "short", agentId: AGENT, tunnelId: TUNNEL, generation: 1 })).toThrow();
    expect(() => deriveIngressTicketKey({ secret: SECRET, agentId: "x", tunnelId: TUNNEL, generation: 1 })).toThrow();
    expect(() => deriveIngressTicketKey({ secret: SECRET, agentId: AGENT, tunnelId: TUNNEL, generation: -1 })).toThrow();
  });

  it("reads HIVRA_INGRESS_SECRET only when it is long enough", () => {
    expect(resolveIngressSecret({})).toBeNull();
    expect(resolveIngressSecret({ HIVRA_INGRESS_SECRET: "x".repeat(31) })).toBeNull();
    expect(resolveIngressSecret({ HIVRA_INGRESS_SECRET: SECRET })).toBe(SECRET);
  });
});

describe("route file", () => {
  const route = () => buildIngressRoute({
    vmid: 1107,
    hostname: "Box-1107.example.test",
    bindingTag: "hivra-agent-abc",
    guestIp: "10.250.20.7",
    ticketKey: "a".repeat(64),
    generation: 4,
  });

  it("has exactly the fields the proxy reads, port 18080 and a lower-case hostname", () => {
    expect(route()).toEqual({
      version: 1,
      vmid: 1107,
      hostname: "box-1107.example.test",
      binding_tag: "hivra-agent-abc",
      guest_ip: "10.250.20.7",
      guest_port: 18080,
      ticket_key: "a".repeat(64),
      generation: 4,
    });
  });

  it("accepts guest_mac as the host adds it, and refuses anything unknown or malformed", () => {
    expect(parseIngressRoute({ ...route(), guest_mac: "02:00:00:00:00:01" })).not.toBeNull();
    expect(parseIngressRoute({ ...route(), guest_mac: "02:00:00:00:00" })).toBeNull();
    expect(parseIngressRoute({ ...route(), extra: 1 })).toBeNull();
    expect(parseIngressRoute({ ...route(), guest_port: 8080 })).toBeNull();
    expect(parseIngressRoute({ ...route(), guest_ip: "8.8.8.8" })).toBeNull();
    expect(parseIngressRoute({ ...route(), ticket_key: "zz" })).toBeNull();
    expect(parseIngressRoute({ ...route(), vmid: 5 })).toBeNull();
    expect(() => buildIngressRoute({ vmid: 1107, hostname: "bad host", bindingTag: "t", guestIp: "10.250.20.7", ticketKey: "a".repeat(64), generation: 0 })).toThrow();
  });

  it("only accepts private guest addresses", () => {
    for (const ip of ["10.240.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1"]) expect(isPrivateGuestIp(ip)).toBe(true);
    for (const ip of ["172.32.0.1", "8.8.8.8", "127.0.0.1", "0.0.0.0", "10.0.0", "10.0.0.256"]) expect(isPrivateGuestIp(ip)).toBe(false);
  });

  it("carries the run document only in the stdin payloads", () => {
    const payload = JSON.parse(buildIngressAttachPayload({ route: route(), token: FAKE_RUN_DOC, metricsPort: 21000 }));
    expect(payload).toEqual({ route: route(), token: FAKE_RUN_DOC, metrics_port: 21000 });
    expect(JSON.parse(buildGuestTokenPayload(FAKE_RUN_DOC))).toEqual({ token: FAKE_RUN_DOC });
    expect(() => buildGuestTokenPayload("short")).toThrow();
    expect(() => buildIngressAttachPayload({ route: route(), token: FAKE_RUN_DOC, metricsPort: 80 })).toThrow();
  });
});

describe("metrics port", () => {
  it("keeps a free preferred port and otherwise takes the lowest free one", () => {
    expect(pickMetricsPort([], null)).toBe(INGRESS_METRICS_PORT_MIN);
    expect(pickMetricsPort([INGRESS_METRICS_PORT_MIN], null)).toBe(INGRESS_METRICS_PORT_MIN + 1);
    expect(pickMetricsPort([INGRESS_METRICS_PORT_MIN], 21500)).toBe(21500);
    expect(pickMetricsPort([21500], 21500)).toBe(INGRESS_METRICS_PORT_MIN);
  });

  it("answers null when the range is full", () => {
    const all = Array.from({ length: INGRESS_METRICS_PORT_MAX - INGRESS_METRICS_PORT_MIN + 1 }, (_, i) => INGRESS_METRICS_PORT_MIN + i);
    expect(pickMetricsPort(all)).toBeNull();
  });
});

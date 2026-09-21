import { createHash } from "node:crypto";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from "nostr-tools";

import {
  BuzzRelayError,
  canonicalBuzzRelay,
  claimBuzzInvite,
  generateBuzzIdentity,
  inspectBuzzRelay,
  leaveBuzzRelay,
  verifyBuzzMembership,
  type BuzzRelayDescriptor,
} from "../buzz-relay";

const RELAY_SECRET = generateSecretKey();
const RELAY_PUBLIC = getPublicKey(RELAY_SECRET);
const COMMUNITY_ID = "018f6d3c-1d91-7c65-9d86-37fc915b8377";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function decodeAuthorization(init: RequestInit | undefined): Event {
  const headers = new Headers(init?.headers);
  const value = headers.get("authorization");
  expect(value).toMatch(/^Nostr /);
  const event = JSON.parse(Buffer.from(value!.slice(6), "base64").toString("utf8")) as Event;
  expect(verifyEvent(event)).toBe(true);
  return event;
}

function tags(event: Event) {
  return new Map(event.tags.map(([key, value]) => [key, value]));
}

function roster(memberPublicKey: string, secret = RELAY_SECRET, createdAt = 1_777_777_777) {
  return finalizeEvent({
    kind: 13_534,
    created_at: createdAt,
    content: "",
    tags: [["-"], ["member", memberPublicKey, "member"]],
  }, secret);
}

const relay: BuzzRelayDescriptor = {
  relayUrl: "wss://relay.example.com",
  httpOrigin: "https://relay.example.com",
  relayPublicKey: RELAY_PUBLIC,
  displayName: "Fixture Buzz",
  software: "https://github.com/block/buzz",
  version: "0.5.20",
  requiresMembership: true,
};

describe("Buzz relay contract", () => {
  it.each([
    "file:///etc/passwd",
    "ws://relay.example.com",
    "wss://user:secret@relay.example.com",
    "wss://relay.example.com/private",
    "wss://relay.example.com?token=secret",
    "wss://127.0.0.1",
    "wss://169.254.169.254",
  ])("rejects unsafe or non-origin relay input %s", (url) => {
    expect(() => canonicalBuzzRelay(url)).toThrow(BuzzRelayError);
  });

  it("canonicalizes a public HTTPS relay to one websocket and HTTP origin", () => {
    expect(canonicalBuzzRelay("https://Relay.Example.com/")).toEqual({
      relayUrl: "wss://relay.example.com",
      httpOrigin: "https://relay.example.com",
    });
  });

  it("rejects cleartext relays even on a self-host controller", () => {
    expect(() => canonicalBuzzRelay("ws://127.0.0.1:7777")).toThrow(BuzzRelayError);
  });

  it("inspects and pins the relay identity instead of trusting its label", async () => {
    const fetcher = jest.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://relay.example.com/");
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("accept")).toContain("application/nostr+json");
      return json({
        name: "Fixture Buzz",
        software: "https://github.com/block/buzz",
        version: "0.5.20",
        supported_nips: [1, 42, 43, 98],
        self: RELAY_PUBLIC,
      });
    });
    await expect(inspectBuzzRelay("wss://relay.example.com", fetcher)).resolves.toEqual(relay);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("accepts the exact official Buzz v0.5.20 NIP-11 omission while retaining the signed protocol checks", async () => {
    const fetcher = jest.fn(async () => json({
      name: "Buzz",
      software: "https://github.com/block/buzz",
      version: "0.5.20",
      supported_nips: [1, 2, 10, 11, 16, 17, 23, 25, 29, 33, 38, 42, 43, 50, 56],
      self: RELAY_PUBLIC,
    }));
    await expect(inspectBuzzRelay("wss://relay.example.com", fetcher)).resolves.toMatchObject({
      relayPublicKey: RELAY_PUBLIC,
      requiresMembership: true,
      version: "0.5.20",
    });
  });

  it("rejects a relay without NIP-42, NIP-43, NIP-98, or a stable identity", async () => {
    const fetcher = jest.fn(async () => json({ supported_nips: [1, 42], self: RELAY_PUBLIC }));
    await expect(inspectBuzzRelay("wss://relay.example.com", fetcher)).rejects.toMatchObject({
      code: "relay_incompatible",
    });
  });

  it("mints a distinct signing identity for every agent", () => {
    const first = generateBuzzIdentity();
    const second = generateBuzzIdentity();
    expect(first.privateKeyHex).toMatch(/^[a-f0-9]{64}$/);
    expect(first.publicKeyHex).toMatch(/^[a-f0-9]{64}$/);
    expect(getPublicKey(Uint8Array.from(Buffer.from(first.privateKeyHex, "hex")))).toBe(first.publicKeyHex);
    expect(second.publicKeyHex).not.toBe(first.publicKeyHex);
  });

  it("claims an invite with a body-bound NIP-98 signature from the new agent identity", async () => {
    const identity = generateBuzzIdentity();
    const fetcher = jest.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://relay.example.com/api/invites/claim");
      const body = String(init?.body);
      expect(JSON.parse(body)).toEqual({ code: "v2.fixture" });
      const auth = decodeAuthorization(init);
      expect(auth.kind).toBe(27235);
      expect(auth.pubkey).toBe(identity.publicKeyHex);
      expect(tags(auth).get("u")).toBe(url);
      expect(tags(auth).get("method")).toBe("POST");
      expect(tags(auth).get("payload")).toBe(createHash("sha256").update(body).digest("hex"));
      return json({ status: "joined", community_id: COMMUNITY_ID, host: "relay.example.com", role: "member" });
    });
    await expect(claimBuzzInvite({ relay, privateKeyHex: identity.privateKeyHex, inviteCode: "v2.fixture" }, fetcher))
      .resolves.toEqual({ status: "joined", communityId: COMMUNITY_ID, host: "relay.example.com", role: "member", publicKeyHex: identity.publicKeyHex });
  });

  it.each([
    ["https://relay.example.com:8443", "relay.example.com:8443"],
    ["https://[2001:db8::1]:8443", "[2001:db8::1]:8443"],
  ])("normalizes the claimed relay authority for %s", async (httpOrigin, host) => {
    const identity = generateBuzzIdentity();
    const descriptor = { ...relay, httpOrigin, relayUrl: httpOrigin.replace(/^https:/, "wss:") };
    const fetcher = jest.fn(async () => json({
      status: "joined", community_id: COMMUNITY_ID, host, role: "member",
    }));
    await expect(claimBuzzInvite({ relay: descriptor, privateKeyHex: identity.privateKeyHex, inviteCode: "v2.fixture" }, fetcher))
      .resolves.toMatchObject({ host: host.toLowerCase(), publicKeyHex: identity.publicKeyHex });
  });

  it.each([
    [403, "join_policy_required", "join_policy_required"],
    [403, "invite_expired", "invite_expired"],
    [403, "invite_exhausted", "invite_exhausted"],
    [403, "invite_invalid", "invalid_invite"],
  ])("maps a relay claim rejection without exposing its response (%s %s)", async (status, error, code) => {
    const identity = generateBuzzIdentity();
    const fetcher = jest.fn(async () => json({ error }, status));
    await expect(claimBuzzInvite({ relay, privateKeyHex: identity.privateKeyHex, inviteCode: "v2.fixture" }, fetcher))
      .rejects.toMatchObject({ code });
  });

  it("revalidates membership with a fresh signed read", async () => {
    const identity = generateBuzzIdentity();
    const fetcher = jest.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://relay.example.com/query");
      const body = String(init?.body);
      expect(JSON.parse(body)).toEqual([{ kinds: [13534], authors: [RELAY_PUBLIC], limit: 1 }]);
      const auth = decodeAuthorization(init);
      expect(auth.pubkey).toBe(identity.publicKeyHex);
      expect(tags(auth).get("u")).toBe(url);
      expect(tags(auth).get("method")).toBe("POST");
      expect(tags(auth).get("payload")).toBe(createHash("sha256").update(body).digest("hex"));
      return json([roster(identity.publicKeyHex)]);
    });
    await expect(verifyBuzzMembership({ relay, privateKeyHex: identity.privateKeyHex }, fetcher)).resolves.toEqual({
      member: true,
      rosterEventId: expect.stringMatching(/^[a-f0-9]{64}$/),
      rosterCreatedAt: 1_777_777_777,
      relayPublicKey: RELAY_PUBLIC,
    });
  });

  it("does not report membership when Buzz rejects the signed query", async () => {
    const fetcher = jest.fn(async () => json({ error: "not a relay member" }, 403));
    await expect(verifyBuzzMembership({ relay, privateKeyHex: generateBuzzIdentity().privateKeyHex }, fetcher))
      .resolves.toBeNull();
  });

  it("does not accept a successful non-array response as membership proof", async () => {
    const fetcher = jest.fn(async () => json({ channels: [] }));
    await expect(verifyBuzzMembership({ relay, privateKeyHex: generateBuzzIdentity().privateKeyHex }, fetcher))
      .resolves.toBeNull();
  });

  it("rejects a roster that is not signed by the pinned relay key", async () => {
    const identity = generateBuzzIdentity();
    const fetcher = jest.fn(async () => json([roster(identity.publicKeyHex, generateSecretKey())]));
    await expect(verifyBuzzMembership({ relay, privateKeyHex: identity.privateKeyHex }, fetcher))
      .resolves.toBeNull();
  });

  it("can prove a target is absent using a different admitted observer", async () => {
    const observer = generateBuzzIdentity();
    const target = generateBuzzIdentity();
    const fetcher = jest.fn(async () => json([roster(observer.publicKeyHex)]));
    await expect(verifyBuzzMembership({
      relay,
      privateKeyHex: observer.privateKeyHex,
      targetPublicKeyHex: target.publicKeyHex,
    }, fetcher)).resolves.toMatchObject({ member: false, relayPublicKey: RELAY_PUBLIC });
  });

  it("leaves only through a signed NIP-43 request bound to the same NIP-98 identity", async () => {
    const identity = generateBuzzIdentity();
    const fetcher = jest.fn(async (url: string, init?: RequestInit) => {
      const event = JSON.parse(String(init?.body)) as Event;
      expect(verifyEvent(event)).toBe(true);
      expect(event.kind).toBe(28936);
      expect(event.tags).toEqual([["-"]]);
      expect(event.pubkey).toBe(identity.publicKeyHex);
      const auth = decodeAuthorization(init);
      expect(auth.pubkey).toBe(identity.publicKeyHex);
      expect(tags(auth).get("payload")).toBe(createHash("sha256").update(String(init?.body)).digest("hex"));
      return json({ event_id: event.id, accepted: true, message: "info: you have left this relay" });
    });
    const result = await leaveBuzzRelay({ relay, privateKeyHex: identity.privateKeyHex }, fetcher);
    expect(result.status).toBe("left");
    expect(result.eventId).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not allow a local leave settlement for an unverified open relay", async () => {
    const fetcher = jest.fn();
    await expect(leaveBuzzRelay({ relay: { ...relay, requiresMembership: false }, privateKeyHex: generateBuzzIdentity().privateKeyHex }, fetcher))
      .rejects.toMatchObject({ code: "relay_incompatible" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("treats a signed retry after the identity is already absent as an idempotent leave", async () => {
    const fetcher = jest.fn(async () => json({ error: "invalid: you are not a relay member" }, 400));
    await expect(leaveBuzzRelay({ relay, privateKeyHex: generateBuzzIdentity().privateKeyHex }, fetcher))
      .resolves.toEqual({ status: "left", eventId: null });
  });
});

/** @jest-environment node */

jest.mock("server-only", () => ({}));

import { createHash, randomUUID } from "node:crypto";
import { finalizeEvent, getPublicKey } from "nostr-tools";

import {
  claimBuzzInvite,
  generateBuzzIdentity,
  leaveBuzzRelay,
  verifyBuzzMembership,
  type BuzzRelayDescriptor,
} from "../buzz-relay";

const LIVE_ORIGIN = process.env.BUZZ_UPSTREAM_LIVE_ORIGIN;
const OWNER_PRIVATE_KEY = process.env.BUZZ_UPSTREAM_OWNER_PRIVATE_KEY;
const RELAY_PRIVATE_KEY = process.env.BUZZ_UPSTREAM_RELAY_PRIVATE_KEY;
const live = LIVE_ORIGIN && OWNER_PRIVATE_KEY && RELAY_PRIVATE_KEY ? describe : describe.skip;
const fixtureFetch = (url: string, init?: RequestInit) => fetch(url, init);

function bytes(hex: string) {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function authorization(method: "POST", url: string, privateKeyHex: string, body: string) {
  const event = finalizeEvent({
    kind: 27_235,
    created_at: Math.floor(Date.now() / 1_000),
    content: "",
    tags: [
      ["u", url],
      ["method", method],
      ["nonce", randomUUID()],
      ["payload", createHash("sha256").update(body).digest("hex")],
    ],
  }, bytes(privateKeyHex));
  return `Nostr ${Buffer.from(JSON.stringify(event), "utf8").toString("base64")}`;
}

async function mintInvite(origin: string, ownerPrivateKey: string) {
  const url = `${origin}/api/invites`;
  const body = JSON.stringify({ ttl_secs: 600, max_uses: 1 });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: authorization("POST", url, ownerPrivateKey, body),
    },
    body,
  });
  const payload = await response.json() as { code?: string; error?: string };
  if (!response.ok || typeof payload.code !== "string") {
    throw new Error(`upstream invite mint failed (${response.status}, ${payload.error ?? "invalid response"})`);
  }
  return payload.code;
}

live("Buzz desktop-v0.5.20 live protocol", () => {
  jest.setTimeout(60_000);

  it("joins two identities, verifies relay-signed rosters, and proves unconditional removal", async () => {
    const origin = LIVE_ORIGIN!;
    const ownerPrivateKey = OWNER_PRIVATE_KEY!;
    const relayPublicKey = getPublicKey(bytes(RELAY_PRIVATE_KEY!));
    const descriptor: BuzzRelayDescriptor = {
      relayUrl: origin.replace(/^http:/, "ws:"),
      httpOrigin: origin,
      relayPublicKey,
      displayName: "Buzz upstream fixture",
      software: "https://github.com/block/buzz",
      version: "0.5.20",
      requiresMembership: true,
    };
    const first = generateBuzzIdentity();
    const second = generateBuzzIdentity();
    let firstJoined = false;
    let secondJoined = false;

    try {
      const nip11 = await fetch(`${origin}/`, { headers: { Accept: "application/nostr+json" } });
      const info = await nip11.json() as { software?: string; supported_nips?: number[]; self?: string };
      expect(nip11.status).toBe(200);
      expect(info).toMatchObject({ software: "https://github.com/block/buzz", self: relayPublicKey });
      expect(info.supported_nips).toContain(43);
      expect(info.supported_nips).not.toContain(98); // Exact v0.5.20 compatibility seam.

      const [firstInvite, secondInvite] = await Promise.all([
        mintInvite(origin, ownerPrivateKey),
        mintInvite(origin, ownerPrivateKey),
      ]);
      await claimBuzzInvite({ relay: descriptor, privateKeyHex: first.privateKeyHex, inviteCode: firstInvite }, fixtureFetch);
      firstJoined = true;
      const firstClaim = await verifyBuzzMembership({
        relay: descriptor,
        privateKeyHex: first.privateKeyHex,
        targetPublicKeyHex: first.publicKeyHex,
      }, fixtureFetch);
      expect(firstClaim).toMatchObject({ member: true, relayPublicKey });

      await claimBuzzInvite({ relay: descriptor, privateKeyHex: second.privateKeyHex, inviteCode: secondInvite }, fixtureFetch);
      secondJoined = true;
      await expect(verifyBuzzMembership({
        relay: descriptor,
        privateKeyHex: second.privateKeyHex,
        targetPublicKeyHex: second.publicKeyHex,
      }, fixtureFetch)).resolves.toMatchObject({ member: true, relayPublicKey });

      await leaveBuzzRelay({ relay: descriptor, privateKeyHex: first.privateKeyHex }, fixtureFetch);
      firstJoined = false;
      const firstAbsent = await verifyBuzzMembership({
        relay: descriptor,
        privateKeyHex: second.privateKeyHex,
        targetPublicKeyHex: first.publicKeyHex,
      }, fixtureFetch);
      expect(firstAbsent).toMatchObject({ member: false, relayPublicKey });
      expect(firstAbsent!.rosterCreatedAt).toBeGreaterThanOrEqual(firstClaim!.rosterCreatedAt);
      expect(firstAbsent!.rosterEventId).not.toBe(firstClaim!.rosterEventId);

      await leaveBuzzRelay({ relay: descriptor, privateKeyHex: second.privateKeyHex }, fixtureFetch);
      secondJoined = false;
      const ownerEvidence = await verifyBuzzMembership({
        relay: descriptor,
        privateKeyHex: ownerPrivateKey,
        targetPublicKeyHex: second.publicKeyHex,
      }, fixtureFetch);
      expect(ownerEvidence).toMatchObject({ member: false, relayPublicKey });
      await expect(verifyBuzzMembership({
        relay: descriptor,
        privateKeyHex: ownerPrivateKey,
        targetPublicKeyHex: first.publicKeyHex,
      }, fixtureFetch)).resolves.toMatchObject({ member: false, relayPublicKey });
    } finally {
      if (firstJoined) await leaveBuzzRelay({ relay: descriptor, privateKeyHex: first.privateKeyHex }, fixtureFetch).catch(() => undefined);
      if (secondJoined) await leaveBuzzRelay({ relay: descriptor, privateKeyHex: second.privateKeyHex }, fixtureFetch).catch(() => undefined);
    }
  });
});

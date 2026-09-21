import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from "nostr-tools";
import { z } from "zod";

import { ssrfSafeFetch } from "@/lib/ssrf-safe-fetch";
import { checkOutboundUrlSafety } from "@/lib/url-safety";

const MAX_RELAY_RESPONSE_BYTES = 64 * 1024;
const RELAY_TIMEOUT_MS = 12_000;
const NIP98_KIND = 27_235;
const NIP43_LEAVE_KIND = 28_936;
const NIP43_MEMBERSHIP_LIST_KIND = 13_534;
const HEX_32 = /^[a-f0-9]{64}$/;

const RelayInfoSchema = z.object({
  name: z.string().max(160).optional(),
  description: z.string().max(2_000).optional(),
  software: z.string().max(512).optional(),
  version: z.string().max(80).optional(),
  supported_nips: z.array(z.number().int().nonnegative()).max(256).optional(),
  self: z.string().regex(HEX_32),
}).passthrough();

const ClaimResponseSchema = z.object({
  status: z.enum(["joined", "already_member"]),
  community_id: z.string().uuid(),
  host: z.string().min(1).max(253),
  role: z.literal("member"),
}).strict();

const EventResponseSchema = z.object({
  event_id: z.string().regex(HEX_32),
  accepted: z.literal(true),
  message: z.string().max(2_000),
}).strict();

const MembershipRosterSchema = z.object({
  id: z.string().regex(HEX_32),
  pubkey: z.string().regex(HEX_32),
  created_at: z.number().int().nonnegative(),
  kind: z.literal(NIP43_MEMBERSHIP_LIST_KIND),
  tags: z.array(z.array(z.string()).max(4)).max(5_000),
  content: z.string().max(1_024),
  sig: z.string().regex(/^[a-f0-9]{128}$/),
}).strict();

export type BuzzRelayProblem =
  | "invalid_relay"
  | "unsafe_relay"
  | "relay_unavailable"
  | "relay_incompatible"
  | "invalid_identity"
  | "invalid_invite"
  | "invite_expired"
  | "invite_exhausted"
  | "join_policy_required"
  | "membership_unconfirmed"
  | "leave_unconfirmed";

const SAFE_MESSAGES: Record<BuzzRelayProblem, string> = {
  invalid_relay: "Enter the public URL of a Buzz relay.",
  unsafe_relay: "That relay address cannot be reached safely from this Hivra controller.",
  relay_unavailable: "The Buzz relay did not respond in time.",
  relay_incompatible: "That server did not present a compatible Buzz relay identity.",
  invalid_identity: "The saved Buzz identity is unavailable.",
  invalid_invite: "That Buzz invite is invalid.",
  invite_expired: "That Buzz invite has expired.",
  invite_exhausted: "That Buzz invite has no remaining uses.",
  join_policy_required: "This Buzz relay requires its joining policy to be accepted first.",
  membership_unconfirmed: "The relay did not confirm this agent identity.",
  leave_unconfirmed: "The relay did not confirm that this agent identity left.",
};

export class BuzzRelayError extends Error {
  constructor(readonly code: BuzzRelayProblem) {
    super(SAFE_MESSAGES[code]);
    this.name = "BuzzRelayError";
  }
}

export type BuzzRelayIdentity = {
  privateKeyHex: string;
  publicKeyHex: string;
};

export type BuzzRelayDescriptor = {
  relayUrl: string;
  httpOrigin: string;
  relayPublicKey: string;
  displayName: string;
  software: string | null;
  version: string | null;
  requiresMembership: boolean;
};

export type BuzzMembershipEvidence = {
  member: boolean;
  rosterEventId: string;
  rosterCreatedAt: number;
  relayPublicKey: string;
};

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

function fetcherForController(fetcher?: Fetcher): Fetcher {
  return fetcher ?? ssrfSafeFetch;
}

export function canonicalBuzzRelay(raw: string): { relayUrl: string; httpOrigin: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new BuzzRelayError("invalid_relay");
  }
  if (parsed.protocol === "https:") parsed.protocol = "wss:";
  else if (parsed.protocol === "http:") parsed.protocol = "ws:";
  if (parsed.protocol !== "wss:") {
    throw new BuzzRelayError("invalid_relay");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash
    || (parsed.pathname !== "" && parsed.pathname !== "/")) {
    throw new BuzzRelayError("invalid_relay");
  }
  parsed.pathname = "/";
  const http = new URL(parsed.toString());
  http.protocol = "https:";
  const safety = checkOutboundUrlSafety(http.origin);
  if (!safety.ok) throw new BuzzRelayError("unsafe_relay");
  return { relayUrl: parsed.origin, httpOrigin: http.origin };
}

export function generateBuzzIdentity(): BuzzRelayIdentity {
  const secret = generateSecretKey();
  const privateKeyHex = Buffer.from(secret).toString("hex");
  return { privateKeyHex, publicKeyHex: getPublicKey(secret) };
}

function secretBytes(privateKeyHex: string): Uint8Array {
  if (!HEX_32.test(privateKeyHex)) throw new BuzzRelayError("invalid_identity");
  return Uint8Array.from(Buffer.from(privateKeyHex, "hex"));
}

function signedEvent(
  privateKeyHex: string,
  template: { kind: number; content: string; tags: string[][] },
) {
  return finalizeEvent({ ...template, created_at: Math.floor(Date.now() / 1_000) }, secretBytes(privateKeyHex));
}

function nip98Authorization(method: "GET" | "POST", url: string, privateKeyHex: string, body?: string) {
  const tags = [["u", url], ["method", method], ["nonce", randomUUID()]];
  if (body !== undefined) {
    tags.push(["payload", createHash("sha256").update(body).digest("hex")]);
  }
  const event = signedEvent(privateKeyHex, { kind: NIP98_KIND, content: "", tags });
  return `Nostr ${Buffer.from(JSON.stringify(event), "utf8").toString("base64")}`;
}

function discard(response: Response) {
  void response.body?.cancel().catch(() => undefined);
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
    discard(response);
    throw new BuzzRelayError("relay_incompatible");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new BuzzRelayError("relay_incompatible");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new BuzzRelayError("relay_unavailable");
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RELAY_RESPONSE_BYTES) throw new BuzzRelayError("relay_incompatible");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof BuzzRelayError) throw error;
    throw new BuzzRelayError("relay_incompatible");
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function relayRequest(
  url: string,
  init: RequestInit,
  fetcher?: Fetcher,
): Promise<{ response: Response; signal: AbortSignal; close: () => void }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS);
  try {
    const response = await fetcherForController(fetcher)(url, {
      ...init,
      redirect: "manual",
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
    });
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      discard(response);
      throw new BuzzRelayError("relay_incompatible");
    }
    return {
      response,
      signal: controller.signal,
      close: () => { clearTimeout(timeout); controller.abort(); },
    };
  } catch (error) {
    clearTimeout(timeout);
    controller.abort();
    if (error instanceof BuzzRelayError) throw error;
    throw new BuzzRelayError("relay_unavailable");
  }
}

export async function inspectBuzzRelay(rawRelay: string, fetcher?: Fetcher): Promise<BuzzRelayDescriptor> {
  const canonical = canonicalBuzzRelay(rawRelay);
  const request = await relayRequest(canonical.httpOrigin + "/", {
    method: "GET",
    headers: { Accept: "application/nostr+json, application/json" },
  }, fetcher);
  try {
    if (request.response.status !== 200) {
      discard(request.response);
      throw new BuzzRelayError("relay_incompatible");
    }
    const parsed = RelayInfoSchema.safeParse(await boundedJson(request.response, request.signal));
    if (!parsed.success) throw new BuzzRelayError("relay_incompatible");
    const nips = new Set(parsed.data.supported_nips ?? []);
    // desktop-v0.5.20 exposes authenticated /events, /query and /count but its
    // NIP-11 list accidentally omits 98. Keep that compatibility exception
    // scoped to the official Block Buzz implementation; all other relays must
    // advertise the protocol they ask Hivra to sign.
    const officialBuzz = parsed.data.software?.replace(/\/+$/, "").toLowerCase()
      === "https://github.com/block/buzz";
    if (!nips.has(42) || !nips.has(43) || (!nips.has(98) && !officialBuzz)) {
      throw new BuzzRelayError("relay_incompatible");
    }
    return {
      ...canonical,
      relayPublicKey: parsed.data.self,
      displayName: parsed.data.name?.trim() || "Buzz Relay",
      software: parsed.data.software?.trim() || null,
      version: parsed.data.version?.trim() || null,
      requiresMembership: true,
    };
  } finally {
    request.close();
  }
}

function inviteProblem(status: number, json: unknown): BuzzRelayProblem {
  const error = z.object({ error: z.string() }).passthrough().safeParse(json);
  const code = error.success ? error.data.error.toLowerCase() : "";
  if (code.includes("join_policy_required")) return "join_policy_required";
  if (code.includes("expired")) return "invite_expired";
  if (code.includes("exhausted")) return "invite_exhausted";
  if (status === 401 || status === 403 || code.includes("invite")) return "invalid_invite";
  return "membership_unconfirmed";
}

export async function claimBuzzInvite(input: {
  relay: BuzzRelayDescriptor;
  privateKeyHex: string;
  inviteCode: string;
  policyReceipt?: string;
}, fetcher?: Fetcher) {
  const code = input.inviteCode.trim();
  if (!code || code.length > 2_048 || /[\u0000-\u001f\u007f]/.test(code)) {
    throw new BuzzRelayError("invalid_invite");
  }
  if (getPublicKey(secretBytes(input.privateKeyHex)) === input.relay.relayPublicKey) {
    throw new BuzzRelayError("invalid_identity");
  }
  const body = JSON.stringify({ code, policy_receipt: input.policyReceipt?.trim() || undefined });
  const url = input.relay.httpOrigin + "/api/invites/claim";
  const request = await relayRequest(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: nip98Authorization("POST", url, input.privateKeyHex, body),
    },
    body,
  }, fetcher);
  try {
    const json = await boundedJson(request.response, request.signal).catch((error) => {
      if (error instanceof BuzzRelayError && request.response.status !== 200) return {};
      throw error;
    });
    if (request.response.status !== 200) throw new BuzzRelayError(inviteProblem(request.response.status, json));
    const parsed = ClaimResponseSchema.safeParse(json);
    if (!parsed.success || normalizedAuthority(parsed.data.host) !== normalizedAuthority(new URL(input.relay.httpOrigin).host)) {
      throw new BuzzRelayError("membership_unconfirmed");
    }
    return {
      status: parsed.data.status,
      communityId: parsed.data.community_id,
      host: parsed.data.host.toLowerCase(),
      role: parsed.data.role,
      publicKeyHex: getPublicKey(secretBytes(input.privateKeyHex)),
    } as const;
  } finally {
    request.close();
  }
}

function normalizedAuthority(raw: string) {
  try {
    const parsed = new URL(`https://${raw.trim().toLowerCase()}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed.host.toLowerCase();
  } catch {
    return null;
  }
}

export async function verifyBuzzMembership(input: {
  relay: BuzzRelayDescriptor;
  privateKeyHex: string;
  targetPublicKeyHex?: string;
}, fetcher?: Fetcher): Promise<BuzzMembershipEvidence | null> {
  const observerPublicKey = getPublicKey(secretBytes(input.privateKeyHex));
  const targetPublicKey = input.targetPublicKeyHex ?? observerPublicKey;
  if (!HEX_32.test(targetPublicKey)) throw new BuzzRelayError("invalid_identity");
  // Buzz's authenticated REST bridge checks the observer's relay membership
  // before executing this query. The returned kind:13534 snapshot is then
  // independently verified against the relay key pinned from NIP-11, so an
  // endpoint replacement cannot manufacture local settlement evidence.
  const body = JSON.stringify([{
    kinds: [NIP43_MEMBERSHIP_LIST_KIND],
    authors: [input.relay.relayPublicKey],
    limit: 1,
  }]);
  const url = input.relay.httpOrigin + "/query";
  const request = await relayRequest(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: nip98Authorization("POST", url, input.privateKeyHex, body),
    },
    body,
  }, fetcher);
  try {
    if (request.response.status !== 200) {
      discard(request.response);
      return null;
    }
    const payload = await boundedJson(request.response, request.signal);
    const parsed = z.array(MembershipRosterSchema).max(4).safeParse(payload);
    if (!parsed.success || parsed.data.length === 0) return null;
    const verified = parsed.data
      .filter((event) => event.pubkey === input.relay.relayPublicKey
        && event.tags.some((tag) => tag.length === 1 && tag[0] === "-")
        && verifyEvent(event as Event))
      .sort((left, right) => right.created_at - left.created_at)[0];
    if (!verified) return null;
    const member = verified.tags.some((tag) => tag[0] === "member"
      && tag[1] === targetPublicKey && ["owner", "admin", "member"].includes(tag[2] ?? ""));
    return {
      member,
      rosterEventId: verified.id,
      rosterCreatedAt: verified.created_at,
      relayPublicKey: verified.pubkey,
    };
  } catch {
    return null;
  } finally {
    request.close();
  }
}

export async function leaveBuzzRelay(input: {
  relay: BuzzRelayDescriptor;
  privateKeyHex: string;
}, fetcher?: Fetcher) {
  if (!input.relay.requiresMembership) throw new BuzzRelayError("relay_incompatible");
  const event = signedEvent(input.privateKeyHex, { kind: NIP43_LEAVE_KIND, content: "", tags: [["-"]] });
  const body = JSON.stringify(event);
  const url = input.relay.httpOrigin + "/events";
  const request = await relayRequest(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: nip98Authorization("POST", url, input.privateKeyHex, body),
    },
    body,
  }, fetcher);
  try {
    const body = await boundedJson(request.response, request.signal);
    if (request.response.status === 400) {
      const rejected = z.object({ error: z.string() }).passthrough().safeParse(body);
      if (rejected.success && rejected.data.error.toLowerCase().includes("not a relay member")) {
        return { status: "left" as const, eventId: null };
      }
    }
    const parsed = EventResponseSchema.safeParse(body);
    if (request.response.status !== 200 || !parsed.success || parsed.data.event_id !== event.id) {
      throw new BuzzRelayError("leave_unconfirmed");
    }
    return { status: "left" as const, eventId: event.id };
  } finally {
    request.close();
  }
}

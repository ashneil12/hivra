import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { log } from "@/lib/logger";

import { connectorHostname, parseConnectorHostname } from "./home-connector-host";
import {
  consumeEnrolmentToken,
  countPendingEnrolments,
  getHomeConnector,
  insertHomeConnector,
  markHomeConnectorRevoked,
  type HomeConnectorRow,
} from "./home-connector-store";
import { hostRelayConfigured, issueConnectorConfig, revokeRelayConnector } from "./host-relay";
import { trustedAppOrigin } from "./trusted-app-origin";

const LOG_SOURCE = "home-connector";
export const ENROLMENT_TOKEN_LIFETIME_MS = 15 * 60_000;
export const MAX_PENDING_ENROLMENTS = 5;
export const ENROLMENT_TOKEN_PATTERN = /^hvc_[A-Za-z0-9_-]{32}$/;

export class HomeConnectorError extends Error {
  constructor(readonly code: "disabled" | "not_found" | "not_usable" | "unavailable" | "too_many", message: string) {
    super(message);
    this.name = "HomeConnectorError";
  }
}

type EnvLike = Record<string, string | undefined>;

/**
 * Off unless HIVRA_HOME_CONNECTOR_ENABLED is exactly "true" AND the relay is
 * configured (HOST_RELAY_URL, HOST_RELAY_SECRET). Read on the server only; the
 * browser learns it as a boolean from GET /api/infrastructure/home-connector.
 */
export function homeConnectorEnabled(env: EnvLike = process.env): boolean {
  return env.HIVRA_HOME_CONNECTOR_ENABLED?.trim().toLowerCase() === "true" && hostRelayConfigured(env as NodeJS.ProcessEnv);
}

const tokenHash = (token: string) => createHash("sha256").update(`home-connector-enrol|v1|${token}`).digest("hex");

export type HomeConnectorEnrolment = {
  connectorId: string;
  /** What the owner enters as the SSH host when naming this machine. */
  hostname: string;
  expiresAt: string;
  /** The one command to paste on the machine. Contains the one-time token. */
  command: string;
};

export function installCommand(origin: string, token: string): string {
  return `curl -fsSL ${origin}/api/infrastructure/home-connector/install | sudo bash -s -- ${token}`;
}

/** Issue a one-time enrolment for a new machine. The token is returned once and stored only as a hash. */
export async function startHomeConnectorEnrolment(
  userId: string,
  options: { env?: EnvLike; now?: () => number } = {},
): Promise<HomeConnectorEnrolment> {
  const env = options.env ?? process.env;
  if (!homeConnectorEnabled(env)) throw new HomeConnectorError("disabled", "Connecting a machine on your network is not available here.");
  const origin = trustedAppOrigin(env);
  if (!origin) throw new HomeConnectorError("unavailable", "This deployment has no public address to install from.");
  const nowMs = (options.now ?? Date.now)();
  // Durable cap: a user can't pile up unused install commands.
  if (await countPendingEnrolments(userId, new Date(nowMs).toISOString()) >= MAX_PENDING_ENROLMENTS) {
    throw new HomeConnectorError("too_many", "You already have several install commands waiting. Use one, or wait for them to expire.");
  }
  const token = `hvc_${randomBytes(24).toString("base64url")}`;
  const expiresAt = new Date(nowMs + ENROLMENT_TOKEN_LIFETIME_MS).toISOString();
  const row = await insertHomeConnector({ userId, tokenHash: tokenHash(token), expiresAt });
  return { connectorId: row.id, hostname: connectorHostname(row.id), expiresAt, command: installCommand(origin, token) };
}

/**
 * Exchange a one-time token for the connector's configuration. The token works
 * once, within its lifetime. Only the derived connector secret leaves here,
 * never the relay's master secret.
 */
export async function redeemHomeConnectorEnrolment(
  token: string,
  options: { env?: EnvLike; now?: () => number } = {},
): Promise<ReturnType<typeof issueConnectorConfig>> {
  const env = options.env ?? process.env;
  if (!homeConnectorEnabled(env)) throw new HomeConnectorError("disabled", "Not available.");
  if (!ENROLMENT_TOKEN_PATTERN.test(token)) throw new HomeConnectorError("not_usable", "That code can't be used.");
  const row = await consumeEnrolmentToken(tokenHash(token), new Date((options.now ?? Date.now)()).toISOString());
  if (!row) throw new HomeConnectorError("not_usable", "That code has expired or was already used.");
  return issueConnectorConfig(row.id, row.generation);
}

/**
 * A connector's state, named in one place. The table has no state column: the
 * state follows from three timestamps, and revoked wins over everything.
 */
export type HomeConnectorState = "awaiting_enrolment" | "enrolment_expired" | "enrolled" | "revoked";

export function homeConnectorState(row: HomeConnectorRow, now: number = Date.now()): HomeConnectorState {
  if (row.revoked_at) return "revoked";
  if (row.enrolment_consumed_at) return "enrolled";
  return Date.parse(row.enrolment_expires_at) > now ? "awaiting_enrolment" : "enrolment_expired";
}

/** Does this user own an enrolled, not-revoked connector with this id? */
export async function userOwnsActiveConnector(userId: string, connectorId: string): Promise<boolean> {
  const row = await getHomeConnector(userId, connectorId);
  return Boolean(row && homeConnectorState(row) === "enrolled");
}

/**
 * A connection may use a connector name as its SSH host only when the flag is
 * on and the signed-in owner enrolled that very machine. Any other host passes
 * through untouched. Returns false when the host is a connector name that this
 * user may not use.
 */
export async function connectorHostAllowedForUser(userId: string, sshHost: string, env: EnvLike = process.env): Promise<boolean> {
  const connectorId = parseConnectorHostname(sshHost);
  if (!connectorId) return !sshHost.trim().toLowerCase().endsWith(".connector.hivra.invalid");
  if (!homeConnectorEnabled(env)) return false;
  return userOwnsActiveConnector(userId, connectorId);
}

/** Stop the machine's connector: bump the generation here, then tell the relay. Safe to repeat. */
export async function revokeHomeConnector(userId: string, connectorId: string, options: { now?: () => number } = {}): Promise<void> {
  const row = await getHomeConnector(userId, connectorId);
  if (!row) throw new HomeConnectorError("not_found", "That machine isn't connected.");
  const revoked = await markHomeConnectorRevoked(userId, row, new Date((options.now ?? Date.now)()).toISOString());
  const current = revoked ?? (await getHomeConnector(userId, connectorId));
  if (!current) throw new HomeConnectorError("not_found", "That machine isn't connected.");
  try {
    await revokeRelayConnector(connectorId, current.generation);
  } catch (error) {
    log.warn("Home connector revoked here but the relay did not confirm", {
      source: LOG_SOURCE,
      failureType: "home_connector_relay_revoke_failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw new HomeConnectorError("unavailable", "Hivra's relay did not confirm. Try again to finish disconnecting this machine.");
  }
}

/** Used when a connection is removed. Does nothing for an ordinary host; never throws. */
export async function revokeConnectorForRemovedConnection(userId: string, sshHost: string | null): Promise<void> {
  const connectorId = parseConnectorHostname(sshHost);
  if (!connectorId) return;
  try {
    await revokeHomeConnector(userId, connectorId);
  } catch (error) {
    log.warn("Could not revoke a home connector for a removed connection", {
      source: LOG_SOURCE,
      failureType: "home_connector_remove_revoke_failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

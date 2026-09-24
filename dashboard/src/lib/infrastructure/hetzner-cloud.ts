import "server-only";

import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { utils as ssh2Utils } from "ssh2";

import {
  createHetznerCloudProjectClient,
  HetznerCloudApiError,
  type HetznerAction,
  type HetznerCloudProjectClient,
  type HetznerProjectCreateServerResult,
  type HetznerSshKey,
  type HetznerImage,
  type HetznerLocation,
  type HetznerPricing,
  type HetznerServer,
  type HetznerServerType,
} from "@/lib/hetzner/client";
import { log } from "@/lib/logger";

import {
  HETZNER_CLOUD_BILLING_SEMANTICS,
  HETZNER_CLOUD_CONNECTION_CAPABILITIES,
  HETZNER_CLOUD_FIREWALL_LIMITATION,
  HETZNER_CLOUD_SIMPLE_MODE_POLICY,
  HETZNER_CLOUD_SPENDING_CONFIRMATION,
  HetznerCloudCapacityCreateRequestSchema,
  HetznerCloudCapacityOperationDtoSchema,
  HetznerCloudCapacityQuoteDtoSchema,
  HetznerCloudCapacityQuoteRequestSchema,
  HetznerCloudOfferCatalogDtoSchema,
  type HetznerCloudCapacityCreateRequest,
  type HetznerCloudCapacityErrorCode,
  type HetznerCloudCapacityOperationDto,
  type HetznerCloudCapacityQuoteDto,
  type HetznerCloudCapacityQuoteRequest,
  type HetznerCloudConnectionDto,
  type HetznerCloudConnectionErrorCode,
  type HetznerCloudOfferCatalogDto,
  type HetznerCloudServerInventoryDto,
} from "./contracts";
import { InfrastructureConnectionStoreError } from "./connection-store";
import { FIRST_BOOT_RECIPE_VERSION } from "./first-boot-enrollment";
import { isHetznerGuidedSetupImage, isHetznerGuidedSetupServerType } from "./hetzner-guided-setup";
import {
  HETZNER_WRITE_CHECK_KEY_PREFIX,
  HETZNER_WRITE_CHECK_LABEL,
  HetznerWriteCheckKeyNameSchema,
  hetznerCloudTokenCheckMessage,
  hetznerCloudTokenReplaceMessage,
  type HetznerCloudTokenCheckErrorCode,
  type HetznerCloudTokenProjectCheck,
  type HetznerCloudTokenReplaceErrorCode,
  type HetznerCloudTokenReplaceResult,
  type HetznerCloudWriteCheck,
} from "./hetzner-cloud-token-contracts";
import { resolveFirstBootCreationRecipe } from "./first-boot-creation-recipe";
import {
  FIRST_BOOT_PREPARATION_CONFIRMATION, loadFirstBootEnrollmentForOrder, markFirstBootServerPostAttempted,
} from "./first-boot-store";
import {
  assertHetznerCreationReceiptMatchesObservation,
  createHetznerCreationReceipt,
  isExactHetznerCreateActionResources,
  type HetznerCreationReceipt,
} from "./hetzner-creation-receipt";
import {
  createHetznerCloudConnectionRecord,
  claimHetznerCloudCapacityOrder,
  createHetznerCloudCapacityQuoteRecord,
  listHetznerCloudInventory,
  loadHetznerCloudCapacityBootstrap,
  loadHetznerCloudCapacityQuote,
  loadHetznerCloudConnectionSecret,
  loadHetznerCloudTokenReplacementScope,
  markHetznerCloudServerPostAttempted,
  markHetznerCloudSshKeyPostAttempted,
  recordHetznerCloudCapacityOrderProgress,
  recordHetznerCloudCapacityOrderResult,
  recordHetznerCloudInventoryFailure,
  recordHetznerCloudSshKeyResult,
  reconcileHetznerCloudInventory,
  replaceHetznerCloudConnectionToken,
  upsertHetznerCloudInventoryServer,
  type SanitizedHetznerCloudServer,
  type HetznerBootstrapBundle,
  type HetznerCloudTokenReplacementScope,
  type StoredHetznerCloudCapacityOrder,
} from "./hetzner-cloud-store";
import type { HetznerCurrentServerShape } from "./hetzner-current-server-shape";

export class HetznerCloudConnectionError extends Error {
  constructor(public readonly code: HetznerCloudConnectionErrorCode) {
    super(`Hetzner Cloud connection failed: ${code}`);
    this.name = "HetznerCloudConnectionError";
  }
}

/** A token that authenticates but cannot be used here: read-only, from a
 * different project, or a write check Hetzner did not confirm. Never persisted
 * as a connection status; the user fixes it on the same screen. */
export class HetznerCloudTokenCheckError extends Error {
  constructor(
    public readonly code: HetznerCloudTokenCheckErrorCode,
    public readonly strayKeyName: string | null = null,
  ) {
    super(hetznerCloudTokenCheckMessage(code, strayKeyName));
    this.name = "HetznerCloudTokenCheckError";
  }
}

/** Replace token refused because the credential is in use, or finished in a
 * state it can't confirm. `replaced_unconfirmed` means the swap happened. */
export class HetznerCloudTokenReplaceError extends Error {
  constructor(public readonly code: HetznerCloudTokenReplaceErrorCode) {
    super(hetznerCloudTokenReplaceMessage(code));
    this.name = "HetznerCloudTokenReplaceError";
  }
}

export class HetznerCloudCapacityError extends Error {
  constructor(public readonly code: HetznerCloudCapacityErrorCode) {
    super(`Hetzner Cloud capacity request failed: ${code}`);
    this.name = "HetznerCloudCapacityError";
  }
}

type Dependencies = {
  now(): Date;
  monotonicNow(): number;
  client(apiToken: string): HetznerCloudProjectClient;
  createRecord: typeof createHetznerCloudConnectionRecord;
  loadSecret: typeof loadHetznerCloudConnectionSecret;
  listInventory: typeof listHetznerCloudInventory;
  recordFailure: typeof recordHetznerCloudInventoryFailure;
  reconcileInventory: typeof reconcileHetznerCloudInventory;
  createQuote: typeof createHetznerCloudCapacityQuoteRecord;
  loadQuote: typeof loadHetznerCloudCapacityQuote;
  claimOrder: typeof claimHetznerCloudCapacityOrder;
  loadBootstrap: typeof loadHetznerCloudCapacityBootstrap;
  markSshKeyPostAttempted: typeof markHetznerCloudSshKeyPostAttempted;
  recordSshKeyResult: typeof recordHetznerCloudSshKeyResult;
  markServerPostAttempted: typeof markHetznerCloudServerPostAttempted;
  firstBootRecipe: typeof resolveFirstBootCreationRecipe;
  firstBootEnrollment: typeof loadFirstBootEnrollmentForOrder;
  markFirstBootServerPost: typeof markFirstBootServerPostAttempted;
  recordOrderProgress: typeof recordHetznerCloudCapacityOrderProgress;
  recordOrderResult: typeof recordHetznerCloudCapacityOrderResult;
  upsertInventoryServer: typeof upsertHetznerCloudInventoryServer;
  loadTokenReplacementScope: typeof loadHetznerCloudTokenReplacementScope;
  replaceToken: typeof replaceHetznerCloudConnectionToken;
  writeCheckKey(): { name: string; publicKey: string };
  newId(): string;
  generateBootstrap(input: {
    userId: string;
    connectionId: string;
    connectionRevision: number;
    orderId: string;
    quoteFingerprintSha256: string;
  }): HetznerBootstrapBundle;
};

const defaultDependencies: Dependencies = {
  now: () => new Date(),
  monotonicNow: () => performance.now(),
  client: (apiToken) => createHetznerCloudProjectClient(apiToken),
  createRecord: createHetznerCloudConnectionRecord,
  loadSecret: loadHetznerCloudConnectionSecret,
  listInventory: listHetznerCloudInventory,
  recordFailure: recordHetznerCloudInventoryFailure,
  reconcileInventory: reconcileHetznerCloudInventory,
  createQuote: createHetznerCloudCapacityQuoteRecord,
  loadQuote: loadHetznerCloudCapacityQuote,
  claimOrder: claimHetznerCloudCapacityOrder,
  loadBootstrap: loadHetznerCloudCapacityBootstrap,
  markSshKeyPostAttempted: markHetznerCloudSshKeyPostAttempted,
  recordSshKeyResult: recordHetznerCloudSshKeyResult,
  markServerPostAttempted: markHetznerCloudServerPostAttempted,
  firstBootRecipe: resolveFirstBootCreationRecipe,
  firstBootEnrollment: loadFirstBootEnrollmentForOrder,
  markFirstBootServerPost: markFirstBootServerPostAttempted,
  recordOrderProgress: recordHetznerCloudCapacityOrderProgress,
  recordOrderResult: recordHetznerCloudCapacityOrderResult,
  upsertInventoryServer: upsertHetznerCloudInventoryServer,
  loadTokenReplacementScope: loadHetznerCloudTokenReplacementScope,
  replaceToken: replaceHetznerCloudConnectionToken,
  writeCheckKey: generateHetznerWriteCheckKey,
  newId: randomUUID,
  generateBootstrap: generateHetznerBootstrapBundle,
};

const HETZNER_QUOTE_TTL_MS = 10 * 60 * 1_000;
const HETZNER_MUTATION_RECONCILE_GRACE_MS = 60 * 1_000;
// Begin before awaiting the durable marker. Leave room for the client's
// bounded 15-second POST inside the 60-second detach/reconciliation grace.
const HETZNER_MUTATION_DISPATCH_BUDGET_MS = 30 * 1_000;
const HETZNER_KEY_GENERATION_MAX_ATTEMPTS = 16;
const HETZNER_OPERATION_LABEL = "hivra-operation";
const HETZNER_QUOTE_LABEL = "hivra-quote";
const HETZNER_MANAGED_LABEL = "hivra-managed";

function safeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function safePositiveNumber(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= max
    ? value
    : null;
}

function safePositiveInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max
    ? value
    : null;
}

function safeNonnegativeInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max
    ? value
    : null;
}

function mutationReconcileLeaseActive(at: string, now: Date): boolean {
  const attemptedAt = Date.parse(at);
  if (!Number.isFinite(attemptedAt)) return true;
  return now.getTime() - attemptedAt < HETZNER_MUTATION_RECONCILE_GRACE_MS;
}

function assertCapacityDispatchWindow(deadline: number, expiresAt: string, deps: Dependencies): void {
  if (deps.monotonicNow() >= deadline) {
    throw new HetznerCloudCapacityError("connection_changed");
  }
  if (deps.now().getTime() >= Date.parse(expiresAt)) {
    throw new HetznerCloudCapacityError("quote_expired");
  }
}

function safeIpv6Network(value: unknown): string | null {
  const raw = safeText(value, 64);
  if (!raw) return null;
  const [address, prefix, ...rest] = raw.split("/");
  if (rest.length > 0 || isIP(address) !== 6) return null;
  if (prefix === undefined) return address;
  if (!/^\d{1,3}$/.test(prefix) || Number(prefix) < 0 || Number(prefix) > 128) {
    return null;
  }
  return `${address}/${Number(prefix)}`;
}

export function generateHetznerBootstrapBundle(input: {
  userId: string;
  connectionId: string;
  connectionRevision: number;
  orderId: string;
  quoteFingerprintSha256: string;
}): HetznerBootstrapBundle {
  // ssh2 1.17's Ed25519 DER conversion removes all leading zero bytes from
  // the ASN.1 BitString. When the actual 32-byte public key begins with 0x00,
  // that produces a malformed 31-byte OpenSSH key. Treat key generation as
  // rejection sampling: accept only a pair that independently parses, matches,
  // and has the exact public form. This happens before any durable claim or
  // provider mutation and stays bounded so a persistent generator fault fails
  // closed instead of looping.
  for (let attempt = 0; attempt < HETZNER_KEY_GENERATION_MAX_ATTEMPTS; attempt += 1) {
    let keyPair: ReturnType<typeof ssh2Utils.generateKeyPairSync>;
    try {
      keyPair = ssh2Utils.generateKeyPairSync("ed25519", {
        comment: "hivra-capacity",
      });
    } catch {
      throw new HetznerCloudCapacityError("access_setup_failed");
    }
    const parsedPrivateKey = ssh2Utils.parseKey(keyPair.private);
    const parsedPublicKey = ssh2Utils.parseKey(keyPair.public);
    if (
      parsedPrivateKey instanceof Error
      || parsedPublicKey instanceof Error
      || !parsedPrivateKey.isPrivateKey()
      || parsedPublicKey.isPrivateKey()
    ) {
      continue;
    }
    const privatePublicBlob = parsedPrivateKey.getPublicSSH();
    const publicBlob = parsedPublicKey.getPublicSSH();
    if (!privatePublicBlob.equals(publicBlob)) continue;
    const publicKeyOpenSsh = keyPair.public.trim();
    if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,2} hivra-capacity$/.test(publicKeyOpenSsh)) {
      continue;
    }
    const publicKeyFingerprint = `SHA256:${createHash("sha256")
      .update(publicBlob)
      .digest("base64")
      .replace(/=+$/, "")}`;
    return {
      version: 2,
      provider: "hetzner-cloud",
      userId: input.userId,
      connectionId: input.connectionId,
      connectionRevision: input.connectionRevision,
      orderId: input.orderId,
      quoteFingerprintSha256: input.quoteFingerprintSha256,
      privateKeyOpenSsh: keyPair.private,
      publicKeyOpenSsh,
      publicKeyFingerprint,
    };
  }
  throw new HetznerCloudCapacityError("access_setup_failed");
}

function cloudInitForBootstrap(publicKeyOpenSsh: string): string {
  if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,2} hivra-capacity$/.test(publicKeyOpenSsh)) {
    throw new HetznerCloudCapacityError("access_setup_failed");
  }
  return [
    "#cloud-config",
    "users:",
    "  - name: hivra",
    "    groups: [sudo]",
    "    sudo: [\"ALL=(ALL) NOPASSWD:ALL\"]",
    "    shell: /bin/bash",
    "    lock_passwd: true",
    "    ssh_authorized_keys:",
    `      - ${JSON.stringify(publicKeyOpenSsh)}`,
    "ssh_pwauth: false",
    "disable_root: true",
    "package_update: true",
    "packages: [ufw]",
    "runcmd:",
    "  - [ufw, default, deny, incoming]",
    "  - [ufw, default, allow, outgoing]",
    "  - [ufw, allow, 22/tcp]",
    "  - [ufw, --force, enable]",
    "",
  ].join("\n");
}

function capacityLabelValue(orderId: string): string {
  return orderId.toLowerCase();
}

function capacitySshKeyName(orderId: string): string {
  return `hivra-key-${orderId.replace(/-/g, "").slice(0, 20)}`;
}

function capacityServerName(orderId: string): string {
  return `hivra-${orderId.replace(/-/g, "").slice(0, 20)}`;
}

function decimal(value: unknown): string | null {
  const text = safeText(value, 32);
  // Hetzner returns gross prices with sixteen fractional digits. Preserve
  // those exact strings for the bounded BigInt quote arithmetic below.
  return text && /^\d{1,12}(?:\.\d{1,16})?$/.test(text) ? text : null;
}

function addDecimals(...values: string[]): string {
  const parsed = values.map((value) => {
    const [whole, fraction = ""] = value.split(".");
    return { whole, fraction };
  });
  const scale = Math.max(...parsed.map((value) => value.fraction.length));
  const total = parsed.reduce(
    (sum, value) => sum + BigInt(`${value.whole}${value.fraction.padEnd(scale, "0")}`),
    0n,
  );
  if (scale === 0) return total.toString();
  const padded = total.toString().padStart(scale + 1, "0");
  const whole = padded.slice(0, -scale);
  const fraction = padded.slice(-scale).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function compareDecimals(left: string, right: string): number {
  const [leftWhole, leftFraction = ""] = left.split(".");
  const [rightWhole, rightFraction = ""] = right.split(".");
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const leftValue = BigInt(`${leftWhole}${leftFraction.padEnd(scale, "0")}`);
  const rightValue = BigInt(`${rightWhole}${rightFraction.padEnd(scale, "0")}`);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function quoteComparable(quote: HetznerCloudCapacityQuoteDto): unknown {
  return {
    connectionId: quote.connectionId,
    connectionRevision: quote.connectionRevision,
    serverName: quote.serverName,
    serverType: quote.serverType,
    location: quote.location,
    image: quote.image,
    price: quote.price,
    publicNetwork: quote.publicNetwork,
    backups: quote.backups,
    volumes: quote.volumes,
    startAfterCreate: quote.startAfterCreate,
    simpleModePolicy: quote.simpleModePolicy,
    billing: quote.billing,
    access: quote.access,
    spendingConfirmation: quote.spendingConfirmation,
  };
}

function quoteFingerprint(quote: HetznerCloudCapacityQuoteDto): string {
  return createHash("sha256")
    .update(JSON.stringify(quoteComparable(quote)))
    .digest("hex");
}

function providerFailure(error: unknown): HetznerCloudConnectionError {
  if (error instanceof HetznerCloudApiError) {
    if (error.status === 401 || error.status === 403) {
      return new HetznerCloudConnectionError("invalid_credentials");
    }
    if (error.code === "response_invalid") {
      return new HetznerCloudConnectionError("provider_response_invalid");
    }
    return new HetznerCloudConnectionError("provider_unavailable");
  }
  if (error instanceof HetznerCloudConnectionError) return error;
  return new HetznerCloudConnectionError("provider_response_invalid");
}

function capacityProviderFailure(error: unknown): HetznerCloudCapacityError {
  if (error instanceof HetznerCloudCapacityError) return error;
  if (error instanceof HetznerCloudApiError) {
    if (error.code === "response_invalid") {
      return new HetznerCloudCapacityError("provider_response_invalid");
    }
    switch (error.providerCode) {
      case "token_readonly":
        return new HetznerCloudCapacityError("token_read_only");
      case "unauthorized":
        return new HetznerCloudCapacityError("invalid_credentials");
      case "forbidden":
        return new HetznerCloudCapacityError("provider_forbidden");
      case "resource_limit_exceeded":
        return new HetznerCloudCapacityError("provider_resource_limit");
      case "maintenance":
        return new HetznerCloudCapacityError("provider_maintenance");
      case "rate_limit_exceeded":
        return new HetznerCloudCapacityError("provider_rate_limited");
      case "invalid_input":
        return new HetznerCloudCapacityError("selection_invalid");
      case "uniqueness_error":
      case "conflict":
        return new HetznerCloudCapacityError("provider_conflict");
      case "unavailable":
      case "resource_unavailable":
      case "service_error":
      case "server_error":
      case "bad_gateway":
      case "timeout":
      case "unknown_error":
      case "locked":
      case "resource_locked":
        return new HetznerCloudCapacityError("provider_unavailable");
      default:
        break;
    }
    if (error.status === 401) {
      return new HetznerCloudCapacityError("invalid_credentials");
    }
    if (error.status === 403) {
      return new HetznerCloudCapacityError("provider_forbidden");
    }
    if (error.status === 409) {
      return new HetznerCloudCapacityError("provider_conflict");
    }
    return new HetznerCloudCapacityError("provider_unavailable");
  }
  return new HetznerCloudCapacityError("provider_response_invalid");
}

type NormalizedHetznerServerStatus = Exclude<
  HetznerCloudCapacityOperationDto["observedServerStatus"],
  null
>;

function normalizeServerStatus(value: unknown): NormalizedHetznerServerStatus {
  switch (value) {
    case "running":
    case "off":
    case "initializing":
    case "starting":
    case "stopping":
    case "deleting":
    case "rebuilding":
    case "migrating":
    case "unknown":
      return value;
    default:
      return "unknown";
  }
}

function sanitizeServer(
  server: HetznerServer,
  discoveredAt: string,
): SanitizedHetznerCloudServer {
  const providerResourceId = safePositiveInteger(server.id);
  const name = safeText(server.name, 128);
  const created = safeText(server.created, 64);
  const typeName = safeText(server.server_type?.name, 64);
  const typeDescription = safeText(server.server_type?.description, 128);
  const cores = safePositiveInteger(server.server_type?.cores, 1_024);
  const memoryGb = safePositiveNumber(server.server_type?.memory, 65_536);
  const diskGb = safePositiveInteger(server.server_type?.disk);
  const providerLocation = server.location ?? server.datacenter?.location;
  const locationName = safeText(providerLocation?.name, 64);
  const locationCity = safeText(providerLocation?.city, 128);
  const locationCountry = safeText(providerLocation?.country, 2);
  const rawIpv4 = safeText(server.public_net?.ipv4?.ip, 45);
  const rawIpv6 = safeText(server.public_net?.ipv6?.ip, 64);
  const createdTimestamp = created ? Date.parse(created) : Number.NaN;
  if (
    providerResourceId === null ||
    !name ||
    !created ||
    !Number.isFinite(createdTimestamp) ||
    !typeName ||
    cores === null ||
    memoryGb === null ||
    diskGb === null ||
    !locationName
  ) {
    throw new HetznerCloudConnectionError("provider_response_invalid");
  }

  const status = normalizeServerStatus(server.status);
  return {
    providerResourceId: String(providerResourceId),
    name,
    status,
    serverType: {
      name: typeName,
      description: typeDescription,
      cores,
      memoryGb,
      diskGb,
      cpuType:
        server.server_type.cpu_type === "shared" ||
        server.server_type.cpu_type === "dedicated"
          ? server.server_type.cpu_type
          : null,
      architecture:
        server.server_type.architecture === "x86" ||
        server.server_type.architecture === "arm"
          ? server.server_type.architecture
          : null,
    },
    location: {
      name: locationName,
      city: locationCity,
      country: locationCountry?.length === 2 ? locationCountry.toUpperCase() : null,
    },
    publicNetwork: {
      ipv4: rawIpv4 && isIP(rawIpv4) === 4 ? rawIpv4 : null,
      ipv6: safeIpv6Network(rawIpv6),
    },
    providerCreatedAt: new Date(createdTimestamp).toISOString(),
    discoveredAt,
    launchReady: false,
    launchBlockedReason: HETZNER_CLOUD_CONNECTION_CAPABILITIES.reason,
  };
}

function sanitizeServerType(
  serverType: HetznerServerType,
  pricing: HetznerPricing,
): HetznerCloudOfferCatalogDto["serverTypes"][number] {
  const id = safePositiveInteger(serverType.id);
  const name = safeText(serverType.name, 64);
  const cores = safePositiveInteger(serverType.cores, 1_024);
  const memoryGb = safePositiveNumber(serverType.memory, 65_536);
  const diskGb = safePositiveInteger(serverType.disk);
  if (id === null || !name || cores === null || memoryGb === null || diskGb === null) {
    throw new HetznerCloudConnectionError("provider_response_invalid");
  }
  if (!Array.isArray(serverType.locations) || serverType.locations.length === 0) {
    throw new HetznerCloudConnectionError("provider_response_invalid");
  }
  const locations = serverType.locations.map((location) => {
    const locationName = safeText(location.name, 64);
    if (
      !locationName ||
      typeof location.available !== "boolean" ||
      typeof location.recommended !== "boolean"
    ) {
      throw new HetznerCloudConnectionError("provider_response_invalid");
    }
    return {
      name: locationName,
      available: location.available,
      recommended: location.recommended,
      deprecated: Boolean(location.deprecation),
    };
  });
  const supportedLocations = new Set(locations.map((location) => location.name));
  if (supportedLocations.size !== locations.length) {
    throw new HetznerCloudConnectionError("provider_response_invalid");
  }

  // Price identity must agree on both stable provider fields. An OR match can
  // bind one type's price to another after a provider rename or malformed
  // response, which is unacceptable for a spending surface.
  const pricingEntries = pricing.server_types.filter(
    (entry) => entry.id === id && entry.name === name,
  );
  if (pricingEntries.length !== 1 || pricingEntries[0].prices.length === 0) {
    throw new HetznerCloudConnectionError("provider_response_invalid");
  }
  const prices = pricingEntries[0].prices.map((price) => {
    const location = safeText(price.location, 64);
    const currency = safeText(pricing.currency, 3)?.toUpperCase();
    const includedTrafficBytes = safeNonnegativeInteger(price.included_traffic);
    if (
      !location ||
      !currency ||
      !supportedLocations.has(location) ||
      !/^\d+(?:\.\d+)?$/.test(price.price_monthly?.net ?? "") ||
      !/^\d+(?:\.\d+)?$/.test(price.price_monthly?.gross ?? "") ||
      !/^\d+(?:\.\d+)?$/.test(price.price_hourly?.net ?? "") ||
      !/^\d+(?:\.\d+)?$/.test(price.price_hourly?.gross ?? "") ||
      includedTrafficBytes === null ||
      !/^\d+(?:\.\d+)?$/.test(price.price_per_tb_traffic?.net ?? "") ||
      !/^\d+(?:\.\d+)?$/.test(price.price_per_tb_traffic?.gross ?? "")
    ) {
      throw new HetznerCloudConnectionError("provider_response_invalid");
    }
    return {
      location,
      monthly: {
        currency,
        net: price.price_monthly.net,
        gross: price.price_monthly.gross,
      },
      hourly: {
        currency,
        net: price.price_hourly.net,
        gross: price.price_hourly.gross,
      },
      includedTrafficBytes,
      additionalTrafficPerTb: {
        currency,
        net: price.price_per_tb_traffic.net,
        gross: price.price_per_tb_traffic.gross,
      },
    };
  });
  const pricedLocations = new Set(prices.map((price) => price.location));
  if (pricedLocations.size !== prices.length) {
    throw new HetznerCloudConnectionError("provider_response_invalid");
  }
  // Every currently selectable location needs an exact price. Deprecated or
  // unavailable locations remain visible for truthful catalog context but are
  // not treated as orderable offers.
  if (
    locations.some(
      (location) => location.available && !location.deprecated && !pricedLocations.has(location.name),
    )
  ) {
    throw new HetznerCloudConnectionError("provider_response_invalid");
  }
  return {
    id,
    name,
    description: safeText(serverType.description, 128),
    cores,
    memoryGb,
    diskGb,
    cpuType:
      serverType.cpu_type === "shared" || serverType.cpu_type === "dedicated"
        ? serverType.cpu_type
        : null,
    architecture:
      serverType.architecture === "x86" || serverType.architecture === "arm"
        ? serverType.architecture
        : null,
    deprecated: Boolean(serverType.deprecated),
    locations,
    prices,
  };
}

function sanitizeLocation(
  location: HetznerLocation,
): HetznerCloudOfferCatalogDto["locations"][number] {
  const id = safePositiveInteger(location.id);
  const name = safeText(location.name, 64);
  const city = safeText(location.city, 128);
  const country = safeText(location.country, 2);
  const networkZone = safeText(location.network_zone, 64);
  if (id === null || !name || !city || country?.length !== 2 || !networkZone) {
    throw new HetznerCloudConnectionError("provider_response_invalid");
  }
  return { id, name, city, country: country.toUpperCase(), networkZone };
}

function sanitizeImage(image: HetznerImage): HetznerCloudOfferCatalogDto["images"][number] | null {
  const id = safePositiveInteger(image.id);
  const name = safeText(image.name, 128);
  const description = safeText(image.description, 256);
  const architecture = image.architecture;
  const osFlavor = safeText(image.os_flavor, 64);
  if (
    id === null ||
    image.type !== "system" ||
    image.status !== "available" ||
    image.deleted !== null ||
    image.created_from !== null ||
    image.bound_to !== null ||
    !name ||
    !description ||
    (architecture !== "x86" && architecture !== "arm") ||
    !osFlavor
  ) {
    return null;
  }
  return {
    id,
    type: "system",
    name,
    description,
    architecture,
    osFlavor,
    osVersion: safeText(image.os_version, 64),
    deprecated: Boolean(image.deprecated),
  };
}

async function fetchOfferCatalogSnapshot(
  provider: HetznerCloudProjectClient,
  fetchedAt: string,
): Promise<{
  catalog: HetznerCloudOfferCatalogDto;
  pricing: HetznerPricing;
}> {
  const [serverTypes, locations, images, pricing] = await Promise.all([
    provider.listServerTypes(),
    provider.listLocations(),
    provider.listSystemImages(),
    provider.getPricing(),
  ]);
  const currency = safeText(pricing.currency, 3)?.toUpperCase();
  const vatRate = decimal(pricing.vat_rate);
  if (!currency || !vatRate) {
    throw new HetznerCloudConnectionError("provider_response_invalid");
  }
  const sanitizedLocations = locations.map(sanitizeLocation);
  const catalog = HetznerCloudOfferCatalogDtoSchema.parse({
    fetchedAt,
    currency,
    vatRate,
    serverTypes: serverTypes.map((serverType) => sanitizeServerType(serverType, pricing)),
    locations: sanitizedLocations,
    primaryIpPrices: sanitizedLocations.map((location) => ({
      location: location.name,
      ipv4: primaryIpPrice(pricing, "ipv4", location.name),
      ipv6: primaryIpPrice(pricing, "ipv6", location.name),
    })),
    images: images.map(sanitizeImage).filter((image) => image !== null),
    simpleModePolicy: HETZNER_CLOUD_SIMPLE_MODE_POLICY,
    billing: HETZNER_CLOUD_BILLING_SEMANTICS,
    capabilities: HETZNER_CLOUD_CONNECTION_CAPABILITIES,
  });
  return { catalog, pricing };
}

function primaryIpPrice(
  pricing: HetznerPricing,
  type: "ipv4" | "ipv6",
  locationName: string,
): {
  hourly: { net: string; gross: string };
  monthly: { net: string; gross: string };
} {
  const typeEntries = pricing.primary_ips?.filter((entry) => entry.type === type);
  if (type === "ipv6" && Array.isArray(typeEntries) && typeEntries.length === 0) {
    // The live pricing API omits free Primary IPv6, as documented at
    // https://docs.hetzner.com/cloud/servers/primary-ips/overview/.
    // Only an absent IPv6 entry has this meaning: a present entry must still
    // validate below, and paid IPv4 always requires an exact provider rate.
    return {
      hourly: { net: "0", gross: "0" },
      monthly: { net: "0", gross: "0" },
    };
  }
  if (!Array.isArray(typeEntries) || typeEntries.length !== 1) {
    throw new HetznerCloudCapacityError("provider_response_invalid");
  }
  const prices = typeEntries[0].prices.filter((price) => price.location === locationName);
  if (prices.length !== 1) {
    throw new HetznerCloudCapacityError("provider_response_invalid");
  }
  const hourlyNet = decimal(prices[0].price_hourly?.net);
  const hourlyGross = decimal(prices[0].price_hourly?.gross);
  const monthlyNet = decimal(prices[0].price_monthly?.net);
  const monthlyGross = decimal(prices[0].price_monthly?.gross);
  if (!hourlyNet || !hourlyGross || !monthlyNet || !monthlyGross) {
    throw new HetznerCloudCapacityError("provider_response_invalid");
  }
  return {
    hourly: { net: hourlyNet, gross: hourlyGross },
    monthly: { net: monthlyNet, gross: monthlyGross },
  };
}

function buildCapacityQuote(input: {
  id: string;
  connectionId: string;
  connectionRevision: number;
  request: HetznerCloudCapacityQuoteRequest;
  fetchedAt: string;
  expiresAt: string;
  catalog: HetznerCloudOfferCatalogDto;
  pricing: HetznerPricing;
}): HetznerCloudCapacityQuoteDto {
  const serverTypes = input.catalog.serverTypes.filter(
    (serverType) => serverType.id === input.request.serverTypeId,
  );
  const locations = input.catalog.locations.filter(
    (location) => location.id === input.request.locationId,
  );
  const images = input.catalog.images.filter((image) => image.id === input.request.imageId);
  if (serverTypes.length !== 1 || locations.length !== 1 || images.length !== 1) {
    throw new HetznerCloudCapacityError("selection_invalid");
  }
  const serverType = serverTypes[0];
  const location = locations[0];
  const image = images[0];
  const availability = serverType.locations.filter(
    (entry) => entry.name === location.name,
  );
  const serverPrices = serverType.prices.filter((entry) => entry.location === location.name);
  if (
    serverType.deprecated
    || serverType.architecture === null
    || availability.length !== 1
    || !availability[0].available
    || availability[0].deprecated
    || serverPrices.length !== 1
    || image.deprecated
    || image.type !== "system"
    || image.osFlavor.toLowerCase() !== "ubuntu"
    || image.architecture !== serverType.architecture
  ) {
    throw new HetznerCloudCapacityError("selection_invalid");
  }
  const serverPrice = serverPrices[0];
  const currency = safeText(input.pricing.currency, 3)?.toUpperCase();
  const vatRate = decimal(input.pricing.vat_rate);
  if (
    !currency
    || !vatRate
    || serverPrice.hourly.currency !== currency
    || serverPrice.monthly.currency !== currency
    || serverPrice.additionalTrafficPerTb.currency !== currency
  ) {
    throw new HetznerCloudCapacityError("provider_response_invalid");
  }
  const ipv4 = primaryIpPrice(input.pricing, "ipv4", location.name);
  const ipv6 = primaryIpPrice(input.pricing, "ipv6", location.name);
  const totalMonthlyGross = addDecimals(
    serverPrice.monthly.gross,
    ipv4.monthly.gross,
    ipv6.monthly.gross,
  );
  const policyCap = HETZNER_CLOUD_SIMPLE_MODE_POLICY.maxMonthlyGrossByCurrency.find(
    (cap) => cap.currency === currency,
  );
  if (
    serverType.cpuType !== HETZNER_CLOUD_SIMPLE_MODE_POLICY.cpuType
    || serverType.cores < HETZNER_CLOUD_SIMPLE_MODE_POLICY.minCores
    || serverType.memoryGb < HETZNER_CLOUD_SIMPLE_MODE_POLICY.minMemoryGb
    || serverType.cores > HETZNER_CLOUD_SIMPLE_MODE_POLICY.maxCores
    || serverType.memoryGb > HETZNER_CLOUD_SIMPLE_MODE_POLICY.maxMemoryGb
    || serverType.diskGb > HETZNER_CLOUD_SIMPLE_MODE_POLICY.maxDiskGb
    || !policyCap
    || compareDecimals(totalMonthlyGross, policyCap.amount) > 0
  ) {
    throw new HetznerCloudCapacityError("selection_invalid");
  }
  return HetznerCloudCapacityQuoteDtoSchema.parse({
    id: input.id,
    connectionId: input.connectionId,
    connectionRevision: input.connectionRevision,
    serverName: capacityServerName(input.id),
    serverType: {
      id: serverType.id,
      name: serverType.name,
      description: serverType.description,
      architecture: serverType.architecture,
      cores: serverType.cores,
      memoryGb: serverType.memoryGb,
      diskGb: serverType.diskGb,
    },
    location: {
      id: location.id,
      name: location.name,
      city: location.city,
      country: location.country,
    },
    image: {
      id: image.id,
      type: image.type,
      name: image.name,
      description: image.description,
      architecture: image.architecture,
      osFlavor: "ubuntu",
      osVersion: image.osVersion,
    },
    price: {
      currency,
      vatRate,
      server: {
        hourly: { net: serverPrice.hourly.net, gross: serverPrice.hourly.gross },
        monthly: { net: serverPrice.monthly.net, gross: serverPrice.monthly.gross },
      },
      primaryIpv4: ipv4,
      primaryIpv6: ipv6,
      total: {
        hourly: {
          net: addDecimals(serverPrice.hourly.net, ipv4.hourly.net, ipv6.hourly.net),
          gross: addDecimals(
            serverPrice.hourly.gross,
            ipv4.hourly.gross,
            ipv6.hourly.gross,
          ),
        },
        monthly: {
          net: addDecimals(serverPrice.monthly.net, ipv4.monthly.net, ipv6.monthly.net),
          gross: totalMonthlyGross,
        },
      },
      traffic: {
        includedBytes: serverPrice.includedTrafficBytes,
        additionalPerTb: {
          net: serverPrice.additionalTrafficPerTb.net,
          gross: serverPrice.additionalTrafficPerTb.gross,
        },
      },
    },
    publicNetwork: { ipv4: true, ipv6: true },
    backups: false,
    volumes: [],
    startAfterCreate: false,
    simpleModePolicy: HETZNER_CLOUD_SIMPLE_MODE_POLICY,
    billing: HETZNER_CLOUD_BILLING_SEMANTICS,
    access: {
      username: "hivra",
      method: "generated-ed25519",
      inboundTcpPortsAfterFirstBoot: [22],
      passwordAuthentication: false,
      rootSshLogin: false,
      providerFirewallAttached: false,
      firewallLimitation: HETZNER_CLOUD_FIREWALL_LIMITATION,
    },
    fetchedAt: input.fetchedAt,
    expiresAt: input.expiresAt,
    spendingConfirmation: HETZNER_CLOUD_SPENDING_CONFIRMATION,
  });
}

function providerLabels(orderId: string, fingerprint: string): Record<string, string> {
  return {
    [HETZNER_OPERATION_LABEL]: capacityLabelValue(orderId),
    [HETZNER_QUOTE_LABEL]: fingerprint.slice(0, 32),
    [HETZNER_MANAGED_LABEL]: "true",
  };
}

function labelsMatch(
  actual: Record<string, string> | undefined,
  expected: Record<string, string>,
): boolean {
  if (!actual) return false;
  const actualEntries = Object.entries(actual).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const expectedEntries = Object.entries(expected).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return JSON.stringify(actualEntries) === JSON.stringify(expectedEntries);
}

function publicKeyFingerprint(publicKeyOpenSsh: string): string | null {
  const match = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]*)?$/.exec(
    publicKeyOpenSsh.trim(),
  );
  if (!match) return null;
  try {
    const blob = Buffer.from(match[1], "base64");
    if (blob.length < 48 || blob.toString("base64").replace(/=+$/, "")
      !== match[1].replace(/=+$/, "")) {
      return null;
    }
    return `SHA256:${createHash("sha256")
      .update(blob)
      .digest("base64")
      .replace(/=+$/, "")}`;
  } catch {
    return null;
  }
}

export function exactSshKey(input: {
  sshKey: HetznerSshKey;
  expectedName: string;
  expectedPublicKey: string;
  expectedFingerprint: string;
  expectedLabels: Record<string, string>;
}): boolean {
  return safePositiveInteger(input.sshKey.id) !== null
    && input.sshKey.name === input.expectedName
    && input.sshKey.public_key.trim() === input.expectedPublicKey.trim()
    && publicKeyFingerprint(input.sshKey.public_key) === input.expectedFingerprint
    && labelsMatch(input.sshKey.labels, input.expectedLabels);
}

function findExactSshKey(input: {
  sshKeys: HetznerSshKey[];
  expectedName: string;
  expectedPublicKey: string;
  expectedFingerprint: string;
  expectedLabels: Record<string, string>;
}): HetznerSshKey | null {
  const sameName = input.sshKeys.filter((sshKey) => sshKey.name === input.expectedName);
  const exact = sameName.filter((sshKey) => exactSshKey({
    sshKey,
    expectedName: input.expectedName,
    expectedPublicKey: input.expectedPublicKey,
    expectedFingerprint: input.expectedFingerprint,
    expectedLabels: input.expectedLabels,
  }));
  if (sameName.length > 1 || (sameName.length === 1 && exact.length !== 1)) {
    throw new HetznerCloudCapacityError("provider_conflict");
  }
  return exact[0] ?? null;
}

function actionReceipt(action: HetznerAction): {
  id: string;
  command: string;
  status: "running" | "success" | "error";
} {
  return {
    id: String(action.id),
    command: action.command,
    status: action.status,
  };
}

function assertCreateActions(input: {
  action: HetznerAction;
  nextActions: HetznerAction[];
  providerServerId: number;
  providerImageId: number;
}): void {
  if (
    input.action.command !== "create_server"
    || !isExactHetznerCreateActionResources(input.action, input.providerServerId, input.providerImageId)
  ) {
    throw new HetznerCloudCapacityError("provider_response_invalid");
  }
  const actionIds = [input.action.id, ...input.nextActions.map((action) => action.id)];
  if (
    new Set(actionIds).size !== actionIds.length
    || input.nextActions.some(
      (action) => action.command === "poweron"
        || action.command === "start_resource"
        || action.resources.length === 0
        || action.resources.some((resource) => resource.type !== "primary_ip"),
    )
  ) {
    throw new HetznerCloudCapacityError("provider_response_invalid");
  }
}

function assertActionObservation(
  observed: HetznerAction,
  expected: Pick<HetznerAction, "id" | "command">,
  providerServerId: number,
  isMain: boolean,
  providerImageId?: number,
): void {
  if (
    observed.id !== expected.id
    || observed.command !== expected.command
    || observed.command === "poweron"
    || observed.command === "start_resource"
    || (isMain
      ? !isExactHetznerCreateActionResources(observed, providerServerId, providerImageId)
      : observed.resources.length === 0
        || observed.resources.some((resource) => resource.type !== "primary_ip"))
  ) {
    throw new HetznerCloudCapacityError("provider_response_invalid");
  }
}

function assertNextActionResourcesMatchServer(
  actions: HetznerAction[],
  server: HetznerServer,
): void {
  const serverId = safePositiveInteger(server.id);
  const ipv4Id = safePositiveInteger(server.public_net?.ipv4?.id);
  const ipv6Id = safePositiveInteger(server.public_net?.ipv6?.id);
  if (serverId === null || ipv4Id === null || ipv6Id === null || ipv4Id === ipv6Id) {
    throw new HetznerCloudCapacityError("provider_response_invalid");
  }
  const primaryIpIds = new Set([ipv4Id, ipv6Id]);
  if (actions.some((action) => (
    action.resources.length === 0
    || action.resources.some((resource) => (
      resource.type !== "primary_ip" || !primaryIpIds.has(resource.id)
    ))
  ))) {
    throw new HetznerCloudCapacityError("provider_response_invalid");
  }
}

export function assertServerIdentityMatchesQuote(
  server: HetznerServer,
  quote: HetznerCloudCapacityQuoteDto,
  labels: Record<string, string>,
): void {
  const volumes = Array.isArray(server.volumes)
    && server.volumes.length <= 64
    && server.volumes.every((id) => Number.isSafeInteger(id) && id > 0)
    ? server.volumes
    : null;
  if (
    !Number.isSafeInteger(server.id)
    || server.id <= 0
    || server.name !== quote.serverName
    || !labelsMatch(server.labels, labels)
    || server.server_type?.id !== quote.serverType.id
    || server.server_type?.name !== quote.serverType.name
    || server.location?.id !== quote.location.id
    || server.location?.name !== quote.location.name
    || server.image?.id !== quote.image.id
    || server.image?.type !== quote.image.type
    || server.image?.status !== "available"
    || server.image?.deleted !== null
    || server.image?.created_from !== null
    || server.image?.bound_to !== null
    || server.image?.name !== quote.image.name
    || server.backup_window !== null
    || volumes === null
    || volumes.length !== 0
    || server.primary_disk_size !== quote.serverType.diskGb
    || server.rescue_enabled !== false
    || server.iso !== null
    || !Array.isArray(server.private_net)
    || server.private_net.length !== 0
    || server.locked !== false
    || server.protection?.delete !== false
    || server.protection?.rebuild !== false
    || !Array.isArray(server.public_net?.floating_ips)
    || server.public_net.floating_ips.length !== 0
    || !Array.isArray(server.load_balancers)
    || server.load_balancers.length !== 0
    || server.placement_group !== null
  ) {
    throw new HetznerCloudCapacityError("provider_response_invalid");
  }
}

/**
 * Preserve every immutable creation identity while accepting only the latest
 * resize shape that was durably chained to that creation receipt. The retained
 * primary disk is checked separately from the target plan's advertised disk.
 */
export function assertServerIdentityMatchesCurrentShape(
  server: HetznerServer,
  quote: HetznerCloudCapacityQuoteDto,
  labels: Record<string, string>,
  currentShape: HetznerCurrentServerShape | null | undefined,
): void {
  assertServerIdentityMatchesShape(server, quote, labels, currentShape);
}

export type HetznerServerShape = Pick<HetznerCurrentServerShape, "serverType" | "primaryDiskGb">;

/** Reuses the immutable creation-quote checks with one explicit, observed
 * server-shape overlay. This never relaxes image, location, network,
 * attachment, label, protection, or retained-primary-disk identity. */
export function assertServerIdentityMatchesShape(
  server: HetznerServer,
  quote: HetznerCloudCapacityQuoteDto,
  labels: Record<string, string>,
  shape: HetznerServerShape | null | undefined,
): void {
  if (!shape) {
    assertServerIdentityMatchesQuote(server, quote, labels);
    return;
  }
  assertServerIdentityMatchesQuote(server, {
    ...quote,
    serverType: {
      ...quote.serverType,
      id: shape.serverType.id,
      name: shape.serverType.name,
      architecture: shape.serverType.architecture,
      cores: shape.serverType.cores,
      memoryGb: shape.serverType.memoryGb,
      diskGb: shape.primaryDiskGb,
    },
  }, labels);
  if (
    server.server_type.architecture !== shape.serverType.architecture
    || server.server_type.cores !== shape.serverType.cores
    || server.server_type.memory !== shape.serverType.memoryGb
    || server.server_type.disk !== shape.serverType.advertisedDiskGb
    || server.server_type.cpu_type !== shape.serverType.cpuType
    || server.primary_disk_size !== shape.primaryDiskGb
  ) throw new HetznerCloudCapacityError("provider_response_invalid");
}

function assertFinalServerMatchesQuote(
  server: HetznerServer,
  quote: HetznerCloudCapacityQuoteDto,
  labels: Record<string, string>,
): void {
  assertServerIdentityMatchesQuote(server, quote, labels);
  const ipv4 = safeText(server.public_net?.ipv4?.ip, 45);
  const ipv6 = safeIpv6Network(server.public_net?.ipv6?.ip);
  const ipv4Id = safePositiveInteger(server.public_net?.ipv4?.id);
  const ipv6Id = safePositiveInteger(server.public_net?.ipv6?.id);
  if (
    !ipv4
    || isIP(ipv4) !== 4
    || !ipv6
    || ipv4Id === null
    || ipv6Id === null
    || ipv4Id === ipv6Id
  ) {
    throw new HetznerCloudCapacityError("provider_response_invalid");
  }
}

function findExactServer(input: {
  servers: HetznerServer[];
  quote: HetznerCloudCapacityQuoteDto;
  labels: Record<string, string>;
}): HetznerServer | null {
  const sameName = input.servers.filter((server) => server.name === input.quote.serverName);
  if (sameName.length === 0) return null;
  if (sameName.length !== 1) {
    throw new HetznerCloudCapacityError("provider_conflict");
  }
  assertServerIdentityMatchesQuote(sameName[0], input.quote, input.labels);
  return sameName[0];
}

function rejectionIsDefinitive(error: HetznerCloudCapacityError): boolean {
  return new Set<HetznerCloudCapacityErrorCode>([
    "selection_invalid",
    "connection_changed",
    "quote_changed",
    "invalid_credentials",
    "token_read_only",
    "provider_forbidden",
    "provider_resource_limit",
  ]).has(error.code);
}

function capacityOperationResult(
  order: StoredHetznerCloudCapacityOrder,
  inventory: HetznerCloudServerInventoryDto[],
): {
  operation: HetznerCloudCapacityOperationDto;
  inventory: HetznerCloudServerInventoryDto[];
} {
  return {
    operation: HetznerCloudCapacityOperationDtoSchema.parse(order.operation),
    inventory,
  };
}

function sshWireUint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

/** A throwaway Ed25519 public key for the disclosed write check. The private
 * half is never exported or stored, so the key cannot open any server even if
 * it outlives the check. Built from the raw 32-byte key (not ssh2), so it has
 * no leading-zero serialization hazard. */
export function generateHetznerWriteCheckKey(): { name: string; publicKey: string } {
  const { publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x?: unknown };
  const raw = typeof jwk.x === "string" ? Buffer.from(jwk.x, "base64url") : Buffer.alloc(0);
  if (raw.length !== 32) throw new HetznerCloudTokenCheckError("write_check_unconfirmed");
  const type = Buffer.from("ssh-ed25519", "ascii");
  const blob = Buffer.concat([sshWireUint32(type.length), type, sshWireUint32(raw.length), raw]);
  return {
    name: `${HETZNER_WRITE_CHECK_KEY_PREFIX}${randomBytes(6).toString("hex")}`,
    publicKey: `ssh-ed25519 ${blob.toString("base64")} hivra-check`,
  };
}

function exactWriteCheckKeyId(
  key: HetznerSshKey | null | undefined,
  name: string,
): number | null {
  return key
    && typeof key === "object"
    && key.name === name
    && Number.isSafeInteger(key.id)
    && key.id > 0
    ? key.id
    : null;
}

/**
 * Disclosed, non-billable proof that a token can change this project: add one
 * labelled SSH key, then delete it by its exact id. A read-only token fails
 * here, before any connection is saved or any price is reviewed. If the
 * delete fails, write access is still proven and the stray key's name is
 * returned so the user can remove it; it is never hidden.
 */
async function verifyHetznerProjectWriteAccess(
  provider: HetznerCloudProjectClient,
  deps: Dependencies,
): Promise<HetznerCloudWriteCheck> {
  const probe = deps.writeCheckKey();
  if (!HetznerWriteCheckKeyNameSchema.safeParse(probe.name).success) {
    throw new HetznerCloudTokenCheckError("write_check_unconfirmed");
  }
  let keyId: number | null = null;
  let createUncertain = false;
  try {
    keyId = exactWriteCheckKeyId(
      await provider.createSshKey({
        name: probe.name,
        publicKey: probe.publicKey,
        labels: { [HETZNER_WRITE_CHECK_LABEL]: "true" },
      }),
      probe.name,
    );
    createUncertain = keyId === null;
  } catch (error) {
    if (!(error instanceof HetznerCloudApiError)) throw providerFailure(error);
    if (error.providerCode === "token_readonly") {
      throw new HetznerCloudTokenCheckError("token_read_only");
    }
    if (error.status === 401 || error.providerCode === "unauthorized") {
      throw new HetznerCloudConnectionError("invalid_credentials");
    }
    if (error.providerCode === "resource_limit_exceeded") {
      throw new HetznerCloudTokenCheckError("write_check_blocked");
    }
    // A timeout or an unreadable success may still have created the key.
    // Anything else is a definite provider refusal or outage.
    if (error.code !== "timeout" && error.code !== "response_invalid") {
      throw providerFailure(error);
    }
    createUncertain = true;
  }
  if (createUncertain) {
    let matches: HetznerSshKey[];
    try {
      matches = (await provider.findSshKeysByName(probe.name)).filter((key) => (
        key.name === probe.name && key.labels?.[HETZNER_WRITE_CHECK_LABEL] === "true"
      ));
    } catch {
      throw new HetznerCloudTokenCheckError("write_check_unconfirmed", probe.name);
    }
    if (matches.length === 0) {
      // Nothing was written, so write access is unproven. Retrying is safe.
      throw new HetznerCloudTokenCheckError("write_check_unconfirmed");
    }
    keyId = matches.length === 1 ? exactWriteCheckKeyId(matches[0], probe.name) : null;
    if (keyId === null) return { strayKeyName: probe.name };
  }
  try {
    await provider.deleteSshKey(keyId as number);
    return { strayKeyName: null };
  } catch {
    return { strayKeyName: probe.name };
  }
}

export async function connectHetznerCloudProject(
  input: { userId: string; name: string; apiToken: string },
  dependencies: Partial<Dependencies> = {},
): Promise<{
  connection: HetznerCloudConnectionDto;
  inventory: HetznerCloudServerInventoryDto[];
  writeCheck: HetznerCloudWriteCheck;
}> {
  const deps = { ...defaultDependencies, ...dependencies };
  const discoveredAt = deps.now().toISOString();
  const provider = deps.client(input.apiToken);
  let inventory: SanitizedHetznerCloudServer[];
  try {
    // GET /servers both validates the project-scoped token and produces the
    // first inventory snapshot.
    const servers = await provider.listServers();
    inventory = servers.map((server) => sanitizeServer(server, discoveredAt));
  } catch (error) {
    throw providerFailure(error);
  }
  // The only mutation in this flow: the disclosed add-then-remove SSH key.
  const writeCheck = await verifyHetznerProjectWriteAccess(provider, deps);
  // Encryption and atomic persistence are deliberately outside the provider
  // error boundary so database or master-key failures retain their real class.
  const record = await deps.createRecord({ ...input, discoveredAt, inventory });
  return { ...record, writeCheck };
}

/** A secret-free failure class for logs: store codes only, never messages. */
function storeFailureType(error: unknown): string {
  return error instanceof InfrastructureConnectionStoreError ? error.code : error instanceof Error ? error.name : typeof error;
}

/** A 'creating' order updated this recently may still be inside its create
 * request (45-second route, 30-second dispatch budget). Mirrors the interval
 * in replace_hetzner_cloud_connection_token. */
export const HETZNER_SERVER_REQUEST_IN_FLIGHT_MS = 2 * 60_000;

/**
 * Does the new token reach the project this connection manages? Hetzner ids
 * are unique across projects, so seeing one server or generated SSH key Hivra
 * created here, one server the saved list saw, or a still-unconfirmed
 * request's server or key (by Hivra's generated name and exact labels) proves
 * it. Refuses only when Hivra holds something here that the token can't see.
 */
function sameProjectCheck(
  scope: HetznerCloudTokenReplacementScope,
  servers: HetznerServer[],
  sshKeys: HetznerSshKey[],
): HetznerCloudTokenProjectCheck {
  const serverIds = new Set(servers.map((server) => String(server.id)));
  const keyIds = new Set(sshKeys.map((key) => String(key.id)));
  const matched = scope.heldServerIds.some((id) => serverIds.has(id))
    || scope.heldSshKeyIds.some((id) => keyIds.has(id))
    || scope.knownServerIds.some((id) => serverIds.has(id))
    || scope.pendingOrders.some((order) => (
      servers.some((server) => server.name === order.serverName && labelsMatch(server.labels, order.providerLabels))
      || sshKeys.some((key) => key.name === capacitySshKeyName(order.orderId)
        && labelsMatch(key.labels, order.providerLabels))
    ));
  if (matched) return "confirmed";
  const holdsResources = scope.heldServerIds.length > 0
    || scope.heldSshKeyIds.length > 0
    || scope.pendingOrders.length > 0;
  if (holdsResources) throw new HetznerCloudTokenCheckError("token_project_mismatch");
  return "unconfirmed";
}

/**
 * Replace a Hetzner project token in place. Refused while a server request may
 * still be running. The new token must authenticate, reach the same project
 * (see sameProjectCheck) and pass the write check. The envelope is then
 * swapped at the same revision, so the generated SSH keys, setup enrollments
 * and targets bound to that revision all carry forward. Nothing is wiped or
 * re-created. Once the swap succeeds, no later failure reports "nothing was
 * replaced": a failed inventory write returns the saved list (or none), and a
 * read-back that doesn't show this token is `replaced_unconfirmed`.
 */
export async function replaceHetznerCloudToken(
  input: { userId: string; connectionId: string; apiToken: string },
  dependencies: Partial<Dependencies> = {},
): Promise<HetznerCloudTokenReplaceResult> {
  const deps = { ...defaultDependencies, ...dependencies };
  const scope = await deps.loadTokenReplacementScope(input.userId, input.connectionId);
  const nowMs = deps.now().getTime();
  // A purchase in flight must finish on the token it started with. The
  // database refuses the same window; checking first gives the real reason
  // instead of a project mismatch for a server that doesn't have an id yet.
  if (scope.pendingOrders.some((order) => order.status === "creating"
    && nowMs - Date.parse(order.updatedAt) < HETZNER_SERVER_REQUEST_IN_FLIGHT_MS)) {
    throw new HetznerCloudTokenReplaceError("server_request_in_progress");
  }
  const discoveredAt = deps.now().toISOString();
  const provider = deps.client(input.apiToken);
  let servers: HetznerServer[];
  let inventory: SanitizedHetznerCloudServer[];
  let sshKeys: HetznerSshKey[] = [];
  try {
    servers = await provider.listServers();
    inventory = servers.map((server) => sanitizeServer(server, discoveredAt));
    if (scope.heldSshKeyIds.length > 0 || scope.pendingOrders.length > 0) {
      sshKeys = await provider.listSshKeys();
    }
  } catch (error) {
    throw providerFailure(error);
  }
  const projectCheck = sameProjectCheck(scope, servers, sshKeys);
  const writeCheck = await verifyHetznerProjectWriteAccess(provider, deps);
  const outcome = await deps.replaceToken({
    userId: input.userId,
    connectionId: input.connectionId,
    expectedRevision: scope.revision,
    expectedEnvelope: scope.encryptedEnvelope,
    apiToken: input.apiToken,
  });
  if (outcome === "server_request_in_progress") throw new HetznerCloudTokenReplaceError("server_request_in_progress");
  if (outcome !== "replaced") throw new HetznerCloudTokenReplaceError("token_in_use");

  // The token is replaced from here on.
  let reconciled: HetznerCloudServerInventoryDto[] | null;
  try {
    reconciled = await deps.reconcileInventory({
      userId: input.userId,
      connectionId: input.connectionId,
      expectedRevision: scope.revision,
      discoveredAt,
      inventory,
    });
  } catch (error) {
    // A newer concurrent sync may have won the write (conflict), or the write
    // failed. Show whichever snapshot is saved; with none, the caller syncs.
    if (!(error instanceof InfrastructureConnectionStoreError && error.code === "conflict")) {
      log.warn("Hetzner token replaced but its inventory write failed", {
        source: "infrastructure/hetzner-cloud/token", requestId: input.connectionId, userId: input.userId,
        failureType: storeFailureType(error),
      });
    }
    reconciled = await deps.listInventory(input.userId, input.connectionId).catch(() => null);
  }
  // Read the saved envelope back through the bound-token path: this proves the
  // swap decrypts, belongs to this owner and revision, and holds this token.
  let saved: Awaited<ReturnType<typeof deps.loadSecret>>;
  try {
    saved = await deps.loadSecret(input.userId, input.connectionId, { requireBoundToken: true });
  } catch (error) {
    log.warn("Hetzner token replaced but the saved token could not be read back", {
      source: "infrastructure/hetzner-cloud/token", requestId: input.connectionId, userId: input.userId,
      failureType: storeFailureType(error),
    });
    throw new HetznerCloudTokenReplaceError("replaced_unconfirmed");
  }
  if (saved.revision !== scope.revision || saved.apiToken !== input.apiToken) {
    // Another change (most likely a second Replace token) landed straight after.
    log.warn("Hetzner token replaced but the connection changed again before read-back", {
      source: "infrastructure/hetzner-cloud/token", requestId: input.connectionId, userId: input.userId,
      failureType: saved.revision !== scope.revision ? "revision_changed" : "token_changed",
    });
    throw new HetznerCloudTokenReplaceError("replaced_unconfirmed");
  }
  return { connection: saved.connection, inventory: reconciled, writeCheck, projectCheck };
}

export async function getHetznerCloudInventory(
  userId: string,
  connectionId: string,
  dependencies: Partial<Dependencies> = {},
): Promise<HetznerCloudServerInventoryDto[]> {
  const deps = { ...defaultDependencies, ...dependencies };
  return deps.listInventory(userId, connectionId);
}

export async function refreshHetznerCloudInventory(
  userId: string,
  connectionId: string,
  dependencies: Partial<Dependencies> = {},
): Promise<HetznerCloudServerInventoryDto[]> {
  const deps = { ...defaultDependencies, ...dependencies };
  const loaded = await deps.loadSecret(userId, connectionId);
  const discoveredAt = deps.now().toISOString();
  let inventory: SanitizedHetznerCloudServer[];
  try {
    const servers = await deps.client(loaded.apiToken).listServers();
    inventory = servers.map((server) => sanitizeServer(server, discoveredAt));
  } catch (error) {
    const failure = providerFailure(error);
    await deps.recordFailure({
      userId,
      connectionId,
      expectedRevision: loaded.revision,
      checkedAt: discoveredAt,
      lastErrorCode: failure.code,
    });
    throw failure;
  }
  return deps.reconcileInventory({
    userId,
    connectionId,
    expectedRevision: loaded.revision,
    discoveredAt,
    inventory,
  });
}

export async function getHetznerCloudOfferCatalog(
  userId: string,
  connectionId: string,
  dependencies: Partial<Dependencies> = {},
): Promise<HetznerCloudOfferCatalogDto> {
  const deps = { ...defaultDependencies, ...dependencies };
  const loaded = await deps.loadSecret(userId, connectionId);
  const provider = deps.client(loaded.apiToken);
  return getHetznerCloudOfferCatalogForBoundClient(provider, deps.now().toISOString());
}

/** Build a live catalog through an already owner/revision-bound project
 * client. Callers must obtain that client from one validated secret read and
 * reuse the same instance for every provider observation in their operation. */
export async function getHetznerCloudOfferCatalogForBoundClient(
  provider: HetznerCloudProjectClient,
  fetchedAt: string,
): Promise<HetznerCloudOfferCatalogDto> {
  try {
    return (await fetchOfferCatalogSnapshot(provider, fetchedAt)).catalog;
  } catch (error) {
    if (error instanceof Error && error.name === "InfrastructureConnectionStoreError") {
      throw error;
    }
    throw providerFailure(error);
  }
}

async function loadCurrentProvider(input: {
  userId: string;
  connectionId: string;
  expectedRevision: number;
  deps: Dependencies;
}): Promise<HetznerCloudProjectClient> {
  let loaded: Awaited<ReturnType<typeof loadHetznerCloudConnectionSecret>>;
  try {
    loaded = await input.deps.loadSecret(input.userId, input.connectionId, {
      requireBoundToken: true,
    });
  } catch (error) {
    if (
      error instanceof InfrastructureConnectionStoreError
      && error.code === "credential_reconnect_required"
    ) {
      throw new HetznerCloudCapacityError("credential_reconnect_required");
    }
    throw error;
  }
  if (
    loaded.revision !== input.expectedRevision
    || loaded.connection.status !== "ready"
  ) {
    throw new HetznerCloudCapacityError("connection_changed");
  }
  return input.deps.client(loaded.apiToken);
}

async function rebuildFreshQuote(input: {
  order: StoredHetznerCloudCapacityOrder;
  provider: HetznerCloudProjectClient;
  now: Date;
}): Promise<HetznerCloudCapacityQuoteDto> {
  const stored = input.order.operation.quote;
  if (input.now.getTime() >= Date.parse(stored.expiresAt)) {
    throw new HetznerCloudCapacityError("quote_expired");
  }
  const snapshot = await fetchOfferCatalogSnapshot(
    input.provider,
    input.now.toISOString(),
  );
  const fresh = buildCapacityQuote({
    id: stored.id,
    connectionId: stored.connectionId,
    connectionRevision: input.order.connectionRevision,
    request: {
      serverTypeId: stored.serverType.id,
      locationId: stored.location.id,
      imageId: stored.image.id,
    },
    fetchedAt: input.now.toISOString(),
    expiresAt: stored.expiresAt,
    ...snapshot,
  });
  if (
    quoteFingerprint(fresh) !== input.order.quoteFingerprintSha256
    || quoteFingerprint(stored) !== input.order.quoteFingerprintSha256
  ) {
    throw new HetznerCloudCapacityError("quote_changed");
  }
  return fresh;
}

async function listInventoryAfterTargetedObservation(input: {
  userId: string;
  connectionId: string;
  expectedRevision: number;
  server: HetznerServer;
  deps: Dependencies;
}): Promise<HetznerCloudServerInventoryDto[]> {
  const discoveredAt = input.deps.now().toISOString();
  const sanitized = sanitizeServer(input.server, discoveredAt);
  try {
    await input.deps.upsertInventoryServer({
      userId: input.userId,
      connectionId: input.connectionId,
      expectedRevision: input.expectedRevision,
      server: sanitized,
    });
  } catch (error) {
    // A newer complete snapshot can legitimately win the generation race. In
    // that case the row must already be present; every other store error is a
    // real persistence failure.
    if (
      !(error instanceof InfrastructureConnectionStoreError)
      || error.code !== "conflict"
    ) {
      throw error;
    }
  }
  const inventory = await input.deps.listInventory(input.userId, input.connectionId);
  if (!inventory.some((server) => server.providerResourceId === String(input.server.id))) {
    throw new InfrastructureConnectionStoreError("conflict");
  }
  return inventory;
}

async function recordRejectedOrder(input: {
  userId: string;
  connectionId: string;
  idempotencyKey: string;
  order: StoredHetznerCloudCapacityOrder;
  code: HetznerCloudCapacityErrorCode;
  deps: Dependencies;
}): Promise<StoredHetznerCloudCapacityOrder> {
  if (input.order.operation.status !== "creating") return input.order;
  return input.deps.recordOrderResult({
    userId: input.userId,
    connectionId: input.connectionId,
    orderId: input.order.operation.id,
    idempotencyKey: input.idempotencyKey,
    status: "provider_rejected",
    errorCode: input.code,
    replayed: input.order.operation.replayed,
  });
}

async function recordAmbiguousOrder(input: {
  userId: string;
  connectionId: string;
  idempotencyKey: string;
  order: StoredHetznerCloudCapacityOrder;
  code: HetznerCloudCapacityErrorCode;
  providerServerId?: string | null;
  providerObservedAt?: string | null;
  observedServerStatus?: HetznerCloudCapacityOperationDto["observedServerStatus"];
  deps: Dependencies;
}): Promise<StoredHetznerCloudCapacityOrder> {
  if (
    input.order.operation.status !== "creating"
    && input.order.operation.status !== "ambiguous"
  ) {
    return input.order;
  }
  return input.deps.recordOrderResult({
    userId: input.userId,
    connectionId: input.connectionId,
    orderId: input.order.operation.id,
    idempotencyKey: input.idempotencyKey,
    status: "ambiguous",
    providerServerId: input.providerServerId,
    providerObservedAt: input.providerObservedAt,
    observedServerStatus: input.observedServerStatus,
    errorCode: input.code,
    replayed: input.order.operation.replayed,
  });
}

async function ensureCapacitySshKey(input: {
  userId: string;
  connectionId: string;
  idempotencyKey: string;
  order: StoredHetznerCloudCapacityOrder;
  bootstrap: HetznerBootstrapBundle;
  deps: Dependencies;
}): Promise<StoredHetznerCloudCapacityOrder> {
  if (
    input.order.providerSshKeyStatus === "accepted"
    && input.order.providerSshKeyId
  ) {
    return input.order;
  }

  const expectedName = capacitySshKeyName(input.order.operation.id);
  const provider = await loadCurrentProvider({
    userId: input.userId,
    connectionId: input.connectionId,
    expectedRevision: input.order.connectionRevision,
    deps: input.deps,
  });
  if (input.order.sshKeyPostAttemptedAt) {
    let exact: HetznerSshKey | null = null;
    try {
      exact = findExactSshKey({
        sshKeys: await provider.findSshKeysByName(expectedName),
        expectedName,
        expectedPublicKey: input.bootstrap.publicKeyOpenSsh,
        expectedFingerprint: input.bootstrap.publicKeyFingerprint,
        expectedLabels: input.order.providerLabels,
      });
    } catch {
      // An attempted provider mutation with no exact reconciliation evidence
      // stays ambiguous. It is never blindly retried.
    }
    if (exact) {
      return input.deps.recordSshKeyResult({
        userId: input.userId,
        connectionId: input.connectionId,
        orderId: input.order.operation.id,
        idempotencyKey: input.idempotencyKey,
        status: "accepted",
        providerSshKeyId: String(exact.id),
        replayed: true,
      });
    }
    return input.deps.recordSshKeyResult({
      userId: input.userId,
      connectionId: input.connectionId,
      orderId: input.order.operation.id,
      idempotencyKey: input.idempotencyKey,
      status: "ambiguous",
      errorCode: "provider_conflict",
      replayed: input.order.operation.replayed,
    });
  }

  if (input.deps.now().getTime() >= Date.parse(input.order.operation.quote.expiresAt)) {
    return recordRejectedOrder({ ...input, code: "quote_expired" });
  }

  const dispatchDeadline = input.deps.monotonicNow() + HETZNER_MUTATION_DISPATCH_BUDGET_MS;
  const marked = await input.deps.markSshKeyPostAttempted({
    userId: input.userId,
    connectionId: input.connectionId,
    expectedRevision: input.order.connectionRevision,
    orderId: input.order.operation.id,
    idempotencyKey: input.idempotencyKey,
    attemptedAt: input.deps.now().toISOString(),
  });
  if (!marked) throw new HetznerCloudCapacityError("connection_changed");
  // Keep the marker when a delayed acknowledgement exhausts authority. This
  // is not a provider rejection and must not enter provider-error recovery.
  assertCapacityDispatchWindow(dispatchDeadline, input.order.operation.quote.expiresAt, input.deps);

  let created: HetznerSshKey;
  try {
    created = await provider.createSshKey({
      name: expectedName,
      publicKey: input.bootstrap.publicKeyOpenSsh,
      labels: input.order.providerLabels,
    });
    if (!exactSshKey({
      sshKey: created,
      expectedName,
      expectedPublicKey: input.bootstrap.publicKeyOpenSsh,
      expectedFingerprint: input.bootstrap.publicKeyFingerprint,
      expectedLabels: input.order.providerLabels,
    })) {
      throw new HetznerCloudCapacityError("provider_response_invalid");
    }
  } catch (error) {
    const failure = capacityProviderFailure(error);
    let exact: HetznerSshKey | null = null;
    try {
      exact = findExactSshKey({
        sshKeys: await provider.findSshKeysByName(expectedName),
        expectedName,
        expectedPublicKey: input.bootstrap.publicKeyOpenSsh,
        expectedFingerprint: input.bootstrap.publicKeyFingerprint,
        expectedLabels: input.order.providerLabels,
      });
    } catch {
      // Preserve the original redacted provider class below.
    }
    if (exact) {
      return input.deps.recordSshKeyResult({
        userId: input.userId,
        connectionId: input.connectionId,
        orderId: input.order.operation.id,
        idempotencyKey: input.idempotencyKey,
        status: "accepted",
        providerSshKeyId: String(exact.id),
        replayed: input.order.operation.replayed,
      });
    }
    if (rejectionIsDefinitive(failure)) {
      return input.deps.recordSshKeyResult({
        userId: input.userId,
        connectionId: input.connectionId,
        orderId: input.order.operation.id,
        idempotencyKey: input.idempotencyKey,
        status: "rejected",
        errorCode: failure.code,
        replayed: input.order.operation.replayed,
      });
    }
    return input.deps.recordSshKeyResult({
      userId: input.userId,
      connectionId: input.connectionId,
      orderId: input.order.operation.id,
      idempotencyKey: input.idempotencyKey,
      status: "ambiguous",
      errorCode: failure.code,
      replayed: input.order.operation.replayed,
    });
  }
  return input.deps.recordSshKeyResult({
    userId: input.userId,
    connectionId: input.connectionId,
    orderId: input.order.operation.id,
    idempotencyKey: input.idempotencyKey,
    status: "accepted",
    providerSshKeyId: String(created.id),
    replayed: input.order.operation.replayed,
  });
}

async function observeCapacityOrder(input: {
  userId: string;
  connectionId: string;
  idempotencyKey: string;
  order: StoredHetznerCloudCapacityOrder;
  provider: HetznerCloudProjectClient;
  deps: Dependencies;
}): Promise<{
  order: StoredHetznerCloudCapacityOrder;
  inventory: HetznerCloudServerInventoryDto[];
}> {
  const operation = input.order.operation;
  if (!operation.providerServerId || !operation.providerActionId) {
    return {
      order: await recordAmbiguousOrder({ ...input, code: "provider_conflict" }),
      inventory: await input.deps.listInventory(input.userId, input.connectionId),
    };
  }
  const serverId = Number(operation.providerServerId);
  const mainExpected = {
    id: Number(operation.providerActionId),
    command: operation.providerActionCommand ?? "",
  };
  try {
    const [main, ...nextActions] = await Promise.all([
      input.provider.getAction(mainExpected.id),
      ...operation.providerNextActions.map((action) =>
        input.provider.getAction(Number(action.id)),
      ),
    ]);
    assertActionObservation(main, mainExpected, serverId, true, operation.quote.image.id);
    nextActions.forEach((action, index) => {
      assertActionObservation(
        action,
        {
          id: Number(operation.providerNextActions[index].id),
          command: operation.providerNextActions[index].command,
        },
        serverId,
        false,
      );
    });
    const server = await input.provider.getServer(serverId);
    assertServerIdentityMatchesQuote(server, operation.quote, input.order.providerLabels);
    assertNextActionResourcesMatchServer(nextActions, server);
    if (input.order.creationReceipt) {
      assertHetznerCreationReceiptMatchesObservation(
        input.order.creationReceipt, server, main, nextActions,
      );
    }
    const observedAt = input.deps.now().toISOString();
    const observedServerStatus = normalizeServerStatus(server.status);
    const inventory = await listInventoryAfterTargetedObservation({
      userId: input.userId,
      connectionId: input.connectionId,
      expectedRevision: input.order.connectionRevision,
      server,
      deps: input.deps,
    });
    const nextReceipts = nextActions.map(actionReceipt);
    const observedOrder = await input.deps.recordOrderProgress({
      userId: input.userId,
      connectionId: input.connectionId,
      orderId: operation.id,
      idempotencyKey: input.idempotencyKey,
      providerServerId: String(serverId),
      providerActionId: String(main.id),
      providerActionCommand: main.command,
      providerActionStatus: main.status,
      providerNextActions: nextReceipts,
      providerObservedAt: observedAt,
      observedServerStatus,
      replayed: operation.replayed,
    });
    if (main.status === "error" || nextActions.some((action) => action.status === "error")) {
      return {
        order: await recordAmbiguousOrder({
          ...input,
          order: observedOrder,
          code: "provider_action_failed",
          providerServerId: String(serverId),
        }),
        inventory,
      };
    }
    if (
      main.status === "success"
      && nextActions.every((action) => action.status === "success")
      && observedServerStatus === "off"
    ) {
      assertFinalServerMatchesQuote(server, operation.quote, input.order.providerLabels);
      const order = await input.deps.recordOrderResult({
        userId: input.userId,
        connectionId: input.connectionId,
        orderId: operation.id,
        idempotencyKey: input.idempotencyKey,
        status: "created_off",
        providerServerId: String(serverId),
        providerActionId: String(main.id),
        providerActionCommand: main.command,
        providerActionStatus: main.status,
        providerNextActions: nextReceipts,
        providerObservedAt: observedAt,
        observedServerStatus: "off",
        replayed: operation.replayed,
      });
      return { order, inventory };
    }
    if (
      observedServerStatus === "running"
      || observedServerStatus === "starting"
      || observedServerStatus === "unknown"
    ) {
      return {
        order: await recordAmbiguousOrder({
          ...input,
          order: observedOrder,
          code: "provider_response_invalid",
          providerServerId: String(serverId),
        }),
        inventory,
      };
    }
    return { order: observedOrder, inventory };
  } catch (error) {
    if (error instanceof InfrastructureConnectionStoreError) throw error;
    const failure = capacityProviderFailure(error);
    let observedServer: HetznerServer | null = null;
    try {
      const candidate = await input.provider.getServer(serverId);
      assertServerIdentityMatchesQuote(
        candidate,
        operation.quote,
        input.order.providerLabels,
      );
      observedServer = candidate;
    } catch {
      // Action and server observations are independent. Malformed or missing
      // server evidence cannot be used to update the durable receipt.
    }
    if (observedServer) {
      const providerObservedAt = input.deps.now().toISOString();
      const observedServerStatus = normalizeServerStatus(observedServer.status);
      const inventory = await listInventoryAfterTargetedObservation({
        userId: input.userId,
        connectionId: input.connectionId,
        expectedRevision: input.order.connectionRevision,
        server: observedServer,
        deps: input.deps,
      });
      const order = await recordAmbiguousOrder({
        ...input,
        code: failure.code,
        providerServerId: String(serverId),
        providerObservedAt,
        observedServerStatus,
      });
      return { order, inventory };
    }
    return {
      order: await recordAmbiguousOrder({ ...input, code: failure.code }),
      inventory: await input.deps.listInventory(input.userId, input.connectionId),
    };
  }
}

export async function quoteHetznerCloudCapacity(
  userId: string,
  connectionId: string,
  rawRequest: HetznerCloudCapacityQuoteRequest,
  dependencies: Partial<Dependencies> = {},
): Promise<HetznerCloudCapacityQuoteDto> {
  const deps = { ...defaultDependencies, ...dependencies };
  const request = HetznerCloudCapacityQuoteRequestSchema.parse(rawRequest);
  let loaded: Awaited<ReturnType<typeof loadHetznerCloudConnectionSecret>>;
  try {
    loaded = await deps.loadSecret(userId, connectionId, {
      requireBoundToken: true,
    });
  } catch (error) {
    if (
      error instanceof InfrastructureConnectionStoreError
      && error.code === "credential_reconnect_required"
    ) {
      throw new HetznerCloudCapacityError("credential_reconnect_required");
    }
    throw error;
  }
  if (loaded.connection.status !== "ready") {
    throw new HetznerCloudCapacityError("connection_changed");
  }
  const provider = deps.client(loaded.apiToken);
  const id = deps.newId();
  const fetchedAt = deps.now();
  let quote: HetznerCloudCapacityQuoteDto;
  try {
    const [snapshot, servers] = await Promise.all([
      fetchOfferCatalogSnapshot(provider, fetchedAt.toISOString()),
      provider.findServersByName(capacityServerName(id)),
    ]);
    quote = buildCapacityQuote({
      id,
      connectionId,
      connectionRevision: loaded.revision,
      request,
      fetchedAt: fetchedAt.toISOString(),
      expiresAt: new Date(fetchedAt.getTime() + HETZNER_QUOTE_TTL_MS).toISOString(),
      ...snapshot,
    });
    if (servers.some((server) => server.name === quote.serverName)) {
      throw new HetznerCloudCapacityError("provider_conflict");
    }
  } catch (error) {
    throw capacityProviderFailure(error);
  }
  const fingerprint = quoteFingerprint(quote);
  try {
    return await deps.createQuote({
      userId,
      connectionId,
      expectedRevision: loaded.revision,
      quote,
      providerLabels: providerLabels(id, fingerprint),
      quoteFingerprintSha256: fingerprint,
    });
  } catch (error) {
    if (
      error instanceof InfrastructureConnectionStoreError
      && error.code === "quote_limit"
    ) {
      throw new HetznerCloudCapacityError("quote_rate_limited");
    }
    throw error;
  }
}

export function createHetznerCloudCapacity(
  userId: string,
  connectionId: string,
  rawRequest: HetznerCloudCapacityCreateRequest,
  dependencies: Partial<Dependencies> = {},
) {
  return createCapacityWithRecipe(userId,connectionId,rawRequest,dependencies,null);
}

type FirstBootPreparation = {
  confirmation:typeof FIRST_BOOT_PREPARATION_CONFIRMATION;
  callbackOrigin:string;
};

/** Private integration point; no public route calls this yet. The eventual
 * authenticated caller must explain/confirm preparation separately from price
 * consent and supply callbackOrigin from trusted deployment configuration.
 * This still creates powered OFF. The separate coordinator owns first boot.
 */
export function createPreparedHetznerCloudCapacity(
  userId:string,connectionId:string,rawRequest:HetznerCloudCapacityCreateRequest,
  preparation:FirstBootPreparation,dependencies:Partial<Dependencies>={},
) {
  if(preparation?.confirmation!==FIRST_BOOT_PREPARATION_CONFIRMATION
    || typeof preparation.callbackOrigin!=="string") throw new HetznerCloudCapacityError("access_setup_failed");
  return createCapacityWithRecipe(userId,connectionId,rawRequest,dependencies,{...preparation});
}

async function createCapacityWithRecipe(
  userId:string,connectionId:string,rawRequest:HetznerCloudCapacityCreateRequest,
  dependencies:Partial<Dependencies>,preparation:FirstBootPreparation|null,
): Promise<{
  operation: HetznerCloudCapacityOperationDto;
  inventory: HetznerCloudServerInventoryDto[];
}> {
  const deps = { ...defaultDependencies, ...dependencies };
  const request = HetznerCloudCapacityCreateRequestSchema.parse(rawRequest);
  const storedQuote = await deps.loadQuote({
    userId,
    connectionId,
    quoteId: request.quoteId,
  });
  if (
    quoteFingerprint(storedQuote.quote) !== storedQuote.quoteFingerprintSha256
    || storedQuote.quote.connectionRevision !== storedQuote.connectionRevision
  ) {
    throw new HetznerCloudCapacityError("quote_changed");
  }
  const bootstrap = deps.generateBootstrap({
    userId,
    connectionId,
    connectionRevision: storedQuote.connectionRevision,
    orderId: request.quoteId,
    quoteFingerprintSha256: storedQuote.quoteFingerprintSha256,
  });
  const claimed = await deps.claimOrder({
    userId,
    connectionId,
    expectedRevision: storedQuote.connectionRevision,
    quoteId: request.quoteId,
    idempotencyKey: request.idempotencyKey,
    bootstrap,
    now: deps.now().toISOString(),
  });
  if (claimed.outcome === "not_found") {
    throw new HetznerCloudCapacityError("selection_invalid");
  }
  if (claimed.outcome === "quote_expired") {
    throw new HetznerCloudCapacityError("quote_expired");
  }
  if (claimed.outcome === "connection_changed") {
    throw new HetznerCloudCapacityError("connection_changed");
  }
  if (
    claimed.outcome === "idempotency_conflict"
    || claimed.outcome === "unresolved_operation"
  ) {
    throw new HetznerCloudCapacityError("idempotency_conflict");
  }
  if (claimed.outcome === "canary_capacity_limit") {
    throw new HetznerCloudCapacityError("canary_capacity_limit");
  }
  if (claimed.outcome !== "claimed" && claimed.outcome !== "replay") {
    throw new HetznerCloudCapacityError("provider_response_invalid");
  }

  let order = claimed.order;
  if (order.operation.externalCleanupResolutionId) {
    return capacityOperationResult(order, await deps.listInventory(userId, connectionId));
  }
  const firstBootScope={binding:{userId,connectionId,connectionRevision:order.connectionRevision,
    orderId:order.operation.id,quoteFingerprint:order.quoteFingerprintSha256,recipeVersion:FIRST_BOOT_RECIPE_VERSION},
  capacityIdempotencyKey:request.idempotencyKey};
  if(preparation && order.serverPostAttemptedAt) {
    // A retry observes an original prepared purchase; it never upgrades an
    // already-created capacity-only disk or rotates its enrollment capability.
    if(!await deps.firstBootEnrollment(firstBootScope)) throw new HetznerCloudCapacityError("access_setup_failed");
  }
  if (
    order.operation.status === "created_off"
    || order.operation.status === "provider_rejected"
    || order.operation.status === "cleaning"
    || order.operation.status === "deleted"
  ) {
    return capacityOperationResult(
      order,
      await deps.listInventory(userId, connectionId),
    );
  }
  const replayObservedAt = deps.now();
  if (
    order.serverPostAttemptedAt
    && mutationReconcileLeaseActive(order.serverPostAttemptedAt, replayObservedAt)
  ) {
    return capacityOperationResult(
      order,
      await deps.listInventory(userId, connectionId),
    );
  }
  if (
    order.sshKeyPostAttemptedAt
    && order.providerSshKeyStatus !== "accepted"
    && mutationReconcileLeaseActive(order.sshKeyPostAttemptedAt, replayObservedAt)
  ) {
    return capacityOperationResult(
      order,
      await deps.listInventory(userId, connectionId),
    );
  }
  const activeBootstrap = claimed.execute
    ? bootstrap
    : await deps.loadBootstrap({
        userId,
        connectionId,
        expectedRevision: order.connectionRevision,
        orderId: order.operation.id,
        idempotencyKey: request.idempotencyKey,
        quoteFingerprintSha256: order.quoteFingerprintSha256,
      });

  let provider = await loadCurrentProvider({
    userId,
    connectionId,
    expectedRevision: order.connectionRevision,
    deps,
  });
  if (order.serverPostAttemptedAt) {
    if (order.operation.providerServerId && order.operation.providerActionId) {
      const observed = await observeCapacityOrder({
        userId,
        connectionId,
        idempotencyKey: request.idempotencyKey,
        order,
        provider,
        deps,
      });
      return capacityOperationResult(observed.order, observed.inventory);
    }
    try {
      const server = findExactServer({
        servers: await provider.findServersByName(order.operation.quote.serverName),
        quote: order.operation.quote,
        labels: order.providerLabels,
      });
      if (server) {
        const providerObservedAt = deps.now().toISOString();
        const observedServerStatus = normalizeServerStatus(server.status);
        const inventory = await listInventoryAfterTargetedObservation({
          userId,
          connectionId,
          expectedRevision: order.connectionRevision,
          server,
          deps,
        });
        order = await recordAmbiguousOrder({
          userId,
          connectionId,
          idempotencyKey: request.idempotencyKey,
          order,
          code: "provider_conflict",
          providerServerId: String(server.id),
          providerObservedAt,
          observedServerStatus,
          deps,
        });
        return capacityOperationResult(order, inventory);
      }
    } catch {
      // The durable POST marker forbids a blind retry even when reconciliation
      // itself fails or returns malformed provider data.
    }
    order = await recordAmbiguousOrder({
      userId,
      connectionId,
      idempotencyKey: request.idempotencyKey,
      order,
      code: "provider_conflict",
      deps,
    });
    return capacityOperationResult(order, await deps.listInventory(userId, connectionId));
  }

  if (order.sshKeyPostAttemptedAt) {
    order = await ensureCapacitySshKey({
      userId,
      connectionId,
      idempotencyKey: request.idempotencyKey,
      order,
      bootstrap: activeBootstrap,
      deps,
    });
    if (order.providerSshKeyStatus !== "accepted" || !order.providerSshKeyId) {
      return capacityOperationResult(order, await deps.listInventory(userId, connectionId));
    }
  }

  try {
    const freshQuote = await rebuildFreshQuote({ order, provider, now: deps.now() });
    // Prepared creation will reuse the existing guest installer, whose current
    // supported base is Ubuntu 22.04/amd64. Reject before a new provider key or
    // server can be created. Earlier POSTs are reconciled above, not stranded
    // by a newer image policy. Capacity-only creation keeps its own contract.
    // The create dialog lists only this same base (hetzner-guided-setup).
    if (preparation && (
      !isHetznerGuidedSetupServerType(freshQuote.serverType)
      || !isHetznerGuidedSetupImage(freshQuote.image)
    )) {
      throw new HetznerCloudCapacityError("access_setup_failed");
    }
  } catch (error) {
    const failure = capacityProviderFailure(error);
    order = await recordRejectedOrder({
      userId,
      connectionId,
      idempotencyKey: request.idempotencyKey,
      order,
      code: failure.code,
      deps,
    });
    return capacityOperationResult(order, await deps.listInventory(userId, connectionId));
  }

  if (!order.sshKeyPostAttemptedAt) {
    order = await ensureCapacitySshKey({
      userId,
      connectionId,
      idempotencyKey: request.idempotencyKey,
      order,
      bootstrap: activeBootstrap,
      deps,
    });
  }
  if (order.providerSshKeyStatus !== "accepted" || !order.providerSshKeyId) {
    return capacityOperationResult(order, await deps.listInventory(userId, connectionId));
  }

  try {
    provider = await loadCurrentProvider({
      userId,
      connectionId,
      expectedRevision: order.connectionRevision,
      deps,
    });
    await rebuildFreshQuote({ order, provider, now: deps.now() });
    if ((await provider.findServersByName(order.operation.quote.serverName)).some(
      (server) => server.name === order.operation.quote.serverName,
    )) {
      throw new HetznerCloudCapacityError("provider_conflict");
    }
  } catch (error) {
    const failure = capacityProviderFailure(error);
    order = await recordRejectedOrder({
      userId,
      connectionId,
      idempotencyKey: request.idempotencyKey,
      order,
      code: failure.code,
      deps,
    });
    return capacityOperationResult(order, await deps.listInventory(userId, connectionId));
  }

  // Reconcile an earlier SSH-key POST and close expired/changed quotes before
  // opening any preparation capability. Stage only once the server is next;
  // an unrelated SSH-key ambiguity must not revoke a not-yet-used recipe.
  const preparedRecipe=preparation ? await deps.firstBootRecipe({...firstBootScope,...preparation,
    publicKeyOpenSsh:activeBootstrap.publicKeyOpenSsh}) : null;
  const serverPayload = {
    name: order.operation.quote.serverName,
    server_type: String(order.operation.quote.serverType.id),
    image: String(order.operation.quote.image.id),
    location: String(order.operation.quote.location.id),
    user_data: preparedRecipe?.userData ?? cloudInitForBootstrap(activeBootstrap.publicKeyOpenSsh),
    ssh_keys: [order.providerSshKeyId],
    labels: order.providerLabels,
    start_after_create: false as const,
    public_net: { enable_ipv4: true as const, enable_ipv6: true as const },
    volumes: [] as [],
  };
  if (deps.now().getTime() >= Date.parse(order.operation.quote.expiresAt)) {
    order = await recordRejectedOrder({
      userId,
      connectionId,
      idempotencyKey: request.idempotencyKey,
      order,
      code: "quote_expired",
      deps,
    });
    return capacityOperationResult(order, await deps.listInventory(userId, connectionId));
  }
  const dispatchDeadline = deps.monotonicNow() + HETZNER_MUTATION_DISPATCH_BUDGET_MS;
  const markerInput = {
    userId,
    connectionId,
    expectedRevision: order.connectionRevision,
    orderId: order.operation.id,
    idempotencyKey: request.idempotencyKey,
    providerSshKeyId: order.providerSshKeyId,
    attemptedAt: deps.now().toISOString(),
  };
  const marked = preparedRecipe
    ? await deps.markFirstBootServerPost({...markerInput,expectedEnrollment:preparedRecipe.expectedEnrollment})
    : await deps.markServerPostAttempted(markerInput);
  if (!marked) throw new HetznerCloudCapacityError("connection_changed");
  assertCapacityDispatchWindow(dispatchDeadline, order.operation.quote.expiresAt, deps);
  if(preparedRecipe && deps.now().getTime()>=Date.parse(preparedRecipe.enrollmentExpiresAt)) {
    throw new HetznerCloudCapacityError("access_setup_failed");
  }

  let created: HetznerProjectCreateServerResult | null = null;
  let creationReceipt: HetznerCreationReceipt;
  let createdIdentityValidated = false;
  try {
    created = await provider.createServer(serverPayload);
    assertServerIdentityMatchesQuote(
      created.server,
      order.operation.quote,
      order.providerLabels,
    );
    createdIdentityValidated = true;
    assertCreateActions({
      action: created.action,
      nextActions: created.nextActions,
      providerServerId: created.server.id,
      providerImageId: order.operation.quote.image.id,
    });
    creationReceipt = createHetznerCreationReceipt(
      created.server, created.action, created.nextActions,
    );
  } catch (error) {
    const failure = capacityProviderFailure(error);
    let exactServer: HetznerServer | null = null;
    try {
      exactServer = findExactServer({
        servers: await provider.findServersByName(order.operation.quote.serverName),
        quote: order.operation.quote,
        labels: order.providerLabels,
      });
    } catch {
      // The durable marker still forbids retry; classification remains safe.
    }
    let inventory = await deps.listInventory(userId, connectionId);
    if (exactServer) {
      inventory = await listInventoryAfterTargetedObservation({
        userId,
        connectionId,
        expectedRevision: order.connectionRevision,
        server: exactServer,
        deps,
      });
    }
    const observedServer = exactServer
      ?? (createdIdentityValidated ? created?.server ?? null : null);
    const providerObservedAt = observedServer ? deps.now().toISOString() : null;
    const observedServerStatus = observedServer
      ? normalizeServerStatus(observedServer.status)
      : null;
    order = await recordAmbiguousOrder({
      userId,
      connectionId,
      idempotencyKey: request.idempotencyKey,
      order,
      code: failure.code,
      providerServerId: observedServer ? String(observedServer.id) : null,
      providerObservedAt,
      observedServerStatus,
      deps,
    });
    return capacityOperationResult(order, inventory);
  }

  const providerObservedAt = deps.now().toISOString();
  const observedServerStatus = normalizeServerStatus(created.server.status);
  order = await deps.recordOrderProgress({
    userId,
    connectionId,
    orderId: order.operation.id,
    idempotencyKey: request.idempotencyKey,
    providerServerId: String(created.server.id),
    providerActionId: String(created.action.id),
    providerActionCommand: created.action.command,
    providerActionStatus: created.action.status,
    providerNextActions: created.nextActions.map(actionReceipt),
    creation: { expectedRevision: order.connectionRevision, receipt: creationReceipt },
    providerObservedAt,
    observedServerStatus,
    replayed: order.operation.replayed,
  });
  if (
    observedServerStatus === "running"
    || observedServerStatus === "starting"
    || observedServerStatus === "unknown"
  ) {
    order = await recordAmbiguousOrder({
      userId,
      connectionId,
      idempotencyKey: request.idempotencyKey,
      order,
      code: "provider_response_invalid",
      providerServerId: String(created.server.id),
      deps,
    });
    return capacityOperationResult(order, await deps.listInventory(userId, connectionId));
  }
  const observed = await observeCapacityOrder({
    userId,
    connectionId,
    idempotencyKey: request.idempotencyKey,
    order,
    provider,
    deps,
  });
  return capacityOperationResult(observed.order, observed.inventory);
}

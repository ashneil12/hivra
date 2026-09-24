/**
 * Hetzner Cloud API v1 — thin REST client
 */

import { log } from "@/lib/logger";
import {
  firstBootFirewallRequest, firstBootFirewallReceipt, firstBootPowerOnAction,
  type FirstBootFirewallScope, type FirstBootFirewallReceipt,
} from "./first-boot-firewall";
import { HETZNER_POWER_ACTIONS, HetznerPowerRequest, HetznerPowerObservation, parseHetznerPowerAction,
  type HetznerPowerAction, type HetznerPowerKind } from "./power-action";

const LOG_SOURCE = "hetzner-client";

const HETZNER_API = "https://api.hetzner.cloud/v1";
const HETZNER_USER_DATA_MAX_LENGTH = 32768;
const HETZNER_ERROR_BODY_MAX_BYTES = 8 * 1024;

const HETZNER_PROVIDER_ERROR_CODES = [
  "token_readonly",
  "unauthorized",
  "forbidden",
  "resource_limit_exceeded",
  "maintenance",
  "rate_limit_exceeded",
  "invalid_input",
  "uniqueness_error",
  "conflict",
  "resource_unavailable",
  "service_error",
  "server_error",
  "bad_gateway",
  "timeout",
  "unknown_error",
  "locked",
  "resource_locked",
  "unavailable",
  "not_found",
] as const;

export type HetznerProviderErrorCode =
  (typeof HETZNER_PROVIDER_ERROR_CODES)[number];

const HETZNER_PROVIDER_ERROR_CODE_SET = new Set<string>(
  HETZNER_PROVIDER_ERROR_CODES,
);

type FetchLike = typeof fetch;

export class HetznerCloudApiError extends Error {
  constructor(
    public readonly status: number | null,
    public readonly method: string,
    public readonly path: string,
    public readonly code: "request_failed" | "timeout" | "response_invalid",
    public readonly providerCode: HetznerProviderErrorCode | null = null,
  ) {
    super(
      code === "timeout"
        ? `Hetzner Cloud API ${method} request timed out.`
        : `Hetzner Cloud API ${method} request failed${status === null ? "" : ` with status ${status}`}.`,
    );
    this.name = "HetznerCloudApiError";
  }
}

async function readProviderErrorCode(
  response: Response,
): Promise<HetznerProviderErrorCode | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > HETZNER_ERROR_BODY_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    const code =
      parsed && typeof parsed === "object" && "error" in parsed
        ? (parsed as { error?: unknown }).error
        : null;
    const providerCode =
      code && typeof code === "object" && "code" in code
        ? (code as { code?: unknown }).code
        : null;
    return typeof providerCode === "string"
      && HETZNER_PROVIDER_ERROR_CODE_SET.has(providerCode)
      ? providerCode as HetznerProviderErrorCode
      : null;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return null;
  }
}

function token(): string {
  const t = process.env.HETZNER_API_TOKEN;
  if (!t) throw new Error("HETZNER_API_TOKEN not set");
  return t;
}

function assertValidUserDataLength(userData?: string): void {
  if (!userData) return;

  const length = Buffer.byteLength(userData, "utf8");
  if (length > HETZNER_USER_DATA_MAX_LENGTH) {
    throw new Error(
      `Hetzner user_data length ${length} exceeds ${HETZNER_USER_DATA_MAX_LENGTH} bytes before request`
    );
  }

  if (length > HETZNER_USER_DATA_MAX_LENGTH * 0.9) {
    log.warn("user_data length nearing maximum", {
      source: LOG_SOURCE,
      failureType: "user_data_length_warn",
      length,
      maxLength: HETZNER_USER_DATA_MAX_LENGTH,
    });
  }
}

async function hetznerFetch<T = unknown>(
  path: string,
  options: RequestInit = {},
  apiToken = token(),
  fetchImpl: FetchLike = fetch,
  expectedStatus?: number,
): Promise<T> {
  if (!path.startsWith("/") || path.includes("://")) {
    throw new Error("Hetzner Cloud API path must be relative to the fixed v1 endpoint");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const headers = new Headers(options.headers);
    // Provider credentials are injected here and cannot be overridden by a
    // caller-supplied header. The API origin is fixed above.
    headers.set("Authorization", `Bearer ${apiToken}`);
    headers.set("Content-Type", "application/json");
    const res = await fetchImpl(`${HETZNER_API}${path}`, {
      ...options,
      // Never follow a provider redirect with an Authorization header or
      // replay a mutation to a second URL.
      redirect: "error",
      signal: controller.signal,
      headers,
    });

    if (!res.ok) {
      // Only retain a size-bounded allowlisted provider code. Messages,
      // details, reflected request data, and raw response bodies never cross
      // this boundary or enter application logs.
      const providerCode = await readProviderErrorCode(res);
      throw new HetznerCloudApiError(
        res.status,
        options.method || "GET",
        path,
        "request_failed",
        providerCode,
      );
    }

    if (expectedStatus !== undefined && res.status !== expectedStatus) {
      throw new HetznerCloudApiError(
        res.status,
        options.method || "GET",
        path,
        "response_invalid",
      );
    }

    if (res.status === 204) return {} as T;
    // Keep the abort deadline active while the body is streaming and parsing.
    // A provider that sends headers but stalls the JSON body must not hold an
    // authenticated route open indefinitely.
    return await (res.json() as Promise<T>);
  } catch (err: unknown) {
    if (err instanceof HetznerCloudApiError) throw err;
    // The owned deadline is authoritative even when fetch throws a DOMException
    // from another realm, which need not satisfy this realm's instanceof Error.
    if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
      throw new HetznerCloudApiError(null, options.method || "GET", path, "timeout");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    // Early rejection (for example an unexpected successful HTTP status) may
    // leave an unread response streaming. No caller receives the body, so keep
    // ownership of its lifetime and close the request on every exit path.
    controller.abort();
  }
}

export interface HetznerServer {
  id: number;
  name: string;
  status:
    | "running"
    | "off"
    | "initializing"
    | "starting"
    | "stopping"
    | "deleting"
    | "rebuilding"
    | "migrating"
    | "unknown";
  public_net: {
    ipv4: { id?: number; ip: string } | null;
    ipv6: { id?: number; ip: string } | null;
    floating_ips?: number[];
    firewalls?: Array<{ id: number; status: string }>;
  };
  created: string;
  labels?: Record<string, string>;
  backup_window?: string | null;
  volumes?: number[];
  primary_disk_size?: number;
  rescue_enabled?: boolean;
  iso?: unknown | null;
  private_net?: unknown[];
  locked?: boolean;
  protection?: {
    delete: boolean;
    rebuild: boolean;
  };
  load_balancers?: number[];
  placement_group?: unknown | null;
  server_type: HetznerServerType;
  image?: HetznerImage | null;
  location?: HetznerLocation;
  datacenter?: {
    id: number;
    name: string;
    description: string;
    location: HetznerLocation;
  };
}

export interface HetznerServerType {
  id: number;
  name: string;
  description: string | null;
  cores: number;
  memory: number;
  disk: number;
  storage_type?: "local" | "network";
  cpu_type?: "shared" | "dedicated";
  architecture?: "x86" | "arm";
  deprecated?: boolean | null;
  locations?: Array<{
    id: number;
    name: string;
    available: boolean;
    recommended: boolean;
    deprecation?: {
      unavailable_after?: string | null;
      announced?: string | null;
    } | null;
  }>;
}

export interface HetznerLocation {
  id: number;
  name: string;
  description?: string;
  country: string;
  city: string;
  latitude?: number;
  longitude?: number;
  network_zone: string;
}

interface HetznerProjectCreateServerPayload {
  name: string;
  server_type: string;
  image: string;
  location: string;
  user_data: string;
  ssh_keys: string[];
  labels: Record<string, string>;
  start_after_create: false;
  public_net: {
    enable_ipv4: true;
    enable_ipv6: true;
  };
  volumes: [];
}

interface CreateServerPayload {
  name: string;
  server_type: string;
  image: string;
  location: string;
  user_data?: string;
  ssh_keys?: number[];
  labels?: Record<string, string>;
  backups?: boolean;
}

export interface HetznerImage {
  id: number;
  type: "system" | "snapshot" | "backup" | "app";
  status: "available" | "creating" | "unavailable";
  name: string | null;
  description: string;
  image_size: number;
  disk_size: number;
  created: string;
  deleted: string | null;
  created_from: unknown | null;
  bound_to: number | null;
  architecture?: "x86" | "arm";
  os_flavor?: string;
  os_version?: string | null;
  deprecated?: string | null;
}

export interface HetznerPricing {
  currency: string;
  vat_rate: string;
  primary_ips: Array<{
    type: "ipv4" | "ipv6";
    prices: Array<{
      location: string;
      price_hourly: { net: string; gross: string };
      price_monthly: { net: string; gross: string };
    }>;
  }>;
  server_types: Array<{
    id: number;
    name: string;
    prices: Array<{
      location: string;
      price_hourly: { net: string; gross: string };
      price_monthly: { net: string; gross: string };
      included_traffic: number;
      price_per_tb_traffic: { net: string; gross: string };
    }>;
  }>;
}

export interface HetznerSshKey {
  id: number;
  name: string;
  fingerprint: string;
  public_key: string;
  labels: Record<string, string>;
  created: string;
}

export interface HetznerPrimaryIp {
  id: number;
  ip: string;
  type: "ipv4" | "ipv6";
  assignee_id: number | null;
  assignee_type: string;
  protection: { delete: boolean };
  auto_delete: boolean;
  blocked: boolean;
  labels: Record<string, string>;
}

export interface HetznerAction {
  id: number;
  status: "running" | "success" | "error";
  command: string;
  resources: Array<{ id: number; type: string }>;
}

export interface HetznerProjectCreateServerResult {
  server: HetznerServer;
  action: HetznerAction;
  nextActions: HetznerAction[];
}

function sanitizeAction(value: unknown): HetznerAction | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<HetznerAction>;
  if (
    !Number.isSafeInteger(candidate.id)
    || Number(candidate.id) <= 0
    || !["running", "success", "error"].includes(String(candidate.status))
    || typeof candidate.command !== "string"
    || !/^[a-z][a-z0-9_]{0,63}$/.test(candidate.command)
    || !Array.isArray(candidate.resources)
    || candidate.resources.length === 0
    || candidate.resources.length > 16
  ) {
    return null;
  }
  const resources = candidate.resources.map((resource) => {
    if (
      !resource
      || typeof resource !== "object"
      || !Number.isSafeInteger(resource.id)
      || resource.id <= 0
      || typeof resource.type !== "string"
      || !/^[a-z][a-z0-9_]{0,63}$/.test(resource.type)
    ) {
      return null;
    }
    return { id: resource.id, type: resource.type };
  });
  if (resources.some((resource) => resource === null)) return null;
  return {
    id: Number(candidate.id),
    status: candidate.status as HetznerAction["status"],
    command: candidate.command,
    resources: resources as HetznerAction["resources"],
  };
}

type Pagination = {
  pagination: {
    page: number;
    per_page: number;
    previous_page: number | null;
    next_page: number | null;
    last_page: number | null;
    total_entries: number | null;
  };
};

async function listAll<T>(
  resourcePath: string,
  key: string,
  apiToken: string,
  fetchImpl: FetchLike,
): Promise<T[]> {
  const output: T[] = [];
  let page = 1;
  let expectedLastPage: number | null | undefined;
  let expectedTotalEntries: number | null = null;
  for (;;) {
    const separator = resourcePath.includes("?") ? "&" : "?";
    const response = await hetznerFetch<Record<string, unknown> & { meta?: Pagination }>(
      `${resourcePath}${separator}per_page=50&page=${page}`,
      {},
      apiToken,
      fetchImpl,
    );
    const values = response[key];
    if (!Array.isArray(values)) {
      throw new HetznerCloudApiError(502, "GET", resourcePath, "request_failed");
    }

    const pagination = response.meta?.pagination;
    if (
      !pagination
      || !Number.isSafeInteger(pagination.page)
      || pagination.page !== page
      || !Number.isSafeInteger(pagination.per_page)
      || pagination.per_page <= 0
      || pagination.per_page > 50
      || (
        pagination.last_page !== null
        && (
          !Number.isSafeInteger(pagination.last_page)
          || pagination.last_page < page
          || pagination.last_page > 10_000
        )
      )
      || (
        pagination.total_entries !== null
        && (
          !Number.isSafeInteger(pagination.total_entries)
          || pagination.total_entries < 0
        )
      )
      || pagination.previous_page !== (page === 1 ? null : page - 1)
      || !Object.prototype.hasOwnProperty.call(pagination, "next_page")
      || values.length > pagination.per_page
    ) {
      throw new HetznerCloudApiError(502, "GET", resourcePath, "request_failed");
    }

    if (pagination.total_entries !== null) {
      if (
        expectedTotalEntries !== null
        && pagination.total_entries !== expectedTotalEntries
      ) {
        throw new HetznerCloudApiError(502, "GET", resourcePath, "request_failed");
      }
      expectedTotalEntries = pagination.total_entries;
    }
    if (expectedLastPage === undefined) {
      expectedLastPage = pagination.last_page;
    } else if (
      expectedLastPage !== null
      && pagination.last_page !== expectedLastPage
    ) {
      throw new HetznerCloudApiError(502, "GET", resourcePath, "request_failed");
    } else if (expectedLastPage === null && pagination.last_page !== null) {
      expectedLastPage = pagination.last_page;
    }

    const nextPage = pagination.next_page;
    if (
      nextPage !== null
      && (
        !Number.isSafeInteger(nextPage)
        || nextPage !== page + 1
        || nextPage > 10_000
        || (pagination.last_page !== null && nextPage > pagination.last_page)
      )
    ) {
      throw new HetznerCloudApiError(502, "GET", resourcePath, "request_failed");
    }
    if (
      expectedLastPage !== null
      && (
        (nextPage === null && page !== expectedLastPage)
        || (nextPage !== null && page >= expectedLastPage)
      )
    ) {
      throw new HetznerCloudApiError(502, "GET", resourcePath, "request_failed");
    }

    output.push(...(values as T[]));
    if (
      expectedTotalEntries !== null
      && (
        output.length > expectedTotalEntries
        || (nextPage !== null && output.length >= expectedTotalEntries)
        || (nextPage === null && output.length !== expectedTotalEntries)
      )
    ) {
      throw new HetznerCloudApiError(502, "GET", resourcePath, "request_failed");
    }
    if (nextPage === null) return output;
    page = nextPage;
  }
}

async function listSinglePageByName<T>(
  resourcePath: "/servers" | "/ssh_keys",
  key: "servers" | "ssh_keys",
  name: string,
  apiToken: string,
  fetchImpl: FetchLike,
): Promise<T[]> {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/.test(name)) {
    throw new HetznerCloudApiError(
      null,
      "GET",
      resourcePath,
      "response_invalid",
    );
  }
  const query = new URLSearchParams({ name, per_page: "50", page: "1" });
  const response = await hetznerFetch<Record<string, unknown> & { meta?: Pagination }>(
    `${resourcePath}?${query.toString()}`,
    {},
    apiToken,
    fetchImpl,
  );
  const values = response[key];
  const pagination = response.meta?.pagination;
  if (
    !Array.isArray(values)
    || values.length > 50
    || !pagination
    || pagination.page !== 1
    || !Number.isSafeInteger(pagination.per_page)
    || pagination.per_page <= 0
    || pagination.per_page > 50
    || pagination.previous_page !== null
    || pagination.next_page !== null
    || (pagination.last_page !== null && pagination.last_page !== 1)
    || (
      pagination.total_entries !== null
      && (
        !Number.isSafeInteger(pagination.total_entries)
        || pagination.total_entries !== values.length
      )
    )
  ) {
    throw new HetznerCloudApiError(
      502,
      "GET",
      resourcePath,
      "response_invalid",
    );
  }
  return values as T[];
}

export type HetznerCloudProjectClient = {
  listServers(): Promise<HetznerServer[]>;
  findServersByName(name: string): Promise<HetznerServer[]>;
  listServerTypes(): Promise<HetznerServerType[]>;
  listLocations(): Promise<HetznerLocation[]>;
  listSystemImages(): Promise<HetznerImage[]>;
  listSshKeys(): Promise<HetznerSshKey[]>;
  findSshKeysByName(name: string): Promise<HetznerSshKey[]>;
  getPricing(): Promise<HetznerPricing>;
  createSshKey(input: {
    name: string;
    publicKey: string;
    labels: Record<string, string>;
  }): Promise<HetznerSshKey>;
  /** Delete one explicitly identified project SSH key. Used only to remove
   * the disclosed, never-attached connect-time write-check key; a 204 is the
   * provider's acknowledgement, not proof that no other key exists. */
  deleteSshKey(sshKeyId: number): Promise<void>;
  createServer(
    input: HetznerProjectCreateServerPayload,
  ): Promise<HetznerProjectCreateServerResult>;
  getAction(actionId: number): Promise<HetznerAction>;
  getServer(serverId: number): Promise<HetznerServer>;
  /** Change only the compute plan of one explicitly identified server. The
   * primary disk is always retained so this helper cannot make a later
   * downgrade impossible by silently enlarging it. Callers must durably mark
   * the one-use dispatch before invoking this mutation. */
  changeServerType(input: {
    serverId: number;
    serverType: string;
  }): Promise<HetznerAction>;
};

/**
 * Project-scoped client for self-managed connections. Unlike the legacy
 * wrappers below, this client never reads HETZNER_API_TOKEN from ambient env.
 */
export function createHetznerCloudProjectClient(
  apiToken: string,
  options: { fetchImpl?: FetchLike } = {},
): HetznerCloudProjectClient {
  const explicitToken = apiToken.trim();
  if (!explicitToken) throw new Error("Hetzner Cloud API token is required");
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    listServers: () =>
      listAll<HetznerServer>("/servers", "servers", explicitToken, fetchImpl),
    findServersByName: (name) =>
      listSinglePageByName<HetznerServer>(
        "/servers",
        "servers",
        name,
        explicitToken,
        fetchImpl,
      ),
    listServerTypes: () =>
      listAll<HetznerServerType>(
        "/server_types",
        "server_types",
        explicitToken,
        fetchImpl,
      ),
    listLocations: () =>
      listAll<HetznerLocation>("/locations", "locations", explicitToken, fetchImpl),
    listSystemImages: () =>
      listAll<HetznerImage>(
        "/images?type=system&include_deprecated=false&sort=name",
        "images",
        explicitToken,
        fetchImpl,
      ),
    listSshKeys: () =>
      listAll<HetznerSshKey>("/ssh_keys", "ssh_keys", explicitToken, fetchImpl),
    findSshKeysByName: (name) =>
      listSinglePageByName<HetznerSshKey>(
        "/ssh_keys",
        "ssh_keys",
        name,
        explicitToken,
        fetchImpl,
      ),
    getPricing: async () => {
      const response = await hetznerFetch<{ pricing: HetznerPricing }>(
        "/pricing",
        {},
        explicitToken,
        fetchImpl,
      );
      if (!response.pricing || typeof response.pricing !== "object") {
        throw new HetznerCloudApiError(502, "GET", "/pricing", "request_failed");
      }
      return response.pricing;
    },
    createSshKey: async (input) => {
      const response = await hetznerFetch<{ ssh_key?: HetznerSshKey }>(
        "/ssh_keys",
        {
          method: "POST",
          body: JSON.stringify({
            name: input.name,
            public_key: input.publicKey,
            labels: input.labels,
          }),
        },
        explicitToken,
        fetchImpl,
        201,
      );
      if (!response.ssh_key || typeof response.ssh_key !== "object") {
        throw new HetznerCloudApiError(
          502,
          "POST",
          "/ssh_keys",
          "response_invalid",
        );
      }
      return response.ssh_key;
    },
    deleteSshKey: async (sshKeyId) => {
      if (!Number.isSafeInteger(sshKeyId) || sshKeyId <= 0) {
        throw new HetznerCloudApiError(
          null,
          "DELETE",
          "/ssh_keys/{id}",
          "response_invalid",
        );
      }
      await hetznerFetch(
        `/ssh_keys/${sshKeyId}`,
        { method: "DELETE" },
        explicitToken,
        fetchImpl,
        204,
      );
    },
    createServer: async (input) => {
      assertValidUserDataLength(input.user_data);
      if (
        input.start_after_create !== false
        || input.ssh_keys.length !== 1
        || !input.ssh_keys[0]
        || input.volumes.length !== 0
        || input.public_net.enable_ipv4 !== true
        || input.public_net.enable_ipv6 !== true
      ) {
        throw new HetznerCloudApiError(
          null,
          "POST",
          "/servers",
          "response_invalid",
        );
      }
      const providerPayload = {
        name: input.name,
        server_type: input.server_type,
        image: input.image,
        location: input.location,
        user_data: input.user_data,
        ssh_keys: input.ssh_keys,
        labels: input.labels,
        start_after_create: input.start_after_create,
        public_net: input.public_net,
        volumes: input.volumes,
      };
      const response = await hetznerFetch<{
        server?: HetznerServer;
        action?: HetznerAction;
        next_actions?: HetznerAction[];
        root_password?: unknown;
      }>(
        "/servers",
        { method: "POST", body: JSON.stringify(providerPayload) },
        explicitToken,
        fetchImpl,
        201,
      );
      if (
        !response.server
        || typeof response.server !== "object"
        || (
          response.next_actions !== undefined
          && !Array.isArray(response.next_actions)
        )
        || (Array.isArray(response.next_actions) && response.next_actions.length > 8)
        || (
          response.root_password !== undefined
          && response.root_password !== null
        )
      ) {
        // A root password must never cross this boundary. Supplying an SSH key
        // should make the provider return null; anything else is treated as an
        // ambiguous provider response and is never returned or persisted.
        throw new HetznerCloudApiError(
          502,
          "POST",
          "/servers",
          "response_invalid",
        );
      }
      const action = sanitizeAction(response.action);
      const nextActions = (response.next_actions ?? []).map(sanitizeAction);
      if (
        !action
        || nextActions.some((nextAction) => nextAction === null)
        || new Set(nextActions.map((nextAction) => nextAction?.id)).size
          !== nextActions.length
      ) {
        throw new HetznerCloudApiError(
          502,
          "POST",
          "/servers",
          "response_invalid",
        );
      }
      return {
        server: response.server,
        action,
        nextActions: nextActions as HetznerAction[],
      };
    },
    getAction: async (actionId) => {
      if (!Number.isSafeInteger(actionId) || actionId <= 0) {
        throw new HetznerCloudApiError(
          null,
          "GET",
          "/actions/{id}",
          "response_invalid",
        );
      }
      const response = await hetznerFetch<{ action?: HetznerAction }>(
        `/actions/${actionId}`,
        {},
        explicitToken,
        fetchImpl,
        200,
      );
      const action = sanitizeAction(response.action);
      if (!action) {
        throw new HetznerCloudApiError(
          502,
          "GET",
          "/actions/{id}",
          "response_invalid",
        );
      }
      return action;
    },
    getServer: async (serverId) => {
      if (!Number.isSafeInteger(serverId) || serverId <= 0) {
        throw new HetznerCloudApiError(
          null,
          "GET",
          "/servers/{id}",
          "response_invalid",
        );
      }
      const response = await hetznerFetch<{ server?: HetznerServer }>(
        `/servers/${serverId}`,
        {},
        explicitToken,
        fetchImpl,
        200,
      );
      if (!response.server || typeof response.server !== "object") {
        throw new HetznerCloudApiError(
          502,
          "GET",
          "/servers/{id}",
          "response_invalid",
        );
      }
      return response.server;
    },
    changeServerType: async (input) => {
      if (
        !Number.isSafeInteger(input.serverId)
        || input.serverId <= 0
        || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/.test(input.serverType)
      ) {
        throw new HetznerCloudApiError(
          null,
          "POST",
          "/servers/{id}/actions/change_type",
          "response_invalid",
        );
      }
      const path = `/servers/${input.serverId}/actions/change_type`;
      const response = await hetznerFetch<{ action?: HetznerAction }>(
        path,
        {
          method: "POST",
          body: JSON.stringify({
            server_type: input.serverType,
            // Deliberately fixed. Enlarging the disk is irreversible and can
            // rule out later downscales even when the user's bytes would fit.
            upgrade_disk: false,
          }),
        },
        explicitToken,
        fetchImpl,
        201,
      );
      const action = sanitizeAction(response.action);
      if (
        !action
        || action.command !== "change_server_type"
        || action.resources.length !== 1
        || action.resources[0].type !== "server"
        || action.resources[0].id !== input.serverId
      ) {
        throw new HetznerCloudApiError(
          502,
          "POST",
          "/servers/{id}/actions/change_type",
          "response_invalid",
        );
      }
      return action;
    },
  };
}

export type HetznerCloudCleanupClient = {
  getServer(id: number): Promise<HetznerServer | null>;
  getPrimaryIp(id: number): Promise<HetznerPrimaryIp | null>;
  getSshKey(id: number): Promise<HetznerSshKey | null>;
  deleteServer(id: number): Promise<HetznerAction>;
  deletePrimaryIp(id: number): Promise<void>;
  deleteSshKey(id: number): Promise<void>;
};

/** Only fresh absence reads; no provider mutation capability. A nonempty
 * project is outside this narrow recovery path, so never walk its pages. */
export function createHetznerExternalCleanupReader(
  apiToken: string,
  options: { fetchImpl?: FetchLike } = {},
) {
  const explicitToken = apiToken.trim();
  if (!explicitToken) throw new Error("Hetzner Cloud API token is required");
  const fetchImpl = options.fetchImpl ?? fetch;
  async function absent(kind: "servers" | "ssh_keys", id: number) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid original resource identity");
    try {
      await hetznerFetch(`/${kind}/${id}`, { cache: "no-store" }, explicitToken, fetchImpl, 200);
      return false;
    } catch (error) {
      if (error instanceof HetznerCloudApiError && error.status === 404 && error.providerCode === "not_found") return true;
      throw new HetznerCloudApiError(null, "GET", `/${kind}/{id}`, "request_failed");
    }
  }
  async function empty(kind: "servers" | "primary_ips") {
    const response = await hetznerFetch<Record<string, unknown> & { meta?: Pagination }>(
      `/${kind}?per_page=1&page=1`, { cache: "no-store" }, explicitToken, fetchImpl, 200,
    );
    const rows = response?.[kind], page = response?.meta?.pagination;
    if (!Array.isArray(rows) || !page || page.page !== 1 || page.per_page !== 1
      || page.previous_page !== null || !Object.hasOwn(page, "next_page")
      || !Object.hasOwn(page, "last_page") || !Object.hasOwn(page, "total_entries")) {
      throw new HetznerCloudApiError(502, "GET", `/${kind}`, "response_invalid");
    }
    if (rows.length > 0) return false;
    if (page.next_page !== null || (page.last_page !== null && page.last_page !== 1)
      || (page.total_entries !== null && page.total_entries !== 0)) {
      throw new HetznerCloudApiError(502, "GET", `/${kind}`, "response_invalid");
    }
    return true;
  }
  return {
    verify: async (serverId: number, sshKeyId: number): Promise<boolean> => {
      if (![serverId, sshKeyId].every(id => Number.isSafeInteger(id) && id > 0)) throw new Error("Invalid original resource identity");
      const evidence = await Promise.all([
        absent("servers", serverId), absent("ssh_keys", sshKeyId), empty("servers"), empty("primary_ips"),
      ]);
      return evidence.every(value => value === true);
    },
  };
}

/** Explicit owner-project authority only. Callers must hold a durable cleanup
 * lease and validate the current resource set before using a delete method.
 * A mutation response is never proof of absence: follow it with a fresh GET.
 */
export function createHetznerCloudCleanupClient(
  apiToken: string,
  options: { fetchImpl?: FetchLike } = {},
): HetznerCloudCleanupClient {
  const explicitToken = apiToken.trim();
  if (!explicitToken) throw new Error("Hetzner Cloud API token is required");
  const fetchImpl = options.fetchImpl ?? fetch;
  const pathFor = (kind: string, id: number): string => {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new HetznerCloudApiError(null, "GET", `/${kind}/{id}`, "response_invalid");
    }
    return `/${kind}/${id}`;
  };
  async function get<T extends { id: number }>(kind: string, field: string, id: number): Promise<T | null> {
    const path = pathFor(kind, id);
    try {
      const response = await hetznerFetch<Record<string, T>>(
        path, { cache: "no-store" }, explicitToken, fetchImpl, 200,
      );
      const resource = response?.[field];
      if (!resource || typeof resource !== "object" || resource.id !== id) {
        throw new HetznerCloudApiError(502, "GET", path, "response_invalid");
      }
      return resource;
    } catch (error) {
      // A proxy HTML 404 or unrelated error is not an absence receipt.
      if (error instanceof HetznerCloudApiError && error.status === 404
        && error.providerCode === "not_found") return null;
      throw error;
    }
  }
  async function remove(kind: string, id: number): Promise<void> {
    await hetznerFetch(pathFor(kind, id), { method: "DELETE" }, explicitToken, fetchImpl, 204);
  }
  return {
    getServer: (id) => get<HetznerServer>("servers", "server", id),
    getPrimaryIp: (id) => get<HetznerPrimaryIp>("primary_ips", "primary_ip", id),
    getSshKey: (id) => get<HetznerSshKey>("ssh_keys", "ssh_key", id),
    deleteServer: async (id) => {
      const path = pathFor("servers", id);
      const response = await hetznerFetch<{ action?: HetznerAction }>(
        path, { method: "DELETE" }, explicitToken, fetchImpl, 200,
      );
      const action = sanitizeAction(response?.action);
      if (!action || action.command !== "delete_server"
        || action.resources.length !== 1 || action.resources[0].type !== "server"
        || action.resources[0].id !== id) {
        throw new HetznerCloudApiError(502, "DELETE", path, "response_invalid");
      }
      return action;
    },
    deletePrimaryIp: (id) => remove("primary_ips", id),
    deleteSshKey: (id) => remove("ssh_keys", id),
  };
}

export type HetznerCloudFirstBootClient = {
  createFirewall(scope: FirstBootFirewallScope): Promise<FirstBootFirewallReceipt>;
  getFirewall(id: number): Promise<unknown | null>;
  getAction(id: number): Promise<HetznerAction>;
  getServer(id: number): Promise<HetznerServer>;
  powerOnServer(id: number): Promise<HetznerAction>;
  deleteFirewall(id: number): Promise<void>;
};

/** Private transport primitives, not preparation authority. Callers must own
 * a durable, explicitly confirmed preparation/cleanup lease, checkpoint each
 * POST before dispatch, and persist the original receipt. No blind retries,
 * name-based adoption, firewall rule editing, or ambient provider credential.
 * No public flow invokes these primitives until that coordinator is enabled.
 */
export function createHetznerCloudFirstBootClient(
  apiToken: string,
  options: { fetchImpl?: FetchLike } = {},
): HetznerCloudFirstBootClient {
  const explicitToken = apiToken.trim();
  if (!explicitToken) throw new Error("Hetzner Cloud API token is required");
  const fetchImpl = options.fetchImpl ?? fetch;
  const pathFor = (kind: "firewalls" | "servers" | "actions", id: number) => {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new HetznerCloudApiError(null, "GET", `/${kind}/{id}`, "response_invalid");
    }
    return `/${kind}/${id}`;
  };
  async function request<T>(path: string, init: RequestInit = {}, status = 200): Promise<T> {
    try {
      return await hetznerFetch<T>(path, { ...init, cache: "no-store" }, explicitToken, fetchImpl, status);
    } catch (error) {
      if (error instanceof HetznerCloudApiError) throw error;
      // A rejected fetch or malformed JSON can include request/response data.
      // This boundary never returns or logs those original exception strings.
      throw new HetznerCloudApiError(null, init.method ?? "GET", path, "request_failed");
    }
  }
  async function get<T extends { id: number }>(kind: "servers" | "firewalls", field: string, id: number): Promise<T> {
    const path = pathFor(kind, id);
    const response = await request<Record<string, T>>(path);
    const value = response?.[field];
    if (!value || typeof value !== "object" || value.id !== id) {
      throw new HetznerCloudApiError(502, "GET", path, "response_invalid");
    }
    return value;
  }
  return {
    createFirewall: async (scope) => {
      // The scope is flat and validated below. Own its primitive values before
      // awaiting I/O; a caller must not rebind an original receipt mid-flight.
      const current = { ...scope };
      const body = firstBootFirewallRequest(current);
      const response = await request<unknown>("/firewalls", { method: "POST", body: JSON.stringify(body) }, 201);
      return firstBootFirewallReceipt(current, response);
    },
    getFirewall: async (id) => {
      try { return await get("firewalls", "firewall", id); }
      catch (error) {
        if (error instanceof HetznerCloudApiError && error.status === 404 && error.providerCode === "not_found") return null;
        throw error;
      }
    },
    getServer: (id) => get<HetznerServer>("servers", "server", id),
    getAction: async (id) => {
      const path = pathFor("actions", id);
      const response = await request<{ action?: unknown }>(path);
      const action = sanitizeAction(response?.action);
      if (!action || action.id !== id) throw new HetznerCloudApiError(502, "GET", path, "response_invalid");
      return action;
    },
    powerOnServer: async (id) => {
      const path = pathFor("servers", id) + "/actions/poweron";
      const response = await request<{ action?: unknown }>(path, { method: "POST" }, 201);
      return firstBootPowerOnAction(id, response?.action);
    },
    deleteFirewall: async (id) => {
      await request(pathFor("firewalls", id), { method: "DELETE" }, 204);
    },
  };
}

export type HetznerCloudPowerClient = {
  getServer(id: number): Promise<HetznerServer>;
  dispatch(input: { serverId: number; kind: HetznerPowerKind }): Promise<HetznerPowerAction>;
  getAction(input: { serverId: number; kind: HetznerPowerKind; actionId: number }): Promise<HetznerPowerAction>;
};

/** Transport only, not lifecycle authority. A caller must durably own the
 * original computer/operation and record a one-use dispatch intent first.
 * Each invocation sends at most one fixed request; uncertain mutations never
 * retry or fall back to reset/poweroff/reinstall. ACPI success is not readiness.
 */
export function createHetznerCloudPowerClient(apiToken: string, options: { fetchImpl?: FetchLike } = {}): HetznerCloudPowerClient {
  const explicitToken = apiToken.trim();
  if (!explicitToken) throw new Error("Hetzner Cloud API token is required");
  const reader = createHetznerCloudFirstBootClient(explicitToken, options);
  return {
    getServer: reader.getServer,
    async dispatch(raw) {
      let input: { serverId: number; kind: HetznerPowerKind };
      try { input = HetznerPowerRequest.parse(raw); }
      catch { throw new HetznerCloudApiError(null, "POST", "/servers/{id}/actions/{power}", "response_invalid"); }
      const path = `/servers/${input.serverId}/actions/${HETZNER_POWER_ACTIONS[input.kind].path}`;
      let response: { action?: unknown };
      try {
        response = await hetznerFetch(path, { method: "POST", cache: "no-store" }, explicitToken, options.fetchImpl ?? fetch, 201);
      } catch (error) {
        if (error instanceof HetznerCloudApiError) throw error;
        throw new HetznerCloudApiError(null, "POST", path, "request_failed");
      }
      try { return parseHetznerPowerAction(response?.action, input); }
      catch { throw new HetznerCloudApiError(502, "POST", path, "response_invalid"); }
    },
    async getAction(raw) {
      let input: { serverId: number; kind: HetznerPowerKind; actionId: number };
      try { input = HetznerPowerObservation.parse(raw); }
      catch { throw new HetznerCloudApiError(null, "GET", "/actions/{id}", "response_invalid"); }
      const action = await reader.getAction(input.actionId);
      try { return parseHetznerPowerAction(action, input); }
      catch { throw new HetznerCloudApiError(502, "GET", `/actions/${input.actionId}`, "response_invalid"); }
    },
  };
}

export async function createServer(payload: CreateServerPayload): Promise<{
  server: HetznerServer;
  action: { id: number; status: string };
}> {
  assertValidUserDataLength(payload.user_data);

  // Hard guard: Hetzner deprecated numeric server type IDs (e.g. "104").
  // Coerce to "cx22" here as a final safety net regardless of how the value arrived.
  let serverType = payload.server_type;
  if (/^\d+$/.test(serverType)) {
    log.error(
      "server_type is a deprecated numeric ID — coercing to cx22",
      new Error("deprecated numeric server_type"),
      {
        source: LOG_SOURCE,
        failureType: "deprecated_numeric_server_type",
        rawValue: serverType,
      }
    );
    serverType = "cx22";
  }

  const safePayload = { ...payload, server_type: serverType };

  log.info("POST /servers", {
    source: LOG_SOURCE,
    serverType: safePayload.server_type,
    image: safePayload.image,
    location: safePayload.location,
  });

  return hetznerFetch("/servers", {
    method: "POST",
    body: JSON.stringify(safePayload),
  });
}

export async function getServer(id: number): Promise<{ server: HetznerServer }> {
  return hetznerFetch(`/servers/${id}`);
}

export async function deleteServer(id: number): Promise<void> {
  await hetznerFetch(`/servers/${id}`, { method: "DELETE" });
}

/**
 * Resize a server's CPU/RAM by changing its type.
 *
 * IMPORTANT: Always call with upgradeDisk=false for plan changes so
 * the server can be downgraded later. Only pass upgradeDisk=true for
 * the paid storage addon — this is irreversible.
 *
 * The server must be powered off for this to work on shared servers.
 * Returns the action ID to poll with waitForAction().
 */
export async function changeServerType(
  serverId: number,
  newServerType: string,
  upgradeDisk: boolean = false
): Promise<{ action: { id: number } }> {
  log.info("changing server type", {
    source: LOG_SOURCE,
    hetznerServerId: serverId,
    newServerType,
    upgradeDisk,
  });
  return hetznerFetch(`/servers/${serverId}/actions/change_type`, {
    method: "POST",
    body: JSON.stringify({
      server_type: newServerType,
      upgrade_disk: upgradeDisk,
    }),
  });
}

export async function powerOnServer(id: number): Promise<{ action: { id: number } }> {
  return hetznerFetch(`/servers/${id}/actions/poweron`, { method: "POST" });
}

export async function enableServerBackup(id: number): Promise<{ action: { id: number } }> {
  return hetznerFetch(`/servers/${id}/actions/enable_backup`, { method: "POST" });
}

export async function disableServerBackup(id: number): Promise<{ action: { id: number } }> {
  return hetznerFetch(`/servers/${id}/actions/disable_backup`, { method: "POST" });
}

export async function shutdownServer(id: number): Promise<{ action: { id: number } }> {
  return hetznerFetch(`/servers/${id}/actions/shutdown`, { method: "POST" });
}

export async function rebootServer(id: number): Promise<{ action: { id: number } }> {
  return hetznerFetch(`/servers/${id}/actions/reboot`, { method: "POST" });
}

/** Rebuild (wipe + reinstall) a server with new user_data. Preserves IP. */
export async function rebuildServer(
  id: number,
  opts: { image: string; user_data?: string }
): Promise<{ action: { id: number } }> {
  assertValidUserDataLength(opts.user_data);
  log.info("POST /servers/{id}/actions/rebuild", {
    source: LOG_SOURCE,
    hetznerServerId: id,
    image: opts.image,
  });
  return hetznerFetch(`/servers/${id}/actions/rebuild`, {
    method: "POST",
    body: JSON.stringify(opts),
  });
}

export async function waitForAction(
  actionId: number,
  maxWaitMs = 120_000,
  pollMs = 3_000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const { action } = await hetznerFetch<{ action: { status: string; error?: { code: string; message: string } } }>(
      `/actions/${actionId}`
    );
    if (action.status === "success") return;
    if (action.status === "error") {
      throw new Error(`Hetzner action ${actionId} failed: ${action.error?.message || "unknown"}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`Hetzner action ${actionId} timed out after ${maxWaitMs}ms`);
}

/** Map Hetzner VM status → our internal status */
export function mapHetznerStatus(
  hs: HetznerServer["status"]
): "provisioning" | "running" | "stopped" | "error" | "redeploying" {
  switch (hs) {
    case "running":      return "running";
    case "off":          return "stopped";
    case "initializing":
    case "starting":     return "provisioning";
    case "rebuilding":   return "redeploying";
    default:             return "error";
  }
}

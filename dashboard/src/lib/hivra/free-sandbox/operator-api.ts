/**
 * The agent app's operator API, as far as the free sandbox bridge uses it (base `/api/operator/v1`, a bearer token,
 * the app run with `MACHINE_PROVISIONING=external`). The shapes follow the app's own route schemas; fields the bridge
 * does not read are left out. Two calls the app does not have yet (`storage`, `platform/capacity`) answer `false` on a
 * 404 instead of failing, so the bridge runs before and after they land.
 *
 * The token and every enroll code stay out of errors and logs: an error carries the method, the path and the app's
 * own error code only.
 */

export type ProvisioningState = "preparing" | "waiting" | "problem";
export type ProvisioningStep = "reserving" | "starting" | "installing" | "connecting";

export interface ProvisioningReport {
  state: ProvisioningState;
  /** With `preparing`. */
  step?: ProvisioningStep;
  /** With `waiting`. */
  reason?: "capacity";
  /** With `preparing`: the earliest the computer should be ready, ISO 8601, at most 7 days ahead. */
  expectedReadyAt?: string;
  // `specs` is never sent for Free: the app takes whole CPUs only, and a free sandbox has a fraction of one.
}

export interface MachineRequest {
  orgId: string;
  orgName: string;
  createdAt: string;
  owner: { userId: string; email: string } | null;
  provisioning: {
    state: string;
    step: string | null;
    since: string | null;
  } | null;
}

export interface OperatorUser {
  id: string;
  email: string;
  emailVerified: boolean;
  blockedAt: string | null;
  deletionDueAt: string | null;
}

export interface OperatorMember {
  userId: string;
  email: string;
  lastSeenAt: string | null;
  blockedAt: string | null;
  deletionDueAt: string | null;
}

export interface OperatorMachine {
  id: string;
  kind: "connected" | "host" | "managed";
  managed: boolean;
  online: boolean;
  standby: boolean;
  busy: boolean;
  /** Runs and jobs count here, so it is never the person-only clock. */
  lastUsedAt: string | null;
  waitingRuns: number;
}

export interface IssuedMachine {
  machineId: string;
  /** Single use, 10 minutes. Never logged. */
  enrollCode: string;
  expiresAt: string;
}

export interface OperatorEvent {
  id: string;
  at: string;
  type: string;
  orgId: string | null;
  userId: string | null;
  data: Record<string, unknown>;
}

/** What a plan gives of agents, routines and models; null: no limit. Every key is sent every time. */
export interface PlanLimits {
  agents: number | null;
  brains: string[] | null;
  routines: number | null;
  routineMinutes: number | null;
  /** The models its agents may think with, the first used by default; null: any. Free sends its free models. */
  models: string[] | null;
}

export type StorageState = "stored" | "restoring" | null;

export interface CapacityReport {
  tier: string;
  open: boolean;
  placesLeft: number;
  waitlistCount: number;
}

/** Everything the bridge asks of the agent app. `OperatorClient` is the real one; tests use a fake. */
export interface AppProvisioningApi {
  listMachineRequests(cursor?: string): Promise<{ requests: MachineRequest[]; next: string | null }>;
  /** Null when no account has this address. */
  findUserByEmail(email: string): Promise<OperatorUser | null>;
  /** False when the workspace is gone (404). 403 and 409 throw: the bridge reads what they mean. */
  reportProvisioning(orgId: string, report: ProvisioningReport): Promise<boolean>;
  issueMachine(orgId: string): Promise<IssuedMachine>;
  /** Null when the workspace is gone. */
  listMachines(orgId: string): Promise<OperatorMachine[] | null>;
  /** Every member, across pages; null when the workspace is gone. */
  listMembers(orgId: string): Promise<OperatorMember[] | null>;
  /** False when the workspace has no such managed computer. */
  setStandby(orgId: string, machineId: string, standby: boolean): Promise<boolean>;
  listEvents(after?: string): Promise<{ events: OperatorEvent[]; next: string | null }>;
  setPlanLimits(orgId: string, limits: PlanLimits): Promise<boolean>;
  /** Only on account deletion or a move to a paid computer, never for packing. False when already gone. */
  removeMachine(orgId: string, machineId: string): Promise<boolean>;
  /** False while the app does not have this call yet (404 on the route), or when the computer is gone. */
  setStorage(orgId: string, machineId: string, state: StorageState, expectedReadyAt?: string): Promise<boolean>;
  /** False while the app does not have this call yet. */
  setCapacity(report: CapacityReport): Promise<boolean>;
}

export class OperatorApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`Operator API ${method} ${path} answered ${status}${code ? ` (${code})` : ""}`);
    this.name = "OperatorApiError";
  }
}

type Fetch = typeof fetch;

export interface OperatorClientOptions {
  /** The app's operator API base, ending in `/api/operator/v1`. https, or http only on a loopback address. */
  baseUrl: string;
  token: string;
  fetch?: Fetch;
  timeoutMs?: number;
}

const PREFIX = "/api/operator/v1";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Checks the base address once: https, or plain http on this machine only; no credentials, query or fragment. */
export function operatorBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("The operator API address is not a URL");
  }
  const local = url.protocol === "http:" && LOOPBACK.has(url.hostname);
  if (url.protocol !== "https:" && !local) throw new Error("The operator API address must be https");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("The operator API address must not carry credentials, a query or a fragment");
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (!path.endsWith(PREFIX)) throw new Error(`The operator API address must end in ${PREFIX}`);
  return `${url.origin}${path}`;
}

const seg = (value: string) => encodeURIComponent(value);

export class OperatorClient implements AppProvisioningApi {
  private readonly base: string;
  private readonly token: string;
  private readonly fetcher: Fetch;
  private readonly timeoutMs: number;

  constructor(options: OperatorClientOptions) {
    this.base = operatorBaseUrl(options.baseUrl);
    if (!options.token || /\s/.test(options.token)) throw new Error("The operator API token is missing or malformed");
    this.token = options.token;
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** One call. `allow` lists statuses answered as `null` instead of thrown. */
  private async call<T>(
    method: string,
    path: string,
    { body, allow = [] }: { body?: unknown; allow?: number[] } = {},
  ): Promise<{ status: number; data: T | null }> {
    const res = await this.fetcher(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: "error",
    });
    const logPath = path.split("?")[0];
    if (allow.includes(res.status)) return { status: res.status, data: null };
    if (!res.ok) {
      let code: string | null = null;
      try {
        const parsed = (await res.json()) as {
          error?: { code?: unknown };
          code?: unknown;
        };
        const raw = parsed?.error?.code ?? parsed?.code;
        code = typeof raw === "string" ? raw.slice(0, 80) : null;
      } catch {
        // No JSON body: the status says enough.
      }
      throw new OperatorApiError(method, logPath, res.status, code);
    }
    if (res.status === 204) return { status: 204, data: null };
    return { status: res.status, data: (await res.json()) as T };
  }

  async listMachineRequests(cursor?: string) {
    const query = new URLSearchParams({
      limit: "100",
      ...(cursor ? { cursor } : {}),
    });
    const { data } = await this.call<{
      requests: MachineRequest[];
      next: string | null;
    }>("GET", `/machine-requests?${query}`);
    return data ?? { requests: [], next: null };
  }

  async findUserByEmail(email: string) {
    const query = new URLSearchParams({ email, limit: "1" });
    const { data } = await this.call<{ users: OperatorUser[] }>("GET", `/users?${query}`);
    const want = email.trim().toLowerCase();
    return data?.users.find((u) => u.email.trim().toLowerCase() === want) ?? null;
  }

  async reportProvisioning(orgId: string, report: ProvisioningReport) {
    const { status } = await this.call("PUT", `/orgs/${seg(orgId)}/provisioning`, { body: report, allow: [404] });
    return status !== 404;
  }

  async issueMachine(orgId: string) {
    const { data } = await this.call<IssuedMachine>("POST", `/orgs/${seg(orgId)}/machines`, { body: {} });
    if (!data) throw new OperatorApiError("POST", `/orgs/${orgId}/machines`, 204, null);
    return data;
  }

  async listMachines(orgId: string) {
    const { data } = await this.call<{ machines: OperatorMachine[] }>("GET", `/orgs/${seg(orgId)}/machines`, {
      allow: [404],
    });
    return data?.machines ?? null;
  }

  async listMembers(orgId: string) {
    const members: OperatorMember[] = [];
    let cursor: string | undefined;
    // A workspace's people, every page; bounded so a bad cursor can never loop for ever.
    for (let page = 0; page < 100; page++) {
      const query = new URLSearchParams({
        limit: "200",
        ...(cursor ? { cursor } : {}),
      });
      const { data } = await this.call<{
        members: OperatorMember[];
        next: string | null;
      }>("GET", `/orgs/${seg(orgId)}/members?${query}`, { allow: [404] });
      if (!data) return null;
      members.push(...data.members);
      if (!data.next) return members;
      cursor = data.next;
    }
    return members;
  }

  async setStandby(orgId: string, machineId: string, standby: boolean) {
    const { status } = await this.call("PUT", `/orgs/${seg(orgId)}/machines/${seg(machineId)}/standby`, {
      body: { standby },
      allow: [404],
    });
    return status !== 404;
  }

  async listEvents(after?: string) {
    const query = new URLSearchParams({
      limit: "500",
      ...(after ? { after } : {}),
    });
    const { data } = await this.call<{
      events: OperatorEvent[];
      next: string | null;
    }>("GET", `/events?${query}`);
    return data ?? { events: [], next: after ?? null };
  }

  async setPlanLimits(orgId: string, limits: PlanLimits) {
    const { status } = await this.call("PUT", `/orgs/${seg(orgId)}/plan-limits`, { body: limits, allow: [404] });
    return status !== 404;
  }

  async removeMachine(orgId: string, machineId: string) {
    const { status } = await this.call("DELETE", `/orgs/${seg(orgId)}/machines/${seg(machineId)}`, { allow: [404] });
    return status !== 404;
  }

  async setStorage(orgId: string, machineId: string, state: StorageState, expectedReadyAt?: string) {
    const { status } = await this.call("PUT", `/orgs/${seg(orgId)}/machines/${seg(machineId)}/storage`, {
      body: { state, ...(expectedReadyAt ? { expectedReadyAt } : {}) },
      allow: [404],
    });
    return status !== 404;
  }

  async setCapacity(report: CapacityReport) {
    const { status } = await this.call("PUT", "/platform/capacity", {
      body: report,
      allow: [404],
    });
    return status !== 404;
  }
}

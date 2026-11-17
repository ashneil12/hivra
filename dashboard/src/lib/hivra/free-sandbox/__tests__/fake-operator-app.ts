/**
 * A fake of the agent app's operator API routes the bridge uses (`/api/operator/v1`, as at the app's commit that
 * added plan limits): just enough state to answer them, and the same refusals for what the real routes refuse. The
 * real `OperatorClient` talks to it through a fake `fetch`, so the bridge's tests cover the client too.
 */
import type { OperatorEvent } from "../operator-api";

export const BASE = "https://agents.example/api/operator/v1";
export const TOKEN = "op-token-0123456789";

interface Org {
  id: string;
  name: string;
  owner: { userId: string; email: string };
  createdAt: string;
  provisioning: { state: string; step: string | null; reason: string | null; expectedReadyAt: string | null } | null;
  machine: {
    id: string;
    online: boolean;
    standby: boolean;
    busy: boolean;
    waitingRuns: number;
    lastUsedAt: string | null;
    code: string | null;
    deleted: boolean;
  } | null;
  members: { userId: string; email: string; lastSeenAt: string | null }[];
  planLimits: unknown;
}

export class FakeOperatorApp {
  orgs = new Map<string, Org>();
  users = new Map<string, { id: string; email: string; emailVerified: boolean }>();
  events: OperatorEvent[] = [];
  calls: { method: string; path: string; body: unknown }[] = [];
  /** Off: the app hasn't the storage and capacity routes yet (404). */
  hasStorageRoutes = false;
  storage: { orgId: string; machineId: string; state: unknown }[] = [];
  capacity: unknown[] = [];
  private serial = 0;

  addWorkspace(orgId: string, email: string, { verified = true } = {}) {
    const userId = `user-${orgId}`;
    this.users.set(email, { id: userId, email, emailVerified: verified });
    this.orgs.set(orgId, {
      id: orgId,
      name: `Workspace ${orgId}`,
      owner: { userId, email },
      createdAt: new Date(0).toISOString(),
      provisioning: null,
      machine: null,
      members: [{ userId, email, lastSeenAt: null }],
      planLimits: null,
    });
  }

  org(orgId: string) {
    const org = this.orgs.get(orgId);
    if (!org) throw new Error(`no org ${orgId}`);
    return org;
  }

  /** The runner's first hello, as the enroll shim's `pair` would lead to. */
  redeem(code: string) {
    for (const org of this.orgs.values()) {
      if (org.machine && org.machine.code === code) {
        org.machine.code = null;
        org.machine.online = true;
        org.machine.standby = false;
        org.provisioning = null;
        return true;
      }
    }
    return false;
  }

  event(type: string, orgId: string, data: Record<string, unknown> = {}, at = new Date().toISOString()) {
    this.serial++;
    this.events.push({
      id: `00000000-0000-4000-8000-${String(this.serial).padStart(12, "0")}`,
      at,
      type,
      orgId,
      userId: null,
      data,
    });
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const auth = new Headers(init.headers).get("authorization");
    if (auth !== `Bearer ${TOKEN}`) return json(401, { error: { code: "unauthorized", message: "no" } });
    if (!url.href.startsWith(BASE)) return json(404, { error: { code: "not_found", message: "no route" } });
    const path = url.pathname.slice(new URL(BASE).pathname.length);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, path, body });
    const parts = path.split("/").filter(Boolean);

    if (method === "GET" && path === "/machine-requests") {
      const requests = [...this.orgs.values()]
        .filter((o) => !o.machine || o.machine.deleted || o.machine.code !== null || !o.machine.online)
        .filter((o) => !(o.machine && o.machine.online))
        .map((o) => ({
          orgId: o.id,
          orgName: o.name,
          createdAt: o.createdAt,
          owner: o.owner,
          provisioning: o.provisioning && { ...o.provisioning, since: null },
        }));
      return json(200, { requests, next: null });
    }
    if (method === "GET" && path === "/users") {
      const email = url.searchParams.get("email");
      if (!email) return json(400, { error: { code: "invalid_request", message: "email or q is required" } });
      const user = [...this.users.values()].find((u) => u.email.toLowerCase() === email.toLowerCase());
      const users = user
        ? [
            {
              ...user,
              name: "",
              createdAt: new Date(0).toISOString(),
              blockedAt: null,
              blockedReason: null,
              deletionDueAt: null,
              lastSignInAt: null,
              orgs: [],
              orgCount: 0,
            },
          ]
        : [];
      return json(200, { users, next: null });
    }
    if (method === "PUT" && path === "/platform/capacity") {
      if (!this.hasStorageRoutes) return json(404, { error: { code: "not_found", message: "no route" } });
      this.capacity.push(body);
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && path === "/events") {
      const after = url.searchParams.get("after");
      const start = after ? this.events.findIndex((e) => e.id === after) + 1 : 0;
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const page = this.events.slice(start, start + limit);
      const next = page.length ? page[page.length - 1].id : (after ?? this.events.at(-1)?.id ?? null);
      return json(200, { events: page, next });
    }

    if (parts[0] !== "orgs" || !parts[1]) return json(404, { error: { code: "not_found", message: "no route" } });
    const org = this.orgs.get(parts[1]);
    const notFound = () => json(404, { error: { code: "not_found", message: "No workspace with this id" } });
    const rest = parts.slice(2).join("/");

    if (method === "PUT" && rest === "provisioning") {
      if (!org) return notFound();
      if (!["preparing", "waiting", "problem"].includes(body.state))
        return json(400, { error: { code: "invalid_request", message: "state" } });
      if (body.specs && !Number.isInteger(body.specs.cpus))
        return json(400, { error: { code: "invalid_request", message: "cpus" } });
      if (org.machine?.online) return json(409, { error: { code: "provisioning.ready", message: "ready" } });
      org.provisioning = {
        state: body.state,
        step: body.step ?? null,
        reason: body.reason ?? null,
        expectedReadyAt: body.expectedReadyAt ?? null,
      };
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && rest === "machines") {
      if (!org) return notFound();
      this.serial++;
      const code = `code${this.serial}abcdefgh`;
      if (!org.machine || org.machine.deleted) {
        org.machine = {
          id: `10000000-0000-4000-8000-${String(this.serial).padStart(12, "0")}`,
          online: false,
          standby: false,
          busy: false,
          waitingRuns: 0,
          lastUsedAt: null,
          code,
          deleted: false,
        };
      } else {
        org.machine.code = code;
      }
      return json(200, {
        machineId: org.machine.id,
        enrollCode: code,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });
    }
    if (method === "GET" && rest === "machines") {
      if (!org) return notFound();
      const m = org.machine && !org.machine.deleted ? org.machine : null;
      const machines = m
        ? [
            {
              id: m.id,
              kind: "managed",
              managed: true,
              name: "Computer",
              online: m.online,
              lastSeenAt: null,
              runnerVersion: "x",
              protocol: 68,
              standby: m.standby,
              busy: m.busy,
              lastUsedAt: m.lastUsedAt,
              orgId: org.id,
              executors: [],
              accounts: [],
              accountCount: 0,
              openTasks: 0,
              holds: 0,
              waitingRuns: m.waitingRuns,
              deletedAt: null,
            },
          ]
        : [];
      return json(200, { machines, provisioning: org.provisioning });
    }
    if (method === "GET" && rest === "members") {
      if (!org) return notFound();
      const members = org.members.map((m) => ({
        ...m,
        name: "",
        handle: null,
        role: "owner",
        joinedAt: new Date(0).toISOString(),
        blockedAt: null,
        deletionDueAt: null,
      }));
      return json(200, { members, next: null, invitations: [], joinRequests: [] });
    }
    if (method === "PUT" && rest === "plan-limits") {
      if (!org) return notFound();
      for (const key of ["agents", "brains", "routines", "routineMinutes"]) {
        if (!(key in body)) return json(400, { error: { code: "invalid_request", message: key } });
      }
      org.planLimits = body;
      return json(200, { ...body, updatedAt: new Date().toISOString() });
    }
    const machineId = parts[3];
    const managed = org?.machine && !org.machine.deleted && org.machine.id === machineId ? org.machine : null;
    if (method === "PUT" && parts[2] === "machines" && parts[4] === "standby") {
      if (!managed) return json(404, { error: { code: "not_found", message: "no managed computer" } });
      managed.standby = body.standby;
      if (body.standby) managed.online = false;
      return json(200, { standby: body.standby });
    }
    if (method === "PUT" && parts[2] === "machines" && parts[4] === "storage") {
      if (!this.hasStorageRoutes || !managed) return json(404, { error: { code: "not_found", message: "no route" } });
      this.storage.push({ orgId: parts[1], machineId, state: body.state });
      return new Response(null, { status: 204 });
    }
    if (method === "DELETE" && parts[2] === "machines" && parts.length === 4) {
      if (!managed) return json(404, { error: { code: "not_found", message: "no managed computer" } });
      managed.deleted = true;
      return new Response(null, { status: 204 });
    }
    return json(404, { error: { code: "not_found", message: "no route" } });
  };
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

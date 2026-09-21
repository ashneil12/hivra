import crypto from "node:crypto";

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { fetchFirstReachableGatewayResponse } from "@/lib/agent-gateway";
import { isPlatformDailyBriefJob } from "@/lib/daily-brief";
import { getSecureUserInstance } from "@/lib/services/instance-security";
import { isProTierUser } from "@/lib/billing/pro-tier";
import {
  enforceAuthenticatedRouteRateLimit,
  RATE_LIMIT_PRESETS,
} from "@/lib/authenticated-rate-limit";
import { apiError } from "@/lib/api-response";
import { log } from "@/lib/logger";

// Standing scheduled tasks ("cron jobs") are the deepest switching-cost lever:
// owned, recurring jobs the agent runs on its own. The engine lives on the
// box's official-dashboard server (port 9119), reached through the gateway via
// the `/_sidecar` prefix — the dashboard-sidecar signs + forwards the request
// to 9119. This route is a thin authenticated proxy mirroring the proven shape
// of `terminal/interactive/route.ts`:
//   - ownership + key decryption via getSecureUserInstance
//   - signed headers (HMAC over timestamp.body) on every box call
//   - the `/_sidecar/api/cron/...` path (gateway-probe special-cases /_sidecar)
//
// LIST (GET) is open to any owner so Free users SEE the feature. The standing-
// task loop is the deepest switching-cost lever, but it never converted while
// it was invisible AND fully Pro-locked (chicken-and-egg). So the gate is:
//   - CREATE: a Free user keeps ONE standing task. The first create succeeds;
//     a second (>= FREE_STANDING_TASK_LIMIT existing jobs) returns the Pro gate.
//     Pro users create without limit.
//   - Lifecycle/edit/delete (pause/resume/trigger, PUT, DELETE): open to any
//     owner — a Free user must be able to manage the single task they own.
// All writes stay rate-limited with the shared scheduledTaskWrite preset.

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

const CRON_REQUEST_TIMEOUT_MS = 15_000;
const CRON_REQUEST_ERROR = "Scheduled task request failed";
// Free includes a single standing task; the 2nd+ requires Pro.
const FREE_STANDING_TASK_LIMIT = 1;
const CRON_OVER_LIMIT_ERROR =
  "Free includes one standing task. Upgrade to Pro to run more.";

const PROFILE_SCHEMA = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9_-]+$/, "Invalid profile name");

const JOB_ID_SCHEMA = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_.:-]+$/, "Invalid job id");

const WRITE_ACTION_SCHEMA = z.enum(["pause", "resume", "trigger"]);

// Field mapping: the UI's LiveJob.command -> box `prompt`; LiveJob.schedule
// (string) -> the RAW cron `schedule` (e.g. "0 9 * * *").
const CREATE_SCHEMA = z.object({
  prompt: z.string().trim().min(1, "A task instruction (prompt) is required").max(20_000),
  schedule: z.string().trim().min(1, "A cron schedule is required").max(200),
  name: z.string().trim().max(200).optional().default(""),
  deliver: z.string().trim().max(120).optional().default("local"),
});

const UPDATE_SCHEMA = z.object({
  jobId: JOB_ID_SCHEMA,
  updates: z
    .object({
      prompt: z.string().trim().min(1).max(20_000).optional(),
      schedule: z.string().trim().min(1).max(200).optional(),
      name: z.string().trim().max(200).optional(),
      enabled: z.boolean().optional(),
    })
    .refine((value) => Object.keys(value).length > 0, {
      message: "At least one field to update is required",
    }),
});

const DELETE_SCHEMA = z.object({
  jobId: JOB_ID_SCHEMA,
});

function resolveErrorStatus(error: string | null): number {
  if (!error) return 500;
  if (error.includes("not found") || error.includes("unauthorized")) return 404;
  if (
    error.includes("not currently running") ||
    error.includes("Gateway URL not configured") ||
    error.includes("not configured")
  ) {
    return 400;
  }
  return 500;
}

function buildSignedHeaders(
  apiServerKey: string,
  rawBody?: string,
  extraHeaders?: Record<string, string>,
): Headers {
  const timestamp = Date.now().toString();
  const signedPayload = rawBody ? `${timestamp}.${rawBody}` : timestamp;
  const signature = crypto
    .createHmac("sha256", apiServerKey)
    .update(signedPayload)
    .digest("hex");

  return new Headers({
    Accept: "application/json",
    Connection: "close",
    Authorization: `Bearer ${apiServerKey}`,
    "X-Hermes-Timestamp": timestamp,
    "X-Hermes-Signature": signature,
    ...(extraHeaders || {}),
  });
}

function buildSidecarCronPath(suffix: string, searchParams?: URLSearchParams): string {
  const base = `/_sidecar/api/cron/jobs${suffix}`;
  const queryString = searchParams?.toString();
  return queryString ? `${base}?${queryString}` : base;
}

type SecureInstanceOk = Extract<
  Awaited<ReturnType<typeof getSecureUserInstance>>,
  { error: null }
>;

async function forwardCronRequest(params: {
  secureInstance: SecureInstanceOk;
  pathname: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  rawBody?: string;
}): Promise<Response> {
  const { secureInstance, pathname, method, rawBody } = params;
  const { response } = await fetchFirstReachableGatewayResponse({
    baseUrl: secureInstance.instance.gateway_url,
    pathname,
    instanceIpv4: secureInstance.instanceIpv4,
    method,
    headers: buildSignedHeaders(secureInstance.apiServerKey, rawBody, {
      "Content-Type": "application/json",
    }),
    body: rawBody,
    timeoutMs: CRON_REQUEST_TIMEOUT_MS,
  });
  return response;
}

async function readCronPayload(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function logRejectedCronRequest(
  instanceId: string,
  method: string,
  response: Response,
  action?: string,
) {
  log.warn("cron sidecar request was rejected", {
    source: "instance-cron",
    route: "/api/instances/[id]/cron",
    method,
    instanceId,
    status: response.status,
    action: action ?? null,
    failureType: "cron_sidecar_request_rejected",
  });
}

function logFailedCronRequest(
  instanceId: string,
  method: string,
  err: unknown,
  action?: string,
) {
  log.warn(
    "cron sidecar request failed",
    {
      source: "instance-cron",
      route: "/api/instances/[id]/cron",
      method,
      instanceId,
      action: action ?? null,
      failureType: "cron_sidecar_request_failed",
    },
    err,
  );
}

async function requireSecureInstance(
  id: string,
  userId: string,
  requireRunning: boolean,
): Promise<{ ok: true; secureInstance: SecureInstanceOk } | { ok: false; response: Response }> {
  const secureInstance = await getSecureUserInstance({ id, userId, requireRunning });
  if (!secureInstance.instance || !secureInstance.apiServerKey) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: secureInstance.error || "Scheduled tasks are unavailable for this instance" },
        { status: resolveErrorStatus(secureInstance.error) },
      ),
    };
  }
  return { ok: true, secureInstance: secureInstance as SecureInstanceOk };
}

// Count the jobs the box currently has for this instance (across all profiles).
// Reuses the exact box-forwarding the GET handler uses; returns null if the box
// can't be listed (treated as "can't confirm under limit" → fail closed).
async function countExistingJobs(secureInstance: SecureInstanceOk): Promise<number | null> {
  try {
    const response = await forwardCronRequest({
      secureInstance,
      pathname: buildSidecarCronPath("", new URLSearchParams({ profile: "all" })),
      method: "GET",
    });
    if (!response.ok) {
      await response.text().catch(() => "");
      return null;
    }
    const payload = await readCronPayload(response);
    if (!Array.isArray(payload)) return 0;
    // Exclude the platform-seeded "Daily brief" job — it's a system job, not one
    // of the user's own standing tasks, so it must not eat a Free user's slot.
    // Stricter (name + schedule) match so a user can't free-ride by naming a task
    // "Daily brief".
    return payload.filter((job) => !isPlatformDailyBriefJob(job)).length;
  } catch {
    return null;
  }
}

// Gate a CREATE: Pro users are unlimited; a Free user keeps ONE standing task,
// so a create is allowed only while they have < FREE_STANDING_TASK_LIMIT jobs.
// The extra list round-trip only happens for non-Pro users attempting a create.
async function requireCreateAllowed(
  userId: string,
  secureInstance: SecureInstanceOk,
): Promise<Response | null> {
  const tierCheck = await isProTierUser(userId);
  if (tierCheck.ok) return null; // Pro+ — unlimited, no extra round-trip.

  const existing = await countExistingJobs(secureInstance);
  // Fail closed if the box list couldn't be read — better to deny a possible
  // 2nd task than to hand a Free user unlimited creates on a transient error.
  if (existing === null) {
    return apiError(
      CRON_REQUEST_ERROR,
      502,
      undefined,
      { failureType: "cron_sidecar_request_failed" },
      { failureType: "cron_sidecar_request_failed" },
    );
  }
  if (existing >= FREE_STANDING_TASK_LIMIT) {
    return apiError(
      CRON_OVER_LIMIT_ERROR,
      403,
      // details — logged server-side only.
      { tier: tierCheck.tier ?? "none", reason: tierCheck.reason },
      // extra — included in the client body so the funnel can branch on it.
      { failureType: "scheduled_task_tier_required" },
      {
        failureType: "scheduled_task_tier_required",
        metadata: { tier: tierCheck.tier ?? "none" },
      },
    );
  }
  return null;
}

// GET — list jobs. Open to any owner (Free users see the locked feature).
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const requestedProfile = searchParams.get("profile") ?? "all";
  const profileParam =
    requestedProfile === "all"
      ? "all"
      : PROFILE_SCHEMA.safeParse(requestedProfile).success
        ? requestedProfile
        : null;
  if (profileParam === null) {
    return NextResponse.json({ error: "Invalid profile name" }, { status: 400 });
  }

  const guard = await requireSecureInstance(id, userId, true);
  if (!guard.ok) return guard.response;

  const proxyParams = new URLSearchParams({ profile: profileParam });

  try {
    const response = await forwardCronRequest({
      secureInstance: guard.secureInstance,
      pathname: buildSidecarCronPath("", proxyParams),
      method: "GET",
    });

    if (!response.ok) {
      await response.text().catch(() => "");
      logRejectedCronRequest(id, "GET", response, "list");
      return NextResponse.json({ error: CRON_REQUEST_ERROR }, { status: response.status });
    }

    const payload = await readCronPayload(response);
    return NextResponse.json(payload ?? [], { status: response.status });
  } catch (err) {
    logFailedCronRequest(id, "GET", err, "list");
    return NextResponse.json({ error: CRON_REQUEST_ERROR }, { status: 502 });
  }
}

// POST — create a job, OR run a lifecycle action via ?action=pause|resume|trigger&jobId=.
// Rate-limited. Create is limited for Free users (one standing task); lifecycle
// actions are open to any owner. See requireCreateAllowed.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rateLimited = enforceAuthenticatedRouteRateLimit(request, {
    routeKey: "scheduledTaskWrite",
    userId,
    ...RATE_LIMIT_PRESETS.scheduledTaskWrite,
  });
  if (rateLimited) return rateLimited;

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action");

  const guard = await requireSecureInstance(id, userId, true);
  if (!guard.ok) return guard.response;

  // Lifecycle action: pause / resume / trigger an existing job. Open to any
  // owner — a Free user must be able to manage the single task they own.
  if (action) {
    const parsedAction = WRITE_ACTION_SCHEMA.safeParse(action);
    if (!parsedAction.success) {
      return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }
    const parsedJobId = JOB_ID_SCHEMA.safeParse(searchParams.get("jobId"));
    if (!parsedJobId.success) {
      return NextResponse.json({ error: "Missing or invalid jobId" }, { status: 400 });
    }

    const proxyParams = buildJobProfileParams(searchParams);
    try {
      const response = await forwardCronRequest({
        secureInstance: guard.secureInstance,
        pathname: buildSidecarCronPath(
          `/${encodeURIComponent(parsedJobId.data)}/${parsedAction.data}`,
          proxyParams,
        ),
        method: "POST",
        rawBody: "",
      });

      if (!response.ok) {
        await response.text().catch(() => "");
        logRejectedCronRequest(id, "POST", response, parsedAction.data);
        return NextResponse.json({ error: CRON_REQUEST_ERROR }, { status: response.status });
      }

      const payload = await readCronPayload(response);
      return NextResponse.json(payload ?? { ok: true }, { status: response.status });
    } catch (err) {
      logFailedCronRequest(id, "POST", err, parsedAction.data);
      return NextResponse.json({ error: CRON_REQUEST_ERROR }, { status: 502 });
    }
  }

  // Create a job.
  let body: z.infer<typeof CREATE_SCHEMA>;
  try {
    body = CREATE_SCHEMA.parse(JSON.parse(await request.text()));
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(", ")
        : "Invalid request body";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const requestedProfile = searchParams.get("profile") ?? "default";
  const parsedProfile = PROFILE_SCHEMA.safeParse(requestedProfile);
  if (!parsedProfile.success) {
    return NextResponse.json({ error: "Invalid profile name" }, { status: 400 });
  }

  // Free keeps ONE standing task: a non-Pro user may create only while they
  // have < FREE_STANDING_TASK_LIMIT jobs. Pro users skip the list round-trip.
  const createGate = await requireCreateAllowed(userId, guard.secureInstance);
  if (createGate) return createGate;

  const proxyParams = new URLSearchParams({ profile: parsedProfile.data });
  // Send the box exactly what its CronJobCreate model expects: the prompt and
  // the RAW cron schedule string (not a parsed dict), plus name + deliver.
  const rawBody = JSON.stringify({
    prompt: body.prompt,
    schedule: body.schedule,
    name: body.name,
    deliver: body.deliver,
  });

  try {
    const response = await forwardCronRequest({
      secureInstance: guard.secureInstance,
      pathname: buildSidecarCronPath("", proxyParams),
      method: "POST",
      rawBody,
    });

    if (!response.ok) {
      await response.text().catch(() => "");
      logRejectedCronRequest(id, "POST", response, "create");
      return NextResponse.json({ error: CRON_REQUEST_ERROR }, { status: response.status });
    }

    const payload = await readCronPayload(response);
    return NextResponse.json(payload ?? { ok: true }, { status: response.status });
  } catch (err) {
    logFailedCronRequest(id, "POST", err, "create");
    return NextResponse.json({ error: CRON_REQUEST_ERROR }, { status: 502 });
  }
}

// PUT — update an existing job. Open to any owner (managing a task they already
// own, including a Free user's single standing task) + rate-limited.
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rateLimited = enforceAuthenticatedRouteRateLimit(request, {
    routeKey: "scheduledTaskWrite",
    userId,
    ...RATE_LIMIT_PRESETS.scheduledTaskWrite,
  });
  if (rateLimited) return rateLimited;

  const { id } = await params;
  const { searchParams } = new URL(request.url);

  let body: z.infer<typeof UPDATE_SCHEMA>;
  try {
    body = UPDATE_SCHEMA.parse(JSON.parse(await request.text()));
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(", ")
        : "Invalid request body";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const guard = await requireSecureInstance(id, userId, true);
  if (!guard.ok) return guard.response;

  const proxyParams = buildJobProfileParams(searchParams);
  // The box's CronJobUpdate model wraps the changed fields under `updates`.
  const rawBody = JSON.stringify({ updates: body.updates });

  try {
    const response = await forwardCronRequest({
      secureInstance: guard.secureInstance,
      pathname: buildSidecarCronPath(`/${encodeURIComponent(body.jobId)}`, proxyParams),
      method: "PUT",
      rawBody,
    });

    if (!response.ok) {
      await response.text().catch(() => "");
      logRejectedCronRequest(id, "PUT", response, "update");
      return NextResponse.json({ error: CRON_REQUEST_ERROR }, { status: response.status });
    }

    const payload = await readCronPayload(response);
    return NextResponse.json(payload ?? { ok: true }, { status: response.status });
  } catch (err) {
    logFailedCronRequest(id, "PUT", err, "update");
    return NextResponse.json({ error: CRON_REQUEST_ERROR }, { status: 502 });
  }
}

// DELETE — remove a job. Open to any owner (managing a task they already own) +
// rate-limited. jobId via ?jobId= or body.
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rateLimited = enforceAuthenticatedRouteRateLimit(request, {
    routeKey: "scheduledTaskWrite",
    userId,
    ...RATE_LIMIT_PRESETS.scheduledTaskWrite,
  });
  if (rateLimited) return rateLimited;

  const { id } = await params;
  const { searchParams } = new URL(request.url);

  let jobId = searchParams.get("jobId") ?? "";
  if (!jobId) {
    const rawBody = await request.text().catch(() => "");
    if (rawBody.trim()) {
      const parsed = DELETE_SCHEMA.safeParse((() => {
        try {
          return JSON.parse(rawBody);
        } catch {
          return null;
        }
      })());
      if (parsed.success) jobId = parsed.data.jobId;
    }
  }
  const parsedJobId = JOB_ID_SCHEMA.safeParse(jobId);
  if (!parsedJobId.success) {
    return NextResponse.json({ error: "Missing or invalid jobId" }, { status: 400 });
  }

  const guard = await requireSecureInstance(id, userId, true);
  if (!guard.ok) return guard.response;

  const proxyParams = buildJobProfileParams(searchParams);

  try {
    const response = await forwardCronRequest({
      secureInstance: guard.secureInstance,
      pathname: buildSidecarCronPath(`/${encodeURIComponent(parsedJobId.data)}`, proxyParams),
      method: "DELETE",
    });

    if (!response.ok) {
      await response.text().catch(() => "");
      logRejectedCronRequest(id, "DELETE", response, "delete");
      return NextResponse.json({ error: CRON_REQUEST_ERROR }, { status: response.status });
    }

    const payload = await readCronPayload(response);
    return NextResponse.json(payload ?? { ok: true }, { status: response.status });
  } catch (err) {
    logFailedCronRequest(id, "DELETE", err, "delete");
    return NextResponse.json({ error: CRON_REQUEST_ERROR }, { status: 502 });
  }
}

// The box can disambiguate a job across profiles on its own, but if the caller
// knows the profile it can pass ?profile= to skip the cross-profile scan.
function buildJobProfileParams(searchParams: URLSearchParams): URLSearchParams | undefined {
  const requestedProfile = searchParams.get("profile");
  if (!requestedProfile || requestedProfile === "all") return undefined;
  const parsed = PROFILE_SCHEMA.safeParse(requestedProfile);
  if (!parsed.success) return undefined;
  return new URLSearchParams({ profile: parsed.data });
}

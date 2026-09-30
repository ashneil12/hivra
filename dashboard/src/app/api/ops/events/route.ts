import { NextRequest } from 'next/server';
import { z } from 'zod';
import { auth, currentUser } from '@clerk/nextjs/server';

import { apiError, apiSuccess, handleApiError } from '@/lib/api-response';
import { enforceAuthenticatedRouteRateLimit } from '@/lib/authenticated-rate-limit';
import { log } from '@/lib/logger';
import { isOpsAdminUser } from '@/lib/ops-access';
import { archiveOpsEvents, deleteOpsEvents, reportOpsEvent, type OpsEventSeverity } from '@/lib/ops-events';
import { getRequestContext, type RequestContext } from '@/lib/request-context';
import { supabaseAdmin } from '@/lib/supabase';

// SCRIPTURE_ANCHOR: ops-watchman | Ezekiel 33:7 | Verse: I have made you a watchman to the house of Israel; therefore hear the word at my mouth.
const SeveritySchema = z.enum(['info', 'warn', 'error', 'fatal']);

const GetQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  severity: SeveritySchema.optional(),
});

// Source values an authenticated (non-admin) user is allowed to write.
// We keep this tight on purpose — POST /api/ops/events is intended for
// client-side telemetry the dashboard itself emits (see
// src/app/providers/OpsTelemetryProvider.tsx), NOT for users to shape
// arbitrary `source` strings (which would let them spoof admin-looking
// entries like `admin.force_delete` and bury real alerts behind fakes).
//
// When OpsTelemetryProvider grows new source identifiers, add them here.
const USER_TELEMETRY_SOURCE_ALLOW_LIST = new Set([
  "client-runtime",
  "client_telemetry",
  "client.error",
  "client.diagnostic",
  // Service Worker fetch failures (chat-start, sidecar SSE, legacy
  // proxy POST, persist PATCH). The SW POSTs structured failure
  // events from inside its own context whenever a fetch throws so
  // ops admins can correlate by trace id with Vercel function logs
  // and Caddy access.log without asking users to screenshot DevTools.
  "hermes-sw",
]);

const PostBodySchema = z.object({
  source: z.string().min(1).max(120),
  title: z.string().min(1).max(200),
  message: z.string().min(1).max(4000),
  severity: SeveritySchema.optional(),
  route: z.string().max(500).optional(),
  instanceId: z.string().max(120).optional(),
  conversationId: z.string().max(120).optional(),
  profileName: z.string().max(120).optional(),
  metadata: z.record(z.unknown()).optional(),
  sampleStack: z.string().max(8000).optional(),
});

const PatchBodySchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(5000),
});

const DeleteBodySchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(5000),
});

const ROUTE = '/api/ops/events';
const SOURCE = 'ops-events';

type ClientOpsEvent = z.infer<typeof PostBodySchema>;

// Everything POSTed here comes from a browser, so it is telemetry, never an
// incident: it can be recorded up to `error`, but never as `fatal`, because a
// first-sighting fatal pages the admin (email + Telegram) with the event's
// title and message. Anyone signed in could otherwise page the admin with
// their own text. Server code that needs to page calls reportOpsEvent()
// directly.
const CLIENT_SEVERITY_CEILING: Record<OpsEventSeverity, OpsEventSeverity> = {
  info: 'info',
  warn: 'warn',
  error: 'error',
  fatal: 'error',
};

// Per signed-in user, admins included. Telemetry dedupes by fingerprint, so
// this only bounds a flood of distinct events.
const CLIENT_EVENT_RATE_LIMIT = { limit: 30, windowMs: 60_000 } as const;

const CLIENT_TITLE_MAX_CHARS = 160;
// reportOpsEvent stores at most 1000 characters of a message anyway.
const CLIENT_MESSAGE_MAX_CHARS = 1000;

// Metadata keys that turn an ops event into a failure banner on the
// instance's owner's dashboard (buildInstanceFailureAlertFromOpsEvent). Only
// server code decides that an instance has failed.
const BANNER_METADATA_KEYS = ['failureOwner', 'failurePhase', 'recoveryAction'] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Characters that are invisible or reverse the reading direction, so text
// would read differently from what it is (e.g. a disguised file name).
const INVISIBLE_FORMAT_CHARS = /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;
const CONTROL_CHARS_EXCEPT_TAB_AND_NEWLINE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

function clampChars(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join('')}\u2026`;
}

/** One plain line: no line breaks (a title becomes an email subject), no control or invisible characters. */
function plainTitle(value: string): string {
  const flattened = value
    .replace(INVISIBLE_FORMAT_CHARS, '')
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clampChars(flattened || 'Client event', CLIENT_TITLE_MAX_CHARS);
}

/** Plain text that keeps its line breaks and tabs and drops every other control or invisible character. */
function plainMessage(value: string): string {
  const cleaned = value
    .replace(INVISIBLE_FORMAT_CHARS, '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS_EXCEPT_TAB_AND_NEWLINE, '')
    .trim();
  return clampChars(cleaned || 'Client event', CLIENT_MESSAGE_MAX_CHARS);
}

/**
 * Whether the signed-in user owns this Hermes instance or Hivra agent. An
 * event's instance_id decides whose dashboard reads it, so a caller may only
 * attach events to their own.
 */
async function callerOwnsInstance(userId: string, instanceId: string, ctx: RequestContext): Promise<boolean> {
  if (!supabaseAdmin || !UUID_PATTERN.test(instanceId)) return false;
  const db = supabaseAdmin;
  const owned = await Promise.all(['hermes_instances', 'hivra_agents'].map(async (table) => {
    const { data, error } = await db
      .from(table)
      .select('id')
      .eq('id', instanceId)
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle();
    if (error) {
      log.warn('client ops event instance ownership lookup failed; dropping the instance id', {
        ...ctx,
        failureType: 'ops_events_instance_lookup_failed',
        table,
        reportOpsEvent: false,
      });
      return false;
    }
    return Boolean(data);
  }));
  return owned.some(Boolean);
}

/**
 * The event as it may be stored from a browser: severity at most `error`,
 * title and message as clamped plain text, banner keys removed, and an
 * instance id only when the caller owns it (ops admins may name any).
 */
async function toStorableClientEvent(
  event: ClientOpsEvent,
  caller: { userId: string; isOpsAdmin: boolean },
  ctx: RequestContext,
): Promise<ClientOpsEvent> {
  const requestedSeverity = event.severity ?? 'error';
  const metadata: Record<string, unknown> = { ...(event.metadata ?? {}) };
  for (const key of BANNER_METADATA_KEYS) delete metadata[key];
  if (CLIENT_SEVERITY_CEILING[requestedSeverity] !== requestedSeverity) {
    metadata.clientRequestedSeverity = requestedSeverity;
  }

  let instanceId = event.instanceId;
  if (instanceId && !caller.isOpsAdmin && !(await callerOwnsInstance(caller.userId, instanceId, ctx))) {
    instanceId = undefined;
    metadata.instanceIdDropped = true;
  }

  return {
    ...event,
    title: plainTitle(event.title),
    message: plainMessage(event.message),
    severity: CLIENT_SEVERITY_CEILING[requestedSeverity],
    instanceId,
    metadata,
  };
}

function logAcceptedClientOpsEvent(event: ClientOpsEvent, ctx: RequestContext): void {
  const severity = event.severity || 'error';
  const logCtx = {
    ...ctx,
    source: event.source,
    route: event.route || ctx.route,
    ingestRoute: ctx.route,
    clientSource: event.source,
    clientSeverity: severity,
    clientTitle: event.title,
    clientMessage: event.message,
    clientMetadata: event.metadata,
    clientSampleStack: event.sampleStack,
    instanceId: event.instanceId || null,
    conversationId: event.conversationId || null,
    profileName: event.profileName || null,
    failureType: 'client_ops_event',
    reportOpsEvent: false,
  };

  if (severity === 'error' || severity === 'fatal') {
    log.error(
      'client ops event received',
      new Error(severity === 'fatal' ? 'client_reported_fatal' : 'client_reported_error'),
      logCtx,
    );
  } else if (severity === 'warn') {
    log.warn('client ops event received', logCtx);
  } else {
    log.info('client ops event received', logCtx);
  }
}

export async function GET(request: NextRequest) {
  const ctx = await getRequestContext(request, { source: SOURCE, route: ROUTE, skipAuth: true });
  try {
    const { userId } = await auth();
    ctx.userId = userId ?? null;
    if (!userId) return apiError('Unauthorized', 401, undefined, undefined, { ctx });
    const user = await currentUser();

    const parsed = GetQuerySchema.safeParse({
      limit: request.nextUrl.searchParams.get('limit') || 50,
      severity: request.nextUrl.searchParams.get('severity') || undefined,
    });

    if (!parsed.success) {
      return apiError('Invalid request parameters', 400, parsed.error, undefined, { ctx });
    }

    const { limit, severity } = parsed.data;
    const isOpsAdmin = isOpsAdminUser({
      userId,
      email: user?.primaryEmailAddress?.emailAddress || user?.emailAddresses?.[0]?.emailAddress || null,
    });

    if (!isOpsAdmin) {
      return apiError('Forbidden', 403, undefined, undefined, { ctx });
    }

    if (!supabaseAdmin) return apiError('Database not configured', 500, undefined, undefined, { ctx });

    let query = supabaseAdmin
      .from('ops_events')
      .select('*')
      .is('archived_at', null)
      .order('last_seen_at', { ascending: false })
      .limit(limit);

    if (severity) {
      query = query.eq('severity', severity as OpsEventSeverity);
    }

    const { data, error } = await query;
    if (error) {
      return apiError('Failed to fetch ops events', 500, {
        failureType: 'ops_events_fetch_failed',
      }, undefined, { ctx, failureType: 'ops_events_fetch_failed' });
    }

    return apiSuccess({
      events: data || [],
      isOpsAdmin: true,
      scope: 'global',
    }, 200, ctx);
  } catch (err) {
    return handleApiError(err, ctx);
  }
}

export async function POST(request: NextRequest) {
  const ctx = await getRequestContext(request, { source: SOURCE, route: ROUTE, skipAuth: true });
  try {
    const { userId } = await auth();
    ctx.userId = userId ?? null;
    if (!userId) return apiError('Unauthorized', 401, undefined, undefined, { ctx });

    const limited = enforceAuthenticatedRouteRateLimit(request, {
      routeKey: 'ops_events_post',
      userId,
      ...CLIENT_EVENT_RATE_LIMIT,
    });
    if (limited) return limited;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError('Invalid JSON body', 400, undefined, undefined, { ctx });
    }

    const parsed = PostBodySchema.safeParse(body);
    if (!parsed.success) {
      return apiError('Invalid request body', 400, parsed.error, undefined, { ctx });
    }

    // Non-admin users may only write to a fixed allow-list of `source`
    // values. Admins can write any source (used by the dashboard's own
    // server-side ops surfaces). Without this gate, any logged-in user
    // could bury real alerts under spoofed entries, including
    // admin-looking ones like `admin.force_delete`.
    const user = await currentUser();
    const isOpsAdmin = isOpsAdminUser({
      userId,
      email: user?.primaryEmailAddress?.emailAddress || user?.emailAddresses?.[0]?.emailAddress || null,
    });
    if (!isOpsAdmin && !USER_TELEMETRY_SOURCE_ALLOW_LIST.has(parsed.data.source)) {
      return apiError('Source not allowed', 403, {
        failureType: 'ops_events_source_not_allowed',
      }, undefined, { ctx, failureType: 'ops_events_source_not_allowed' });
    }

    const event = await toStorableClientEvent(parsed.data, { userId, isOpsAdmin }, ctx);

    await reportOpsEvent({
      ...event,
      userId,
    });

    logAcceptedClientOpsEvent(event, ctx);

    return apiSuccess({ accepted: true }, 202, ctx);
  } catch (err) {
    return handleApiError(err, ctx);
  }
}

export async function PATCH(request: NextRequest) {
  const ctx = await getRequestContext(request, { source: SOURCE, route: ROUTE, skipAuth: true });
  try {
    const { userId } = await auth();
    ctx.userId = userId ?? null;
    if (!userId) return apiError('Unauthorized', 401, undefined, undefined, { ctx });
    if (!supabaseAdmin) return apiError('Database not configured', 500, undefined, undefined, { ctx });

    const user = await currentUser();
    const isOpsAdmin = isOpsAdminUser({
      userId,
      email: user?.primaryEmailAddress?.emailAddress || user?.emailAddresses?.[0]?.emailAddress || null,
    });

    if (!isOpsAdmin) {
      return apiError('Forbidden', 403, undefined, undefined, { ctx });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError('Invalid JSON body', 400, undefined, undefined, { ctx });
    }

    const parsed = PatchBodySchema.safeParse(body);
    if (!parsed.success) {
      return apiError('Invalid request body', 400, parsed.error, undefined, { ctx });
    }

    const result = await archiveOpsEvents({
      ids: parsed.data.ids,
      archivedByUserId: userId,
    });

    if (result.error) {
      return apiError(`Failed to archive ops events: ${result.error}`, 500, {
        failureType: 'ops_events_archive_failed',
      }, undefined, { ctx, failureType: 'ops_events_archive_failed' });
    }

    return apiSuccess(result, 200, ctx);
  } catch (err) {
    return handleApiError(err, ctx);
  }
}

export async function DELETE(request: NextRequest) {
  const ctx = await getRequestContext(request, { source: SOURCE, route: ROUTE, skipAuth: true });
  try {
    const { userId } = await auth();
    ctx.userId = userId ?? null;
    if (!userId) return apiError('Unauthorized', 401, undefined, undefined, { ctx });
    if (!supabaseAdmin) return apiError('Database not configured', 500, undefined, undefined, { ctx });

    const user = await currentUser();
    const isOpsAdmin = isOpsAdminUser({
      userId,
      email: user?.primaryEmailAddress?.emailAddress || user?.emailAddresses?.[0]?.emailAddress || null,
    });

    if (!isOpsAdmin) {
      return apiError('Forbidden', 403, undefined, undefined, { ctx });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError('Invalid JSON body', 400, undefined, undefined, { ctx });
    }

    const parsed = DeleteBodySchema.safeParse(body);
    if (!parsed.success) {
      return apiError('Invalid request body', 400, parsed.error, undefined, { ctx });
    }

    const result = await deleteOpsEvents({ ids: parsed.data.ids });

    if (result.error) {
      return apiError(`Failed to delete ops events: ${result.error}`, 500, {
        failureType: 'ops_events_delete_failed',
      }, undefined, { ctx, failureType: 'ops_events_delete_failed' });
    }

    return apiSuccess(result, 200, ctx);
  } catch (err) {
    return handleApiError(err, ctx);
  }
}

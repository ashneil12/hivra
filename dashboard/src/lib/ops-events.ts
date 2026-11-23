import { createHash } from 'node:crypto';

import { redactSensitiveCommandOutput } from '@/lib/command-output-redaction';
import { supabaseAdmin } from '@/lib/supabase';

// SCRIPTURE_ANCHOR: ops-honest | 2 Corinthians 8:21 | Verse: We have regard for honorable things, not only in the sight of the Lord, but also in the sight of men.

export type OpsEventSeverity = 'info' | 'warn' | 'error' | 'fatal';

export interface OpsEventInput {
  source: string;
  title: string;
  message: string;
  /**
   * Extra input to the fingerprint only: the code location of a code-less error (its top
   * stack frame, see logger.ts). The detail is never written to the row, but the stored
   * fingerprint is a hash over it, so it must carry no values. A digest of a raw message
   * would let a reader test a guessed message (an internal IP or VMID) against the fingerprint.
   */
  fingerprintDetail?: string;
  severity?: OpsEventSeverity;
  route?: string;
  userId?: string | null;
  instanceId?: string | null;
  conversationId?: string | null;
  profileName?: string | null;
  metadata?: Record<string, unknown>;
  sampleStack?: string | null;
  /**
   * Page an admin on first sighting even when severity is below fatal. Same
   * dedupe rules as fatal: pages on the INSERT branch, and again only after the
   * row has been archived and the fingerprint recurs. Use for customer-impact
   * incidents that are errors, not process-fatal.
   */
  page?: boolean;
  /**
   * On an archived→open reopen, reset first_seen_at to now in the same write.
   * For rows whose first_seen_at is a domain timestamp (e.g. an outage start)
   * that must restart when the condition recurs, not keep the first-ever sighting.
   */
  resetFirstSeenOnReopen?: boolean;
}

export interface ArchiveOpsEventsInput {
  ids: string[];
  archivedByUserId: string;
}

export interface DeleteOpsEventsInput {
  ids: string[];
}

const SENSITIVE_KEY_PATTERN = /token|secret|password|authorization|cookie|api[-_]?key|session|bearer|pepper|credentials|private[-_]?key|webhook/i;
const MAX_STRING_LENGTH = 1000;
const MAX_ARRAY_ITEMS = 25;
const MAX_OBJECT_KEYS = 40;
const MAX_DEPTH = 5;

function sanitizeString(value: string): string {
  const redacted = redactSensitiveCommandOutput(value, Math.max(value.length, MAX_STRING_LENGTH));
  if (redacted.length <= MAX_STRING_LENGTH) return redacted;
  return `${redacted.slice(0, MAX_STRING_LENGTH)}… [TRUNCATED]`;
}

function sanitizeUnknown(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return '[DEPTH_LIMIT]';
  if (value == null) return value;

  if (typeof value === 'string') {
    return sanitizeString(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeUnknown(item, depth + 1));
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeString(value.message),
      stack: value.stack ? sanitizeString(value.stack) : undefined,
    };
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS);
    return Object.fromEntries(entries.map(([key, nestedValue]) => {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        return [key, '[REDACTED]'];
      }
      return [key, sanitizeUnknown(nestedValue, depth + 1)];
    }));
  }

  return String(value);
}

export function sanitizeOpsMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!metadata) return {};
  return sanitizeUnknown(metadata, 0) as Record<string, unknown>;
}

export function buildOpsEventFingerprint(input: {
  source: string;
  title: string;
  message: string;
  fingerprintDetail?: string;
  route?: string;
  userId?: string | null;
  instanceId?: string | null;
  conversationId?: string | null;
  profileName?: string | null;
}): string {
  const raw = JSON.stringify({
    source: input.source,
    title: input.title,
    message: input.message,
    route: input.route || '',
    userId: input.userId || '',
    instanceId: input.instanceId || '',
    conversationId: input.conversationId || '',
    profileName: input.profileName || '',
    // Added only when given, so events without a detail keep their existing fingerprint.
    ...(input.fingerprintDetail ? { detail: input.fingerprintDetail } : {}),
  });

  return createHash('sha256').update(raw).digest('hex');
}

export async function reportOpsEvent(input: OpsEventInput): Promise<{ id?: string; fingerprint: string } | null> {
  if (!supabaseAdmin) return null;

  const severity = input.severity || 'error';
  const fingerprint = buildOpsEventFingerprint(input);
  const now = new Date().toISOString();
  const shouldPage = severity === 'fatal' || input.page === true;

  const payload = {
    fingerprint,
    source: sanitizeString(input.source),
    severity,
    title: sanitizeString(input.title),
    message: sanitizeString(input.message),
    route: input.route ? sanitizeString(input.route) : null,
    user_id: input.userId || null,
    instance_id: input.instanceId || null,
    conversation_id: input.conversationId || null,
    profile_name: input.profileName || null,
    metadata: sanitizeOpsMetadata(input.metadata),
    sample_stack: input.sampleStack ? sanitizeString(input.sampleStack) : null,
    environment: process.env.NODE_ENV || 'unknown',
  };

  try {
    const { data: existing, error: lookupError } = await supabaseAdmin
      .from('ops_events')
      .select('id, occurrence_count, archived_at')
      .eq('fingerprint', fingerprint)
      .maybeSingle();

    if (lookupError) {
      return null;
    }

    if (existing?.id) {
      const wasArchived = existing.archived_at != null;

      if (wasArchived) {
        // Conditional reopen: the write only lands while the row is still
        // archived, so exactly one racing writer flips it back to open — and
        // only that writer may page for the fresh incident.
        const { data: reopened, error: reopenError } = await supabaseAdmin
          .from('ops_events')
          .update({
            ...payload,
            archived_at: null,
            archived_by_user_id: null,
            last_seen_at: now,
            occurrence_count: (existing.occurrence_count || 0) + 1,
            ...(input.resetFirstSeenOnReopen ? { first_seen_at: now } : {}),
          })
          .eq('id', existing.id)
          .not('archived_at', 'is', null)
          .select('id')
          .maybeSingle();

        // A failed update is NOT a lost race: the row is still archived, no
        // writer paged, and the event went unrecorded. Returning the existing
        // id here would look like a persisted event to callers while the feed
        // stayed silent — report failure instead, same as the lookup path.
        if (reopenError) {
          return null;
        }

        if (reopened?.id) {
          // A recurrence of an ARCHIVED fingerprint un-archives the row —
          // that is a fresh incident, so it pages once more. An still-open
          // row takes the branch below and must not re-page.
          if (shouldPage) {
            await dispatchAdminPageAlert({
              fingerprint,
              source: payload.source,
              title: payload.title,
              message: payload.message,
              route: payload.route,
              instanceId: payload.instance_id,
              userId: payload.user_id,
              metadata: payload.metadata,
            });
          }
          return { id: reopened.id, fingerprint };
        }
        // Lost the reopen race: the update was error-free but matched no rows,
        // so another writer already flipped the row open (and paged if needed).
        // The fingerprint is represented; report the existing row id.
        return { id: existing.id, fingerprint };
      }

      const { data } = await supabaseAdmin
        .from('ops_events')
        .update({
          ...payload,
          archived_at: null,
          archived_by_user_id: null,
          last_seen_at: now,
          occurrence_count: (existing.occurrence_count || 0) + 1,
        })
        .eq('id', existing.id)
        .select('id')
        .single();

      return {
        id: data?.id,
        fingerprint,
      };
    }

    const { data } = await supabaseAdmin
      .from('ops_events')
      .insert({
        ...payload,
        first_seen_at: now,
        last_seen_at: now,
        occurrence_count: 1,
      })
      .select('id')
      .single();

    // First sighting of a pageable fingerprint (fatal, or page:true): page an
    // admin once — but only after the insert actually persisted an id, so a
    // failed write can never page for an event that was never stored. The
    // INSERT branch is the dedupe — an extended outage that
    // keeps re-reporting the same fingerprint takes the UPDATE branch above
    // and never re-pages, so a prolonged incident notifies exactly once
    // instead of every cron tick. The one exception is a recurrence after the
    // row was archived, handled on the UPDATE branch.
    // Best-effort and fire-and-forget: the alert transport is awaited but its
    // own try/catch swallows everything, so a Resend/Telegram hiccup can never
    // mask the event write or throw out of reportOpsEvent.
    if (shouldPage && data?.id) {
      await dispatchAdminPageAlert({
        fingerprint,
        source: payload.source,
        title: payload.title,
        message: payload.message,
        route: payload.route,
        instanceId: payload.instance_id,
        userId: payload.user_id,
        metadata: payload.metadata,
      });
    }

    return {
      id: data?.id,
      fingerprint,
    };
  } catch {
    return null;
  }
}

/**
 * Page an admin for a first-sighting pageable event (fatal severity or
 * page:true). Isolated so the dynamic import of the (Resend-pulling)
 * transport stays off the hot path of non-paging events, and so a transport
 * failure is contained to a logged warning. Never throws.
 */
async function dispatchAdminPageAlert(input: {
  fingerprint: string;
  source: string;
  title: string;
  message: string;
  route: string | null;
  instanceId: string | null;
  userId: string | null;
  metadata: Record<string, unknown>;
}): Promise<void> {
  try {
    const { sendOpsFatalAdminAlert } = await import('@/lib/email/ops-fatal-admin');
    await sendOpsFatalAdminAlert(input);
  } catch {
    // Transport module failed to load or threw past its own guard — never let
    // paging break event recording.
  }
}

export async function archiveOpsEvents(input: ArchiveOpsEventsInput): Promise<{ archivedCount: number; error?: string }> {
  if (!supabaseAdmin) return { archivedCount: 0, error: 'supabase admin client unavailable' };

  const ids = Array.from(new Set(input.ids.filter((id) => id.trim().length > 0)));
  if (ids.length === 0) return { archivedCount: 0 };

  const archivedAt = new Date().toISOString();

  try {
    const { data, error } = await supabaseAdmin
      .from('ops_events')
      .update({
        archived_at: archivedAt,
        archived_by_user_id: input.archivedByUserId,
      })
      .in('id', ids)
      .select('id');

    if (error) return { archivedCount: 0, error: error.message };

    return {
      archivedCount: data?.length || 0,
    };
  } catch (err) {
    return { archivedCount: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function deleteOpsEvents(input: DeleteOpsEventsInput): Promise<{ deletedCount: number; error?: string }> {
  if (!supabaseAdmin) return { deletedCount: 0, error: 'supabase admin client unavailable' };

  const ids = Array.from(new Set(input.ids.filter((id) => id.trim().length > 0)));
  if (ids.length === 0) return { deletedCount: 0 };

  try {
    const { data, error } = await supabaseAdmin
      .from('ops_events')
      .delete()
      .in('id', ids)
      .select('id');

    if (error) return { deletedCount: 0, error: error.message };

    return {
      deletedCount: data?.length || 0,
    };
  } catch (err) {
    return { deletedCount: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

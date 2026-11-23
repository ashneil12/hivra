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
  /**
   * ISO-8601 time the observation behind this report was taken. For events
   * whose fingerprint row doubles as a state record (e.g. the public-probe
   * outage rows), a report can be in flight long enough — a stalled write
   * racing a deadline — for a NEWER observation to change the stored verdict
   * first: the row got archived by a healthy scan, or records an outage that
   * began after this observation. Reopening or refreshing that row would
   * commit stale state. When set, both update branches are predicated on the
   * observation still being current and the report is refused
   * ({ superseded: true }) instead. The insert branch is unguarded by
   * necessity: no row exists to contradict the observation.
   */
  observedAt?: string;
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

export interface OpsEventReport {
  /** Persisted row id — unset when a raced write matched nothing. */
  id?: string;
  fingerprint: string;
  /**
   * Set (true) only for observedAt-guarded reports that were REFUSED: the
   * stored fingerprint row carries a verdict newer than the observation this
   * report recorded — it was archived after the observation, or its recorded
   * start began after it — so the stale write was skipped rather than
   * committed. Callers should treat the subject as contested, not written.
   */
  superseded?: boolean;
}

function parseIsoMs(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : Number.NaN;
}

function buildOpsEventPayload(input: OpsEventInput, fingerprint: string) {
  return {
    fingerprint,
    source: sanitizeString(input.source),
    severity: input.severity || 'error',
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
}

export async function reportOpsEvent(input: OpsEventInput): Promise<OpsEventReport | null> {
  if (!supabaseAdmin) return null;

  const severity = input.severity || 'error';
  const fingerprint = buildOpsEventFingerprint(input);
  const now = new Date().toISOString();
  const shouldPage = severity === 'fatal' || input.page === true;
  // The observation-time guard (see OpsEventInput.observedAt) keeps a stalled
  // report from committing a stale verdict over a newer one. An unparseable
  // timestamp disables the guard rather than silently refusing every write.
  const observedAtMs = input.observedAt != null ? Date.parse(input.observedAt) : Number.NaN;
  const hasObservedAt = Number.isFinite(observedAtMs);

  const payload = buildOpsEventPayload(input, fingerprint);

  try {
    const { data: existing, error: lookupError } = await supabaseAdmin
      .from('ops_events')
      .select('id, occurrence_count, archived_at, first_seen_at')
      .eq('fingerprint', fingerprint)
      .maybeSingle();

    if (lookupError) {
      return null;
    }

    if (existing?.id) {
      const wasArchived = existing.archived_at != null;

      if (wasArchived) {
        // A row closed AT-or-AFTER the observation was resolved by a newer
        // verdict; reopening it from this stale report would resurrect a
        // state that already ended. Refuse before the write — and predicate
        // the write itself so the same verdict landing between the lookup
        // and the update turns it into a no-op as well.
        const archivedAtMs = parseIsoMs(existing.archived_at);
        if (hasObservedAt && Number.isFinite(archivedAtMs) && archivedAtMs >= observedAtMs) {
          return { fingerprint, superseded: true };
        }

        // Conditional reopen: the write only lands while the row is still
        // archived, so exactly one racing writer flips it back to open — and
        // only that writer may page for the fresh incident.
        let reopenQuery = supabaseAdmin
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
          .not('archived_at', 'is', null);
        if (input.observedAt) {
          // Same verdict at the row: the close must still predate the
          // observation, or the reopen is the stale commit.
          reopenQuery = reopenQuery.lt('archived_at', input.observedAt);
        }
        const { data: reopened, error: reopenError } = await reopenQuery
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
        // The update was error-free but matched no rows. Unguarded reports
        // treat that as a lost reopen race — another writer already flipped
        // the row open (and paged if needed), so the fingerprint is
        // represented. Guarded reports treat it as a refusal: the verdict
        // that won is newer than this observation.
        if (input.observedAt) {
          return { fingerprint, superseded: true };
        }
        return { id: existing.id, fingerprint };
      }

      // An OPEN row that records a start newer than this observation belongs
      // to a fresher report — this stale one must not bump it.
      const firstSeenAtMs = parseIsoMs(existing.first_seen_at);
      if (hasObservedAt && Number.isFinite(firstSeenAtMs) && firstSeenAtMs > observedAtMs) {
        return { fingerprint, superseded: true };
      }

      let refreshQuery = supabaseAdmin
        .from('ops_events')
        .update({
          ...payload,
          archived_at: null,
          archived_by_user_id: null,
          last_seen_at: now,
          occurrence_count: (existing.occurrence_count || 0) + 1,
        })
        .eq('id', existing.id);
      if (input.observedAt) {
        // Land only while the row has not been closed after the observation
        // (the update itself can reopen an archived row — an archive landing
        // between the lookup and this write must not be undone by the stale
        // report) and does not record a start newer than the observation.
        refreshQuery = refreshQuery
          .or(`archived_at.is.null,archived_at.lt."${input.observedAt}"`)
          .lte('first_seen_at', input.observedAt);
      }
      const { data } = await refreshQuery
        .select('id')
        .single();

      if (input.observedAt && !data?.id) {
        return { fingerprint, superseded: true };
      }
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

export interface OpsEventInsertOnceResult {
  /** Inserted row id — set only when this call actually wrote the row. */
  id?: string;
  fingerprint: string;
  /**
   * True when this call inserted the row; false when the fingerprint was
   * already stored — the unique constraint resolved the race at insert time
   * and NO update, reopen, or counter bump happened.
   */
  inserted: boolean;
}

/**
 * Insert-only report: records the event iff its fingerprint is not already
 * stored. reportOpsEvent's dedupe is select-then-update — two racing reports
 * can both pass the lookup and the second lands on the UPDATE branch,
 * bumping last_seen_at/occurrence_count (or reopening an archived row) for
 * an event that was already recorded. For receipt relays — where each
 * receipt is a unique event that must persist exactly once no matter how
 * many sweeps re-read it — that bump is false activity.
 *
 * The unique fingerprint constraint decides the race atomically inside the
 * INSERT (ON CONFLICT DO NOTHING): a conflict means "already recorded" and
 * changes nothing. Pages on insert like reportOpsEvent's insert branch —
 * the row IS the first sighting — and never otherwise.
 *
 * Returns the insert result on success, { inserted:false } on conflict,
 * and null on failure (same convention as reportOpsEvent).
 */
export async function reportOpsEventOnce(input: OpsEventInput): Promise<OpsEventInsertOnceResult | null> {
  if (!supabaseAdmin) return null;

  const severity = input.severity || 'error';
  const fingerprint = buildOpsEventFingerprint(input);
  const now = new Date().toISOString();
  const shouldPage = severity === 'fatal' || input.page === true;

  const payload = buildOpsEventPayload(input, fingerprint);

  try {
    const { data, error } = await supabaseAdmin
      .from('ops_events')
      .upsert(
        {
          ...payload,
          first_seen_at: now,
          last_seen_at: now,
          occurrence_count: 1,
        },
        { onConflict: 'fingerprint', ignoreDuplicates: true },
      )
      .select('id');

    if (error) return null;

    const row = ((data ?? []) as Array<{ id?: string }>)[0];
    if (!row?.id) {
      // Fingerprint already stored: this receipt was recorded already.
      return { fingerprint, inserted: false };
    }

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

    return { id: row.id, fingerprint, inserted: true };
  } catch {
    return null;
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

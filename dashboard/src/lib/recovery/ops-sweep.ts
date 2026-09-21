import { classifyOpsEvent, type OpsEventBucket } from '@/lib/ops-event-classification';
import type { OpsEventSeverity } from '@/lib/ops-events';
import { extractOpsEventHostIp, resolveOpsEventHostIpMap } from '@/lib/ops-event-hosts';
import { supabaseAdmin } from '@/lib/supabase';

export interface OpsSweepEventRow {
  id: string;
  source: string;
  severity: OpsEventSeverity;
  title: string;
  message: string;
  route: string | null;
  user_id: string | null;
  instance_id: string | null;
  conversation_id: string | null;
  profile_name: string | null;
  metadata: Record<string, unknown> | null;
  sample_stack: string | null;
  first_seen_at: string;
  last_seen_at: string;
  occurrence_count: number;
  archived_at?: string | null;
}

export interface OpsSweepOptions {
  hours?: number;
  since?: string;
  limit?: number;
  severity?: OpsEventSeverity;
  source?: string;
  includeArchived?: boolean;
}

export interface OpsSweepEvent extends OpsSweepEventRow {
  bucket: OpsEventBucket;
  bucketLabel: string;
  hostIp: string | null;
  consolePath: string | null;
  automationGuidance: string;
}

interface OpsSweepSummary {
  total: number;
  fatal: number;
  error: number;
  warn: number;
  info: number;
  byBucket: Record<OpsEventBucket, number>;
}

export interface OpsSweepReport {
  generatedAt: string;
  filters: {
    window: string;
    limit: number;
    includeArchived: boolean;
    severity: OpsEventSeverity | null;
    source: string | null;
  };
  summary: OpsSweepSummary;
  events: OpsSweepEvent[];
}

const MAX_LIMIT = 500;

const BUCKET_LABELS: Record<OpsEventBucket, string> = {
  'assistant-soft-error': 'Soft Chat Error',
  'chat-runtime': 'Chat Runtime',
  proxy: 'Proxy',
  persistence: 'Persistence',
  'client-runtime': 'Client Runtime',
  browser: 'Browser',
  health: 'Health',
  other: 'Other',
};

function truncateBlock(value: string | null | undefined, maxLength = 900): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}\n...`;
}

function formatMetadata(metadata: Record<string, unknown> | null): string | null {
  if (!metadata || Object.keys(metadata).length === 0) return null;
  return truncateBlock(JSON.stringify(metadata, null, 2));
}

function normalizeLimit(limit?: number): number {
  if (!Number.isFinite(limit)) return 200;
  return Math.min(Math.max(Math.trunc(limit as number), 1), MAX_LIMIT);
}

function resolveWindowDescription(options: OpsSweepOptions): string {
  if (options.since) {
    return `since ${options.since}`;
  }

  if (typeof options.hours === 'number' && Number.isFinite(options.hours) && options.hours > 0) {
    return `last ${options.hours}h`;
  }

  return options.includeArchived ? 'all incidents' : 'all unarchived incidents';
}

function resolveSinceTimestamp(options: OpsSweepOptions): string | null {
  if (options.since) {
    const parsed = new Date(options.since);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error('Invalid `since` timestamp. Expected an ISO-8601 value.');
    }
    return parsed.toISOString();
  }

  if (typeof options.hours === 'number' && Number.isFinite(options.hours) && options.hours > 0) {
    return new Date(Date.now() - options.hours * 60 * 60 * 1000).toISOString();
  }

  return null;
}

function describeOpsAutomationGuidance(
  event: Pick<OpsSweepEvent, 'bucket' | 'source' | 'title' | 'message'>
): string {
  const source = event.source.toLowerCase();
  const title = event.title.toLowerCase();
  const message = event.message.toLowerCase();

  if (event.bucket === 'assistant-soft-error') {
    return 'Treat this as a runtime or provider failure, not a valid assistant reply. Verify the managed stream path is sanitizing upstream failures before archiving repeats.';
  }

  if (
    event.bucket === 'client-runtime' &&
    (title.includes('input_batch_delay_ms') || message.includes('input_batch_delay_ms'))
  ) {
    return 'This often points to an older deployed bundle. Check the live release first; if current code already uses the shell and TUI batch delay constants, treat new incidents as deployment drift instead of writing a new fix.';
  }

  if (
    source.includes('codex-oauth-status') ||
    source.includes('instance-actions') ||
    message.includes('ssh host fingerprint') ||
    message.includes('timed out capturing ssh host fingerprint')
  ) {
    return 'Prefer the existing Hermes retryable status or action flows before raw SSH. Use SSH only if the host stays unhealthy after route-level verification or a safe retry.';
  }

  if (event.bucket === 'client-runtime') {
    return 'Confirm the issue still reproduces in the current deployed build before changing code. Ignore known low-signal client noise and focus on actionable regressions.';
  }

  if (event.bucket === 'proxy' || event.bucket === 'chat-runtime') {
    return 'Start with route verification, provider availability, and recent deploy changes. Prefer non-destructive retries and existing Hermes APIs before touching infrastructure.';
  }

  return 'Verify the current route still reproduces the problem, use Hermes APIs before SSH when possible, and archive only after a confirmed fix or a clearly stale incident.';
}

export function decorateOpsSweepEvents(
  rows: OpsSweepEventRow[],
  hostIpByInstanceId: ReadonlyMap<string, string> = new Map<string, string>()
): OpsSweepEvent[] {
  return rows.map((row) => {
    const bucket = classifyOpsEvent(row);
    const hostIp =
      extractOpsEventHostIp(row.metadata) ||
      (row.instance_id ? hostIpByInstanceId.get(row.instance_id) || null : null);

    const decorated: OpsSweepEvent = {
      ...row,
      bucket,
      bucketLabel: BUCKET_LABELS[bucket],
      hostIp,
      consolePath: row.instance_id ? `/dashboard/instances/${row.instance_id}/console` : null,
      automationGuidance: describeOpsAutomationGuidance({
        bucket,
        source: row.source,
        title: row.title,
        message: row.message,
      }),
    };

    return decorated;
  });
}

export function buildOpsSweepReport(
  events: OpsSweepEvent[],
  options: OpsSweepOptions = {},
  generatedAt = new Date().toISOString()
): OpsSweepReport {
  const summary: OpsSweepSummary = {
    total: events.length,
    fatal: events.filter((event) => event.severity === 'fatal').length,
    error: events.filter((event) => event.severity === 'error').length,
    warn: events.filter((event) => event.severity === 'warn').length,
    info: events.filter((event) => event.severity === 'info').length,
    byBucket: {
      'assistant-soft-error': events.filter((event) => event.bucket === 'assistant-soft-error').length,
      'chat-runtime': events.filter((event) => event.bucket === 'chat-runtime').length,
      proxy: events.filter((event) => event.bucket === 'proxy').length,
      persistence: events.filter((event) => event.bucket === 'persistence').length,
      'client-runtime': events.filter((event) => event.bucket === 'client-runtime').length,
      browser: events.filter((event) => event.bucket === 'browser').length,
      health: events.filter((event) => event.bucket === 'health').length,
      other: events.filter((event) => event.bucket === 'other').length,
    },
  };

  return {
    generatedAt,
    filters: {
      window: resolveWindowDescription(options),
      limit: normalizeLimit(options.limit),
      includeArchived: Boolean(options.includeArchived),
      severity: options.severity || null,
      source: options.source || null,
    },
    summary,
    events,
  };
}

export function formatOpsSweepMarkdownReport(report: OpsSweepReport): string {
  const bucketSummary = Object.entries(report.summary.byBucket)
    .filter(([, count]) => count > 0)
    .map(([bucket, count]) => `- ${BUCKET_LABELS[bucket as OpsEventBucket]}: ${count}`)
    .join('\n');

  const incidents = report.events.map((event, index) => {
    const metadata = formatMetadata(event.metadata);
    const stack = truncateBlock(event.sample_stack);

    const lines = [
      `Incident ${index + 1}`,
      `- ID: ${event.id}`,
      `- Title: ${event.title}`,
      `- Source: ${event.source}`,
      `- Severity: ${event.severity}`,
      `- Bucket: ${event.bucketLabel}`,
      event.route ? `- Route: ${event.route}` : null,
      event.instance_id ? `- Instance: ${event.instance_id}` : null,
      event.hostIp ? `- Server IP: ${event.hostIp}` : null,
      event.consolePath ? `- Console Path: ${event.consolePath}` : null,
      event.profile_name ? `- Profile: ${event.profile_name}` : null,
      event.conversation_id ? `- Conversation: ${event.conversation_id}` : null,
      `- Occurrences: ${event.occurrence_count}`,
      `- First Seen: ${event.first_seen_at}`,
      `- Last Seen: ${event.last_seen_at}`,
      `- Message: ${event.message}`,
      `- Automation Guidance: ${event.automationGuidance}`,
      metadata ? `- Metadata:\n${metadata}` : null,
      stack ? `- Stack Sample:\n${stack}` : null,
    ].filter((line): line is string => Boolean(line));

    return lines.join('\n');
  });

  return [
    '# Hermes Ops Sweep',
    `Generated: ${report.generatedAt}`,
    `Scope: ${report.filters.window}`,
    `Limit: ${report.filters.limit}`,
    `Include archived: ${report.filters.includeArchived ? 'yes' : 'no'}`,
    report.filters.severity ? `Severity filter: ${report.filters.severity}` : null,
    report.filters.source ? `Source filter: ${report.filters.source}` : null,
    '',
    `Total incidents: ${report.summary.total}`,
    `Severity summary: fatal ${report.summary.fatal}, error ${report.summary.error}, warn ${report.summary.warn}, info ${report.summary.info}`,
    bucketSummary ? `Bucket summary:\n${bucketSummary}` : null,
    '',
    report.events.length === 0 ? 'No incidents matched the current sweep.' : incidents.join('\n\n'),
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

export async function fetchOpsSweepReport(options: OpsSweepOptions = {}): Promise<OpsSweepReport> {
  if (!supabaseAdmin) {
    throw new Error('Database not configured. Missing Supabase admin credentials.');
  }

  const limit = normalizeLimit(options.limit);
  const since = resolveSinceTimestamp(options);
  let query = supabaseAdmin
    .from('ops_events')
    .select('*')
    .order('last_seen_at', { ascending: false })
    .limit(limit);

  if (!options.includeArchived) {
    query = query.is('archived_at', null);
  }

  if (options.severity) {
    query = query.eq('severity', options.severity);
  }

  if (options.source) {
    query = query.eq('source', options.source);
  }

  if (since) {
    query = query.gte('last_seen_at', since);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to fetch ops incidents: ${error.message}`);
  }

  const rows = (data || []) as OpsSweepEventRow[];
  const hostIpByInstanceId = await resolveOpsEventHostIpMap(
    rows
      .map((row) => row.instance_id || '')
      .filter((instanceId): instanceId is string => instanceId.length > 0)
  );

  return buildOpsSweepReport(
    decorateOpsSweepEvents(rows, hostIpByInstanceId),
    { ...options, limit }
  );
}

import Link from 'next/link';
import { auth, currentUser } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';

import { OpsArchiveButton } from '@/components/ops/OpsArchiveButton';
import { OpsCopyAllButton } from '@/components/ops/OpsCopyAllButton';
import { OpsDeleteAllButton } from '@/components/ops/OpsDeleteAllButton';
import { OpsHandoffCopyButton } from '@/components/ops/OpsHandoffCopyButton';
import { OpsRowActions } from '@/components/ops/OpsRowActions';
import { OpsSourceGroup } from '@/components/ops/OpsSourceGroup';
import { DashboardPageShell } from '@/components/layout/DashboardPageShell';
import { isOpsAdminUser } from '@/lib/ops-access';
import { classifyOpsEvent, type OpsEventBucket } from '@/lib/ops-event-classification';
import { extractOpsEventHostIp, resolveOpsEventHostIpMap } from '@/lib/ops-event-hosts';
import { buildOpsEventHandoffPrompt } from '@/lib/ops-event-handoff';
import { buildInstanceFailureAlertFromOpsEvent } from '@/lib/failure-ownership';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

type Severity = 'info' | 'warn' | 'error' | 'fatal';

interface OpsEventRow {
  id: string;
  source: string;
  severity: Severity;
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
}

interface DecoratedOpsEvent extends OpsEventRow {
  bucket: OpsEventBucket;
  hostIp: string | null;
}

const FILTERS: Array<Severity | 'all'> = ['all', 'fatal', 'error', 'warn', 'info'];
const BUCKET_FILTERS: Array<OpsEventBucket | 'all'> = [
  'all',
  'assistant-soft-error',
  'chat-runtime',
  'proxy',
  'persistence',
  'client-runtime',
  'browser',
  'health',
  'other',
];

const severityStyles: Record<Severity, { bg: string; border: string; text: string }> = {
  info: { bg: 'rgba(59,130,246,0.08)', border: 'rgba(59,130,246,0.22)', text: '#1d4ed8' },
  warn: { bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.22)', text: '#b45309' },
  error: { bg: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.22)', text: '#b91c1c' },
  fatal: { bg: 'rgba(127,29,29,0.12)', border: 'rgba(127,29,29,0.28)', text: '#7f1d1d' },
};

const bucketStyles: Record<OpsEventBucket, { bg: string; border: string; text: string; label: string }> = {
  'assistant-soft-error': { bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.22)', text: '#b45309', label: 'Soft Chat Error' },
  'chat-runtime': { bg: 'rgba(59,130,246,0.08)', border: 'rgba(59,130,246,0.22)', text: '#1d4ed8', label: 'Chat Runtime' },
  proxy: { bg: 'rgba(244,63,94,0.08)', border: 'rgba(244,63,94,0.22)', text: '#be123c', label: 'Proxy' },
  persistence: { bg: 'rgba(20,184,166,0.08)', border: 'rgba(20,184,166,0.22)', text: '#0f766e', label: 'Persistence' },
  'client-runtime': { bg: 'rgba(168,85,247,0.08)', border: 'rgba(168,85,247,0.22)', text: '#7e22ce', label: 'Client Runtime' },
  browser: { bg: 'rgba(14,165,233,0.08)', border: 'rgba(14,165,233,0.22)', text: '#0369a1', label: 'Browser' },
  health: { bg: 'rgba(34,197,94,0.08)', border: 'rgba(34,197,94,0.22)', text: '#15803d', label: 'Health' },
  other: { bg: 'rgba(107,114,128,0.08)', border: 'rgba(107,114,128,0.22)', text: '#374151', label: 'Other' },
};
const UNARCHIVED_FETCH_CAP = 2000;

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function formatMetadata(value: Record<string, unknown> | null): string | null {
  if (!value || Object.keys(value).length === 0) return null;

  const serialized = JSON.stringify(value, null, 2);
  if (serialized.length <= 900) return serialized;
  return `${serialized.slice(0, 900)}\n…`;
}

function formatBucketLabel(value: OpsEventBucket | 'all'): string {
  if (value === 'all') return 'all';
  return bucketStyles[value].label;
}

async function fetchTopUnarchivedOpsEvents(): Promise<{
  data: OpsEventRow[] | null;
  error: { message: string } | null;
  capHit: boolean;
}> {
  const { data, error } = await supabaseAdmin!
    .from('ops_events')
    .select('*')
    .is('archived_at', null)
    .order('last_seen_at', { ascending: false })
    .limit(UNARCHIVED_FETCH_CAP);

  if (error) {
    return { data: null, error, capHit: false };
  }

  const rows = (data || []) as OpsEventRow[];
  return { data: rows, error: null, capHit: rows.length >= UNARCHIVED_FETCH_CAP };
}

function buildOpsFeedCopyText(events: DecoratedOpsEvent[]): string {
  const sections = events.map((event, index) => {
    const metadata = formatMetadata(event.metadata);
    const lines = [
      `Incident ${index + 1}`,
      `Title: ${event.title}`,
      `Source: ${event.source}`,
      `Severity: ${event.severity}`,
      `Bucket: ${bucketStyles[event.bucket].label}`,
      event.route ? `Route: ${event.route}` : null,
      event.instance_id ? `Instance: ${event.instance_id}` : null,
      event.hostIp ? `Server IP: ${event.hostIp}` : null,
      event.profile_name ? `Profile: ${event.profile_name}` : null,
      event.conversation_id ? `Conversation: ${event.conversation_id}` : null,
      `Occurrences: ${event.occurrence_count}`,
      `First seen: ${event.first_seen_at}`,
      `Last seen: ${event.last_seen_at}`,
      `Message: ${event.message}`,
      metadata ? `Metadata:\n${metadata}` : null,
      event.sample_stack ? `Stack Sample:\n${event.sample_stack}` : null,
    ].filter((line): line is string => Boolean(line));

    return lines.join('\n');
  });

  return [
    'Hermes Internal Ops Feed',
    `Matching unarchived incidents: ${events.length}`,
    '',
    ...sections,
  ].join('\n\n');
}

export default async function OpsPage(props: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { userId } = await auth();
  await auth.protect();
  const user = await currentUser();
  const userEmail = user?.primaryEmailAddress?.emailAddress || user?.emailAddresses?.[0]?.emailAddress || null;
  const isOpsAdmin = isOpsAdminUser({ userId: userId || user?.id || null, email: userEmail });

  if (!isOpsAdmin) {
    redirect('/dashboard');
    return null;
  }

  if (!supabaseAdmin) {
    return (
      <div className="p-10">
        <h1 className="serif text-3xl">Ops is unavailable.</h1>
        <p style={{ color: 'var(--text-secondary)' }}>The Supabase admin client is not configured.</p>
      </div>
    );
  }

  const searchParams = await props.searchParams;
  const severityFilterRaw = typeof searchParams.severity === 'string' ? searchParams.severity : 'all';
  const severityFilter = FILTERS.includes(severityFilterRaw as Severity | 'all')
    ? (severityFilterRaw as Severity | 'all')
    : 'all';
  const bucketFilterRaw = typeof searchParams.bucket === 'string' ? searchParams.bucket : 'all';
  const bucketFilter = BUCKET_FILTERS.includes(bucketFilterRaw as OpsEventBucket | 'all')
    ? (bucketFilterRaw as OpsEventBucket | 'all')
    : 'all';
  const sourceFilter = typeof searchParams.source === 'string' ? searchParams.source : 'all';
  const limitRaw = typeof searchParams.limit === 'string' ? Number(searchParams.limit) : 50;
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 10), 100) : 50;

  const { data, error, capHit } = await fetchTopUnarchivedOpsEvents();

  if (error) {
    return (
      <div className="p-10">
        <h1 className="serif text-3xl">Ops feed failed to load.</h1>
        <p style={{ color: 'var(--text-secondary)' }}>{error.message}</p>
      </div>
    );
  }

  const rawEvents = (data || []) as OpsEventRow[];
  const hostIpByInstanceId = await resolveOpsEventHostIpMap(
    rawEvents
      .map((event) => event.instance_id || '')
      .filter((instanceId): instanceId is string => instanceId.length > 0)
  );
  const allEvents = (rawEvents.map((event) => ({
    ...event,
    bucket: classifyOpsEvent(event),
    hostIp: extractOpsEventHostIp(event.metadata) || (event.instance_id ? hostIpByInstanceId.get(event.instance_id) || null : null),
  })) as DecoratedOpsEvent[]);
  const sourceOptions = ['all', ...Array.from(new Set(allEvents.map((event) => event.source))).sort((a, b) => a.localeCompare(b))];
  const filteredEvents = allEvents.filter((event) => {
    if (severityFilter !== 'all' && event.severity !== severityFilter) return false;
    if (bucketFilter !== 'all' && event.bucket !== bucketFilter) return false;
    if (sourceFilter !== 'all' && event.source !== sourceFilter) return false;
    return true;
  });
  const events = filteredEvents.slice(0, limit);
  const groupedEvents = events.reduce<Record<string, DecoratedOpsEvent[]>>((acc, event) => {
    if (!acc[event.source]) acc[event.source] = [];
    acc[event.source].push(event);
    return acc;
  }, {});

  const totalSuffix = capHit ? '+' : '';
  const summary = {
    total: `${allEvents.length}${totalSuffix}`,
    fatal: `${allEvents.filter((event) => event.severity === 'fatal').length}${totalSuffix}`,
    error: `${allEvents.filter((event) => event.severity === 'error').length}${totalSuffix}`,
    warn: `${allEvents.filter((event) => event.severity === 'warn').length}${totalSuffix}`,
    softChat: `${allEvents.filter((event) => event.bucket === 'assistant-soft-error').length}${totalSuffix}`,
  };
  const feedBadge = 'Internal Ops Feed';
  const feedDescription = 'This feed rolls up dashboard, browser, chat, and runtime failures into one operator view across the whole system.';

  return (
    <>
      <DashboardPageShell
        maxWidth={1100}
        marginBottom="8rem"
        padding="0 clamp(16px, 5vw, 24px)"
        topPadding="1rem"
        style={{ position: 'relative', zIndex: 1 }}
      >
        <div
          className="flex flex-col md:flex-row md:justify-between"
          style={{
            gap: '1.5rem',
            alignItems: 'flex-start',
            marginBottom: '3rem',
          }}
        >
          <div style={{ maxWidth: 900 }}>
            <p
              className="mono"
              style={{
                fontSize: 12,
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                opacity: 0.5,
                color: 'var(--ink-black)',
                fontWeight: 700,
                marginTop: '1rem',
                marginBottom: 0,
              }}
            >
              {feedBadge}
            </p>
            <h1
              className="serif"
              style={{
                fontSize: 'clamp(2.5rem, 8vw, 3.5rem)',
                fontWeight: 400,
                lineHeight: 1,
                color: 'var(--ink-black)',
                margin: 0,
                marginBottom: '0.5rem',
              }}
            >
              Live system incidents.
            </h1>
            <p style={{ color: 'var(--text-secondary)', maxWidth: 980, lineHeight: 1.8, fontSize: '1.05rem', marginTop: '1rem' }}>
              {feedDescription}
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <OpsCopyAllButton incidentCount={filteredEvents.length} text={buildOpsFeedCopyText(filteredEvents)} />
            <OpsArchiveButton eventIds={filteredEvents.map((event) => event.id)} />
            <OpsDeleteAllButton eventIds={filteredEvents.map((event) => event.id)} />
            <Link
              href="/dashboard/ops"
              className="action-button"
              style={{ padding: '10px 20px', fontSize: 10, letterSpacing: '0.1em', textDecoration: 'none' }}
            >
              Refresh Feed
            </Link>
          </div>
        </div>

        {capHit && (
          <div
            style={{
              border: '1px solid rgba(245,158,11,0.45)',
              background: 'rgba(245,158,11,0.08)',
              padding: '0.75rem 1rem',
              marginBottom: '1rem',
              fontSize: 13,
              color: '#92400e',
            }}
          >
            Showing the {UNARCHIVED_FETCH_CAP} most recent unarchived incidents. Archive or delete what you see, then refresh to load the next batch.
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6" style={{ marginBottom: '1.5rem' }}>
          {[
            { label: 'Tracked Events', value: summary.total },
            { label: 'Fatal', value: summary.fatal },
            { label: 'Errors', value: summary.error },
            { label: 'Warnings', value: summary.warn },
            { label: 'Soft Chat', value: summary.softChat },
          ].map((item) => (
            <div
              key={item.label}
              style={{
                border: '1px solid var(--etched-border)',
                background: 'var(--bg-surface)',
                padding: '1.25rem 1.2rem',
                boxShadow: '0 6px 18px rgba(0,0,0,0.04)',
              }}
            >
              <p className="mono" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--text-muted)', marginBottom: 8 }}>
                {item.label}
              </p>
              <p style={{ fontSize: 28, lineHeight: 1, color: 'var(--ink-black)', fontWeight: 700 }}>{item.value}</p>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap gap-2" style={{ marginBottom: '1.5rem' }}>
          {FILTERS.map((filter) => {
            const isActive = severityFilter === filter;
            const params = new URLSearchParams({ limit: String(limit) });
            if (filter !== 'all') params.set('severity', filter);
            if (bucketFilter !== 'all') params.set('bucket', bucketFilter);
            if (sourceFilter !== 'all') params.set('source', sourceFilter);
            const href = `/dashboard/ops?${params.toString()}`;

            return (
              <Link
                key={filter}
                href={href}
                style={{
                  padding: '8px 12px',
                  border: '1px solid var(--etched-border)',
                  background: isActive ? 'var(--ink-black)' : 'var(--bg-surface)',
                  color: isActive ? 'var(--vellum-bg)' : 'var(--ink-black)',
                  textDecoration: 'none',
                  fontSize: 12,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                }}
              >
                {filter}
              </Link>
            );
          })}
        </div>

        <div className="flex flex-wrap gap-2" style={{ marginBottom: '1rem' }}>
          {BUCKET_FILTERS.map((filter) => {
            const isActive = bucketFilter === filter;
            const params = new URLSearchParams({ limit: String(limit) });
            if (severityFilter !== 'all') params.set('severity', severityFilter);
            if (filter !== 'all') params.set('bucket', filter);
            if (sourceFilter !== 'all') params.set('source', sourceFilter);
            const href = `/dashboard/ops?${params.toString()}`;

            return (
              <Link
                key={filter}
                href={href}
                style={{
                  padding: '8px 12px',
                  border: '1px solid var(--etched-border)',
                  background: isActive ? 'var(--ink-black)' : 'var(--bg-surface)',
                  color: isActive ? 'var(--vellum-bg)' : 'var(--ink-black)',
                  textDecoration: 'none',
                  fontSize: 12,
                  fontWeight: 700,
                  letterSpacing: '0.05em',
                }}
              >
                {formatBucketLabel(filter)}
              </Link>
            );
          })}
        </div>

        <div className="flex flex-wrap gap-2" style={{ marginBottom: '1.5rem' }}>
          {sourceOptions.map((source) => {
            const isActive = sourceFilter === source;
            const params = new URLSearchParams({ limit: String(limit) });
            if (severityFilter !== 'all') params.set('severity', severityFilter);
            if (bucketFilter !== 'all') params.set('bucket', bucketFilter);
            if (source !== 'all') params.set('source', source);
            const href = `/dashboard/ops?${params.toString()}`;

            return (
              <Link
                key={source}
                href={href}
                style={{
                  padding: '8px 12px',
                  border: '1px solid var(--etched-border)',
                  background: isActive ? 'rgba(0,0,0,0.92)' : 'var(--bg-surface)',
                  color: isActive ? 'var(--vellum-bg)' : 'var(--ink-black)',
                  textDecoration: 'none',
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                }}
              >
                {source}
              </Link>
            );
          })}
        </div>

        <div className="space-y-4">
          {events.length === 0 ? (
            <div
              style={{
                border: '1px solid var(--etched-border)',
                background: 'var(--bg-surface)',
                padding: '1.5rem',
              }}
            >
              <p style={{ color: 'var(--text-secondary)' }}>No incidents match the current filter.</p>
            </div>
          ) : (
            Object.entries(groupedEvents).map(([source, sourceEvents]) => (
              <OpsSourceGroup key={source} source={source} incidentCount={sourceEvents.length}>
                {sourceEvents.map((event) => {
                    const metadata = formatMetadata(event.metadata);
                    const severityStyle = severityStyles[event.severity];
                    const bucketStyle = bucketStyles[event.bucket];
                    const failureAlert = buildInstanceFailureAlertFromOpsEvent({
                      source: event.source,
                      severity: event.severity,
                      title: event.title,
                      message: event.message,
                      lastSeenAt: event.last_seen_at,
                      metadata: event.metadata,
                    });
                    const handoffPrompt = buildOpsEventHandoffPrompt({
                      source: event.source,
                      title: event.title,
                      message: event.message,
                      route: event.route,
                      instanceId: event.instance_id,
                      hostIp: event.hostIp,
                      conversationId: event.conversation_id,
                      profileName: event.profile_name,
                      metadata: event.metadata,
                      sampleStack: event.sample_stack,
                      bucket: event.bucket,
                    });

                    return (
                      <article
                        key={event.id}
                        style={{
                          border: '1px solid var(--etched-border)',
                          background: 'var(--bg-surface)',
                          padding: '1.25rem',
                          boxShadow: '0 8px 24px rgba(0,0,0,0.04)',
                        }}
                      >
                        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span
                                className="mono"
                                style={{
                                  padding: '4px 8px',
                                  fontSize: 10,
                                  textTransform: 'uppercase',
                                  letterSpacing: '0.12em',
                                  background: severityStyle.bg,
                                  border: `1px solid ${severityStyle.border}`,
                                  color: severityStyle.text,
                                  fontWeight: 700,
                                }}
                              >
                                {event.severity}
                              </span>
                              <span
                                className="mono"
                                style={{
                                  padding: '4px 8px',
                                  fontSize: 10,
                                  letterSpacing: '0.1em',
                                  background: bucketStyle.bg,
                                  border: `1px solid ${bucketStyle.border}`,
                                  color: bucketStyle.text,
                                  fontWeight: 700,
                                }}
                              >
                                {bucketStyle.label}
                              </span>
                              <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                                seen {formatTime(event.last_seen_at)}
                              </span>
                            </div>
                            <h3 className="serif" style={{ fontSize: '1.45rem', marginTop: '0.9rem', color: 'var(--ink-black)' }}>
                              {event.title}
                            </h3>
                            <p style={{ color: 'var(--text-secondary)', lineHeight: 1.7, marginTop: '0.6rem', whiteSpace: 'pre-wrap' }}>
                              {event.message}
                            </p>
                          </div>

                          <div style={{ minWidth: 160, display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-end' }}>
                            <div>
                              <p className="mono" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--text-muted)', marginBottom: 6, textAlign: 'right' }}>
                                Occurrences
                              </p>
                              <p style={{ fontSize: 28, fontWeight: 700, color: 'var(--ink-black)', textAlign: 'right' }}>{event.occurrence_count}</p>
                            </div>
                            <OpsRowActions eventId={event.id} title={event.title} />
                          </div>
                        </div>

                        <div className="mt-4 flex flex-wrap gap-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
                          {event.route && <span><strong style={{ color: 'var(--ink-black)' }}>Route:</strong> {event.route}</span>}
                          {isOpsAdmin && event.user_id && <span><strong style={{ color: 'var(--ink-black)' }}>User:</strong> {event.user_id}</span>}
                          {event.instance_id && <span><strong style={{ color: 'var(--ink-black)' }}>Instance:</strong> {event.instance_id}</span>}
                          {event.hostIp && <span><strong style={{ color: 'var(--ink-black)' }}>Server IP:</strong> {event.hostIp}</span>}
                          {event.profile_name && <span><strong style={{ color: 'var(--ink-black)' }}>Profile:</strong> {event.profile_name}</span>}
                          {event.conversation_id && <span><strong style={{ color: 'var(--ink-black)' }}>Conversation:</strong> {event.conversation_id}</span>}
                          {failureAlert && <span><strong style={{ color: 'var(--ink-black)' }}>Owner:</strong> {failureAlert.ownerLabel}</span>}
                          {failureAlert && <span><strong style={{ color: 'var(--ink-black)' }}>Phase:</strong> {failureAlert.phaseLabel}</span>}
                          {failureAlert && <span><strong style={{ color: 'var(--ink-black)' }}>Recovery:</strong> {failureAlert.recoveryLabel}</span>}
                          {failureAlert?.requestId && <span><strong style={{ color: 'var(--ink-black)' }}>Request:</strong> {failureAlert.requestId}</span>}
                        </div>

                        <div className="mt-4 flex flex-wrap gap-3">
                          {event.instance_id && (
                            <Link
                              href={`/dashboard/instances/${event.instance_id}/console`}
                              style={{
                                fontSize: 12,
                                fontWeight: 700,
                                textTransform: 'uppercase',
                                letterSpacing: '0.1em',
                                textDecoration: 'none',
                                color: 'var(--ink-black)',
                              }}
                            >
                              Open Instance Console
                            </Link>
                          )}
                          <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                            first seen {formatTime(event.first_seen_at)}
                          </span>
                        </div>

                        {(metadata || event.sample_stack) && (
                          <div className="mt-4 grid gap-4 lg:grid-cols-2">
                            {metadata && (
                              <div>
                                <p className="mono" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--text-muted)', marginBottom: 8 }}>
                                  Metadata
                                </p>
                                <pre
                                  style={{
                                    margin: 0,
                                    padding: '0.9rem',
                                    border: '1px solid var(--etched-border)',
                                    background: 'rgba(0,0,0,0.03)',
                                    fontSize: 12,
                                    overflowX: 'auto',
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-word',
                                  }}
                                >
                                  {metadata}
                                </pre>
                              </div>
                            )}

                            {event.sample_stack && (
                              <div>
                                <p className="mono" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--text-muted)', marginBottom: 8 }}>
                                  Stack Sample
                                </p>
                                <pre
                                  style={{
                                    margin: 0,
                                    padding: '0.9rem',
                                    border: '1px solid var(--etched-border)',
                                    background: 'rgba(0,0,0,0.03)',
                                    fontSize: 12,
                                    overflowX: 'auto',
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-word',
                                  }}
                                >
                                  {event.sample_stack}
                                </pre>
                              </div>
                            )}
                          </div>
                        )}

                        <div className="mt-4">
                          <div className="flex flex-wrap items-center justify-between gap-3" style={{ marginBottom: '0.7rem' }}>
                            <p className="mono" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--text-muted)', margin: 0 }}>
                              Agent Handoff
                            </p>
                            <OpsHandoffCopyButton text={handoffPrompt} />
                          </div>
                          <pre
                            style={{
                              margin: 0,
                              padding: '0.9rem',
                              border: '1px solid var(--etched-border)',
                              background: 'rgba(0,0,0,0.03)',
                              fontSize: 12,
                              overflowX: 'auto',
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                            }}
                          >
                            {handoffPrompt}
                          </pre>
                        </div>
                      </article>
                    );
                  })}
              </OpsSourceGroup>
            ))
          )}
        </div>
      </DashboardPageShell>
    </>
  );
}

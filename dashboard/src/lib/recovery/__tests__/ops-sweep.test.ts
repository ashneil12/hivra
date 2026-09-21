import {
  buildOpsSweepReport,
  decorateOpsSweepEvents,
  formatOpsSweepMarkdownReport,
} from '@/lib/recovery/ops-sweep';

describe('ops-sweep', () => {
  it('decorates incidents with bucket, host IP, console path, and automation guidance', () => {
    const events = decorateOpsSweepEvents(
      [
        {
          id: 'evt_1',
          source: 'chat-soft-error',
          severity: 'warn',
          title: 'Assistant returned an error-like message',
          message: 'Error code: 401 - invalid access token',
          route: '/dashboard/chat',
          user_id: null,
          instance_id: 'inst_123',
          conversation_id: 'conv_123',
          profile_name: 'default',
          metadata: null,
          sample_stack: null,
          first_seen_at: '2026-04-23T08:00:00.000Z',
          last_seen_at: '2026-04-23T08:05:00.000Z',
          occurrence_count: 2,
        },
        {
          id: 'evt_2',
          source: 'client-runtime',
          severity: 'error',
          title: 'Unhandled client error',
          message: 'INPUT_BATCH_DELAY_MS is not defined',
          route: '/dashboard/instances/inst_456/tui',
          user_id: null,
          instance_id: 'inst_456',
          conversation_id: null,
          profile_name: null,
          metadata: {
            hostIp: '198.51.100.7',
          },
          sample_stack: null,
          first_seen_at: '2026-04-23T09:00:00.000Z',
          last_seen_at: '2026-04-23T09:01:00.000Z',
          occurrence_count: 1,
        },
      ],
      new Map([['inst_123', '203.0.113.10']])
    );

    expect(events[0]).toMatchObject({
      bucket: 'assistant-soft-error',
      hostIp: '203.0.113.10',
      consolePath: '/dashboard/instances/inst_123/console',
    });
    expect(events[0].automationGuidance).toMatch(/runtime or provider failure/i);

    expect(events[1]).toMatchObject({
      bucket: 'client-runtime',
      hostIp: '198.51.100.7',
      consolePath: '/dashboard/instances/inst_456/console',
    });
    expect(events[1].automationGuidance).toMatch(/older deployed bundle/i);
  });

  it('builds a severity and bucket summary', () => {
    const report = buildOpsSweepReport([
      {
        id: 'evt_warn',
        source: 'chat-soft-error',
        severity: 'warn',
        title: 'Soft chat',
        message: 'Generation failed: 404',
        route: '/dashboard/chat',
        user_id: null,
        instance_id: 'inst_1',
        conversation_id: null,
        profile_name: null,
        metadata: null,
        sample_stack: null,
        first_seen_at: '2026-04-23T08:00:00.000Z',
        last_seen_at: '2026-04-23T08:05:00.000Z',
        occurrence_count: 1,
        bucket: 'assistant-soft-error',
        bucketLabel: 'Soft Chat Error',
        hostIp: '203.0.113.10',
        consolePath: '/dashboard/instances/inst_1/console',
        automationGuidance: 'guidance',
      },
      {
        id: 'evt_error',
        source: 'client-runtime',
        severity: 'error',
        title: 'Unhandled client error',
        message: 'boom',
        route: '/dashboard/ops',
        user_id: null,
        instance_id: null,
        conversation_id: null,
        profile_name: null,
        metadata: null,
        sample_stack: null,
        first_seen_at: '2026-04-23T09:00:00.000Z',
        last_seen_at: '2026-04-23T09:01:00.000Z',
        occurrence_count: 1,
        bucket: 'client-runtime',
        bucketLabel: 'Client Runtime',
        hostIp: null,
        consolePath: null,
        automationGuidance: 'guidance',
      },
    ], {
      hours: 24,
      limit: 100,
    }, '2026-04-23T10:00:00.000Z');

    expect(report.summary).toEqual({
      total: 2,
      fatal: 0,
      error: 1,
      warn: 1,
      info: 0,
      byBucket: {
        'assistant-soft-error': 1,
        'chat-runtime': 0,
        proxy: 0,
        persistence: 0,
        'client-runtime': 1,
        browser: 0,
        health: 0,
        other: 0,
      },
    });
    expect(report.filters.window).toBe('last 24h');
  });

  it('formats an automation-friendly markdown report', () => {
    const markdown = formatOpsSweepMarkdownReport(buildOpsSweepReport([
      {
        id: 'evt_1',
        source: 'codex-oauth-status',
        severity: 'error',
        title: 'API 500',
        message: 'Timed out capturing SSH host fingerprint from 203.0.113.10 after 5321ms',
        route: '/api/instances/[id]/oauth/codex/status',
        user_id: null,
        instance_id: 'inst_123',
        conversation_id: null,
        profile_name: null,
        metadata: {
          status: 500,
        },
        sample_stack: 'None',
        first_seen_at: '2026-04-23T08:00:00.000Z',
        last_seen_at: '2026-04-23T08:05:00.000Z',
        occurrence_count: 3,
        bucket: 'other',
        bucketLabel: 'Other',
        hostIp: '203.0.113.10',
        consolePath: '/dashboard/instances/inst_123/console',
        automationGuidance: 'Prefer the existing Hermes retryable status or action flows before raw SSH.',
      },
    ], {
      hours: 24,
      limit: 100,
    }, '2026-04-23T10:00:00.000Z'));

    expect(markdown).toContain('# Hermes Ops Sweep');
    expect(markdown).toContain('Total incidents: 1');
    expect(markdown).toContain('- Server IP: 203.0.113.10');
    expect(markdown).toContain('- Console Path: /dashboard/instances/inst_123/console');
    expect(markdown).toContain('Prefer the existing Hermes retryable status or action flows before raw SSH.');
  });
});

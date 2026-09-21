import fs from 'node:fs';
import path from 'node:path';

import { buildOpsEventHandoffPrompt, type OpsEventHandoffInput } from '../ops-event-handoff';
import type { OpsEventBucket } from '../ops-event-classification';

const WORKSPACE_ROOT = path.resolve(process.cwd(), '..');

const ALL_BUCKETS: OpsEventBucket[] = [
  'assistant-soft-error',
  'chat-runtime',
  'proxy',
  'persistence',
  'client-runtime',
  'browser',
  'health',
  'other',
];

function baseInput(overrides: Partial<OpsEventHandoffInput> = {}): OpsEventHandoffInput {
  return {
    source: 'api',
    title: 'Something failed',
    message: 'Something failed',
    route: null,
    instanceId: null,
    hostIp: null,
    conversationId: null,
    profileName: null,
    metadata: null,
    sampleStack: null,
    bucket: 'other',
    ...overrides,
  };
}

/** The prompt lists suspect files as `- <repo-relative path>` bullet lines. */
function extractSuspectFiles(prompt: string): string[] {
  return prompt
    .split('\n')
    .filter((line) => line.startsWith('- dashboard/'))
    .map((line) => line.slice('- '.length));
}

function expectAllExist(suspects: string[]): void {
  expect(suspects.length).toBeGreaterThan(0);

  const missing = suspects.filter((suspect) => !fs.existsSync(path.join(WORKSPACE_ROOT, suspect)));
  expect(missing).toEqual([]);
}

describe('ops-event-handoff', () => {
  it('builds a copy-friendly prompt with incident context and suspect files', () => {
    const prompt = buildOpsEventHandoffPrompt({
      source: 'chat-soft-error',
      title: 'Assistant returned an error-like message',
      message: 'Assistant message matched multiple runtime failure keywords.',
      route: '/dashboard/chat',
      instanceId: 'inst-123',
      hostIp: '203.0.113.10',
      conversationId: 'conv-123',
      profileName: 'default',
      metadata: {
        excerpt: 'Error: provider returned 429 rate limit exceeded.',
      },
      sampleStack: null,
      bucket: 'assistant-soft-error',
    });

    expect(prompt).toContain('Bucket: assistant-soft-error');
    expect(prompt).toContain('Source: chat-soft-error');
    expect(prompt).toContain('Server IP: 203.0.113.10');
    expect(prompt).toContain('dashboard/src/lib/server-chat-stream-outcome.ts');
    expect(prompt).toContain('verify the actual code path before diagnosing');
  });

  it('truncates large metadata and stack samples', () => {
    const prompt = buildOpsEventHandoffPrompt(
      baseInput({
        source: 'responses-proxy',
        title: 'Responses proxy failed',
        message: 'Gateway unreachable',
        route: '/api/instances/[id]/responses',
        instanceId: 'inst-999',
        metadata: { huge: 'x'.repeat(1200) },
        sampleStack: 'y'.repeat(1200),
        bucket: 'proxy',
      })
    );

    expect(prompt).toContain('...');
    expect(prompt).toContain('dashboard/src/lib/agent-gateway.ts');
  });

  // send-stream and responses are both retired, but ops_events is append-only so
  // historical rows still carry those routes. The handoff must never cite the
  // deleted routes, their deleted helpers, or the deleted in-dashboard chat
  // surface they used to live behind.
  describe('retired chat proxies', () => {
    const RETIRED_ROUTES = [
      '/api/instances/[id]/send-stream',
      '/api/instances/inst-444/send-stream',
      '/api/instances/[id]/responses',
      '/api/instances/inst-333/responses',
    ];

    const DELETED_PATHS = [
      'dashboard/src/app/api/instances/[id]/send-stream/route.ts',
      'dashboard/src/app/api/instances/[id]/responses/route.ts',
      'dashboard/src/lib/chat-send-stream.ts',
      'dashboard/src/lib/chat-send-stream-events.ts',
      'dashboard/src/lib/responses-proxy-request.ts',
      'dashboard/src/components/chat/hooks/useChatStreaming.ts',
      'dashboard/src/components/chat/hooks/chat-stream.ts',
    ];

    it.each(RETIRED_ROUTES)('points %s at the surviving transports', (route) => {
      const prompt = buildOpsEventHandoffPrompt(
        baseInput({
          source: 'responses-proxy',
          title: 'Chat transport incident',
          message: 'Final assistant text missing after tool call.',
          route,
          bucket: 'proxy',
        })
      );

      expect(prompt).toContain('dashboard/src/components/hivra/HivraChat.tsx');
      expect(prompt).toContain('dashboard/src/components/webui/WebuiIframe.tsx');

      for (const deleted of DELETED_PATHS) {
        expect(prompt).not.toContain(deleted);
      }
    });

    it('leaves unrelated routes to their bucket defaults', () => {
      const prompt = buildOpsEventHandoffPrompt(
        baseInput({ route: '/api/instances/inst-1/health', bucket: 'health' })
      );

      expect(prompt).toContain('dashboard/src/app/api/instances/[id]/health/route.ts');
      expect(prompt).not.toContain('dashboard/src/components/hivra/HivraChat.tsx');
    });
  });

  // buildOpsEventHandoffPrompt is pure string concatenation, so a stale path is
  // invisible until an operator opens the handoff and finds nothing there. The
  // send-stream retirement shipped exactly that bug: it repointed the handoff at
  // `responses/route.ts` and `useChatStreaming.ts`, both already dead. This is
  // the guard — every suspect file the prompt can emit must exist on disk.
  describe('every suspect file exists on disk', () => {
    it.each(ALL_BUCKETS)('bucket %s cites only real files', (bucket) => {
      expectAllExist(extractSuspectFiles(buildOpsEventHandoffPrompt(baseInput({ bucket }))));
    });

    it('the retired-route mapping cites only real files', () => {
      expectAllExist(
        extractSuspectFiles(
          buildOpsEventHandoffPrompt(
            baseInput({ route: '/api/instances/[id]/responses', bucket: 'proxy' })
          )
        )
      );
    });
  });
});

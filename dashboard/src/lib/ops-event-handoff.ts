import type { OpsEventBucket } from './ops-event-classification';

export interface OpsEventHandoffInput {
  source: string;
  title: string;
  message: string;
  route: string | null;
  instanceId: string | null;
  hostIp: string | null;
  conversationId: string | null;
  profileName: string | null;
  metadata: Record<string, unknown> | null;
  sampleStack: string | null;
  bucket: OpsEventBucket;
}

/**
 * Starting points an operator should open for each incident bucket.
 *
 * INVARIANT: every path here must exist on disk. `buildOpsEventHandoffPrompt` is
 * pure string concatenation, so a stale entry silently ships an operator (or an
 * agent) to a file that was deleted years ago. `ops-event-handoff.test.ts`
 * asserts the whole map against the filesystem to keep that from rotting again.
 *
 * The webui-free cutover removed the in-dashboard chat surface
 * (`src/components/chat/**`) and the conversation-mirror API
 * (`src/app/api/conversations/**`), and the send-stream + responses retirements
 * removed both per-instance chat proxies. Chat lives on the box now: the Hivra
 * lane posts straight to `<box>/api/chat` (HivraChat) and the instances lane
 * renders the box's own dashboard in a cross-origin iframe (WebuiIframe).
 */
const SUSPECT_FILES: Record<OpsEventBucket, string[]> = {
  'assistant-soft-error': [
    'dashboard/src/lib/server-chat-stream-outcome.ts',
    'dashboard/src/lib/ops-event-classification.ts',
  ],
  'chat-runtime': [
    'dashboard/src/components/hivra/HivraChat.tsx',
    'dashboard/src/lib/server-chat-stream-outcome.ts',
    'dashboard/src/app/dashboard/chat/page.tsx',
  ],
  proxy: [
    'dashboard/src/lib/agent-gateway.ts',
    'dashboard/src/lib/gateway-probe.ts',
  ],
  persistence: [
    'dashboard/src/app/dashboard/agent/[id]/page.tsx',
    'dashboard/src/lib/ops-events.ts',
  ],
  'client-runtime': [
    'dashboard/src/app/providers/OpsTelemetryProvider.tsx',
    'dashboard/src/app/dashboard/error.tsx',
    'dashboard/src/app/dashboard/ops/page.tsx',
  ],
  browser: [
    'dashboard/src/app/api/instances/[id]/browser-stream/route.ts',
    'dashboard/src/app/api/instances/[id]/browser-sessions/route.ts',
  ],
  health: [
    'dashboard/src/app/api/instances/[id]/health/route.ts',
    'dashboard/src/components/webui/WebuiIframe.tsx',
  ],
  other: [
    'dashboard/src/lib/ops-events.ts',
    'dashboard/src/app/dashboard/ops/page.tsx',
  ],
};

/** The two per-instance chat proxies the dashboard used to own. Both retired. */
const RETIRED_CHAT_PROXY_SEGMENTS = ['/send-stream', '/responses'] as const;

function isRetiredChatProxyRoute(route: string): boolean {
  return (
    route.includes('/api/instances/') &&
    RETIRED_CHAT_PROXY_SEGMENTS.some((segment) => route.includes(segment))
  );
}

/**
 * `ops_events` is append-only, so historical rows still carry
 * `/api/instances/:id/send-stream` and `/api/instances/:id/responses` (in both
 * the templated `[id]` and concrete-id forms). Both routes are gone: send-stream
 * proxied to hermes-webui's removed `POST /api/chat/start`, and responses proxied
 * to the agent's `POST /v1/responses` on :8642 — real, but bound to the compose
 * network and never exposed by the per-instance Caddyfile. Point those incidents
 * at the transports that actually carry chat today, never at deleted files.
 */
function getRouteSpecificFiles(route: string | null): string[] {
  if (!route) return [];

  if (isRetiredChatProxyRoute(route)) {
    return [
      'dashboard/src/components/hivra/HivraChat.tsx',
      'dashboard/src/components/webui/WebuiIframe.tsx',
      'dashboard/src/lib/agent-gateway.ts',
    ];
  }

  return [];
}

function formatMetadata(metadata: Record<string, unknown> | null): string {
  if (!metadata || Object.keys(metadata).length === 0) return 'None';
  const serialized = JSON.stringify(metadata, null, 2);
  if (serialized.length <= 800) return serialized;
  return `${serialized.slice(0, 800)}\n...`;
}

function formatStack(sampleStack: string | null): string {
  if (!sampleStack) return 'None';
  if (sampleStack.length <= 800) return sampleStack;
  return `${sampleStack.slice(0, 800)}\n...`;
}

function formatValue(label: string, value: string | null): string {
  return `${label}: ${value || 'None'}`;
}

export function buildOpsEventHandoffPrompt(input: OpsEventHandoffInput): string {
  const suspectFiles = [
    ...getRouteSpecificFiles(input.route),
    ...(SUSPECT_FILES[input.bucket] || SUSPECT_FILES.other),
  ].filter((file, index, allFiles) => allFiles.indexOf(file) === index);

  return [
    `Investigate this Hermes incident and propose the smallest safe fix.`,
    ``,
    `Confirmed incident data:`,
    `- Bucket: ${input.bucket}`,
    `- Source: ${input.source}`,
    `- Title: ${input.title}`,
    `- Message: ${input.message}`,
    `- ${formatValue('Route', input.route)}`,
    `- ${formatValue('Instance', input.instanceId)}`,
    `- ${formatValue('Server IP', input.hostIp)}`,
    `- ${formatValue('Conversation', input.conversationId)}`,
    `- ${formatValue('Profile', input.profileName)}`,
    ``,
    `Metadata:`,
    formatMetadata(input.metadata),
    ``,
    `Stack sample:`,
    formatStack(input.sampleStack),
    ``,
    `Suggested starting files:`,
    ...suspectFiles.map((file) => `- ${file}`),
    ``,
    `Please:`,
    `1. verify the actual code path before diagnosing`,
    `2. separate confirmed facts from hypotheses`,
    `3. identify the smallest robust fix`,
    `4. call out tests that should cover the fix`,
  ].join('\n');
}

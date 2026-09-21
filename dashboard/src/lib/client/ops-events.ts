import { pushBreadcrumb } from './breadcrumbs';
import { isLocalAuthMode } from '@/lib/self-host/config';

export interface ClientOpsEventInput {
  source: string;
  title: string;
  message: string;
  severity?: 'info' | 'warn' | 'error' | 'fatal';
  route?: string;
  instanceId?: string;
  conversationId?: string;
  profileName?: string;
  metadata?: Record<string, unknown>;
  sampleStack?: string;
}

export async function captureClientOpsEvent(input: ClientOpsEventInput): Promise<void> {
  // Always push a breadcrumb — even if the network POST fails, the local
  // ring buffer keeps a record so the next "Copy report" can still surface
  // what was happening in the seconds before the user-visible failure.
  pushBreadcrumb({
    ts: new Date().toISOString(),
    source: input.source,
    severity: input.severity || 'info',
    title: input.title,
    route: input.route,
    instanceId: input.instanceId,
  });

  // A standalone installation has no Hivra-operated event collector. Keep the
  // local breadcrumb for diagnostics without making a failing hosted-ops POST.
  if (isLocalAuthMode()) return;

  try {
    await fetch('/api/ops/events', {
      method: 'POST',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });
  } catch {
    // Swallow to avoid cascading client failures from the reporter itself.
  }
}

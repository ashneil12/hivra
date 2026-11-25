/** Software evidence for one launched agent, read through the owner API. */

import type { APIRequestContext } from '@playwright/test';

export interface SweepSoftwareEvidence {
  supported: boolean;
  /** Catalog app or CLI name when the owner API supports this agent. */
  name?: string;
  /** The public software view kind (`current`, `checking`, `not_running`, …). */
  state?: string;
  /** The installed version the computer reported; for catalog docker apps this is normally the resolved sha256 image digest. */
  installed?: string | null;
  observedAt?: string | null;
  error?: string;
}

interface AgentSoftwareApiResponse {
  supported?: boolean;
  cli?: string | null;
  app?: string | null;
  observedAt?: string | null;
  view?: { kind?: string; installed?: string | null } | null;
}

/** Converts the owner API's public response into compact sweep evidence. */
export function softwareEvidenceFromResponse(body: AgentSoftwareApiResponse): SweepSoftwareEvidence {
  if (!body.supported) return { supported: false };
  return {
    supported: true,
    name: body.app ?? body.cli ?? undefined,
    state: body.view?.kind,
    installed: body.view?.installed ?? null,
    observedAt: body.observedAt ?? null,
  };
}

/**
 * Reads the live software report without making it part of the pass/fail proof.
 * A missing or unreadable version is evidence; it must not turn an otherwise
 * successful customer-path launch into a harness failure.
 */
export async function readSweepSoftware(
  request: APIRequestContext,
  baseUrl: string,
  agentId: string,
): Promise<SweepSoftwareEvidence> {
  try {
    const res = await request.get(`${baseUrl}/api/hivra/agents/${encodeURIComponent(agentId)}/agent-software?live=1`, { timeout: 90_000 });
    if (!res.ok()) return { supported: false, error: `agent-software answered HTTP ${res.status()}` };
    const body = (await res.json()) as { data?: AgentSoftwareApiResponse };
    return softwareEvidenceFromResponse(body.data ?? {});
  } catch (error) {
    return { supported: false, error: error instanceof Error ? error.message : String(error) };
  }
}

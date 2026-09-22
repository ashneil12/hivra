import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { NormalizedTelemetryEvent } from "./otlp";

export interface PersistTelemetryResult { accepted: number; duplicates: number; ids: string[] }

export async function persistTelemetryEvents(
  client: SupabaseClient,
  userId: string,
  agent: { id: string; type?: string | null; name?: string | null },
  events: NormalizedTelemetryEvent[],
): Promise<PersistTelemetryResult> {
  if (events.length === 0) return { accepted: 0, duplicates: 0, ids: [] };
  const receivedAt=new Date().toISOString();
  const rows = events.map((item) => ({
    id: item.id,
    agent_id: agent.id,
    user_id: userId,
    agent_type: agent.type ?? null,
    event: item.event,
    created_at: item.occurredAt,
    detail: {
      schemaVersion: 1,
      source: item.sourceKind,
      receivedAt,
      agentName: agent.name ?? null,
      telemetry: {
        title: item.title,
        summary: item.summary,
        outcome: item.outcome,
        severity: item.severity,
        traceId: item.traceId,
        spanId: item.spanId,
        parentSpanId: item.parentSpanId,
        runId: item.runId,
        evidence: item.evidence,
        attributes: item.safeAttributes,
        // Native run records (contract-validated at ingest; re-validated on read).
        role: item.role,
        producer: item.producer,
        toolName: item.toolName,
        durationMs: item.durationMs,
        conversationId: item.conversationId,
        errorType: item.errorType,
      },
    },
  }));
  const { data, error } = await client
    .from("hivra_agent_events")
    .upsert(rows, { onConflict: "id", ignoreDuplicates: true })
    .select("id");
  if (error) throw new Error("activity telemetry persistence failed");
  const ids = (data ?? []).map((row: { id?: unknown }) => String(row.id ?? "")).filter(Boolean);
  return { accepted: ids.length, duplicates: rows.length - ids.length, ids };
}

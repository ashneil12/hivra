import { supabaseAdmin } from '@/lib/supabase';

interface OpsInstanceHostRow {
  id: string;
  host_id?: string | null;
  ipv4_address?: string | null;
}

interface OpsHostRow {
  id: string;
  ipv4_address?: string | null;
}

function isIpv4Literal(value: string): boolean {
  const parts = value.trim().split('.');
  if (parts.length !== 4) return false;

  return parts.every((part) => {
    if (!/^\d+$/.test(part)) return false;
    const numeric = Number(part);
    return Number.isInteger(numeric) && numeric >= 0 && numeric <= 255;
  });
}

function readIpv4Candidate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return isIpv4Literal(trimmed) ? trimmed : null;
}

function readHostDetails(details: unknown): string | null {
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return null;
  }

  const record = details as Record<string, unknown>;
  return (
    readIpv4Candidate(record.hostIp) ||
    readIpv4Candidate(record.instanceIpv4) ||
    readIpv4Candidate(record.publicIpv4) ||
    readIpv4Candidate(record.ipv4) ||
    readIpv4Candidate(record.ip) ||
    null
  );
}

export function extractOpsEventHostIp(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata) return null;

  return (
    readIpv4Candidate(metadata.hostIp) ||
    readIpv4Candidate(metadata.instanceIpv4) ||
    readIpv4Candidate(metadata.publicIpv4) ||
    readIpv4Candidate(metadata.ipv4) ||
    readIpv4Candidate(metadata.ip) ||
    readHostDetails(metadata.details) ||
    null
  );
}

export async function resolveOpsEventHostIpMap(instanceIds: string[]): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();

  if (!supabaseAdmin) return resolved;

  const uniqueInstanceIds = Array.from(new Set(
    instanceIds
      .map((id) => id.trim())
      .filter((id) => id.length > 0)
  ));

  if (uniqueInstanceIds.length === 0) return resolved;

  const { data: instances, error: instanceError } = await supabaseAdmin
    .from('hermes_instances')
    .select('id, host_id, ipv4_address')
    .in('id', uniqueInstanceIds);

  if (instanceError || !instances) {
    return resolved;
  }

  const typedInstances = instances as OpsInstanceHostRow[];
  const uniqueHostIds = Array.from(new Set(
    typedInstances
      .map((instance) => instance.host_id?.trim() || '')
      .filter((id) => id.length > 0)
  ));

  const hostIpById = new Map<string, string>();
  if (uniqueHostIds.length > 0) {
    const { data: hosts } = await supabaseAdmin
      .from('hermes_hosts')
      .select('id, ipv4_address')
      .in('id', uniqueHostIds);

    for (const host of (hosts || []) as OpsHostRow[]) {
      const hostIp = readIpv4Candidate(host.ipv4_address);
      if (hostIp) {
        hostIpById.set(host.id, hostIp);
      }
    }
  }

  for (const instance of typedInstances) {
    const instanceIp = readIpv4Candidate(instance.ipv4_address);
    const hostIp = instance.host_id ? hostIpById.get(instance.host_id) || null : null;
    const resolvedIp = instanceIp || hostIp;
    if (resolvedIp) {
      resolved.set(instance.id, resolvedIp);
    }
  }

  return resolved;
}

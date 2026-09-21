import { auth } from '@clerk/nextjs/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase';
import { apiError } from '@/lib/api-response';
import { resolveInstanceIpv4 } from '@/lib/instance-resolvers';
import { sshExec } from '@/lib/hetzner/ssh';
import {
  getProxmoxHostRoutingConfigFromInfrastructure,
  getProxmoxInfrastructure,
} from '@/lib/services/proxmox-infrastructure';

export async function validateConsoleAccess(params: Promise<{ id: string }>) {
  const { userId } = await auth();
  if (!userId) {
    return { errorResponse: apiError('Unauthorized', 401) };
  }

  const { id } = await params;
  if (!z.string().regex(/^[a-zA-Z0-9-]+$/).safeParse(id).success) {
    return { errorResponse: apiError('Invalid ID format', 400) };
  }

  const { data: instance } = await supabaseAdmin!
    .from('hermes_instances')
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .single();

  if (!instance) {
    return { errorResponse: apiError('Instance not found', 404) };
  }

  let hostIp: string | null = null;
  const proxmoxInfrastructure = getProxmoxInfrastructure((instance as { config?: unknown }).config);
  const proxmoxHostConfig = getProxmoxHostRoutingConfigFromInfrastructure(
    proxmoxInfrastructure,
    { host_id: (instance as { host_id?: string | null }).host_id ?? null },
  );
  try {
    hostIp = await resolveInstanceIpv4(instance as unknown as import('@/app/api/instances/[id]/route').HermesInstanceRow);
  } catch (e) {
    const err = e as { response?: { status?: number }; status?: number };
    if (err.response?.status === 404 || err.status === 404) {
      return { errorResponse: apiError('Instance offline or unknown IP', 404) };
    }
  }

  if (!hostIp) {
    return { errorResponse: apiError('Instance offline or unknown IP', 404) };
  }

  return {
    id,
    userId,
    instance,
    hostIp,
    ...(proxmoxHostConfig ? { proxmoxHostConfig } : {}),
    errorResponse: null,
  };
}

export async function discoverContainerName(
  ip: string,
  id: string,
  proxmoxHostConfig?: ReturnType<typeof getProxmoxHostRoutingConfigFromInfrastructure>
): Promise<string> {
  // Exact-match this instance's container only. The previous fuzzy
  // `grep -E "agent-${id}|hermes-agent|agent"` had a bare `agent` alternative
  // that could match a sibling/other-tenant container on multi-container
  // webfree boxes (e.g. agent-<otherid>). Mirror the overview route's
  // anchored `name=^/?<C>$` strategy so we never resolve another tenant.
  const expected = `agent-${id}`;
  const command = `docker ps --format "{{.Names}}" -f "name=^/?${expected}$" | head -n 1`;
  const check = proxmoxHostConfig
    ? await sshExec(ip, command, { proxmoxHostConfig })
    : await sshExec(ip, command);
  return check.stdout?.trim() || expected;
}

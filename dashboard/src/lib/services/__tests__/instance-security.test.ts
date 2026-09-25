import crypto from 'node:crypto';

import {
  ensureManagedSidecarScript,
  getSecureUserInstance,
  recoverAndPersistApiServerKeyFromManagedHost,
  refreshManagedSidecarScript,
} from '../instance-security';
import { supabaseAdmin } from '@/lib/supabase';
import { decryptApiKey, encryptApiKey } from '@/lib/crypto';
import { getHetznerInstanceStatus } from '@/lib/services/hetzner-instance-service';
import { sshExec } from '@/lib/hetzner/ssh';
import { log } from '@/lib/logger';

// Mock dependencies
jest.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    neq: jest.fn().mockReturnThis(),
    single: jest.fn()
  }
}));

jest.mock('@/lib/crypto', () => ({
  decryptApiKey: jest.fn(),
  encryptApiKey: jest.fn(),
}));

jest.mock('@/lib/services/hetzner-instance-service', () => ({
  getHetznerInstanceStatus: jest.fn(),
}));

jest.mock('@/lib/hetzner/ssh', () => ({
  sshExec: jest.fn(),
}));

jest.mock('@/lib/logger', () => ({
  log: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

interface SupabaseMockChain {
  eq: () => SupabaseMockChain;
  neq: () => SupabaseMockChain;
  single: jest.Mock;
}

interface MutableSupabaseMockChain {
  eq: jest.MockedFunction<() => MutableSupabaseMockChain>;
  neq: jest.MockedFunction<() => MutableSupabaseMockChain>;
  single: jest.Mock;
}

// A Proxmox `config.infrastructure` handle pins the managing pve host (via
// `node`), so recovery is allowed to read the (otherwise non-unique) private
// vmbr1 guest IP — sshExec routes through that host. Recovery now fails closed
// for a private guest IP WITHOUT such a handle, so the proxmox recovery tests
// must carry one. The derived routing config is { hostSlug: 'fixturenodea', ... }.
function proxmoxInfraConfig(privateIpv4: string, node = 'fixturenode10') {
  return {
    infrastructure: {
      provider: 'proxmox',
      vmid: 1000,
      privateIpv4,
      gatewayHost: 'agent.example.com',
      node,
    },
  };
}
const expectProxmoxSshOptions = expect.objectContaining({
  timeoutMs: 20_000,
  proxmoxHostConfig: expect.objectContaining({ hostSlug: 'fixturenode10', failClosed: true }),
});

describe('getSecureUserInstance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fails if instance is not found', async () => {
    ((supabaseAdmin!.from('hermes_instances').select() as unknown as SupabaseMockChain).eq().eq().neq().single as jest.Mock).mockResolvedValue({
      data: null,
      error: new Error('Not found')
    });

    const result = await getSecureUserInstance({ id: '123', userId: 'user_1' });
    expect(result.error).toBe('Instance not found or unauthorized');
    expect(result.instance).toBeNull();
  });

  it('fails if instance is not running and requireRunning is true', async () => {
    ((supabaseAdmin!.from('hermes_instances').select() as unknown as SupabaseMockChain).eq().eq().neq().single as jest.Mock).mockResolvedValue({
      data: { status: 'starting' },
      error: null
    });

    const result = await getSecureUserInstance({ id: '123', userId: 'user_1', requireRunning: true });
    expect(result.error).toBe('Instance is not currently running');
  });

  it('succeeds and decrypts API key if valid', async () => {
    ((supabaseAdmin!.from('hermes_instances').select() as unknown as SupabaseMockChain).eq().eq().neq().single as jest.Mock).mockResolvedValue({
      data: { status: 'running', gateway_url: 'https://test.com', api_server_key_encrypted: 'encoded_blob' },
      error: null
    });

    (decryptApiKey as jest.Mock).mockReturnValue('decrypted_key_123');

    const result = await getSecureUserInstance({ id: '123', userId: 'user_1' });
    expect(result.error).toBeNull();
    expect(result.instance?.gateway_url).toBe('https://test.com');
    expect(result.apiServerKey).toBe('decrypted_key_123');
  });

  it('fails closed when the instance has no API server key configured', async () => {
    ((supabaseAdmin!.from('hermes_instances').select() as unknown as SupabaseMockChain).eq().eq().neq().single as jest.Mock).mockResolvedValue({
      data: { status: 'running', gateway_url: 'https://test.com', api_server_key_encrypted: null },
      error: null
    });

    const result = await getSecureUserInstance({ id: '123', userId: 'user_1' });
    expect(result.error).toBe('Instance API server key not configured');
    expect(result.instance).toBeNull();
    expect(result.apiServerKey).toBe('');
  });

  it('recovers and persists a missing Proxmox WebUI API server key from the instance dashboard sidecar before its Caddyfile', async () => {
    const token = 'a'.repeat(64);
    const single = jest.fn().mockResolvedValue({
      data: {
        id: '2f3c8ca9-06ca-4a11-8998-0fa344416fe1',
        status: 'running',
        gateway_url: 'https://agent.example.com',
        api_server_key_encrypted: null,
        ipv4_address: '10.250.20.56',
        config: proxmoxInfraConfig('10.250.20.56'),
      },
      error: null,
    });
    const selectChain = {} as MutableSupabaseMockChain;
    selectChain.eq = jest.fn(() => selectChain);
    selectChain.neq = jest.fn(() => selectChain);
    selectChain.single = single;
    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const update = jest.fn(() => ({ eq: updateEq }));

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table !== 'hermes_instances') throw new Error(`Unexpected table ${table}`);
      return {
        select: jest.fn(() => selectChain),
        update,
      };
    });

    // dashboard-sidecar (the API_SERVER_KEY-bearing auth bridge) is probed
    // first, so a single SSH read recovers the key — no Caddyfile fallback.
    (sshExec as jest.Mock)
      .mockResolvedValueOnce({ ok: true, stdout: `${token}\n`, stderr: '' });
    (encryptApiKey as jest.Mock).mockReturnValue('encrypted-token');

    const result = await getSecureUserInstance({ id: '2f3c8ca9-06ca-4a11-8998-0fa344416fe1', userId: 'user_1' });

    expect(result.error).toBeNull();
    expect(result.apiServerKey).toBe(token);
    expect(result.instanceIpv4).toBe('10.250.20.56');
    expect(sshExec).toHaveBeenNthCalledWith(
      1,
      '10.250.20.56',
      expect.stringContaining('docker inspect agent-2f3c8ca9-06ca-4a11-8998-0fa344416fe1-dashboard-sidecar'),
      expectProxmoxSshOptions,
    );
    expect(sshExec).not.toHaveBeenCalledWith(
      '10.250.20.56',
      expect.stringContaining('/opt/hermes/instances/*/Caddyfile'),
      expect.anything(),
    );
    expect(sshExec).toHaveBeenCalledTimes(1);
    expect(encryptApiKey).toHaveBeenCalledWith(token);
    expect(update).toHaveBeenCalledWith({ api_server_key_encrypted: 'encrypted-token' });
    expect(updateEq).toHaveBeenCalledWith('id', '2f3c8ca9-06ca-4a11-8998-0fa344416fe1');
  });

  it('only reads the target instance Caddyfile when container env recovery is unavailable', async () => {
    const token = 'b'.repeat(64);
    const single = jest.fn().mockResolvedValue({
      data: {
        id: 'inst_456',
        status: 'running',
        gateway_url: 'https://agent.example.com',
        api_server_key_encrypted: null,
        ipv4_address: '10.250.20.57',
        config: proxmoxInfraConfig('10.250.20.57'),
      },
      error: null,
    });
    const selectChain = {} as MutableSupabaseMockChain;
    selectChain.eq = jest.fn(() => selectChain);
    selectChain.neq = jest.fn(() => selectChain);
    selectChain.single = single;
    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const update = jest.fn(() => ({ eq: updateEq }));

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table !== 'hermes_instances') throw new Error(`Unexpected table ${table}`);
      return {
        select: jest.fn(() => selectChain),
        update,
      };
    });

    // All five container probes + the discovered-sidecar sweep come back empty,
    // so recovery falls through to the target instance Caddyfile (7th call).
    (sshExec as jest.Mock)
      .mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: `${token}\n`, stderr: '' });
    (encryptApiKey as jest.Mock).mockReturnValue('encrypted-token');

    const result = await getSecureUserInstance({ id: 'inst_456', userId: 'user_1' });

    expect(result.error).toBeNull();
    expect(result.apiServerKey).toBe(token);
    expect(result.instanceIpv4).toBe('10.250.20.57');
    expect(sshExec).toHaveBeenLastCalledWith(
      '10.250.20.57',
      expect.stringContaining('/opt/hermes/instances/inst_456/Caddyfile'),
      expectProxmoxSshOptions,
    );
    expect(sshExec).not.toHaveBeenCalledWith(
      '10.250.20.57',
      expect.stringContaining('/opt/hermes/instances/*/Caddyfile'),
      expect.anything(),
    );
    expect(encryptApiKey).toHaveBeenCalledWith(token);
    expect(update).toHaveBeenCalledWith({ api_server_key_encrypted: 'encrypted-token' });
    expect(updateEq).toHaveBeenCalledWith('id', 'inst_456');
  });

  it('keeps searching for a fresh WebUI bearer when container env still has the stale dashboard token', async () => {
    const staleToken = 'c'.repeat(64);
    const freshToken = 'd'.repeat(64);
    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const update = jest.fn(() => ({ eq: updateEq }));

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table !== 'hermes_instances') throw new Error(`Unexpected table ${table}`);
      return { update };
    });

    // dashboard-sidecar (call 1) still carries the stale/rejected token, so
    // recovery logs and keeps searching: 4 more container probes + the
    // discovered-sidecar sweep come back empty, and the Caddyfile (call 7)
    // finally yields the fresh bearer.
    (sshExec as jest.Mock)
      .mockResolvedValueOnce({ ok: true, stdout: `${staleToken}\n`, stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: `${freshToken}\n`, stderr: '' });
    (encryptApiKey as jest.Mock).mockReturnValue('encrypted-fresh-token');

    const result = await recoverAndPersistApiServerKeyFromManagedHost({
      id: 'inst_789',
      gateway_url: 'https://agent.example.com',
      ipv4_address: '10.250.20.58',
      config: proxmoxInfraConfig('10.250.20.58'),
    }, { ignoreApiServerKey: staleToken });

    expect(result).toEqual({
      apiServerKey: freshToken,
      instanceIpv4: '10.250.20.58',
    });
    expect(sshExec).toHaveBeenNthCalledWith(
      1,
      '10.250.20.58',
      expect.stringContaining('docker inspect agent-inst_789-dashboard-sidecar'),
      expectProxmoxSshOptions,
    );
    expect(sshExec).toHaveBeenNthCalledWith(
      7,
      '10.250.20.58',
      expect.stringContaining('/opt/hermes/instances/inst_789/Caddyfile'),
      expectProxmoxSshOptions,
    );
    expect(log.warn).toHaveBeenCalledWith(
      'recovered API server key candidate matched rejected bearer; continuing recovery',
      expect.objectContaining({
        source: 'instance-security',
        instanceId: 'inst_789',
        recoverySource: 'container_env',
        containerName: 'agent-inst_789-dashboard-sidecar',
        failureType: 'recovered_bearer_matched_rejected_token',
      }),
    );
    expect(encryptApiKey).toHaveBeenCalledWith(freshToken);
    expect(update).toHaveBeenCalledWith({ api_server_key_encrypted: 'encrypted-fresh-token' });
    expect(updateEq).toHaveBeenCalledWith('id', 'inst_789');
  });

  it('recovers a Proxmox WebUI key from the discovered dashboard sidecar when compose names do not include the dashboard instance id', async () => {
    const freshToken = 'e'.repeat(64);
    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const update = jest.fn(() => ({ eq: updateEq }));

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table !== 'hermes_instances') throw new Error(`Unexpected table ${table}`);
      return { update };
    });

    // Five container probes by compose name miss (the dashboard's instance id is
    // not in the container names — the WebUI DB row id differs from the agent
    // compose project id), so the label-filtered discovered-sidecar sweep
    // (call 6) is what surfaces the live key. This is SAFE only because the
    // recovery is routed to the correct single-tenant box via the row's own
    // config.infrastructure handle; without that handle recovery would have
    // failed closed rather than risk reading a stranger's sidecar.
    (sshExec as jest.Mock)
      .mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: `agent-00000000-0000-4000-8000-000000001013-dashboard-sidecar\t${freshToken}\n`, stderr: '' });
    (encryptApiKey as jest.Mock).mockReturnValue('encrypted-discovered-token');

    const result = await recoverAndPersistApiServerKeyFromManagedHost({
      id: '00000000-0000-4000-8000-000000001027',
      gateway_url: 'https://agent.example.com',
      ipv4_address: '10.250.20.56',
      config: proxmoxInfraConfig('10.250.20.56'),
    }, { ignoreApiServerKey: 'f'.repeat(64) });

    expect(result).toEqual({
      apiServerKey: freshToken,
      instanceIpv4: '10.250.20.56',
    });
    expect(sshExec).toHaveBeenNthCalledWith(
      6,
      '10.250.20.56',
      expect.stringContaining("com.docker.compose.service=dashboard-sidecar"),
      expectProxmoxSshOptions,
    );
    expect(sshExec).not.toHaveBeenCalledWith(
      '10.250.20.56',
      expect.stringContaining('/opt/hermes/instances/00000000-0000-4000-8000-000000001027/Caddyfile'),
      expect.anything(),
    );
    expect(encryptApiKey).toHaveBeenCalledWith(freshToken);
    expect(update).toHaveBeenCalledWith({ api_server_key_encrypted: 'encrypted-discovered-token' });
    expect(updateEq).toHaveBeenCalledWith('id', '00000000-0000-4000-8000-000000001027');
  });

  it('fails closed without any SSH when a private guest IP has no pinned host route', async () => {
    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const update = jest.fn(() => ({ eq: updateEq }));
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table !== 'hermes_instances') throw new Error(`Unexpected table ${table}`);
      return { update };
    });

    // A private vmbr1 IP (reused on every pve host) with no config.infrastructure
    // handle cannot be reached unambiguously — recovery must NOT sshExec it, or it
    // risks landing on another tenant's box and harvesting a stranger's key.
    const result = await recoverAndPersistApiServerKeyFromManagedHost({
      id: 'inst_private',
      gateway_url: 'https://agent.example.com',
      ipv4_address: '10.250.20.50',
    }, { ignoreApiServerKey: 'a'.repeat(64) });

    expect(result).toBeNull();
    expect(sshExec).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'apiServerKey recovery refused: private guest IP without a pinned host route',
      expect.objectContaining({
        source: 'instance-security',
        instanceId: 'inst_private',
        failureType: 'api_server_key_recovery_unroutable_private_ip',
      }),
    );
  });

  it('still recovers over a globally-unique public IP without a host route (Hetzner)', async () => {
    const token = 'a'.repeat(64);
    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const update = jest.fn(() => ({ eq: updateEq }));
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table !== 'hermes_instances') throw new Error(`Unexpected table ${table}`);
      return { update };
    });
    (sshExec as jest.Mock).mockResolvedValueOnce({ ok: true, stdout: `${token}\n`, stderr: '' });
    (encryptApiKey as jest.Mock).mockReturnValue('encrypted-public-token');

    const result = await recoverAndPersistApiServerKeyFromManagedHost({
      id: 'inst_hetzner',
      gateway_url: 'https://192-0-2-122.sslip.io',
      ipv4_address: '192.0.2.122',
    });

    expect(result).toEqual({ apiServerKey: token, instanceIpv4: '192.0.2.122' });
    expect(sshExec).toHaveBeenNthCalledWith(
      1,
      '192.0.2.122',
      expect.stringContaining('docker inspect agent-inst_hetzner-dashboard-sidecar'),
      { timeoutMs: 20_000 },
    );
    expect(update).toHaveBeenCalledWith({ api_server_key_encrypted: 'encrypted-public-token' });
  });

  it('resolves instanceIpv4 from the host hetzner server when available', async () => {
    const singleMock = jest
      .fn()
      .mockResolvedValueOnce({
        data: {
          id: '2f3c8ca9-06ca-4a11-8998-0fa344416fe1',
          status: 'running',
          gateway_url: 'https://test.com',
          api_server_key_encrypted: 'encoded_blob',
          host_id: 'host_123',
          hetzner_server_id: null,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { hetzner_server_id: 987654 },
        error: null,
      });

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'hermes_instances' || table === 'hermes_hosts') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                neq: () => ({
                  single: singleMock,
                }),
              }),
              single: singleMock,
            }),
            single: singleMock,
          }),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    (decryptApiKey as jest.Mock).mockReturnValue('decrypted_key_123');
    (getHetznerInstanceStatus as jest.Mock).mockResolvedValue({ status: 'running', ipv4: '192.0.2.122' });

    const result = await getSecureUserInstance({ id: '2f3c8ca9-06ca-4a11-8998-0fa344416fe1', userId: 'user_1' });

    expect(result.error).toBeNull();
    expect(result.apiServerKey).toBe('decrypted_key_123');
    expect(result.instanceIpv4).toBe('192.0.2.122');
    expect(getHetznerInstanceStatus).toHaveBeenCalledWith(987654);
  });

  it('falls back to parsing sslip.io gateway URLs for instanceIpv4', async () => {
    ((supabaseAdmin!.from('hermes_instances').select() as unknown as SupabaseMockChain).eq().eq().neq().single as jest.Mock).mockResolvedValue({
      data: {
        id: '2f3c8ca9-06ca-4a11-8998-0fa344416fe1',
        status: 'running',
        gateway_url: 'https://192-0-2-122.sslip.io',
        api_server_key_encrypted: 'encoded_blob',
        host_id: null,
        hetzner_server_id: null,
      },
      error: null,
    });

    (decryptApiKey as jest.Mock).mockReturnValue('decrypted_key_123');

    const result = await getSecureUserInstance({ id: '2f3c8ca9-06ca-4a11-8998-0fa344416fe1', userId: 'user_1' });

    expect(result.error).toBeNull();
    expect(result.instanceIpv4).toBe('192.0.2.122');
    expect(getHetznerInstanceStatus).not.toHaveBeenCalled();
  });

  it('continues to prefer the stored public gateway url even when tailscale metadata exists', async () => {
    ((supabaseAdmin!.from('hermes_instances').select() as unknown as SupabaseMockChain).eq().eq().neq().single as jest.Mock).mockResolvedValue({
      data: {
        id: '2f3c8ca9-06ca-4a11-8998-0fa344416fe1',
        status: 'running',
        gateway_url: 'https://192-0-2-122.sslip.io',
        api_server_key_encrypted: 'encoded_blob',
        host_id: null,
        hetzner_server_id: null,
        config: {
          privateAccess: {
            tailscale: {
              enabled: true,
              hostScoped: true,
              state: 'connected',
              magicDnsName: 'atlas-agent.tail.ts.net',
            },
          },
        },
      },
      error: null,
    });

    (decryptApiKey as jest.Mock).mockReturnValue('decrypted_key_123');

    const result = await getSecureUserInstance({ id: '2f3c8ca9-06ca-4a11-8998-0fa344416fe1', userId: 'user_1' });

    expect(result.error).toBeNull();
    expect(result.instance?.gateway_url).toBe('https://192-0-2-122.sslip.io');
    expect(result.instanceIpv4).toBe('192.0.2.122');
    expect(getHetznerInstanceStatus).not.toHaveBeenCalled();
  });
});

describe('refreshManagedSidecarScript', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: '', stderr: '' });
  });

  it('no longer ships or mounts the retired chat-stream worker module', async () => {
    const result = await refreshManagedSidecarScript({
      id: '2f3c8ca9-06ca-4a11-8998-0fa344416fe1',
      instanceIpv4: '203.0.113.10',
    });

    expect(result).toBe(true);
    expect(sshExec).toHaveBeenCalledTimes(1);
    const [, repairCommand] = (sshExec as jest.Mock).mock.calls[0];
    expect(repairCommand).toContain('base64 -d > sidecar_server.js');
    expect(repairCommand).not.toContain('WORKER_MOUNT_REGEX');
    expect(repairCommand).not.toContain('Sidecar missing ./w mount');
    expect(repairCommand).not.toContain('EXPECTED_WORKER_VERSION');
  });

  it('refreshes the WebUI dashboard sidecar without requiring the chat worker mount', async () => {
    const result = await refreshManagedSidecarScript({
      id: '2f3c8ca9-06ca-4a11-8998-0fa344416fe1',
      instanceIpv4: '203.0.113.10',
      composeService: 'dashboard-sidecar',
    });

    expect(result).toBe(true);
    expect(sshExec).toHaveBeenCalledTimes(1);
    const [, repairCommand] = (sshExec as jest.Mock).mock.calls[0];
    expect(repairCommand).toContain('SIDECAR_CONTAINER=agent-2f3c8ca9-06ca-4a11-8998-0fa344416fe1-dashboard-sidecar');
    expect(repairCommand).toContain('docker compose up -d dashboard-sidecar');
    expect(repairCommand).not.toContain('Sidecar missing ./w mount');
  });

  it('preserves the WebUI handoff artifact and pins refresh SSH to the managing Proxmox host', async () => {
    const result = await refreshManagedSidecarScript({
      id: '2f3c8ca9-06ca-4a11-8998-0fa344416fe1',
      instanceIpv4: '10.250.20.52',
      composeService: 'dashboard-sidecar',
      config: proxmoxInfraConfig('10.250.20.52', 'fixturenode13'),
      hostId: null,
    });

    expect(result).toBe(true);
    expect(sshExec).toHaveBeenCalledTimes(1);
    const [, repairCommand, sshOptions] = (sshExec as jest.Mock).mock.calls[0];
    const encodedArtifact = repairCommand.match(
      /printf '%s' '([^']+)' \| base64 -d > sidecar_server\.js/,
    )?.[1];

    expect(encodedArtifact).toBeTruthy();
    const decodedArtifact = Buffer.from(encodedArtifact, 'base64').toString('utf8');
    expect(decodedArtifact).toContain("u.pathname === '/webui-login'");
    expect(decodedArtifact).toContain("u.pathname === '/webui-session-check'");
    expect(repairCommand).toContain(
      `EXPECTED_SERVER_VERSION=${crypto.createHash('sha256').update(decodedArtifact).digest('hex')}`,
    );
    expect(sshOptions).toEqual({
      timeoutMs: 30_000,
      proxmoxHostConfig: {
        hostId: null,
        hostSlug: 'fixturenode13',
        envPrefix: null,
        failClosed: true,
        vmid: 1000,
        instanceId: '2f3c8ca9-06ca-4a11-8998-0fa344416fe1',
      },
    });
  });

  it('fails closed instead of refreshing an ambiguous private guest IP', async () => {
    const result = await refreshManagedSidecarScript({
      id: '2f3c8ca9-06ca-4a11-8998-0fa344416fe1',
      instanceIpv4: '10.250.20.52',
      composeService: 'dashboard-sidecar',
    });

    expect(result).toBe(false);
    expect(sshExec).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'refused managed sidecar refresh for unroutable private guest IP',
      expect.objectContaining({
        instanceId: '2f3c8ca9-06ca-4a11-8998-0fa344416fe1',
        failureType: 'managed_sidecar_refresh_unroutable_private_ip',
      }),
    );
  });

  it('does not reuse a refresh cache entry across hosts with the same private guest IP', async () => {
    const common = {
      id: 'inst_reused_private_ip',
      instanceIpv4: '10.250.20.52',
      composeService: 'dashboard-sidecar' as const,
      hostId: null,
    };

    await expect(ensureManagedSidecarScript({
      ...common,
      config: proxmoxInfraConfig('10.250.20.52', 'fixturenode11'),
    })).resolves.toBe(true);
    await expect(ensureManagedSidecarScript({
      ...common,
      config: proxmoxInfraConfig('10.250.20.52', 'fixturenode13'),
    })).resolves.toBe(true);

    expect(sshExec).toHaveBeenCalledTimes(2);
    expect((sshExec as jest.Mock).mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      proxmoxHostConfig: expect.objectContaining({ hostSlug: 'fixturenode11' }),
    }));
    expect((sshExec as jest.Mock).mock.calls[1]?.[2]).toEqual(expect.objectContaining({
      proxmoxHostConfig: expect.objectContaining({ hostSlug: 'fixturenode13' }),
    }));
  });

  it('patches older WebUI dashboard sidecar compose files with the terminal upstream env', async () => {
    const result = await refreshManagedSidecarScript({
      id: '2f3c8ca9-06ca-4a11-8998-0fa344416fe1',
      instanceIpv4: '203.0.113.10',
      composeService: 'dashboard-sidecar',
    });

    expect(result).toBe(true);
    const [, repairCommand] = (sshExec as jest.Mock).mock.calls[0];
    expect(repairCommand).toContain(
      'DASHBOARD_TERMINAL_UPSTREAM_URL=http://agent-2f3c8ca9-06ca-4a11-8998-0fa344416fe1-official-dashboard:9119',
    );
    expect(repairCommand).toContain('WEBUI_TERMINAL_UPSTREAM_URL=$DASHBOARD_TERMINAL_UPSTREAM_URL');
    expect(repairCommand).toContain('grep -Fq -- "WEBUI_TERMINAL_UPSTREAM_URL=" "$COMPOSE_FILE"');
    expect(repairCommand).toContain('docker compose up -d dashboard-sidecar');
  });
});

describe('recoverAndPersistApiServerKeyFromManagedHost (present-but-wrong drift)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('recovers and persists the live VM key when the stored key has drifted', async () => {
    const driftedStoredKey = '1'.repeat(64);
    const liveVmKey = '2'.repeat(64);
    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const update = jest.fn(() => ({ eq: updateEq }));

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table !== 'hermes_instances') throw new Error(`Unexpected table ${table}`);
      return { update };
    });

    // First container env probe already surfaces a DIFFERENT (live) key, so a
    // single SSH read is enough — no SSH-storm across every recovery source.
    (sshExec as jest.Mock).mockResolvedValueOnce({ ok: true, stdout: `${liveVmKey}\n`, stderr: '' });
    (encryptApiKey as jest.Mock).mockReturnValue('encrypted-live-key');

    const result = await recoverAndPersistApiServerKeyFromManagedHost(
      {
        id: 'inst_drift',
        gateway_url: 'https://agent.example.com',
        ipv4_address: '10.250.20.60',
        config: proxmoxInfraConfig('10.250.20.60'),
      },
      { ignoreApiServerKey: driftedStoredKey },
    );

    expect(result).toEqual({ apiServerKey: liveVmKey, instanceIpv4: '10.250.20.60' });
    expect(sshExec).toHaveBeenCalledTimes(1);
    expect(encryptApiKey).toHaveBeenCalledWith(liveVmKey);
    expect(update).toHaveBeenCalledWith({ api_server_key_encrypted: 'encrypted-live-key' });
    expect(updateEq).toHaveBeenCalledWith('id', 'inst_drift');
  });

  it('does NOT persist when every VM source still matches the stored key (no real drift)', async () => {
    const storedKey = '3'.repeat(64);
    const update = jest.fn(() => ({ eq: jest.fn() }));

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table !== 'hermes_instances') throw new Error(`Unexpected table ${table}`);
      return { update };
    });

    // Every recovery source (5 container envs, the discovered dashboard sidecar,
    // and the Caddyfile) reports the SAME key the dashboard already stores, so a
    // signature 403 was NOT caused by drift — never persist, never re-mint.
    (sshExec as jest.Mock)
      .mockResolvedValueOnce({ ok: true, stdout: `${storedKey}\n`, stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: `${storedKey}\n`, stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: `${storedKey}\n`, stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: `${storedKey}\n`, stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: `${storedKey}\n`, stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: `agent-inst_nodrift-dashboard-sidecar\t${storedKey}\n`, stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: `${storedKey}\n`, stderr: '' });

    const result = await recoverAndPersistApiServerKeyFromManagedHost(
      {
        id: 'inst_nodrift',
        gateway_url: 'https://agent.example.com',
        ipv4_address: '10.250.20.61',
        config: proxmoxInfraConfig('10.250.20.61'),
      },
      { ignoreApiServerKey: storedKey },
    );

    expect(result).toBeNull();
    expect(update).not.toHaveBeenCalled();
    expect(encryptApiKey).not.toHaveBeenCalled();
  });

  it('routes the recovery SSH through the managing pve host for a Proxmox instance', async () => {
    const driftedStoredKey = '7'.repeat(64);
    const liveVmKey = '8'.repeat(64);
    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const update = jest.fn(() => ({ eq: updateEq }));

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table !== 'hermes_instances') throw new Error(`Unexpected table ${table}`);
      return { update };
    });

    (sshExec as jest.Mock).mockResolvedValueOnce({ ok: true, stdout: `${liveVmKey}\n`, stderr: '' });
    (encryptApiKey as jest.Mock).mockReturnValue('encrypted-live-key');

    // host_id/hetzner_server_id are NULL (the common Proxmox-fleet data gap), but
    // config.infrastructure carries the routing keys, so recovery still reaches
    // the right pve host. The private vmbr1 IP from infrastructure.privateIpv4 is
    // what the nested SSH lands on, via the managing host.
    const result = await recoverAndPersistApiServerKeyFromManagedHost(
      {
        id: 'ed6fc634-acf8-41a1-893c-36f0af43f16c',
        gateway_url: 'https://00000000000000000000.agents.canary.hermesos.cloud',
        host_id: null,
        hetzner_server_id: null,
        ipv4_address: '10.250.20.50',
        config: {
          infrastructure: {
            provider: 'proxmox',
            node: 'fixturenode10',
            vmid: 1000,
            hostSlug: 'fixturenode10',
            hostEnvPrefix: 'PROXMOX_FIXTURENODE10_',
            privateIpv4: '10.250.20.50',
            gatewayHost: '00000000000000000000.agents.canary.hermesos.cloud',
            templateVmid: 9007,
          },
        },
      },
      { ignoreApiServerKey: driftedStoredKey },
    );

    expect(result).toEqual({ apiServerKey: liveVmKey, instanceIpv4: '10.250.20.50' });
    expect(sshExec).toHaveBeenNthCalledWith(
      1,
      '10.250.20.50',
      expect.stringContaining('docker inspect agent-ed6fc634-acf8-41a1-893c-36f0af43f16c-dashboard-sidecar'),
      {
        timeoutMs: 20_000,
        proxmoxHostConfig: {
          hostId: null,
          hostSlug: 'fixturenode10',
          envPrefix: 'PROXMOX_FIXTURENODE10_',
          failClosed: true,
          vmid: 1000,
          instanceId: 'ed6fc634-acf8-41a1-893c-36f0af43f16c',
        },
      },
    );
    expect(encryptApiKey).toHaveBeenCalledWith(liveVmKey);
    expect(update).toHaveBeenCalledWith({ api_server_key_encrypted: 'encrypted-live-key' });
  });

  it('does NOT pass a proxmoxHostConfig for a Hetzner-cloud instance (public IP path)', async () => {
    const driftedStoredKey = '9'.repeat(64);
    const liveVmKey = 'a'.repeat(64);
    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const update = jest.fn(() => ({ eq: updateEq }));

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table !== 'hermes_instances') throw new Error(`Unexpected table ${table}`);
      return { update };
    });

    (sshExec as jest.Mock).mockResolvedValueOnce({ ok: true, stdout: `${liveVmKey}\n`, stderr: '' });
    (encryptApiKey as jest.Mock).mockReturnValue('encrypted-live-key');

    const result = await recoverAndPersistApiServerKeyFromManagedHost(
      {
        id: 'inst_hetzner',
        gateway_url: 'https://203-0-113-10.sslip.io',
        ipv4_address: '203.0.113.10',
      },
      { ignoreApiServerKey: driftedStoredKey },
    );

    expect(result).toEqual({ apiServerKey: liveVmKey, instanceIpv4: '203.0.113.10' });
    // Exact options object — { timeoutMs } only — proves no proxmoxHostConfig
    // leaked onto the non-Proxmox path.
    expect(sshExec).toHaveBeenNthCalledWith(
      1,
      '203.0.113.10',
      expect.stringContaining('docker inspect agent-inst_hetzner-dashboard-sidecar'),
      { timeoutMs: 20_000 },
    );
  });
});

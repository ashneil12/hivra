import { InstanceAccessError, ProfileService, __test__ as profileServiceInternals } from '../profile-service';
import { supabaseAdmin } from '@/lib/supabase';
import { sshExec } from '@/lib/hetzner/ssh';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManagedGatewayStatusCommand } from '../managed-gateway-command';

// Mock static dependencies
jest.mock('@/lib/hetzner/ssh', () => ({
  sshExec: jest.fn(),
}));

jest.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

function stringifyMockCalls(spy: jest.SpyInstance): string {
  return spy.mock.calls
    .flat()
    .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
    .join(' ');
}

function verifyProfileStatusRuntimeSelection(script: string): void {
  const start = script.indexOf('      if [ -e "/opt/data/hermes-agent/.venv" ]');
  const end = script.indexOf('\n      if grep -q "Gateway is running"', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  for (const mode of ['absent-source', 'absent-venv', 'broken-venv', 'dangling-venv', 'missing-image-binary']) {
    const root = mkdtempSync(join(tmpdir(), 'profile-status-test-'));
    try {
      const agent = join(root, 'hermes-agent');
      if (mode !== 'absent-source') mkdirSync(agent);
      if (mode === 'broken-venv') mkdirSync(join(agent, '.venv'));
      if (mode === 'dangling-venv') symlinkSync(join(root, 'missing'), join(agent, '.venv'));
      const imageHermes = join(root, 'image-hermes');
      if (mode !== 'missing-image-binary') {
        writeFileSync(imageHermes, '#!/bin/sh\n[ -z "${UV_PROJECT_ENVIRONMENT+x}" ] || exit 98\nprintf "image-status %s\\n" "$HERMES_HOME"\n', { mode: 0o700 });
      }
      const statusFile = join(root, 'status.log');
      // A missing executable must truncate stale success, not reuse it.
      writeFileSync(statusFile, 'Gateway is running\n');
      const branch = script.slice(start, end).replaceAll('/opt/data', root);
      const run = spawnSync('sh', ['-c', 'HERMES_BIN="$1"; STATUS_FILE="$2";\n' + branch, 'fixture', imageHermes, statusFile], {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', UV_PROJECT_ENVIRONMENT: join(root, 'wrong-venv'), NODE_ENV: 'test' },
      });
      expect(run.error).toBeUndefined();
      expect(run.status).toBe(0);
      const status = readFileSync(statusFile, 'utf8');
      if (mode === 'absent-source' || mode === 'absent-venv') {
        expect(status).toBe('image-status ' + join(root, 'profiles/my-agent-2') + '\n');
      } else {
        expect(status).not.toContain('image-status');
        expect(status).not.toContain('Gateway is running');
        if (mode !== 'missing-image-binary') expect(status).toContain('missing or broken');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

/**
 * The only kind of `backend` value that still routes to the legacy
 * buildAgentCaddyfile stack. NO real instance carries it: InstanceBackend is
 * "gateway" | "webui" and both are webfree, and a null/unknown backend is
 * treated as webfree (fail closed). It exists here so the reload / rollback /
 * health-probe machinery in updateAgentCaddyRouting stays under test.
 */
const LEGACY_BACKEND = 'legacy-no-shell';

describe('ProfileService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('getHostIpForInstance ownership lookup', () => {
    function mockInstanceLookup(result: { data: unknown; error: unknown }) {
      const maybeSingle = jest.fn().mockResolvedValue(result);
      const secondEq = jest.fn().mockReturnValue({ maybeSingle });
      const firstEq = jest.fn().mockReturnValue({ eq: secondEq });
      const select = jest.fn().mockReturnValue({ eq: firstEq });
      (supabaseAdmin!.from as jest.Mock).mockReturnValue({ select });
      return { firstEq, secondEq, maybeSingle };
    }

    it('classifies an ordinary zero-row owner lookup as unauthorized', async () => {
      const query = mockInstanceLookup({ data: null, error: null });

      await expect(ProfileService.getHostIpForInstance('instance-123', 'foreign-user'))
        .rejects.toBeInstanceOf(InstanceAccessError);
      expect(supabaseAdmin!.from).toHaveBeenCalledWith('hermes_instances');
      expect(query.firstEq).toHaveBeenCalledWith('id', 'instance-123');
      expect(query.secondEq).toHaveBeenCalledWith('user_id', 'foreign-user');
      expect(query.maybeSingle).toHaveBeenCalledTimes(1);
    });

    it('preserves a real database lookup failure as an operational error', async () => {
      mockInstanceLookup({ data: null, error: { code: 'XX000' } });

      await expect(ProfileService.getHostIpForInstance('instance-123', 'owner-user'))
        .rejects.toThrow('Instance lookup failed');
    });
  });

  describe('syncProfiles', () => {
    it('gracefully protects profiles currently in "creating" status from premature deletion due to race conditions', async () => {
      // 1. Mock getHostIpForInstance so it doesn't query DB
      jest.spyOn(ProfileService, 'getHostIpForInstance').mockResolvedValue('127.0.0.1');
      jest.spyOn(ProfileService, 'getHermesHomeForInstance').mockResolvedValue('/opt/data');

      // 2. Mock sshExec to simulate that no profiles are running natively yet on the host
      //    (i.e. the creation process is still underway and hasn't written the files/directories)
      (sshExec as jest.Mock).mockResolvedValue({
        ok: true,
        stdout: '[]', // SSH output: no profiles found on disk
        stderr: '',
      });

      // 3. Mock Supabase DB: The Database currently knows of one profile, which is in 'creating' state
      const mockEq = jest.fn().mockReturnThis();
      const mockSelect = jest.fn().mockReturnValue({
        eq: mockEq.mockResolvedValue({
          data: [
            { id: 'profile_123', name: 'my-new-agent', status: 'creating' },
          ],
        }),
      });

      const mockDelete = jest.fn().mockReturnValue({
        eq: jest.fn().mockResolvedValue({}),
      });

      const supabaseFromMock = supabaseAdmin?.from as jest.Mock;
      supabaseFromMock.mockImplementation((tableName: string) => {
        if (tableName === 'profiles') {
          return {
            select: mockSelect,
            delete: mockDelete,
          };
        }
        return {};
      });

      // Act
      await ProfileService.syncProfiles('inst_123', 'user_123');

      // Assert
      // We expect that the syncing logic noticed the profile in the DB but did NOT delete it
      // because its status was 'creating'.
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it("reuses the loaded profile rows when assigning ports to multiple host-created profiles", async () => {
      jest.spyOn(ProfileService, "getHostIpForInstance").mockResolvedValue("127.0.0.1");
      jest.spyOn(ProfileService, "getHermesHomeForInstance").mockResolvedValue("/opt/data");

      (sshExec as jest.Mock).mockResolvedValue({
        ok: true,
        stdout: JSON.stringify([
          { name: "existing-agent", running: true },
          { name: "native-agent-a", running: true },
          { name: "native-agent-b", running: false },
        ]),
        stderr: "",
      });

      const mockEq = jest.fn().mockResolvedValue({
        data: [
          { id: "profile_existing", name: "existing-agent", status: "running", gateway_port: 8650 },
        ],
        error: null,
      });
      const mockSelect = jest.fn().mockReturnValue({
        eq: mockEq,
      });
      const mockInsert = jest.fn().mockResolvedValue({ error: null });

      const supabaseFromMock = supabaseAdmin?.from as jest.Mock;
      supabaseFromMock.mockImplementation((tableName: string) => {
        if (tableName === "profiles") {
          return {
            select: mockSelect,
            insert: mockInsert,
          };
        }
        return {};
      });

      await ProfileService.syncProfiles("inst_123", "user_123");

      expect(mockSelect).toHaveBeenCalledTimes(1);
      expect(mockInsert).toHaveBeenNthCalledWith(1, expect.objectContaining({
        name: "native-agent-a",
        gateway_port: 8651,
        status: "running",
      }));
      expect(mockInsert).toHaveBeenNthCalledWith(2, expect.objectContaining({
        name: "native-agent-b",
        gateway_port: 8652,
        status: "stopped",
      }));
    });

    it("throws when a host-created profile cannot be assigned a gateway port", async () => {
      jest.spyOn(ProfileService, "getHostIpForInstance").mockResolvedValue("127.0.0.1");
      jest.spyOn(ProfileService, "getHermesHomeForInstance").mockResolvedValue("/opt/data");

      (sshExec as jest.Mock).mockResolvedValue({
        ok: true,
        stdout: '[{ "name": "native-agent", "running": true }]',
        stderr: "",
      });

      const mockEq = jest.fn().mockResolvedValue({
        data: Array.from({ length: 21 }, (_, index) => ({
          id: `profile_${index}`,
          name: `existing-${index}`,
          status: "running",
          gateway_port: 8650 + index,
        })),
        error: null,
      });
      const mockSelect = jest.fn().mockReturnValue({
        eq: mockEq,
      });
      const mockInsert = jest.fn();

      const supabaseFromMock = supabaseAdmin?.from as jest.Mock;
      supabaseFromMock.mockImplementation((tableName: string) => {
        if (tableName === "profiles") {
          return {
            select: mockSelect,
            insert: mockInsert,
          };
        }
        return {};
      });

      await expect(ProfileService.syncProfiles("inst_123", "user_123")).rejects.toThrow(
        "No available ports for new profile. Maximum of 18 profiles reached."
      );
      expect(mockInsert).not.toHaveBeenCalled();
    });
  });

  describe('startProfileGateway', () => {
    it('rebuilds profile gateway env cleanly and fails startup if the gateway never binds', async () => {
      // 1. Mock getHostIpForInstance
      jest.spyOn(ProfileService, 'getHostIpForInstance').mockResolvedValue('127.0.0.1');
      jest.spyOn(ProfileService, 'getHermesHomeForInstance').mockResolvedValue('/opt/data');

      // 2. Mock DB query retrieving gateway_port
      const mockChain: Record<string, jest.Mock> = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        not: jest.fn().mockReturnThis(),
        update: jest.fn().mockReturnThis(),
        single: jest.fn()
      }
      mockChain.single.mockResolvedValueOnce({ data: { id: 'prof_new', gateway_port: 8651 } }); // startProfileGateway
      mockChain.not.mockResolvedValueOnce({ data: [] }); // updateAgentCaddyRouting profiles
      mockChain.single.mockResolvedValueOnce({ data: { subdomain: "test", config: {} } }); // updateAgentCaddyRouting instances
      
      const supabaseFromMock = supabaseAdmin?.from as jest.Mock;
      supabaseFromMock.mockReturnValue(mockChain);

      // 3. Mock sshExec and intercept script parameter
      (sshExec as jest.Mock).mockImplementation(() => {
        return Promise.resolve({ ok: true, stdout: '', stderr: '' });
      });

      // Act
      await ProfileService.startProfileGateway('inst_test', 'user_1', 'my-agent-2');

      // Assert
      expect(sshExec).toHaveBeenCalled();
      const script = (sshExec as jest.Mock).mock.calls[0][1] as string;

      expect(script).toContain('"$HERMES_BIN" -p my-agent-2 gateway stop || true');
      // The gateway is launched under a self-restarting supervisor, not a bare
      // fire-and-forget nohup; the stop-existing step must still run first.
      expect(script).not.toContain('nohup "$HERMES_BIN" gateway run');
      expect(script).toContain('base64 -d > /opt/data/profiles/my-agent-2/gateway-supervisor.sh');
      expect(script).toContain('echo $! > /opt/data/profiles/my-agent-2/gateway-supervisor.pid');
      expect(script.indexOf('"$HERMES_BIN" -p my-agent-2 gateway stop || true')).toBeLessThan(
        script.indexOf('nohup sh /opt/data/profiles/my-agent-2/gateway-supervisor.sh')
      );
      expect(script).toContain('API_SERVER_KEY missing from /opt/data/.env');
      expect(script).toContain(`env HERMES_HOME=/opt/data/profiles/my-agent-2 HERMES_WEBUI_AGENT_DIR=/opt/data/hermes-agent ${buildManagedGatewayStatusCommand()}`);
      expect(script).not.toContain('uv run');
      expect(spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' }).status).toBe(0);
      verifyProfileStatusRuntimeSelection(script);
      expect(script).toContain('/opt/data/profiles/my-agent-2/gateway-status.log');
      
      // Specifically assert that the script strips only gateway/runtime overrides and
      // removes stale PID state without touching unrelated messaging credentials.
      expect(sshExec).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining("sed -i -E '/^(API_SERVER_(PORT|HOST|KEY|ENABLED)|PROFILE_NAME)=/d' /opt/data/profiles/my-agent-2/.env"),
        expect.any(Object)
      );
      expect(sshExec).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('rm -f /opt/data/profiles/my-agent-2/gateway.pid'),
        expect.any(Object)
      );
      
      // Also confirm it explicitly exports the correct API server bindings
      expect(sshExec).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('API_SERVER_PORT=8651'),
        expect.any(Object)
      );
      expect(sshExec).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('PROFILE_NAME=my-agent-2'),
        expect.any(Object)
      );
      expect(sshExec).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('. /opt/data/profiles/my-agent-2/.env'),
        expect.any(Object)
      );
      expect(sshExec).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('READY=0'),
        expect.any(Object)
      );
      expect(sshExec).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('Profile gateway failed to bind to port 8651.'),
        expect.any(Object)
      );
      expect(sshExec).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('tail -n 80 /opt/data/profiles/my-agent-2/gateway.log'),
        expect.any(Object)
      );
      expect(sshExec).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('Profile gateway env/config diagnostics:'),
        expect.any(Object)
      );
      expect(sshExec).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('HERMES_INFERENCE_PROVIDER|OPENAI_BASE_URL'),
        expect.any(Object)
      );
    });
  });

  describe('updateAgentCaddyRouting', () => {
    it('rebuilds profile routes using the saved gateway host when DNS env is absent', async () => {
      jest.spyOn(ProfileService, 'getHostIpForInstance').mockResolvedValue('127.0.0.1');

      const mockChain: Record<string, jest.Mock> = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        not: jest.fn().mockResolvedValueOnce({ data: [{ name: 'marcus', gateway_port: 8650 }] }),
        single: jest.fn().mockResolvedValueOnce({
          data: {
            subdomain: 'unused',
            gateway_url: 'https://203-0-113-11.sslip.io',
            config: {},
            backend: LEGACY_BACKEND,
          },
        }),
      };

      (supabaseAdmin!.from as jest.Mock).mockReturnValue(mockChain);
      (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: '', stderr: '' });

      await ProfileService.updateAgentCaddyRouting('inst_test', 'user_1');

      expect(sshExec).toHaveBeenCalledWith(
        '127.0.0.1',
        expect.stringContaining('203-0-113-11.sslip.io {'),
      );
      expect(sshExec).toHaveBeenCalledWith(
        '127.0.0.1',
        expect.not.stringContaining('203-0-113-11.sslip.io, :80'),
      );
      expect(sshExec).toHaveBeenCalledWith(
        '127.0.0.1',
        expect.stringContaining('handle_path /profiles/marcus*'),
      );
    });

    it('drops the gateway port when reconstructing the public caddy host', async () => {
      jest.spyOn(ProfileService, 'getHostIpForInstance').mockResolvedValue('127.0.0.1');

      const mockChain: Record<string, jest.Mock> = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        not: jest.fn().mockResolvedValueOnce({ data: [{ name: 'marcus', gateway_port: 8650 }] }),
        single: jest.fn().mockResolvedValueOnce({
          data: {
            subdomain: 'unused',
            gateway_url: 'https://203-0-113-11.sslip.io:8443',
            config: {},
            backend: LEGACY_BACKEND,
          },
        }),
      };

      (supabaseAdmin!.from as jest.Mock).mockReturnValue(mockChain);
      (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: '', stderr: '' });

      await ProfileService.updateAgentCaddyRouting('inst_test', 'user_1');

      expect(sshExec).toHaveBeenCalledWith(
        '127.0.0.1',
        expect.stringContaining('203-0-113-11.sslip.io {'),
      );
      expect(sshExec).toHaveBeenCalledWith(
        '127.0.0.1',
        expect.not.stringContaining('203-0-113-11.sslip.io:8443, :80'),
      );
    });

    it('emits a script that snapshots the old Caddyfile, validates, reloads, then health-probes the public gateway', async () => {
      jest.spyOn(ProfileService, 'getHostIpForInstance').mockResolvedValue('127.0.0.1');

      const mockChain: Record<string, jest.Mock> = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        not: jest.fn().mockResolvedValueOnce({ data: [] }),
        single: jest.fn().mockResolvedValueOnce({
          data: {
            subdomain: 'unused',
            gateway_url: 'https://203-0-113-11.sslip.io',
            config: {},
            backend: LEGACY_BACKEND,
          },
        }),
      };

      (supabaseAdmin!.from as jest.Mock).mockReturnValue(mockChain);
      (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: 'OK status=200', stderr: '' });

      await ProfileService.updateAgentCaddyRouting('inst_test', 'user_1');

      const script = (sshExec as jest.Mock).mock.calls[0][1] as string;

      // Snapshot before write — required for rollback
      expect(script).toContain('cp Caddyfile Caddyfile.before-reload');
      // Health probe with --resolve so DNS doesn't have to work for the
      // probe to succeed (just validates Caddy + reverse_proxy backend)
      expect(script).toContain('--resolve "${HEALTH_FQDN}:443:127.0.0.1"');
      expect(script).toContain("HEALTH_FQDN='203-0-113-11.sslip.io'");
      // Failed reload triggers rollback
      expect(script).toContain('mv "$INST_DIR/Caddyfile.before-reload" "$INST_DIR/Caddyfile"');
      // The legacy stack's ports (the only stack this builder can describe).
      expect(script).toContain('agent-inst_test:8642');
      expect(script).toContain('agent-inst_test-sidecar:9090');
    });

    // REGRESSION (profile-lane Caddyfile clobber). updateAgentCaddyRouting used
    // to call buildAgentCaddyfile for EVERY backend and reload the result onto
    // the live box. On a webfree box that Caddyfile's upstreams (`agent-<id>`,
    // `agent-<id>-sidecar`) do not exist — the real services are
    // `agent-<id>-gateway`, `agent-<id>-official-dashboard` and
    // `agent-<id>-dashboard-sidecar` — so every route 502'd and the public
    // /webchat + /dash shells vanished. Reachable from BOTH
    // POST /profiles/[name]/gateway?action=stop and the chat lane
    // (responses/route.ts restarts a profile gateway on runtime-auth change).
    //
    // We assert nothing reaches the host rather than spying on the dynamically
    // imported buildAgentCaddyfile: the builder is pure, so its return value
    // only matters if a script carrying it is sshExec'd onto the box.
    it.each([
      ['gateway', 'gateway'],
      ['webui', 'webui'],
      ['null (column unset — fail closed)', null],
      ['undefined (column absent — fail closed)', undefined],
    ])('never writes a Caddyfile to a webfree box: backend=%s', async (_label, backend) => {
      jest.spyOn(ProfileService, 'getHostIpForInstance').mockResolvedValue('127.0.0.1');

      const mockChain: Record<string, jest.Mock> = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        not: jest.fn().mockResolvedValue({ data: [{ name: 'marcus', gateway_port: 8650 }] }),
        single: jest.fn().mockResolvedValue({
          data: {
            subdomain: 'agent-x',
            gateway_url: 'https://203-0-113-11.sslip.io',
            config: {},
            ...(backend === undefined ? {} : { backend }),
          },
        }),
      };

      (supabaseAdmin!.from as jest.Mock).mockReturnValue(mockChain);
      (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: 'OK', stderr: '' });

      await expect(
        ProfileService.updateAgentCaddyRouting('inst_test', 'user_1'),
      ).resolves.toBeUndefined();

      // The single invariant that matters: no Caddyfile ever reaches the host.
      expect(sshExec).not.toHaveBeenCalled();
    });

    it('throws instead of silently writing a probe-less, un-rollback-able Caddyfile', async () => {
      // No gateway_url and no DNS domain → fqdn falls back to "localhost". The
      // reload script skips the health probe in that case, which ALSO skips the
      // rollback and still exits 0 — so a bad Caddyfile would be permanent and
      // reported as success. Fail closed instead.
      const priorDnsDomain = process.env.NEXT_PUBLIC_DNS_DOMAIN_DEPLOY;
      delete process.env.NEXT_PUBLIC_DNS_DOMAIN_DEPLOY;

      try {
        jest.spyOn(ProfileService, 'getHostIpForInstance').mockResolvedValue('127.0.0.1');

        const mockChain: Record<string, jest.Mock> = {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          not: jest.fn().mockResolvedValue({ data: [] }),
          single: jest.fn().mockResolvedValue({
            data: {
              subdomain: null,
              gateway_url: null,
              config: {},
              backend: LEGACY_BACKEND,
            },
          }),
        };

        (supabaseAdmin!.from as jest.Mock).mockReturnValue(mockChain);
        (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: 'OK', stderr: '' });

        await expect(ProfileService.updateAgentCaddyRouting('inst_test', 'user_1')).rejects.toThrow(
          'Refusing to rebuild Caddy routing without a probeable public hostname',
        );
        expect(sshExec).not.toHaveBeenCalled();
      } finally {
        if (priorDnsDomain === undefined) {
          delete process.env.NEXT_PUBLIC_DNS_DOMAIN_DEPLOY;
        } else {
          process.env.NEXT_PUBLIC_DNS_DOMAIN_DEPLOY = priorDnsDomain;
        }
      }
    });

    it('skips the health probe in localhost / dev mode (no public hostname to probe)', () => {
      const script = profileServiceInternals.buildCaddyReloadWithHealthProbeScript({
        instanceId: 'inst_test',
        caddyfile: ':80 {\n  respond 200\n}',
        probeFqdn: null,
      });
      expect(script).toContain('Skipping health probe');
      expect(script).not.toContain('HEALTH_FQDN=');
      expect(script).not.toContain('--resolve');
    });

    it('refuses to interpolate fqdns that fail the alphanumeric+dot+hyphen allowlist', () => {
      // Defense in depth — the fqdn flows into a shell variable assignment
      // and into a curl flag, so we hard-allowlist the chars to make
      // shell injection structurally impossible. This test pins that.
      const malicious = profileServiceInternals.buildCaddyReloadWithHealthProbeScript({
        instanceId: 'inst_test',
        caddyfile: ':80 { respond 200 }',
        probeFqdn: "evil.example'; rm -rf /; #",
      });
      // Falls through to the no-probe branch when input fails validation
      expect(malicious).toContain('Skipping health probe');
      expect(malicious).not.toContain('rm -rf');
    });

    it('redacts secrets when caddy reload errors are logged', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      jest.spyOn(ProfileService, 'getHostIpForInstance').mockResolvedValue('127.0.0.1');

      const mockChain: Record<string, jest.Mock> = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        not: jest.fn().mockResolvedValueOnce({ data: [{ name: 'marcus', gateway_port: 8650 }] }),
        single: jest.fn().mockResolvedValueOnce({
          data: {
            subdomain: 'unused',
            gateway_url: 'https://203-0-113-11.sslip.io',
            config: {},
            backend: LEGACY_BACKEND,
          },
        }),
      };

      (supabaseAdmin!.from as jest.Mock).mockReturnValue(mockChain);
      (sshExec as jest.Mock).mockResolvedValue({ ok: false, stdout: '', stderr: 'refresh_token=super-secret' });

      await expect(ProfileService.updateAgentCaddyRouting('inst_test', 'user_1')).rejects.toThrow(
        'Failed to reload routing layer'
      );

      const consoleOutput = stringifyMockCalls(consoleErrorSpy);
      expect(consoleOutput).toContain('[REDACTED]');
      expect(consoleOutput).not.toContain('super-secret');

      consoleErrorSpy.mockRestore();
    });
  });
});

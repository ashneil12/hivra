import zlib from 'node:zlib';

import { pickServerType, getServerSpecs, buildAgentDeployScript } from '@/lib/services/hetzner-instance-service';
import { buildAutoUpdateTimerProvisioningScript } from '@/lib/services/hetzner-instance-builders';
import { gunzipSync } from 'zlib';

/** Decode all base64 | base64 -d blocks in a deploy script and return the joined plaintext. */
function decodeScriptBase64(script: string): string {
  const parts: string[] = [];
  const patterns = [
    /printf\s+'%s'\s+'([A-Za-z0-9+/=]+)'\s*\|\s*base64\s+-d(?:\s*\|\s*gunzip)?/g,
    /echo\s+"([A-Za-z0-9+/=]+)"\s*\|\s*base64\s+-d(?:\s*\|\s*gunzip)?/g,
  ];

  for (const pattern of patterns) {
    for (const m of script.matchAll(pattern)) {
      try {
        const decoded = Buffer.from(m[1], 'base64');
        parts.push(m[0].includes('gunzip') ? gunzipSync(decoded).toString('utf8') : decoded.toString('utf8'));
      } catch {
        // skip invalid b64 chunks
      }
    }
  }
  return parts.join('\n');
}

const BASE_PARAMS = {
  instanceId: 'i_123',
  containerName: 'hermes-xyz',
  apiServerKey: 'super-secret',
  provider: 'openai' as const,
  apiKey: 'sk-123',
  model: 'gpt-4o',
  fqdn: 'hermes-xyz.deploy.com',
  cpuLimit: 2,
  ramLimit: 4096,
  agentSettings: {
    maxIterations: 60,
    toolProgressMode: 'all' as const,
    compressionThreshold: 0.85,
    sessionResetMode: 'both' as const,
    browserProvider: 'local',
  },
};

describe('Hetzner Instance Service', () => {
  describe('pickServerType()', () => {
    it('maps literal Stripe plan keys to their intended dynamic Hetzner instances', () => {
      expect(pickServerType('operator')).toBe('cx23');
      expect(pickServerType('fleet')).toBe('cx43');
      expect(pickServerType('command')).toBe('cx53');
    });

    it('falls back to environment variable or cx23 if tier is unknown', () => {
      process.env.HETZNER_SERVER_TYPE = 'cpx31';
      expect(pickServerType('nonexistent-tier')).toBe('cpx31');
      expect(pickServerType(undefined)).toBe('cpx31');

      delete process.env.HETZNER_SERVER_TYPE;
      expect(pickServerType('unknown')).toBe('cx23');
    });
  });

  describe('getServerSpecs()', () => {
    it('returns correct vCPU and RAM properties for targeted Hetzner tiers', () => {
      const cx23 = getServerSpecs('cx23');
      expect(cx23.cpu).toBe(2);
      expect(cx23.ram).toBe(4096);

      const cx33 = getServerSpecs('cx33');
      expect(cx33.cpu).toBe(4);
      expect(cx33.ram).toBe(8192);

      const cx43 = getServerSpecs('cx43');
      expect(cx43.cpu).toBe(8);
      expect(cx43.ram).toBe(16384);
    });

    it('returns a safe fallback block for completely unknown instances', () => {
      const fallback = getServerSpecs('unknown192934');
      expect(fallback.cpu).toBe(2);
      expect(fallback.ram).toBe(4096);
    });
  });

  describe('buildAgentDeployScript()', () => {
    it('generates base64 file injection to avoid bash escaping', () => {
      const deployScript = buildAgentDeployScript({
        instanceId: 'i_123',
        containerName: 'hermes-xyz',
        apiServerKey: 'super-secret',
        provider: 'openai',
        apiKey: 'sk-123',
        model: 'gpt-4o',
        fqdn: 'hermes-xyz.deploy.com',
        cpuLimit: 2,
        ramLimit: 4096,
        agentSettings: {
          enableRootAccess: true,
          systemPrompt: "You are the best. 'SOULEOF' injection.",
          maxIterations: 60,
          toolProgressMode: 'all',
          compressionThreshold: 0.85,
          sessionResetMode: 'both',
          browserProvider: 'local',
        },
      });

      expect(deployScript).not.toContain('SOULEOF');
      expect(deployScript).toContain("printf '%s' '");
      expect(deployScript).toMatch(/\| base64 -d(?: \| gunzip)? > SOUL\.md/);
      expect(deployScript).toContain('docker compose pull agent');
    });

    it('makes the webfree agent-source copy owner-writable (gateway crash-loop fix)', () => {
      // The webfree runtime install copies the read-only baked /opt/hermes tree
      // into the persisted agent-source volume with `cp -a` (archive mode, which
      // preserves the image's `a-w` mode). Without making the copy owner-writable,
      // the gateway's editable build of hermes-agent can't write its egg-info
      // (EACCES) and the gateway crash-loops on every redeploy. The `chmod -R u+w`
      // right after the copy is the durable fix.
      const updateScript = buildAutoUpdateTimerProvisioningScript({
        instanceId: 'i_123',
        containerName: 'hermes-xyz',
        backend: 'webui',
        webuiAgentImage: 'ghcr.io/ashneil12/operatoros-agent:stable',
      });

      // The provisioning userData ships the update toolchain gzip+base64-encoded,
      // so decompress the blob(s) to assert on the real script content.
      const blobs = [...updateScript.matchAll(/printf '%s' '([^']+)' \| base64 -d \| gunzip/g)];
      expect(blobs.length).toBeGreaterThan(0);
      const decompressed = blobs
        .map((b) => zlib.gunzipSync(Buffer.from(b[1], 'base64')).toString('utf8'))
        .join('\n');

      expect(decompressed).toContain('cp -a /opt/hermes/. /target/');
      // The chmod must come AFTER the chown, both inside the same copy command.
      expect(decompressed).toMatch(/cp -a \/opt\/hermes\/\. \/target\/; chown -R 1024:1024 \/target; chmod -R u\+w \/target/);
    });

    it('injects a2a bridge dependencies securely when a2aSettings are passed', () => {
      const deployScript = buildAgentDeployScript({
        instanceId: 'i_123',
        containerName: 'hermes-xyz',
        apiServerKey: 'super-secret',
        provider: 'openai',
        apiKey: 'sk-123',
        model: 'gpt-4o',
        fqdn: 'hermes-xyz.deploy.com',
        cpuLimit: 2,
        ramLimit: 4096,
        a2aSettings: {
          enableAcp: true,
          enableMcp: true,
        },
      });

      expect(deployScript).toMatch(/base64 -d(?: \| gunzip)? > a2a_bridge\.py/);
    });

    it('uses a non-root Hermes home when root access is disabled', () => {
      const script = buildAgentDeployScript({
        ...BASE_PARAMS,
        agentSettings: {
          ...BASE_PARAMS.agentSettings,
          enableRootAccess: false,
        },
      });

      const decoded = decodeScriptBase64(script);
      expect(decoded).toContain('HERMES_HOME=/opt/data');
      expect(decoded).toContain('- ./.env:/opt/data/.env');
      expect(decoded).toContain('- agent-memories:/opt/data/memories');
      expect(decoded).toContain('- agent-profiles:/opt/data/profiles');
      expect(decoded).toContain('container_name: hermes-xyz-web');
      expect(decoded).toContain('command: ["dashboard", "--host", "0.0.0.0", "--no-open", "--insecure", "--tui"]');
      expect(decoded).toContain('HERMES_DASHBOARD_TUI=1');
      expect(decoded).toContain('command: ["gateway", "run"]');
      expect(decoded).not.toContain('privileged: true');
      expect(decoded).not.toContain('user: root');
    });

    it('rebuilds root mode with an explicit root-preserving entrypoint', () => {
      const script = buildAgentDeployScript({
        ...BASE_PARAMS,
        agentSettings: {
          ...BASE_PARAMS.agentSettings,
          enableRootAccess: true,
        },
      });

      const decoded = decodeScriptBase64(script);
      expect(decoded).toContain('HERMES_HOME=/root/.hermes');
      expect(decoded).toContain('HOME=/root');
      expect(decoded).toContain('privileged: true');
      expect(decoded).toContain('user: root');
      expect(decoded).toContain('entrypoint: ["/bin/bash", "/opt/hermes/docker/root-mode-entrypoint.sh"]');
      expect(decoded).toContain('- ./root-mode-entrypoint.sh:/opt/hermes/docker/root-mode-entrypoint.sh:ro');
      expect(decoded).toContain('if command -v "$1" >/dev/null 2>&1; then');
      expect(decoded).toContain('exec "$@"');
      expect(decoded).toContain('exec hermes "$@"');
    });

    it('sanitizes preserved env lines and excludes managed keys from legacy env merges', () => {
      const script = buildAgentDeployScript({
        ...BASE_PARAMS,
        agentSettings: {
          ...BASE_PARAMS.agentSettings,
          enableRootAccess: true,
        },
      });
      const decoded = decodeScriptBase64(script);

      expect(script).toContain('.managed-env-keys');
      expect(script).toContain('^[A-Za-z_][A-Za-z0-9_]*=');
      expect(script).toContain("managed[$1]=1");
      expect(decoded).toContain('BROWSERBASE_API_KEY');
      expect(decoded).toContain('FIRECRAWL_API_KEY');
    });

    // ── Proxy env var injection ───────────────────────────────────────────
    // The Docker Compose YAML is base64-encoded inside the script.
    // We decode all base64 blobs to assert on their plaintext content.

    describe('proxy env var injection', () => {
      it('does NOT include PROXY_HOST when proxy is not configured', () => {
        const script = buildAgentDeployScript({
          ...BASE_PARAMS,
          agentSettings: { ...BASE_PARAMS.agentSettings },
        });

        const decoded = decodeScriptBase64(script);
        expect(decoded).not.toContain('PROXY_HOST');
        expect(decoded).not.toContain('PROXY_PORT');
        expect(decoded).not.toContain('PROXY_USERNAME');
        expect(decoded).not.toContain('PROXY_PASSWORD');
      });
    });
  });
});

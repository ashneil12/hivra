import { buildAgentDeployScript, renderHostUserData } from '../hetzner-instance-service';
import { gunzipSync } from 'zlib';

function extractEmbeddedFile(deployScript: string, path: string): string {
  const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = deployScript.match(
    new RegExp(`printf '%s' '([A-Za-z0-9+/=]+)' \\| base64 -d( \\| gunzip)? > ${escapedPath}`)
  );
  expect(match?.[1]).toBeTruthy();
  const encoded = Buffer.from(match![1], 'base64');
  return match?.[2] ? gunzipSync(encoded).toString('utf8') : encoded.toString('utf8');
}

function extractComposeFromDeployScript(deployScript: string): string {
  return extractEmbeddedFile(deployScript, 'docker-compose.yml');
}

describe('hetzner-instance-service', () => {
  it('renderHostUserData generates the current host bootstrap bash script', () => {
    const userData = renderHostUserData();
    
    expect(userData).toContain('#!/usr/bin/env bash');
    expect(userData).toContain('curl -fsSL https://get.docker.com | sh');
    expect(userData).toContain('docker network create hermes_net || true');
    expect(userData).toContain('cat > docker-compose.yml << \'COMPOSEEOF\'');
  });

  // Adding explicit boundary execution validation
  it('prevents dangerous execution variables', () => {
    const userData = renderHostUserData();
    expect(userData).not.toContain('rm -rf / '); // basic boundary check
  });

  it('publishes only the public web ports on the host gateway', () => {
    const userData = renderHostUserData();

    expect(userData).toContain('"80:80"');
    expect(userData).toContain('"443:443"');
    expect(userData).not.toContain('"8080:8080"');
    expect(userData).not.toContain('"9377:9377"');
    expect(userData).not.toContain('"6080:6080"');
  });

  it('boots the sidecar without installing npm packages at runtime', () => {
    const deployScript = buildAgentDeployScript({
      instanceId: 'inst-123',
      containerName: 'agent-inst-123',
      apiServerKey: 'api-key',
      provider: 'openai',
      apiKey: 'provider-key',
      model: 'gpt-5.4-mini',
      fqdn: 'agent.example.com',
      cpuLimit: 2,
      ramLimit: 2048,
    });

    expect(deployScript).not.toContain('npm install --prefer-offline --no-audit --no-fund express');
    expect(deployScript).not.toContain('sidecar-node-modules');
  });

  it('fails deployment when the host caddy config is invalid instead of masking reload errors', () => {
    const deployScript = buildAgentDeployScript({
      instanceId: 'inst-123',
      containerName: 'agent-inst-123',
      apiServerKey: 'api-key',
      provider: 'openai',
      apiKey: 'provider-key',
      model: 'gpt-5.4-mini',
      fqdn: 'agent.example.com',
      cpuLimit: 2,
      ramLimit: 2048,
    });

    expect(deployScript).toContain('docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile');
    expect(deployScript).toContain('docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile');
    expect(deployScript).toContain('FATAL: caddy reload failed after startup');
    expect(deployScript).not.toContain('docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile || true');
  });

  it('reloads caddy before runtime patch hooks can abort first-boot deploys', () => {
    const deployScript = buildAgentDeployScript({
      instanceId: 'inst-123',
      containerName: 'agent-inst-123',
      apiServerKey: 'api-key',
      provider: 'openai',
      apiKey: 'provider-key',
      model: 'gpt-5.4-mini',
      fqdn: 'agent.example.com',
      cpuLimit: 2,
      ramLimit: 2048,
    });

    const caddyReloadIndex = deployScript.indexOf('reload_host_caddy()');
    const runtimePatchIndex = deployScript.indexOf('FATAL: $container_name did not start before runtime patching');

    expect(caddyReloadIndex).toBeGreaterThan(-1);
    expect(runtimePatchIndex).toBeGreaterThan(-1);
    expect(caddyReloadIndex).toBeLessThan(runtimePatchIndex);
  });

  it('configures the official dashboard to probe the gateway across containers', () => {
    const deployScript = buildAgentDeployScript({
      instanceId: 'inst-123',
      containerName: 'agent-inst-123',
      apiServerKey: 'api-key',
      provider: 'openai',
      apiKey: 'provider-key',
      model: 'gpt-5.4-mini',
      fqdn: 'agent.example.com',
      cpuLimit: 2,
      ramLimit: 2048,
    });

    const compose = extractComposeFromDeployScript(deployScript);

    expect(compose).toContain('container_name: agent-inst-123-web');
    expect(compose).toContain('GATEWAY_HEALTH_URL=http://agent-inst-123:8642');
    expect(compose).toContain('command: ["dashboard", "--host", "0.0.0.0", "--no-open", "--insecure", "--tui"]');
  });

  it('gives root-enabled instances a local terminal rooted in the Hermes install by default', () => {
    const deployScript = buildAgentDeployScript({
      instanceId: 'inst-123',
      containerName: 'agent-inst-123',
      apiServerKey: 'api-key',
      provider: 'openai',
      apiKey: 'provider-key',
      model: 'gpt-5.4-mini',
      fqdn: 'agent.example.com',
      cpuLimit: 2,
      ramLimit: 2048,
      agentSettings: {
        enableRootAccess: true,
        maxIterations: 60,
        toolProgressMode: 'full',
        compressionThreshold: 0.5,
        sessionResetMode: 'both',
      },
    });

    const config = extractEmbeddedFile(deployScript, 'config.yaml');
    const compose = extractComposeFromDeployScript(deployScript);

    expect(config).toContain('terminal:\n  backend: local\n  cwd: "/opt/hermes"\n');
    expect(compose).toContain('TERMINAL_EXEC_USER=root');
    expect(compose).toContain('TERMINAL_CWD=/opt/hermes');
    expect(compose).toContain('TERMINAL_SHELL_CWD=/opt/hermes');
    expect(compose).toContain('TERMINAL_TUI_CWD=/opt/hermes');
  });

  it('starts root-enabled terminals in the persistent source mount when available', () => {
    const deployScript = buildAgentDeployScript({
      instanceId: 'inst-123',
      containerName: 'agent-inst-123',
      apiServerKey: 'api-key',
      provider: 'openai',
      apiKey: 'provider-key',
      model: 'gpt-5.4-mini',
      fqdn: 'agent.example.com',
      cpuLimit: 2,
      ramLimit: 2048,
      agentSettings: {
        enableRootAccess: true,
        mountPersistentSource: true,
        maxIterations: 60,
        toolProgressMode: 'full',
        compressionThreshold: 0.5,
        sessionResetMode: 'both',
      },
    });

    const config = extractEmbeddedFile(deployScript, 'config.yaml');
    const compose = extractComposeFromDeployScript(deployScript);

    expect(config).toContain('terminal:\n  backend: local\n  cwd: "/root/.hermes/hermes-agent"\n');
    expect(compose).toContain('TERMINAL_EXEC_USER=root');
    expect(compose).toContain('TERMINAL_CWD=/root/.hermes/hermes-agent');
    expect(compose).toContain('TERMINAL_SHELL_CWD=/root/.hermes/hermes-agent');
    expect(compose).toContain('TERMINAL_TUI_CWD=/opt/hermes');
  });

  it('keeps legacy /opt/data compatibility mounts for root-enabled runtimes', () => {
    const deployScript = buildAgentDeployScript({
      instanceId: 'inst-123',
      containerName: 'agent-inst-123',
      apiServerKey: 'api-key',
      provider: 'openai',
      apiKey: 'provider-key',
      model: 'gpt-5.4-mini',
      fqdn: 'agent.example.com',
      cpuLimit: 2,
      ramLimit: 2048,
      agentSettings: {
        enableRootAccess: true,
        maxIterations: 60,
        toolProgressMode: 'full',
        compressionThreshold: 0.5,
        sessionResetMode: 'both',
      },
    });

    const compose = extractComposeFromDeployScript(deployScript);

    expect(compose).toContain('HERMES_HOME=/root/.hermes');
    expect(compose).toContain('- ./.env:/root/.hermes/.env');
    expect(compose).toContain('- ./config.yaml:/root/.hermes/config.yaml');
    expect(compose).toContain('- ./.env:/opt/data/.env');
    expect(compose).toContain('- ./config.yaml:/opt/data/config.yaml');
    expect(compose).toContain('- ./SOUL.md:/opt/data/SOUL.md');
    expect(compose).toContain('- ./honcho.json:/opt/data/honcho.json');
    expect(compose).toContain('- MAIN_ENV_FILE=/opt/data/.env');
    expect(compose).toContain('- ./sidecar_server.js:/opt/data/server.js');
  });

  it('starts managed terminals as the hermes user inside the Hermes home', () => {
    const deployScript = buildAgentDeployScript({
      instanceId: 'inst-123',
      containerName: 'agent-inst-123',
      apiServerKey: 'api-key',
      provider: 'openai',
      apiKey: 'provider-key',
      model: 'gpt-5.4-mini',
      fqdn: 'agent.example.com',
      cpuLimit: 2,
      ramLimit: 2048,
      agentSettings: {
        enableRootAccess: false,
        maxIterations: 60,
        toolProgressMode: 'full',
        compressionThreshold: 0.5,
        sessionResetMode: 'both',
      },
    });

    const compose = extractComposeFromDeployScript(deployScript);

    expect(compose).toContain('TERMINAL_EXEC_USER=hermes');
    expect(compose).toContain('TERMINAL_CWD=/opt/data');
    expect(compose).toContain('TERMINAL_SHELL_CWD=/opt/data');
    expect(compose).toContain('TERMINAL_TUI_CWD=/opt/data');
  });

  it('starts managed terminals in the persistent source mount when developer source mounts are enabled', () => {
    const deployScript = buildAgentDeployScript({
      instanceId: 'inst-123',
      containerName: 'agent-inst-123',
      apiServerKey: 'api-key',
      provider: 'openai',
      apiKey: 'provider-key',
      model: 'gpt-5.4-mini',
      fqdn: 'agent.example.com',
      cpuLimit: 2,
      ramLimit: 2048,
      agentSettings: {
        enableRootAccess: false,
        mountPersistentSource: true,
        maxIterations: 60,
        toolProgressMode: 'full',
        compressionThreshold: 0.5,
        sessionResetMode: 'both',
      },
    });

    const compose = extractComposeFromDeployScript(deployScript);

    expect(compose).toContain('TERMINAL_EXEC_USER=hermes');
    expect(compose).toContain('TERMINAL_CWD=/opt/data/hermes-agent');
    expect(compose).toContain('TERMINAL_SHELL_CWD=/opt/data/hermes-agent');
    expect(compose).toContain('TERMINAL_TUI_CWD=/opt/data');
  });

  it('bootstraps developer shell tools for root-enabled runtime containers', () => {
    const deployScript = buildAgentDeployScript({
      instanceId: 'inst-123',
      containerName: 'agent-inst-123',
      apiServerKey: 'api-key',
      provider: 'openai',
      apiKey: 'provider-key',
      model: 'gpt-5.4-mini',
      fqdn: 'agent.example.com',
      cpuLimit: 2,
      ramLimit: 2048,
      agentSettings: {
        enableRootAccess: true,
        maxIterations: 60,
        toolProgressMode: 'full',
        compressionThreshold: 0.5,
        sessionResetMode: 'both',
      },
    });

    expect(deployScript).toContain('command -v sudo >/dev/null 2>&1');
    expect(deployScript).toContain('install_deb_package sudo || true');
    expect(deployScript).toContain('command -v curl >/dev/null 2>&1');
    expect(deployScript).toContain('install_deb_package curl ca-certificates || install_deb_package curl || true');
    expect(deployScript).toContain('command -v docker >/dev/null 2>&1');
    expect(deployScript).toContain('install_deb_package docker.io || install_deb_package docker-ce-cli || true');
    expect(deployScript).toContain("/opt/hermes/.venv/bin/python -c 'import yaml' >/dev/null 2>&1");
    expect(deployScript).toContain('uv pip install --python /opt/hermes/.venv/bin/python pyyaml >/dev/null 2>&1');
    expect(deployScript).toContain('/usr/local/bin/sudo');
  });

  it('primes root-enabled interactive shells with the Hermes virtualenv', () => {
    const deployScript = buildAgentDeployScript({
      instanceId: 'inst-123',
      containerName: 'agent-inst-123',
      apiServerKey: 'api-key',
      provider: 'openai',
      apiKey: 'provider-key',
      model: 'gpt-5.4-mini',
      fqdn: 'agent.example.com',
      cpuLimit: 2,
      ramLimit: 2048,
      agentSettings: {
        enableRootAccess: true,
        maxIterations: 60,
        toolProgressMode: 'full',
        compressionThreshold: 0.5,
        sessionResetMode: 'both',
      },
    });

    const rootEntrypoint = extractEmbeddedFile(deployScript, 'root-mode-entrypoint.sh');

    expect(rootEntrypoint).toContain('# Hermes root terminal bootstrap');
    expect(rootEntrypoint).toContain('ROOT_BASHRC="/root/.bashrc"');
    expect(rootEntrypoint).toContain('export PATH="/opt/hermes/.venv/bin:$PATH"');
    expect(rootEntrypoint).toContain('. /opt/hermes/.venv/bin/activate >/dev/null 2>&1 || true');
  });
});

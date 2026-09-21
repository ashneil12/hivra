import {
  buildGoogleWorkspaceExchangeCommand,
  buildGoogleWorkspaceSetupCommand,
} from '@/lib/google-workspace-oauth';

describe('google-workspace-oauth helpers', () => {
  it('builds the setup command with the current Hermes CLI path and a fallback', () => {
    const command = buildGoogleWorkspaceSetupCommand('inst_123', '{"client":"secret"}');

    expect(command).toContain('/opt/hermes/.venv/bin/hermes');
    expect(command).toContain('/opt/venv/bin/hermes');
    expect(command).toContain('command -v hermes');
    expect(command).toContain('workspace setup --client-secret /tmp/gws_creds.json');
    expect(command).toContain('workspace setup --auth-url');
  });

  it('builds the exchange command with the current Hermes CLI path and a fallback', () => {
    const command = buildGoogleWorkspaceExchangeCommand('inst_123', 'test-code-123');

    expect(command).toContain('/opt/hermes/.venv/bin/hermes');
    expect(command).toContain('/opt/venv/bin/hermes');
    expect(command).toContain('command -v hermes');
    expect(command).toContain('GWS_AUTH_CODE=$(printf %s "');
    expect(command).toContain('"$HERMES_BIN" workspace setup --auth-code "$GWS_AUTH_CODE"');
  });

  it('resolves the running container across the webui and webfree topologies', () => {
    const setup = buildGoogleWorkspaceSetupCommand('inst_123', '{"client":"secret"}');
    const exchange = buildGoogleWorkspaceExchangeCommand('inst_123', 'test-code-123');

    for (const command of [setup, exchange]) {
      expect(command).toContain(
        'for candidate_container in agent-inst_123 agent-inst_123-gateway; do'
      );
      expect(command).toContain(
        'docker inspect --format=\'{{.State.Running}}\' "$candidate_container"'
      );
      // The gws setup/exchange routes key on this docker stderr
      // ("No such container") to return a 503; the sentinel must stay intact.
      expect(command).toContain(
        'echo "Error response from daemon: No such container: agent-inst_123" >&2'
      );
      // Container resolution must run before the docker exec / pipeline.
      expect(command.indexOf('if [ -z "$AGENT_CONTAINER" ]; then')).toBeLessThan(
        command.indexOf('docker exec')
      );
      // The exec must target the resolved container, never the bare name.
      expect(command).toContain('"$AGENT_CONTAINER" sh -lc');
    }

    // Setup pipes the b64 client_secret into the resolved container over stdin.
    expect(setup).toContain('base64 -d | docker exec -i "$AGENT_CONTAINER" sh -lc');
    expect(exchange).toContain('docker exec "$AGENT_CONTAINER" sh -lc');
  });

  it('base64-encodes auth codes before embedding them into the remote shell command', () => {
    const command = buildGoogleWorkspaceExchangeCommand(
      'inst_123',
      "oauth-code'; touch /tmp/pwn; echo '"
    );

    expect(command).not.toContain('touch /tmp/pwn');
    expect(command).not.toContain("--auth-code 'oauth-code");
  });
});

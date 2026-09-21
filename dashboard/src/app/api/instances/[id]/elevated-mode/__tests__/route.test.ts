import {
  buildElevatedModeApplyScript,
  buildElevatedModeReadScript,
  isElevatedFromReadOutput,
  ELEVATED_ENV_KEY,
} from '../elevated-mode-script';

// Regression guard for the agent elevated-mode (gated sudo) toggle. Ash asked
// that neither the capability nor the OPTION can be silently dropped. These tests
// pin the contract of the SSH scripts the route ships to the host.
describe('elevated-mode ssh script builders', () => {
  const id = 'abc123-def456';

  it('exposes the agreed env flag name', () => {
    expect(ELEVATED_ENV_KEY).toBe('HERMES_AGENT_ELEVATED');
  });

  describe('enable', () => {
    const script = buildElevatedModeApplyScript(id, true);

    it('writes HERMES_AGENT_ELEVATED=1 into the instance env_file', () => {
      expect(script).toContain(`/opt/hermes/instances/${id}/.env`);
      expect(script).toContain(ELEVATED_ENV_KEY);
      expect(script).toContain('key + "=1"');
    });

    it('recreates the resolved runtime service (gateway on webfree, else webui) so docker_init re-applies the gate', () => {
      expect(script).toContain('sudo docker compose up -d --force-recreate "$TARGET_SVC"');
      expect(script).toContain('grep -qx gateway && echo gateway || echo webui');
      // Must not hard-code the webui service — webfree has no such service.
      expect(script).not.toContain('--force-recreate webui ');
    });

    it('is pipefail-safe: config exit code is neutralized before the pipe (script runs under set -euo pipefail)', () => {
      // This script opens with `set -euo pipefail`, so a non-zero `docker compose
      // config` exit would otherwise fail the `… | grep -qx gateway` pipeline and
      // fall through to the ABSENT `webui` service (cf. hermesdeploy#470). The
      // `{ …; || true; }` guard keeps gateway resolution correct.
      expect(script).toContain('set -euo pipefail');
      expect(script).toContain('|| true; } | grep -qx gateway');
      expect(script).not.toContain('config --services 2>/dev/null | grep -qx gateway');
    });

    it('preserves docker compose exit code by capturing command substitution output before tailing', () => {
      expect(script).toContain('OUT=$(sudo docker compose up -d --force-recreate "$TARGET_SVC" 2>&1)');
      expect(script).not.toContain('sudo docker compose up -d --force-recreate "$({ sudo docker compose config');
    });

    it('strips any existing flag first so repeated toggles are idempotent', () => {
      expect(script).toContain('!= key');
    });
  });

  describe('disable', () => {
    const script = buildElevatedModeApplyScript(id, false);

    it('writes an explicit HERMES_AGENT_ELEVATED=0 (default is ON, so absent ⇒ on)', () => {
      expect(script).toContain('key + "=0"');
      expect(script).not.toContain('key + "=1"');
      expect(script).toContain('!= key'); // still strips the old value first
    });

    it('still recreates the resolved runtime service so the sudoers drop-in is removed', () => {
      expect(script).toContain('sudo docker compose up -d --force-recreate "$TARGET_SVC"');
      expect(script).toContain('grep -qx gateway && echo gateway || echo webui');
    });
  });

  describe('read', () => {
    it('greps the flag from the instance env_file', () => {
      const script = buildElevatedModeReadScript(id);
      expect(script).toContain(`/opt/hermes/instances/${id}/.env`);
      expect(script).toContain(`${ELEVATED_ENV_KEY}=`);
    });

    // Default-ON contract: the agent is elevated unless explicitly disabled.
    it('reads an absent flag (empty output) as ENABLED (default on)', () => {
      expect(isElevatedFromReadOutput('')).toBe(true);
      expect(isElevatedFromReadOutput('   \n')).toBe(true);
    });

    it('reads an explicit falsy flag as disabled', () => {
      expect(isElevatedFromReadOutput('HERMES_AGENT_ELEVATED=0')).toBe(false);
      expect(isElevatedFromReadOutput('HERMES_AGENT_ELEVATED=false')).toBe(false);
      expect(isElevatedFromReadOutput('HERMES_AGENT_ELEVATED=off')).toBe(false);
    });

    it('reads an explicit truthy flag as enabled', () => {
      expect(isElevatedFromReadOutput('HERMES_AGENT_ELEVATED=1')).toBe(true);
      expect(isElevatedFromReadOutput('HERMES_AGENT_ELEVATED=true')).toBe(true);
    });
  });

  it('isolates the instance id into the path (no cross-instance bleed)', () => {
    expect(buildElevatedModeApplyScript('inst-A', true)).toContain('/opt/hermes/instances/inst-A/.env');
    expect(buildElevatedModeApplyScript('inst-A', true)).not.toContain('inst-B');
  });
});

import { sanitizeDockerName, ProfileService } from '../lib/services/profile-service';

jest.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

describe('Profile Service Unit Tests', () => {
  describe('sanitizeDockerName', () => {
    it('allows valid docker names', () => {
      expect(sanitizeDockerName('valid-name')).toBe('valid-name');
      expect(sanitizeDockerName('VALID_NAME_123')).toBe('VALID_NAME_123');
      expect(sanitizeDockerName('default')).toBe('default');
    });

    it('throws on invalid characters', () => {
      expect(() => sanitizeDockerName('invalid/name')).toThrow('Invalid identifier format');
      expect(() => sanitizeDockerName('invalid name')).toThrow('Invalid identifier format');
      expect(() => sanitizeDockerName('invalid&name')).toThrow('Invalid identifier format');
      expect(() => sanitizeDockerName('invalid|name')).toThrow('Invalid identifier format');
    });

    it('throws on empty names', () => {
      expect(() => sanitizeDockerName('')).toThrow('Invalid identifier format');
    });
  });

  describe('buildEnvPatchCommand', () => {
    it('should generate a python script that updates existing keys and appends new ones', () => {
      
      const updates = {
          MODEL: "gpt-4o",
          API_KEY: "sk-12345",
          PROVIDER: ""
      };
      const cmd = ProfileService.buildEnvPatchCommand("/root/.hermes/profiles/test/.env", updates);
      
      expect(cmd).toContain("echo");
      expect(cmd).toContain("base64 -d");
      expect(cmd).toContain("python3");
      expect(cmd).toMatch(/PYTHON_BIN=\/opt\/venv\/bin\/python\nif \[ ! -x "\$PYTHON_BIN" \]; then/);

      // Extract the base64 part and decode it to verify the python payload
      const b64Match = cmd.match(/echo "([^"]+)"/);
      expect(b64Match).not.toBeNull();
      
      const decodedPython = Buffer.from(b64Match![1], "base64").toString("utf-8");
      expect(decodedPython).toContain("import json, re, sys, base64");
      expect(decodedPython).toContain("with open('/root/.hermes/profiles/test/.env', 'r') as f: content = f.read()");
      
      // Extract the payload base64 inside the python script
      const payloadMatch = decodedPython.match(/base64\.b64decode\('([^']+)'\)/);
      expect(payloadMatch).not.toBeNull();
      
      const decodedPayload = Buffer.from(payloadMatch![1], "base64").toString("utf-8");
      const parsedPayload = JSON.parse(decodedPayload);
      
      expect(parsedPayload.MODEL).toBe("gpt-4o");
      expect(parsedPayload.API_KEY).toBe("sk-12345");
      expect(parsedPayload.PROVIDER).toBe("");
    });

    it('falls back to the WebUI agent virtualenv before system python so hermes_cli imports succeed', () => {
      // The Hetzner image ships /opt/venv with httpx; the WebUI image keeps its
      // venv at $HERMES_HOME/hermes-agent/.venv. Without this fallback, the
      // resolver dropped to /usr/local/bin/python3 which lacks httpx and broke
      // every `import hermes_cli.auth` (Nous Portal connect, Codex login, etc.)
      // on Proxmox-backed instances. Lock in the ordering: WebUI venv before
      // the system python fallback.
      const cmd = ProfileService.buildEnvPatchCommand("/root/.hermes/profiles/test/.env", { K: "v" });
      expect(cmd).toContain('HERMES_AGENT_DIR="${HERMES_WEBUI_AGENT_DIR:-${HERMES_HOME:-}/hermes-agent}"');
      expect(cmd).toContain('PYTHON_BIN="$HERMES_AGENT_DIR/.venv/bin/python"');
      expect(cmd.indexOf('PYTHON_BIN="$HERMES_AGENT_DIR/.venv/bin/python"'))
        .toBeLessThan(cmd.indexOf('PYTHON_BIN=$(command -v python3 || command -v python)'));
    });
  });

  describe('buildRemoveWebUIUserPinCommand', () => {
    it('targets only the webui service user pin before forced recreates', () => {
      const cmd = ProfileService.buildRemoveWebUIUserPinCommand(
        "/opt/hermes/instances/inst-1/docker-compose.yml"
      );

      expect(cmd).toContain("removed_webui_user_pin_check=starting");
      expect(cmd).toContain("base64 -d");

      const b64Matches = Array.from(cmd.matchAll(/echo "([A-Za-z0-9+/=]+)"/g));
      expect(b64Matches.length).toBeGreaterThan(0);
      const decodedPython = Buffer.from(b64Matches.at(-1)![1], "base64").toString("utf-8");

      expect(decodedPython).toContain('compose_path = Path("/opt/hermes/instances/inst-1/docker-compose.yml")');
      expect(decodedPython).toContain('current_service == "webui"');
      expect(decodedPython).toContain('user: "1024:1024"');
      expect(decodedPython).toContain("removed_webui_user_pin=");
      expect(decodedPython).not.toContain('current_service == "sidecar"');
    });
  });

  describe('getHermesHomeForInstance', () => {
    it('resolves the non-root runtime home from instance config', async () => {
      const { supabaseAdmin } = await import('@/lib/supabase');
      (supabaseAdmin!.from as jest.Mock).mockReturnValue({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({
          data: {
            config: {
              agentSettings: {
                enableRootAccess: false,
              },
            },
          },
        }),
      });

      await expect(ProfileService.getHermesHomeForInstance('inst_123', 'user_123')).resolves.toBe('/opt/data');
    });
  });
});

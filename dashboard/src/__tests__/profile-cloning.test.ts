import { ProfileService } from '../lib/services/profile-service';
import { sshExec } from '../lib/hetzner/ssh';

// Setup basic mocks
jest.mock('../lib/supabase', () => ({
  supabaseAdmin: {
    from: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    not: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: { id: 'mock-id', gateway_port: 8650 }, error: null })
  }
}));

jest.mock('../lib/hetzner/ssh', () => ({
  sshExec: jest.fn().mockResolvedValue({ ok: true, stdout: '', stderr: '' })
}));

describe('ProfileService Configuration Injection', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeAll(() => {
    originalEnv = process.env;
    process.env = { ...originalEnv, SUPABASE_SERVICE_ROLE_KEY: 'test', NEXT_PUBLIC_SUPABASE_URL: 'https://test' };

    // Mock internal helpers
    jest.spyOn(ProfileService, 'getGuestSshForInstance').mockResolvedValue({ ip: '203.0.113.4', guestTarget: null });
    // @ts-expect-error Mocking private static
    jest.spyOn(ProfileService, 'allocatePort').mockResolvedValue(8650);
    jest.spyOn(ProfileService, 'startProfileGateway').mockResolvedValue(undefined);
  });

  afterAll(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('skips .env overwrite if we are cloning and NO provider overrides are passed', async () => {
    await ProfileService.createProfile('inst-1', 'user-1', {
      name: 'cloned-agent',
      cloneFrom: 'default',
    });

    const sshCalls = (sshExec as jest.Mock).mock.calls;
    const injectCall = sshCalls.find(call => typeof call[1] === 'string' && call[1].includes('docker exec -i agent-inst-1 sh'));
    
    expect(injectCall).toBeDefined();
    
    // We decode the entire script that gets piped to sh
    const rawInjectScriptMatch = injectCall[1].match(/echo "(.*?)" \| base64 -d \| docker/);
    if (rawInjectScriptMatch) {
      const decodedScript = Buffer.from(rawInjectScriptMatch[1], 'base64').toString('utf-8');
      expect(decodedScript).not.toContain('>.env');
      expect(decodedScript).not.toContain('> "$profile_dir/.env"');
    }
  });

  it('writes a fresh .env if NOT cloning', async () => {
    await ProfileService.createProfile('inst-1', 'user-1', {
      name: 'new-agent',
      provider: 'openrouter',
      apiKey: 'sk-123'
    });

    const sshCalls = (sshExec as jest.Mock).mock.calls;
    const injectCall = sshCalls.find(call => typeof call[1] === 'string' && call[1].includes('docker exec -i agent-inst-1 sh'));
    
    expect(injectCall).toBeDefined();
    
    const rawInjectScriptMatch = injectCall[1].match(/echo "(.*?)" \| base64 -d \| docker/);
    if (rawInjectScriptMatch) {
      const decodedScript = Buffer.from(rawInjectScriptMatch[1], 'base64').toString('utf-8');
      expect(decodedScript).toContain('"$profile_dir/.env"');
      
      // we need to base64 decode the injected .env string directly to verify its contents
      const envEchoMatch = decodedScript.match(/echo "(.*?)" \| base64 -d > "\$profile_dir\/\.env"/);
      expect(envEchoMatch).toBeDefined();
      if (envEchoMatch) {
        const decodedEnv = Buffer.from(envEchoMatch[1], 'base64').toString('utf-8');
        expect(decodedEnv).toContain('HERMES_INFERENCE_PROVIDER=openrouter');
      }
    }
  });
});

import { ProfileService } from '../profile-service';
import { supabaseAdmin } from '@/lib/supabase';
import { sshExec } from '@/lib/hetzner/ssh';

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

function decodeEnvUpdatesFromCreateProfileInjectCall(): Record<string, string> {
  const injectCall = (sshExec as jest.Mock).mock.calls.find(call =>
    call[1].includes('docker exec -i agent-inst_123 sh') && !call[1].includes('hermes profile create')
  );
  expect(injectCall).toBeDefined();

  const injectedScriptEncoded = injectCall[1].match(/echo "([^"]+)" \| base64 -d/)[1];
  const decodedScript = Buffer.from(injectedScriptEncoded, 'base64').toString('utf-8');
  const envPatchEncoded = decodedScript.match(/echo "([^"]+)" \| base64 -d \| "\$PYTHON_BIN"/);
  expect(envPatchEncoded).not.toBeNull();
  const envPatchScript = Buffer.from(envPatchEncoded![1], 'base64').toString('utf-8');
  const updatesMatch = envPatchScript.match(/base64\.b64decode\('([^']+)'\)/);
  expect(updatesMatch).not.toBeNull();
  return JSON.parse(Buffer.from(updatesMatch![1], 'base64').toString('utf-8')) as Record<string, string>;
}

describe('ProfileService.createProfile', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('injects symlink logic when linkUserMd is true', async () => {
    // Mock getHostIpForInstance
    jest.spyOn(ProfileService, 'getGuestSshForInstance').mockResolvedValue({ ip: '127.0.0.1', guestTarget: null });
    jest.spyOn(ProfileService, 'getHermesHomeForInstance').mockResolvedValue('/opt/data');
    // @ts-expect-error - Mocking private method allocatePort
    jest.spyOn(ProfileService, 'allocatePort').mockResolvedValue(8001);
    jest.spyOn(ProfileService, 'startProfileGateway').mockResolvedValue(undefined);

    const mockSingle = jest.fn().mockResolvedValue({ data: { id: 'test_id', name: 'my_agent' } });
    const mockEqChain = jest.fn().mockImplementation(() => ({ eq: mockEqChain, single: mockSingle }));
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEqChain, single: mockSingle });
    const mockInsert = jest.fn().mockReturnValue({ select: mockSelect });
    const mockEq = jest.fn().mockResolvedValue({ data: null, error: null });
    const mockDelete = jest.fn().mockReturnValue({ eq: mockEq });

    (supabaseAdmin!.from as jest.Mock).mockReturnValue({
      insert: mockInsert,
      delete: mockDelete,
      select: mockSelect,
    });

    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: '', stderr: '' });

    await ProfileService.createProfile('inst_123', 'user_123', {
      name: 'my_agent',
      linkUserMd: true
    });

    // We expect the 2nd call to sshExec to be the config injector script
    // The exact CLI invocation should be something like this:
    const injectCall = (sshExec as jest.Mock).mock.calls.find(call => 
      call[1].includes('docker exec -i agent-inst_123 sh') && !call[1].includes('hermes profile create')
    );
    expect(injectCall).toBeDefined();

    const injectedScriptEncoded = injectCall[1].match(/echo "([^"]+)" \| base64 -d/)[1];
    const decodedScript = Buffer.from(injectedScriptEncoded, 'base64').toString('utf-8');

    expect(decodedScript).toContain('rm -f "$profile_dir/memories/USER.md"');
    expect(decodedScript).toContain('ln -s "/opt/data/memories/USER.md" "$profile_dir/memories/USER.md"');
    
    // Ensure we don't accidentally touch the USER.md directly in link mode
    expect(decodedScript).not.toContain('touch "$profile_dir/memories/USER.md"');
  });

  it('injects isolated files logic when linkUserMd is false', async () => {
    jest.spyOn(ProfileService, 'getGuestSshForInstance').mockResolvedValue({ ip: '127.0.0.1', guestTarget: null });
    jest.spyOn(ProfileService, 'getHermesHomeForInstance').mockResolvedValue('/opt/data');
    // @ts-expect-error - Mocking private method allocatePort
    jest.spyOn(ProfileService, 'allocatePort').mockResolvedValue(8001);
    jest.spyOn(ProfileService, 'startProfileGateway').mockResolvedValue(undefined);

    const mockSingle = jest.fn().mockResolvedValue({ data: { id: 'test_id', name: 'my_agent' } });
    const mockEqChain = jest.fn().mockImplementation(() => ({ eq: mockEqChain, single: mockSingle }));
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEqChain, single: mockSingle });
    const mockInsert = jest.fn().mockReturnValue({ select: mockSelect });
    const mockEq = jest.fn().mockResolvedValue({ data: null, error: null });
    const mockDelete = jest.fn().mockReturnValue({ eq: mockEq });

    (supabaseAdmin!.from as jest.Mock).mockReturnValue({
      insert: mockInsert,
      delete: mockDelete,
      select: mockSelect,
    });

    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: '', stderr: '' });

    await ProfileService.createProfile('inst_123', 'user_123', {
      name: 'my_agent',
      linkUserMd: false
    });

    const injectCall = (sshExec as jest.Mock).mock.calls.find(call => 
      call[1].includes('docker exec -i agent-inst_123 sh') && !call[1].includes('hermes profile create')
    );
    expect(injectCall).toBeDefined();

    const injectedScriptEncoded = injectCall[1].match(/echo "([^"]+)" \| base64 -d/)[1];
    const decodedScript = Buffer.from(injectedScriptEncoded, 'base64').toString('utf-8');

    // We should be touching the user md directly to initialize it empty
    expect(decodedScript).toContain('touch "$profile_dir/memories/USER.md"');
    expect(decodedScript).not.toContain('ln -s');
  });

  it('patches the real profile env path when cloning with overrides', async () => {
    jest.spyOn(ProfileService, 'getGuestSshForInstance').mockResolvedValue({ ip: '127.0.0.1', guestTarget: null });
    jest.spyOn(ProfileService, 'getHermesHomeForInstance').mockResolvedValue('/opt/data');
    // @ts-expect-error - Mocking private method allocatePort
    jest.spyOn(ProfileService, 'allocatePort').mockResolvedValue(8001);
    jest.spyOn(ProfileService, 'startProfileGateway').mockResolvedValue(undefined);

    const mockSingle = jest.fn().mockResolvedValue({ data: { id: 'test_id', name: 'my_agent' } });
    const mockEqChain = jest.fn().mockImplementation(() => ({ eq: mockEqChain, single: mockSingle }));
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEqChain, single: mockSingle });
    const mockInsert = jest.fn().mockReturnValue({ select: mockSelect });
    const mockEq = jest.fn().mockResolvedValue({ data: null, error: null });
    const mockDelete = jest.fn().mockReturnValue({ eq: mockEq });

    (supabaseAdmin!.from as jest.Mock).mockReturnValue({
      insert: mockInsert,
      delete: mockDelete,
      select: mockSelect,
    });

    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: '', stderr: '' });

    await ProfileService.createProfile('inst_123', 'user_123', {
      name: 'my_agent',
      cloneFrom: 'default',
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-5.4'
    });

    const injectCall = (sshExec as jest.Mock).mock.calls.find(call =>
      call[1].includes('docker exec -i agent-inst_123 sh') && !call[1].includes('hermes profile create')
    );
    expect(injectCall).toBeDefined();

    const injectedScriptEncoded = injectCall[1].match(/echo "([^"]+)" \| base64 -d/)[1];
    const decodedScript = Buffer.from(injectedScriptEncoded, 'base64').toString('utf-8');
    const envPatchEncoded = decodedScript.match(/echo "([^"]+)" \| base64 -d \| "\$PYTHON_BIN"/);
    expect(envPatchEncoded).not.toBeNull();
    const envPatchScript = Buffer.from(envPatchEncoded![1], 'base64').toString('utf-8');

    expect(envPatchScript).toContain("with open('/opt/data/profiles/my_agent/.env', 'r') as f: content = f.read()");
    expect(envPatchScript).not.toContain("with open('$profile_dir/.env'");
  });

  it('creates profiles using the resolved Hermes binary instead of assuming PATH', async () => {
    jest.spyOn(ProfileService, 'getGuestSshForInstance').mockResolvedValue({ ip: '127.0.0.1', guestTarget: null });
    jest.spyOn(ProfileService, 'getHermesHomeForInstance').mockResolvedValue('/opt/data');
    // @ts-expect-error - Mocking private method allocatePort
    jest.spyOn(ProfileService, 'allocatePort').mockResolvedValue(8001);
    jest.spyOn(ProfileService, 'startProfileGateway').mockResolvedValue(undefined);

    const mockSingle = jest.fn().mockResolvedValue({ data: { id: 'test_id', name: 'my_agent' } });
    const mockEqChain = jest.fn().mockImplementation(() => ({ eq: mockEqChain, single: mockSingle }));
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEqChain, single: mockSingle });
    const mockInsert = jest.fn().mockReturnValue({ select: mockSelect });
    const mockEq = jest.fn().mockResolvedValue({ data: null, error: null });
    const mockDelete = jest.fn().mockReturnValue({ eq: mockEq });

    (supabaseAdmin!.from as jest.Mock).mockReturnValue({
      insert: mockInsert,
      delete: mockDelete,
      select: mockSelect,
    });

    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: '', stderr: '' });

    await ProfileService.createProfile('inst_123', 'user_123', {
      name: 'my_agent',
      linkUserMd: false
    });

    const createCall = (sshExec as jest.Mock).mock.calls.find(call =>
      typeof call[1] === 'string' &&
      call[1].includes('docker exec agent-inst_123 sh -lc') &&
      call[1].includes('safe_name = "my_agent"')
    );
    expect(createCall).toBeDefined();
    expect(createCall[1]).toContain('docker exec agent-inst_123 sh -lc');
    expect(createCall[1]).toContain('PYTHON_BIN=/opt/venv/bin/python');
    expect(createCall[1]).toContain('cmd = [hermes_bin, "profile", "create", safe_name]');
    expect(createCall[1]).not.toContain('docker exec agent-inst_123 hermes profile create');
  });

  it("patches cloned env files with the resolved python binary instead of assuming python3", () => {
    const patchCommand = ProfileService.buildEnvPatchCommand("/opt/data/profiles/my_agent/.env", {
      MODEL: "gpt-5.4",
    });

    expect(patchCommand).toContain('PYTHON_BIN=/opt/venv/bin/python');
    expect(patchCommand).toContain('PYTHON_BIN=$(command -v python3 || command -v python)');
    expect(patchCommand).toContain('| base64 -d | "$PYTHON_BIN"');
    expect(patchCommand).not.toContain("| base64 -d | python3");
  });

  it("clears stale provider env vars when cloning with a different provider", async () => {
    jest.spyOn(ProfileService, 'getGuestSshForInstance').mockResolvedValue({ ip: '127.0.0.1', guestTarget: null });
    jest.spyOn(ProfileService, 'getHermesHomeForInstance').mockResolvedValue('/opt/data');
    // @ts-expect-error - Mocking private method allocatePort
    jest.spyOn(ProfileService, 'allocatePort').mockResolvedValue(8001);
    jest.spyOn(ProfileService, 'startProfileGateway').mockResolvedValue(undefined);

    const mockSingle = jest.fn().mockResolvedValue({ data: { id: 'test_id', name: 'my_agent' } });
    const mockEqChain = jest.fn().mockImplementation(() => ({ eq: mockEqChain, single: mockSingle }));
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEqChain, single: mockSingle });
    const mockInsert = jest.fn().mockReturnValue({ select: mockSelect });
    const mockEq = jest.fn().mockResolvedValue({ data: null, error: null });
    const mockDelete = jest.fn().mockReturnValue({ eq: mockEq });

    (supabaseAdmin!.from as jest.Mock).mockReturnValue({
      insert: mockInsert,
      delete: mockDelete,
      select: mockSelect,
    });

    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: '', stderr: '' });

    await ProfileService.createProfile('inst_123', 'user_123', {
      name: 'my_agent',
      cloneFrom: 'default',
      provider: 'crof',
      apiKey: 'nahcrof_test',
      model: 'glm-5.1-precision'
    });

    const injectCall = (sshExec as jest.Mock).mock.calls.find(call =>
      call[1].includes('docker exec -i agent-inst_123 sh') && !call[1].includes('hermes profile create')
    );
    expect(injectCall).toBeDefined();

    const injectedScriptEncoded = injectCall[1].match(/echo "([^"]+)" \| base64 -d/)[1];
    const decodedScript = Buffer.from(injectedScriptEncoded, 'base64').toString('utf-8');
    const envPatchEncoded = decodedScript.match(/echo "([^"]+)" \| base64 -d \| "\$PYTHON_BIN"/);
    expect(envPatchEncoded).not.toBeNull();
    const envPatchScript = Buffer.from(envPatchEncoded![1], 'base64').toString('utf-8');
    const updatesMatch = envPatchScript.match(/base64\.b64decode\('([^']+)'\)/);
    expect(updatesMatch).not.toBeNull();
    const envUpdates = JSON.parse(Buffer.from(updatesMatch![1], 'base64').toString('utf-8')) as Record<string, string>;

    expect(envPatchScript).toContain("updates = json.loads");
    expect(envUpdates.DASHSCOPE_API_KEY).toBe("");
    expect(envUpdates.DASHSCOPE_BASE_URL).toBe("");
    expect(envUpdates.OPENAI_API_KEY).toBe("nahcrof_test");
  });

  it("keeps auth-store provider runtime env when cloning without an API key", async () => {
    jest.spyOn(ProfileService, 'getGuestSshForInstance').mockResolvedValue({ ip: '127.0.0.1', guestTarget: null });
    jest.spyOn(ProfileService, 'getHermesHomeForInstance').mockResolvedValue('/opt/data');
    // @ts-expect-error - Mocking private method allocatePort
    jest.spyOn(ProfileService, 'allocatePort').mockResolvedValue(8001);
    jest.spyOn(ProfileService, 'startProfileGateway').mockResolvedValue(undefined);

    const mockSingle = jest.fn().mockResolvedValue({ data: { id: 'test_id', name: 'my_agent' } });
    const mockEqChain = jest.fn().mockImplementation(() => ({ eq: mockEqChain, single: mockSingle }));
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEqChain, single: mockSingle });
    const mockInsert = jest.fn().mockReturnValue({ select: mockSelect });
    const mockEq = jest.fn().mockResolvedValue({ data: null, error: null });
    const mockDelete = jest.fn().mockReturnValue({ eq: mockEq });

    (supabaseAdmin!.from as jest.Mock).mockReturnValue({
      insert: mockInsert,
      delete: mockDelete,
      select: mockSelect,
    });

    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: '', stderr: '' });

    await ProfileService.createProfile('inst_123', 'user_123', {
      name: 'my_agent',
      cloneFrom: 'default',
      provider: 'nous-portal',
      model: 'nousresearch/hermes-3-llama-3.1-70b',
    });

    const envUpdates = decodeEnvUpdatesFromCreateProfileInjectCall();

    expect(envUpdates.PROVIDER).toBe('custom');
    expect(envUpdates.LLM_PROVIDER).toBe('custom');
    expect(envUpdates.HERMES_INFERENCE_PROVIDER).toBe('custom');
    expect(envUpdates.OPENAI_BASE_URL).toBe('https://inference-api.nousresearch.com/v1');
    expect(envUpdates.OPENAI_API_KEY).toBe('');
  });

  it("surfaces rollback failures when profile creation cleanup cannot delete the record", async () => {
    jest.spyOn(ProfileService, "getGuestSshForInstance").mockResolvedValue({ ip: "127.0.0.1", guestTarget: null });
    jest.spyOn(ProfileService, "getHermesHomeForInstance").mockResolvedValue("/opt/data");
    // @ts-expect-error - Mocking private method allocatePort
    jest.spyOn(ProfileService, "allocatePort").mockResolvedValue(8001);
    jest
      .spyOn(ProfileService, "startProfileGateway")
      .mockRejectedValue(new Error("gateway failed to start"));

    const mockSingle = jest.fn().mockResolvedValue({ data: { id: "test_id", name: "my_agent" }, error: null });
    const mockEqChain = jest.fn().mockImplementation(() => ({ eq: mockEqChain, single: mockSingle }));
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEqChain, single: mockSingle });
    const mockInsert = jest.fn().mockReturnValue({ select: mockSelect });
    const mockRollbackEq = jest.fn().mockResolvedValue({ error: { message: "db unavailable" } });
    const mockDelete = jest.fn().mockReturnValue({ eq: mockRollbackEq });

    (supabaseAdmin!.from as jest.Mock).mockReturnValue({
      insert: mockInsert,
      delete: mockDelete,
      select: mockSelect,
    });

    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: "", stderr: "" });

    await expect(
      ProfileService.createProfile("inst_123", "user_123", {
        name: "my_agent",
        linkUserMd: false,
      })
    ).rejects.toThrow(
      "Profile creation failed: gateway failed to start. Rollback failed to delete profile record."
    );

    expect(mockDelete).toHaveBeenCalled();
    expect(mockRollbackEq).toHaveBeenCalledWith("id", "test_id");
  });

  it("stops gateways using the resolved Hermes binary instead of assuming PATH", async () => {
    jest.spyOn(ProfileService, "getGuestSshForInstance").mockResolvedValue({ ip: "127.0.0.1", guestTarget: null });
    jest.spyOn(ProfileService, "getHermesHomeForInstance").mockResolvedValue("/opt/data");
    jest.spyOn(ProfileService, "updateAgentCaddyRouting").mockResolvedValue(undefined);

    // stopProfileGateway resolves the profile row (and its gateway_port) before
    // it will touch the box — see the fail-closed guard added for the
    // profile-lane Caddyfile clobber.
    const mockLookup = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { id: "prof_123", gateway_port: 8651 },
        error: null,
      }),
    };

    const mockEqSecond = jest.fn().mockResolvedValue({ data: null, error: null });
    const mockEqFirst = jest.fn().mockReturnValue({ eq: mockEqSecond });
    const mockUpdate = jest.fn().mockReturnValue({ eq: mockEqFirst });
    (supabaseAdmin!.from as jest.Mock)
      .mockReturnValueOnce(mockLookup)
      .mockReturnValueOnce({ update: mockUpdate });

    (sshExec as jest.Mock).mockResolvedValue({ ok: true, stdout: "", stderr: "" });

    await ProfileService.stopProfileGateway("inst_123", "user_123", "my_agent");

    const stopCall = (sshExec as jest.Mock).mock.calls.find((call) =>
      typeof call[1] === "string" && call[1].includes("gateway stop")
    );
    expect(stopCall).toBeDefined();
    expect(stopCall[1]).toContain('HERMES_BIN=/opt/venv/bin/hermes');
    expect(stopCall[1]).toContain('"$HERMES_BIN" -p my_agent gateway stop || true');
    expect(stopCall[1]).not.toContain("\n  hermes -p my_agent gateway stop || true");
  });

  it('redacts secrets when profile config injection writes fail', async () => {
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    jest.spyOn(ProfileService, 'getGuestSshForInstance').mockResolvedValue({ ip: '127.0.0.1', guestTarget: null });
    jest.spyOn(ProfileService, 'getHermesHomeForInstance').mockResolvedValue('/opt/data');
    // @ts-expect-error - Mocking private method allocatePort
    jest.spyOn(ProfileService, 'allocatePort').mockResolvedValue(8001);
    jest.spyOn(ProfileService, 'startProfileGateway').mockResolvedValue(undefined);

    const mockSingle = jest.fn().mockResolvedValue({ data: { id: 'test_id', name: 'my_agent' } });
    const mockEqChain = jest.fn().mockImplementation(() => ({ eq: mockEqChain, single: mockSingle }));
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEqChain, single: mockSingle });
    const mockInsert = jest.fn().mockReturnValue({ select: mockSelect });
    const mockEq = jest.fn().mockResolvedValue({ data: null, error: null });
    const mockDelete = jest.fn().mockReturnValue({ eq: mockEq });

    (supabaseAdmin!.from as jest.Mock).mockReturnValue({
      insert: mockInsert,
      delete: mockDelete,
      select: mockSelect,
    });

    (sshExec as jest.Mock)
      .mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ ok: false, stdout: '', stderr: 'client_secret=super-secret' });

    await ProfileService.createProfile('inst_123', 'user_123', {
      name: 'my_agent',
      linkUserMd: false,
    });

    const consoleOutput = stringifyMockCalls(consoleWarnSpy);
    expect(consoleOutput).toContain('[REDACTED]');
    expect(consoleOutput).not.toContain('super-secret');

    consoleWarnSpy.mockRestore();
  });
});

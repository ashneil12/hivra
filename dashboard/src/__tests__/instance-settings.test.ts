import {
  DEFAULT_AUTO_UPDATE_ENABLED,
  DEFAULT_AUTO_UPDATE_TIME,
  buildStoredInstanceConfig,
  getAutoUpdateConfig,
  getRuntimeAgentSettings,
  getPublicInstanceConfig,
  buildAdvancedInstanceConfigPayload,
} from '../lib/instance-settings';

// Mock the crypto lib to return deterministic static strings instead of actual AES
jest.mock('../lib/crypto', () => ({
  encryptApiKey: (val: string) => `enc_${val}`,
  decryptApiKey: (val: string) => val.startsWith('enc_') ? val.substring(4) : val,
}));

describe('instance-settings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('buildStoredInstanceConfig properly encrypts known keys and drops plain versions', () => {
    const patch = {
      agentSettings: {
        browserbaseApiKey: 'plain_bb_key',
        tavilyApiKey: 'plain_tav_key',
        exaApiKey: 'plain_exa_key'
      }
    };
    const result = buildStoredInstanceConfig({}, patch as Record<string, unknown>);

    expect(result.agentSettings?.browserbaseApiKey).toBeUndefined();
    expect(result.agentSettings?.tavilyApiKey).toBeUndefined();
    expect(result.agentSettings?.exaApiKey).toBeUndefined();

    expect(result.agentSettings?.browserbaseApiKeyEncrypted).toBe('enc_plain_bb_key');
    expect(result.agentSettings?.tavilyApiKeyEncrypted).toBe('enc_plain_tav_key');
    expect(result.agentSettings?.exaApiKeyEncrypted).toBe('enc_plain_exa_key');
  });

  it('processes clear flags correctly', () => {
    const current = {
      agentSettings: {
        browserbaseApiKeyEncrypted: 'enc_old_key',
        browserbaseApiKey: 'leak_old_key',
      }
    };
    const patch = { secretOps: { clearBrowserbaseApiKey: true } };

    const result = buildStoredInstanceConfig(current, patch as Record<string, unknown>);
    expect(result.agentSettings?.browserbaseApiKey).toBeUndefined();
    expect(result.agentSettings?.browserbaseApiKeyEncrypted).toBeUndefined();
  });

  it('clears encrypted memory-system secrets when the UI sends an explicit empty value', () => {
    const current = {
      memorySystem: {
        provider: 'honcho',
        honchoApiKeyEncrypted: 'enc_old_honcho_key',
        honchoBaseUrl: 'https://honcho.example',
      },
    };

    const result = buildStoredInstanceConfig(current as Record<string, unknown>, {
      memorySystem: {
        provider: 'honcho',
        honchoApiKey: '',
      },
    });

    expect(result.memorySystem?.honchoApiKey).toBeUndefined();
    expect(result.memorySystem?.honchoApiKeyEncrypted).toBeUndefined();
    expect(result.memorySystem?.honchoBaseUrl).toBe('https://honcho.example');
  });

  it('encrypts and hides Supermemory secrets while preserving public-safe flags', () => {
    const stored = buildStoredInstanceConfig({}, {
      memorySystem: {
        provider: 'supermemory',
        supermemoryApiKey: 'sm_secret_key',
        supermemoryContainerTag: 'workspace-alpha',
      },
    } as Record<string, unknown>);

    expect(stored.memorySystem?.supermemoryApiKey).toBeUndefined();
    expect(stored.memorySystem?.supermemoryApiKeyEncrypted).toBe('enc_sm_secret_key');
    expect(stored.memorySystem?.supermemoryContainerTag).toBe('workspace-alpha');

    const pub = getPublicInstanceConfig(stored as Record<string, unknown>);
    const memorySystem = pub.memorySystem as unknown as Record<string, unknown>;

    expect(memorySystem.supermemoryApiKey).toBeUndefined();
    expect(memorySystem.supermemoryApiKeyEncrypted).toBeUndefined();
    expect(memorySystem.hasSupermemoryApiKey).toBe(true);
    expect(memorySystem.supermemoryContainerTag).toBe('workspace-alpha');
  });

  it('getRuntimeAgentSettings reconstructs the mapped keys correctly', () => {
    const currentConfig = {
      agentSettings: {
        maxIterations: 100,
        browserbaseApiKeyEncrypted: 'enc_bb123',
        webUseGateway: true,
        runtimeMode: 'developer',
      }
    };

    const runtime = getRuntimeAgentSettings(currentConfig as Record<string, unknown>);
    expect(runtime.maxIterations).toBe(100);
    expect(runtime.runtimeMode).toBe('developer');
    expect(runtime.mountPersistentSource).toBe(false);
    expect(runtime.browserbaseApiKey).toBe('bb123');
    expect(runtime.webUseGateway).toBe(true);
    expect(runtime.imageGenUseGateway).toBe(false);
    expect(runtime.tavilyApiKey).toBeUndefined();
    expect(runtime.exaApiKey).toBeUndefined();
  });

  it('hides tool calls in chat by default while preserving explicit opt-in', () => {
    expect(getRuntimeAgentSettings(undefined).showToolCallsInChat).toBe(false);

    const visibleRuntime = getRuntimeAgentSettings({
      agentSettings: {
        showToolCallsInChat: true,
      },
    });

    expect(visibleRuntime.showToolCallsInChat).toBe(true);
  });

  it('buildAdvancedInstanceConfigPayload preserves runtimeMode', () => {
    const result = buildAdvancedInstanceConfigPayload({}, {
      agentSettings: {
        runtimeMode: 'developer',
      },
    });

    expect(result.agentSettings?.runtimeMode).toBe('developer');
    expect(result.agentSettings?.mountPersistentSource).toBe(false);
  });

  it('preserves root access independently from runtime mode', () => {
    const stored = buildStoredInstanceConfig({}, {
      agentSettings: {
        runtimeMode: 'managed',
        enableRootAccess: true,
        mountPersistentSource: false,
      },
    });

    const runtime = getRuntimeAgentSettings(stored as Record<string, unknown>);

    expect(runtime.runtimeMode).toBe('managed');
    expect(runtime.enableRootAccess).toBe(true);
    expect(runtime.mountPersistentSource).toBe(false);
  });

  it('getPublicInstanceConfig correctly hides keys and sets boolean flags', () => {
    const currentConfig = {
      agentSettings: {
        browserbaseApiKeyEncrypted: 'enc_bb123',
      }
    };

    const pub = getPublicInstanceConfig(currentConfig as Record<string, unknown>);
    expect(pub.agentSettings?.browserbaseApiKey).toBeUndefined();
    expect(pub.agentSettings?.browserbaseApiKeyEncrypted).toBeUndefined();
    expect((pub.agentSettings as Record<string, unknown>).hasBrowserbaseApiKey).toBe(true);
    expect((pub.agentSettings as Record<string, unknown>).hasTavilyApiKey).toBe(false);
    expect((pub.agentSettings as Record<string, unknown>).hasExaApiKey).toBe(false);
  });

  it('normalizes auto-update settings and keeps them public-safe', () => {
    const stored = buildStoredInstanceConfig({}, {
      autoUpdate: {
        enabled: true,
        time: ' 03:45 ',
      },
    });

    expect(stored.autoUpdate).toEqual({
      enabled: true,
      time: '03:45',
    });

    const pub = getPublicInstanceConfig(stored as Record<string, unknown>);
    expect(pub.autoUpdate).toEqual({
      enabled: true,
      time: '03:45',
    });
  });

  it('falls back to the default auto-update time for missing or invalid values', () => {
    const stored = buildStoredInstanceConfig(
      {
        autoUpdate: {
          enabled: true,
          time: '99:99',
        },
      } as Record<string, unknown>,
      {}
    );

    expect(stored.autoUpdate).toEqual({
      enabled: true,
      time: DEFAULT_AUTO_UPDATE_TIME,
    });
    expect(getAutoUpdateConfig(undefined)).toEqual({
      enabled: DEFAULT_AUTO_UPDATE_ENABLED,
      time: DEFAULT_AUTO_UPDATE_TIME,
    });
  });

  it('A2A settings are cleanly merged and retained', () => {
    const currentConfig = { a2a: { enableAcp: true } };
    const patch = { a2a: { enableMcp: true } };
    const result = buildStoredInstanceConfig(currentConfig as Record<string, unknown>, patch as Record<string, unknown>);
    expect(result.a2a?.enableAcp).toBe(true);
    expect(result.a2a?.enableMcp).toBe(true);
  });

  it('A2A settings remain intact if patch omits them', () => {
    const currentConfig = { a2a: { enableAcp: true } };
    const patch = {};
    const result = buildStoredInstanceConfig(currentConfig as Record<string, unknown>, patch as Record<string, unknown>);
    expect(result.a2a?.enableAcp).toBe(true);
    expect(result.a2a?.enableMcp).toBeUndefined();
  });

  // ── Browser proxy credential tests ───────────────────────────────────────

  describe('browser proxy credentials', () => {
    it('encrypts browserProxyPassword at rest and removes plaintext', () => {
      const patch = {
        agentSettings: {
          browserProxyHost: 'proxy.example.com',
          browserProxyPort: '8080',
          browserProxyUsername: 'user1',
          browserProxyPassword: 'secret123',
        },
      };

      const result = buildStoredInstanceConfig({}, patch as Record<string, unknown>);

      // Plaintext must not be persisted
      expect(result.agentSettings?.browserProxyPassword).toBeUndefined();
      // Encrypted version must exist
      expect(result.agentSettings?.browserProxyPasswordEncrypted).toBe('enc_secret123');
      // Non-secret fields stored as-is
      expect(result.agentSettings?.browserProxyHost).toBe('proxy.example.com');
      expect(result.agentSettings?.browserProxyPort).toBe('8080');
      expect(result.agentSettings?.browserProxyUsername).toBe('user1');
    });

    it('getRuntimeAgentSettings decrypts browserProxyPassword correctly', () => {
      const config = {
        agentSettings: {
          browserProxyHost: 'proxy.example.com',
          browserProxyPort: '3128',
          browserProxyUsername: 'proxyuser',
          browserProxyPasswordEncrypted: 'enc_mysecret',
        },
      };

      const runtime = getRuntimeAgentSettings(config as Record<string, unknown>);

      expect(runtime.browserProxyHost).toBe('proxy.example.com');
      expect(runtime.browserProxyPort).toBe('3128');
      expect(runtime.browserProxyUsername).toBe('proxyuser');
      expect(runtime.browserProxyPassword).toBe('mysecret');
    });

    it('clearBrowserProxyPassword removes both plaintext and encrypted fields', () => {
      const current = {
        agentSettings: {
          browserProxyHost: 'proxy.example.com',
          browserProxyPasswordEncrypted: 'enc_old_secret',
        },
      };
      const patch = { secretOps: { clearBrowserProxyPassword: true } };

      const result = buildStoredInstanceConfig(
        current as Record<string, unknown>,
        patch as Record<string, unknown>
      );

      expect(result.agentSettings?.browserProxyPassword).toBeUndefined();
      expect(result.agentSettings?.browserProxyPasswordEncrypted).toBeUndefined();
      // Non-secret host field is preserved
      expect(result.agentSettings?.browserProxyHost).toBe('proxy.example.com');
    });

    it('does not expose browserProxyPassword or its encrypted form in public config', () => {
      const config = {
        agentSettings: {
          browserProxyPasswordEncrypted: 'enc_topsecret',
          browserProxyHost: 'proxy.example.com',
        },
      };

      const pub = getPublicInstanceConfig(config as Record<string, unknown>);
      const settings = pub.agentSettings as Record<string, unknown>;

      // Neither should be visible client-side
      expect(settings.browserProxyPassword).toBeUndefined();
      expect(settings.browserProxyPasswordEncrypted).toBeUndefined();
      // Host is safe to expose
      expect(settings.browserProxyHost).toBe('proxy.example.com');
    });

    it('preserves existing encrypted password when no new value is submitted', () => {
      // Simulates user saving settings without re-entering the password field:
      // the UI sends only the host field, no browserProxyPassword key.
      const current = {
        agentSettings: {
          browserProxyHost: 'proxy.example.com',
          browserProxyPasswordEncrypted: 'enc_existing_secret',
        },
      };
      const patch = {
        agentSettings: { browserProxyHost: 'proxy.example.com' },
      };

      const result = buildStoredInstanceConfig(
        current as Record<string, unknown>,
        patch as Record<string, unknown>
      );

      // Existing encrypted password must survive an unrelated save
      expect(result.agentSettings?.browserProxyPasswordEncrypted).toBe('enc_existing_secret');
    });

    it('returns undefined proxy fields when none are configured', () => {
      const config = { agentSettings: { browserProvider: 'browserbase' } };
      const runtime = getRuntimeAgentSettings(config as Record<string, unknown>);

      expect(runtime.browserProxyHost).toBeUndefined();
      expect(runtime.browserProxyPort).toBeUndefined();
      expect(runtime.browserProxyUsername).toBeUndefined();
      expect(runtime.browserProxyPassword).toBeUndefined();
    });
  });

  describe('buildAdvancedInstanceConfigPayload', () => {
    it('correctly maps top-level properties and nests agent settings', () => {
      const patchDto = {
        model: 'gpt-4o',
        agentSettings: {
          browserProvider: 'browserbase',
          browserbaseProjectId: ' proj-123 ',
          webUseGateway: true,
          browserUseGateway: true,
          subagentProvider: ' openrouter ',
        },
        honcho: {
          enabled: true,
          baseUrl: ' http://localhost:1234 ',
        }
      };

      const result = buildAdvancedInstanceConfigPayload({}, patchDto);

      expect(result.model).toBe('gpt-4o');
      expect(result.agentSettings?.browserProvider).toBe('browserbase');
      expect(result.agentSettings?.webUseGateway).toBe(true);
      expect(result.agentSettings?.browserUseGateway).toBe(true);
      
      // Should trim strings
      expect(result.agentSettings?.browserbaseProjectId).toBe('proj-123');
      expect(result.agentSettings?.subagentProvider).toBe('openrouter');
      
      // Honcho settings
      expect(result.honcho?.enabled).toBe(true);
      expect(result.honcho?.baseUrl).toBe('http://localhost:1234');
    });

    it('correctly delegates secretOps via agentSettings', () => {
      const current = {
        agentSettings: {
          browserbaseApiKeyEncrypted: 'enc_old_bb_key'
        }
      };
      
      const patchDto = {
        agentSettings: {
          clearBrowserbaseApiKey: true
        }
      };

      const result = buildAdvancedInstanceConfigPayload(current, patchDto);
      expect(result.agentSettings?.browserbaseApiKey).toBeUndefined();
      expect(result.agentSettings?.browserbaseApiKeyEncrypted).toBeUndefined();
    });

    it('passes canonical OpenRouter model IDs through primary and fallback settings correctly', () => {
      const patchDto = {
        model: 'anthropic/claude-sonnet-4.6',
        agentSettings: {
          subagentProvider: 'openrouter',
          subagentModel: 'openrouter:anthropic/claude-opus-4.6',
          fallbackModels: JSON.stringify([
            { provider: 'openrouter', model: 'anthropic/claude-opus-4.6', apiKey: '' },
          ]),
        },
      };

      const result = buildAdvancedInstanceConfigPayload({}, patchDto);
      expect(result.model).toBe('anthropic/claude-sonnet-4.6');
      expect(result.agentSettings?.subagentModel).toBe('openrouter:anthropic/claude-opus-4.6');
      expect(result.agentSettings?.fallbackModels).toContain('anthropic/claude-opus-4.6');
      expect(result.agentSettings?.fallbackModels).not.toContain('anthropic/claude-opus-4-6-20260205');
    });

    it('carries the welcome-flow systemPrompt through to stored config and back out via getRuntimeAgentSettings', () => {
      // Mirrors the Hermes welcome PATCH: { apply: true, agentSettings: { systemPrompt } }.
      const systemPrompt = 'You are Atlas, a logistics agent.\nAlways confirm before booking.';

      const result = buildAdvancedInstanceConfigPayload({}, {
        agentSettings: { systemPrompt },
      });

      // Persisted into stored config…
      expect(result.agentSettings?.systemPrompt).toBe(systemPrompt);
      // …and surfaced to the runtime/builder unchanged.
      expect(getRuntimeAgentSettings(result as Record<string, unknown>).systemPrompt).toBe(systemPrompt);
    });

    it('allows an empty systemPrompt to clear a previously stored prompt', () => {
      const current = {
        agentSettings: { systemPrompt: 'old prompt' },
      };

      const result = buildAdvancedInstanceConfigPayload(current, {
        agentSettings: { systemPrompt: '' },
      });

      expect(result.agentSettings?.systemPrompt).toBe('');
      expect(getRuntimeAgentSettings(result as Record<string, unknown>).systemPrompt).toBe('');
    });

    it('leaves a stored systemPrompt untouched when the patch omits it', () => {
      const current = {
        agentSettings: { systemPrompt: 'keep me' },
      };

      const result = buildAdvancedInstanceConfigPayload(current, {
        agentSettings: { fastMode: true },
      });

      expect(result.agentSettings?.systemPrompt).toBe('keep me');
      expect(result.agentSettings?.fastMode).toBe(true);
    });

    it('preserves the stored auto-update time when only the enabled flag changes', () => {
      const current = {
        autoUpdate: {
          enabled: true,
          time: '02:15',
        },
      };

      const result = buildAdvancedInstanceConfigPayload(current, {
        autoUpdate: {
          enabled: false,
        },
      });

      expect(result.autoUpdate).toEqual({
        enabled: false,
        time: '02:15',
      });
    });
  });
});

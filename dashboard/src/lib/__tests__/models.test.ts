import {
  FEATURED_PROVIDER_ID,
  getFeaturedProvider,
  getOverflowProviders,
  getQuickSelectProviders,
  inferProviderFromModel,
  isModelValidForProvider,
  normalizeModelValue,
  PROVIDERS,
  reconcileModelProvider,
  VISIBLE_PROVIDERS,
} from '../models';

describe('models.ts', () => {
  describe('inferProviderFromModel', () => {
    it('should infer openrouter provider', () => {
      expect(inferProviderFromModel('openai/gpt-5.4')).toBe('openrouter');
      expect(inferProviderFromModel('google/gemini-2.5-pro')).toBe('openrouter');
    });

    it('should infer codex provider', () => {
      expect(inferProviderFromModel('gpt-5.5')).toBe('codex');
    });

    it('should infer codex provider for shared models since it is higher in the array', () => {
      expect(inferProviderFromModel('gpt-5.4-mini')).toBe('codex');
    });

    it('should infer venice provider for Venice-specific models', () => {
      expect(inferProviderFromModel('kimi-k2-6')).toBe('venice');
      expect(inferProviderFromModel('zai-org-glm-5')).toBe('venice');
      expect(inferProviderFromModel('venice-uncensored-1-2')).toBe('venice');
    });

    it('should infer crof for glm-5.1-precision', () => {
      expect(inferProviderFromModel('glm-5.1-precision')).toBe('crof');
      expect(inferProviderFromModel('kimi-k2.6-precision')).toBe('crof');
    });

    it('should infer moonshot and openrouter for Kimi K2.6 model IDs', () => {
      expect(inferProviderFromModel('kimi-k2.6')).toBe('moonshot');
      expect(inferProviderFromModel('moonshotai/kimi-k2.6')).toBe('openrouter');
    });

    it('should return null for unknown models', () => {
      expect(inferProviderFromModel('unknown-model')).toBeNull();
    });

    it('should infer openrouter for canonical Claude 4.6 OR model IDs', () => {
      expect(inferProviderFromModel('anthropic/claude-opus-4.6')).toBe('openrouter');
      expect(inferProviderFromModel('anthropic/claude-sonnet-4.6')).toBe('openrouter');
    });

    it('should infer openrouter for canonical Claude Opus 4.7 OR model ID', () => {
      expect(inferProviderFromModel('anthropic/claude-opus-4.7')).toBe('openrouter');
    });

    it('should infer anthropic for stale direct Anthropic snapshot IDs after normalization', () => {
      expect(inferProviderFromModel('claude-opus-4-1-20250805')).toBe('anthropic');
      expect(inferProviderFromModel('claude-sonnet-4-20250514')).toBe('anthropic');
    });
  });

  describe('normalizeModelValue', () => {
    it('should pass canonical OpenRouter Claude 4.6 IDs through unchanged', () => {
      expect(normalizeModelValue('anthropic/claude-opus-4.6', 'openrouter')).toBe('anthropic/claude-opus-4.6');
      expect(normalizeModelValue('anthropic/claude-sonnet-4.6', 'openrouter')).toBe('anthropic/claude-sonnet-4.6');
    });

    it('should rewrite stale regressed Anthropic snapshot IDs to the current direct API IDs', () => {
      expect(normalizeModelValue('claude-opus-4-1-20250805', 'anthropic')).toBe('claude-opus-4-7');
      expect(normalizeModelValue('claude-opus-4-20250514', 'anthropic')).toBe('claude-opus-4-6');
      expect(normalizeModelValue('claude-sonnet-4-20250514', 'anthropic')).toBe('claude-sonnet-4-6');
    });

    it('should keep current Anthropic native model IDs unchanged', () => {
      expect(normalizeModelValue('claude-opus-4-7', 'anthropic')).toBe('claude-opus-4-7');
      expect(normalizeModelValue('claude-opus-4-6', 'anthropic')).toBe('claude-opus-4-6');
      expect(normalizeModelValue('claude-sonnet-4-6', 'anthropic')).toBe('claude-sonnet-4-6');
      expect(normalizeModelValue('claude-haiku-4-5', 'anthropic')).toBe('claude-haiku-4-5');
    });

    it('should keep Anthropic legacy model IDs unchanged', () => {
      expect(normalizeModelValue('claude-3-5-sonnet-20241022', 'anthropic')).toBe('claude-3-5-sonnet-20241022');
      expect(normalizeModelValue('claude-3-5-haiku-20241022', 'anthropic')).toBe('claude-3-5-haiku-20241022');
    });
  });

  describe('provider ordering helpers', () => {
    it('promotes Venice to the featured slot and fills the quick-select pills', () => {
      const featured = getFeaturedProvider(PROVIDERS);
      const quickSelectIds = getQuickSelectProviders(VISIBLE_PROVIDERS).map((provider) => provider.id);

      expect(FEATURED_PROVIDER_ID).toBe('venice');
      expect(featured?.id).toBe('venice');
      expect(quickSelectIds).toEqual(['opengateway', 'bankr', 'openrouter', 'nous', 'codex', 'crof']);
      expect(quickSelectIds).not.toContain('venice');
      expect(quickSelectIds).not.toContain('anthropic');
    });

    it('keeps featured and quick-select providers out of overflow and hides CometAPI; anthropic falls into overflow', () => {
      const overflowIds = getOverflowProviders(PROVIDERS).map((provider) => provider.id);

      expect(overflowIds).not.toContain('venice');
      expect(overflowIds).not.toContain('bankr');
      expect(overflowIds).not.toContain('openrouter');
      expect(overflowIds).not.toContain('nous');
      expect(overflowIds).not.toContain('codex');
      expect(overflowIds).not.toContain('crof');
      expect(overflowIds).not.toContain('opengateway');
      expect(overflowIds).not.toContain('cometapi');
      expect(overflowIds).toContain('anthropic');
      expect(overflowIds[0]).toBe('anthropic');
    });

  });

  describe('PROVIDERS array', () => {
    it('uses Google Gemini model IDs accepted by the Gemini OpenAI-compatible endpoint', () => {
      const gemini = PROVIDERS.find((provider) => provider.id === 'gemini');
      expect(gemini).toBeDefined();
      expect(gemini!.models.map((model) => model.value)).toEqual([
        'gemini-3.5-flash',
        'gemini-3.1-pro-preview',
        'gemini-3.1-flash-lite',
        'gemini-3-flash-preview',
        'gemini-2.5-pro',
        'gemini-2.5-flash',
      ]);
      expect(gemini!.models.map((model) => model.value)).not.toContain('gemini-3-flash');
    });

    it('codex should remain available as a dedicated provider option', () => {
      expect(PROVIDERS.some((provider) => provider.id === 'codex')).toBe(true);
    });

    it('codex should contain the current ChatGPT OAuth model set', () => {
      const codex = PROVIDERS.find(p => p.id === 'codex');
      expect(codex).toBeDefined();
      const modelValues = codex!.models.map(m => m.value);
      expect(modelValues).toContain('gpt-5.5');
      expect(modelValues).toContain('gpt-5.4');
      expect(modelValues).toContain('gpt-5.4-mini');
      expect(modelValues).toContain('gpt-5.3-chat-latest');
      expect(modelValues).toContain('gpt-5.2');
      expect(modelValues).not.toContain('gpt-4o');
    });

    it('openrouter should expose canonical Claude 4.7 and 4.6 model IDs', () => {
      const openrouter = PROVIDERS.find((provider) => provider.id === 'openrouter');
      expect(openrouter).toBeDefined();
      const modelValues = openrouter!.models.map((m) => m.value);
      expect(modelValues).toContain('anthropic/claude-opus-4.7');
      expect(modelValues).toContain('anthropic/claude-opus-4.6');
      expect(modelValues).toContain('anthropic/claude-sonnet-4.6');
      expect(modelValues).not.toContain('anthropic/claude-opus-4-6-20260205');
      expect(modelValues).not.toContain('anthropic/claude-sonnet-4-6-20260217');
    });

    it('anthropic should expose Claude Fable 5 as the flagship model', () => {
      const anthropic = PROVIDERS.find((provider) => provider.id === 'anthropic');
      expect(anthropic).toBeDefined();
      expect(anthropic!.desc).toContain('Fable 5');
      expect(anthropic!.models[0]?.value).toBe('claude-fable-5');
      // Opus 4.8 (the current Opus tier and the zero-config deploy default in
      // provider-config) sits directly behind the new flagship.
      expect(anthropic!.models[1]?.value).toBe('claude-opus-4-8');
    });

    it('openrouter should not expose the stale Gemma model ID', () => {
      const openrouter = PROVIDERS.find((provider) => provider.id === 'openrouter');
      expect(openrouter).toBeDefined();
      const modelValues = openrouter!.models.map((m) => m.value);
      expect(modelValues).toContain('google/gemma-4-26b-a4b-it');
      expect(modelValues).not.toContain('google/gemma-4-26b-it');
    });

    it('venice should remain visible as the default provider with DeepSeek V4 Flash as the recommended default', () => {
      const venice = PROVIDERS.find((provider) => provider.id === 'venice');
      expect(venice).toBeDefined();
      expect(venice!.hidden).toBeUndefined();
      expect(VISIBLE_PROVIDERS.map((provider) => provider.id)).toContain('venice');
      expect(venice!.models[0]?.value).toBe('deepseek-v4-flash');
      expect(venice!.models.map((m) => m.value)).toEqual(
        expect.arrayContaining([
          'deepseek-v4-flash',
          'deepseek-v4-pro',
          'deepseek-v3.2',
          'zai-org-glm-4.7',
          'zai-org-glm-5-1',
          'zai-org-glm-5',
          'claude-opus-4-7',
          'kimi-k2-6',
          'openai-gpt-55',
          'qwen3-vl-235b-a22b',
          'qwen3-coder-480b-a35b-instruct-turbo',
          'qwen3-235b-a22b-thinking-2507',
          'venice-uncensored-1-2',
          'e2ee-glm-5-1',
        ])
      );
    });

    it('bankr should expose a curated multi-provider starter set', () => {
      const bankr = PROVIDERS.find((provider) => provider.id === 'bankr');
      expect(bankr).toBeDefined();
      expect(bankr!.models[0]?.value).toBe('claude-opus-4.7');
      expect(bankr!.models.map((m) => m.value)).toEqual(
        expect.arrayContaining([
          'claude-opus-4.7',
          'claude-opus-4.6',
          'claude-sonnet-4.6',
          'claude-haiku-4.5',
          'gemini-3.1-pro',
          'gemini-3-flash',
          'gemma-4-31b-it',
          'gpt-5.4',
          'gpt-5.2-codex',
          'grok-4.20',
          'glm-5.1',
          'deepseek-v3.2',
          'minimax-m2.7',
          'kimi-k2.6',
          'qwen3-coder',
          'qwen3.5-plus',
        ])
      );
    });

    it('should only expose one Bankr provider entry so quick-select and dropdowns stay in sync', () => {
      expect(PROVIDERS.filter((provider) => provider.id === 'bankr')).toHaveLength(1);
    });

    it('should include Kimi K2.6 everywhere it is currently supported', () => {
      const openrouter = PROVIDERS.find((provider) => provider.id === 'openrouter');
      const crof = PROVIDERS.find((provider) => provider.id === 'crof');
      const moonshot = PROVIDERS.find((provider) => provider.id === 'moonshot');

      expect(openrouter?.models.map((m) => m.value)).toContain('moonshotai/kimi-k2.6');
      expect(crof?.models.map((m) => m.value)).toContain('kimi-k2.6');
      expect(crof?.models.map((m) => m.value)).toContain('kimi-k2.6-precision');
      expect(moonshot?.models.map((m) => m.value)).toContain('kimi-k2.6');
    });

    it('crof should expose the current CrofAI offer model set', () => {
      const crof = PROVIDERS.find((provider) => provider.id === 'crof');
      expect(crof).toBeDefined();
      const crofModels = crof!.models;

      expect(crofModels.map((m) => m.value)).toEqual([
        'glm-5.1',
        'glm-5.1-precision',
        'greg',
        'kimi-k2.6',
        'kimi-k2.6-precision',
        'kimi-k2.5',
        'kimi-k2.5-lightning',
        'glm-5',
        'glm-4.7',
        'glm-4.7-flash',
        'gemma-4-31b-it',
        'minimax-m2.5',
        'qwen3.5-397b-a17b',
        'qwen3.5-9b',
        'qwen3.5-9b-chat',
        'deepseek-v3.2',
      ]);
      expect(crofModels.find((m) => m.value === 'kimi-k2.6')?.label).toBe('Kimi K2.6 (Regular)');
      expect(crofModels.find((m) => m.value === 'kimi-k2.6-precision')?.label).toBe('Kimi K2.6 (Precision)');
    });

    it('openai API presets should include GPT-5.5 without making it the fallback default yet', () => {
      const openai = PROVIDERS.find((provider) => provider.id === 'openai');
      expect(openai).toBeDefined();
      const modelValues = openai!.models.map((m) => m.value);

      expect(modelValues).toContain('gpt-5.5');
      expect(openai!.models[0]?.value).toBe('gpt-5.5');
    });

    it('CometAPI should expose its live GPT-5.5 all-model IDs first', () => {
      const cometapi = PROVIDERS.find((provider) => provider.id === 'cometapi');
      expect(cometapi).toBeDefined();
      const modelValues = cometapi!.models.map((m) => m.value);

      expect(cometapi!.models[0]?.value).toBe('gpt-5.5-all');
      expect(modelValues).toEqual(
        expect.arrayContaining([
          'gpt-5.5-all',
          'gpt-5.5-medium-all',
          'gpt-5.5-high-all',
          'gpt-5.5-xhigh-all',
          'gpt-5.5-low-all',
        ])
      );
    });

    it('alibaba should expose the current Qwen 3.6 family entries', () => {
      const alibaba = PROVIDERS.find((provider) => provider.id === 'alibaba');
      expect(alibaba).toBeDefined();
      const modelValues = alibaba!.models.map((m) => m.value);
      expect(modelValues).toContain('qwen3.6-max-preview');
      expect(modelValues).toContain('qwen3.6-plus');
      expect(modelValues).toContain('qwen3.6-flash');
      expect(modelValues).toContain('qwen3.6-35b-a3b');
    });

    it('anthropic should not expose stale native Claude aliases in the picker', () => {
      const anthropic = PROVIDERS.find((provider) => provider.id === 'anthropic');
      expect(anthropic).toBeDefined();
      const modelValues = anthropic!.models.map((m) => m.value);
      expect(modelValues).toContain('claude-fable-5');
      expect(modelValues).toContain('claude-opus-4-8');
      expect(modelValues).toContain('claude-opus-4-7');
      expect(modelValues).toContain('claude-opus-4-6');
      expect(modelValues).toContain('claude-sonnet-4-6');
      expect(modelValues).toContain('claude-haiku-4-5');
      expect(modelValues).not.toContain('claude-opus-4-1-20250805');
      expect(modelValues).not.toContain('claude-opus-4-20250514');
      expect(modelValues).not.toContain('claude-sonnet-4-20250514');
    });


  });
});

describe('isModelValidForProvider / reconcileModelProvider', () => {
  it('validates a model against its provider catalog', () => {
    expect(isModelValidForProvider('gpt-5.5', 'codex')).toBe(true);
    expect(isModelValidForProvider('grok-4.3', 'xai-oauth')).toBe(true);
    expect(isModelValidForProvider('gpt-5.5', 'xai-oauth')).toBe(false);
    expect(isModelValidForProvider('gpt-5.5', 'no-such-provider')).toBe(false);
  });

  it('repairs a stranded model by following it to its real provider', () => {
    // Regression: a SuperGrok (xai-oauth) auto-switch left the codex model
    // gpt-5.5 paired with xai-oauth, which 404s on api.x.ai.
    expect(reconcileModelProvider('gpt-5.5', 'xai-oauth')).toBe('codex');
  });

  it('keeps a provider that already serves the model', () => {
    expect(reconcileModelProvider('grok-4.3', 'xai-oauth')).toBe('xai-oauth');
    expect(reconcileModelProvider('gpt-5.5', 'codex')).toBe('codex');
  });

  it('never hijacks BYOK/custom models it cannot validate', () => {
    expect(reconcileModelProvider('my-private-finetune', 'openai')).toBe('openai');
    expect(reconcileModelProvider('gpt-5.5', 'custom_llm')).toBe('custom_llm');
    expect(reconcileModelProvider('whatever', 'unknown-provider')).toBe('unknown-provider');
  });
});

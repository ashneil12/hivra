-- Hivra catalog agents: optional alternative LLM-provider config (Venice BYOK
-- or managed-Venice gateway). Key-free metadata in llm_config; the key itself
-- encrypted at rest in llm_api_key_encrypted (Hermes-lane custody model).
-- Additive + nullable: old code ignores both columns; absent config = native
-- vendor auth, byte-identical to prior behavior.
alter table hivra_agents
  add column if not exists llm_config jsonb,
  add column if not exists llm_api_key_encrypted text;

comment on column hivra_agents.llm_config is
  'Alternative LLM provider metadata (provider/mode/model/proxyKeyId/walletType/enabledAt). Null = native vendor auth.';
comment on column hivra_agents.llm_api_key_encrypted is
  'Encrypted provider API key (user-supplied for byok, Hivra-minted hven_live_* proxy key for managed).';

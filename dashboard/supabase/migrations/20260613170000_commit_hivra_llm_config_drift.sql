-- Commit the hivra_agents LLM-config schema drift.
--
-- llm_config + llm_api_key_encrypted are LIVE on both Supabase DBs (canary +
-- prod) but were applied via MCP without a committed migration file, so the
-- migrations-manifest / migration-drift-check has no record of them. This
-- additive, idempotent migration captures that drift so any NEW hivra_agents
-- migration sequences cleanly after it and prod-parity is in the pipeline.
--
-- No-op where the columns already exist (add column if not exists).

alter table public.hivra_agents add column if not exists llm_config            jsonb;
alter table public.hivra_agents add column if not exists llm_api_key_encrypted text;

comment on column public.hivra_agents.llm_config is
  'Key-free LLM provider config (StoredLlmConfig) — provider/mode/model/walletType. Never the secret.';
comment on column public.hivra_agents.llm_api_key_encrypted is
  'Encrypted per-agent LLM provider key (e.g. managed-Venice proxy). Stripped by sanitizeHivraAgentRow before client.';

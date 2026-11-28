alter table public.hivra_canary_lite_qa_settings
  add column if not exists credential_mode text not null default 'encrypted',
  add column if not exists permit_git_sha text,
  add column if not exists permit_signer_sha256 text;

alter table public.hivra_canary_lite_qa_settings
  drop constraint if exists hivra_canary_lite_qa_settings_check,
  drop constraint if exists hivra_canary_lite_managed_qa_requires_config,
  drop constraint if exists hivra_canary_lite_qa_credential_mode_check,
  add constraint hivra_canary_lite_qa_credential_mode_check check (
    case credential_mode
      when 'encrypted' then
        permit_git_sha is null and permit_signer_sha256 is null
        and (not enabled or (owner_id is not null and expires_at is not null
          and worker_origin is not null and signing_secret_enc is not null))
        and (not managed_enabled or (enabled and managed_model is not null
          and managed_proxy_key_id is not null and managed_proxy_key_enc is not null))
      when 'trusted_permit' then
        signing_secret_enc is null and managed_proxy_key_enc is null
        and (not managed_enabled or enabled)
        and (not enabled or (managed_enabled and owner_id is not null and expires_at is not null
          and worker_origin is not null and managed_model is not null and managed_proxy_key_id is not null
          and permit_git_sha is not null and permit_git_sha ~ '^[0-9a-f]{40}$'
          and permit_signer_sha256 is not null and permit_signer_sha256 ~ '^[0-9a-f]{64}$'))
      else false
    end
  );

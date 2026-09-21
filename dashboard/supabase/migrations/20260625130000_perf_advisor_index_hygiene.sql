-- Performance-advisor index hygiene (Supabase advisor, 2026-06-25).
-- Three changes, all derived from the live catalog + 199 days of pg_stat:
--   A. Add 26 covering indexes for foreign keys flagged unindexed_foreign_keys.
--   B. Drop 3 duplicate indexes (an identical index/constraint is kept).
--   C. Drop 73 indexes with idx_scan = 0 over a 199-day stats window
--      (unused_index). Only plain btree indexes — no unique/PK/constraint
--      indexes are touched. All target tables are small (<= ~24k rows) so the
--      brief CREATE/DROP locks are negligible.
-- The exact CREATE statements for every dropped index are listed at the bottom
-- of this file so any drop can be reversed by copy-paste if a workload ever
-- needs it.

-- ── A. Covering indexes for unindexed foreign keys ──────────────────────────
CREATE INDEX IF NOT EXISTS ix_agent_templates_forked_from ON public.agent_templates (forked_from);
CREATE INDEX IF NOT EXISTS ix_credit_ledger_entries_account_id ON public.credit_ledger_entries (account_id);
CREATE INDEX IF NOT EXISTS ix_credit_reservations_account_id ON public.credit_reservations (account_id);
CREATE INDEX IF NOT EXISTS ix_crypto_deposit_receipts_payment_transaction_id ON public.crypto_deposit_receipts (payment_transaction_id);
CREATE INDEX IF NOT EXISTS ix_crypto_wallet_sweeps_deposit_wallet_credential_id ON public.crypto_wallet_sweeps (deposit_wallet_credential_id);
CREATE INDEX IF NOT EXISTS ix_hermes_chat_stream_jobs_parent_id ON public.hermes_chat_stream_jobs (parent_id);
CREATE INDEX IF NOT EXISTS ix_hermes_instances_pool_id ON public.hermes_instances (pool_id);
CREATE INDEX IF NOT EXISTS ix_hivra_agents_pool_id ON public.hivra_agents (pool_id);
CREATE INDEX IF NOT EXISTS ix_managed_venice_card_ledger_entries_account_id ON public.managed_venice_card_ledger_entries (account_id);
CREATE INDEX IF NOT EXISTS ix_managed_venice_financial_events_account_id ON public.managed_venice_financial_events (account_id);
CREATE INDEX IF NOT EXISTS ix_managed_venice_proxy_keys_account_id ON public.managed_venice_proxy_keys (account_id);
CREATE INDEX IF NOT EXISTS ix_managed_venice_reconciliation_items_account_id ON public.managed_venice_reconciliation_items (account_id);
CREATE INDEX IF NOT EXISTS ix_managed_venice_reconciliation_items_proxy_key_id ON public.managed_venice_reconciliation_items (proxy_key_id);
CREATE INDEX IF NOT EXISTS ix_managed_venice_reconciliation_items_reservation_id ON public.managed_venice_reconciliation_items (reservation_id);
CREATE INDEX IF NOT EXISTS ix_managed_venice_reconciliation_items_usage_event_id ON public.managed_venice_reconciliation_items (usage_event_id);
CREATE INDEX IF NOT EXISTS ix_managed_venice_reservations_account_id ON public.managed_venice_reservations (account_id);
CREATE INDEX IF NOT EXISTS ix_managed_venice_reservations_proxy_key_id ON public.managed_venice_reservations (proxy_key_id);
CREATE INDEX IF NOT EXISTS ix_managed_venice_token_lots_account_id ON public.managed_venice_token_lots (account_id);
CREATE INDEX IF NOT EXISTS ix_managed_venice_token_quotes_account_id ON public.managed_venice_token_quotes (account_id);
CREATE INDEX IF NOT EXISTS ix_managed_venice_usage_events_account_id ON public.managed_venice_usage_events (account_id);
CREATE INDEX IF NOT EXISTS ix_managed_venice_usage_events_proxy_key_id ON public.managed_venice_usage_events (proxy_key_id);
CREATE INDEX IF NOT EXISTS ix_managed_venice_usage_events_reservation_id ON public.managed_venice_usage_events (reservation_id);
CREATE INDEX IF NOT EXISTS ix_token_holding_snapshots_wallet_id ON public.token_holding_snapshots (wallet_id);
CREATE INDEX IF NOT EXISTS ix_workspace_cloud_handoff_codes_instance_id ON public.workspace_cloud_handoff_codes (instance_id);
CREATE INDEX IF NOT EXISTS ix_yearly_token_subscriptions_yearly_quote_id ON public.yearly_token_subscriptions (yearly_quote_id);

-- ── B. Drop duplicate indexes (an identical index/constraint remains) ────────
DROP INDEX IF EXISTS public.idx_instances_status;        -- twin: instances_status_idx
DROP INDEX IF EXISTS public.idx_instances_user_id;       -- twin: instances_user_id_idx
DROP INDEX IF EXISTS public.profiles_instance_name_idx;  -- twin: profiles_instance_id_name_key (unique constraint, kept)

-- ── C. Drop unused indexes (idx_scan = 0 over 199 days) ─────────────────────
DROP INDEX IF EXISTS public.idx_access_sessions_user;
DROP INDEX IF EXISTS public.idx_agent_templates_share_token;
DROP INDEX IF EXISTS public.idx_audit_log_user_id;
DROP INDEX IF EXISTS public.idx_auth_attempts_created;
DROP INDEX IF EXISTS public.idx_auth_attempts_ip;
DROP INDEX IF EXISTS public.idx_auto_reload_queue_pending;
DROP INDEX IF EXISTS public.idx_bankr_withdrawals_user_token;
DROP INDEX IF EXISTS public.idx_blog_posts_slug;
DROP INDEX IF EXISTS public.idx_channel_connections_channel_connected_at;
DROP INDEX IF EXISTS public.idx_channel_connections_connected_at;
DROP INDEX IF EXISTS public.idx_channel_connections_user;
DROP INDEX IF EXISTS public.idx_churn_surveys_created_at;
DROP INDEX IF EXISTS public.idx_churn_surveys_user;
DROP INDEX IF EXISTS public.compute_usage_events_reference_idx;
DROP INDEX IF EXISTS public.crypto_deposit_receipts_deposit_address_idx;
DROP INDEX IF EXISTS public.crypto_deposit_receipts_reference_idx;
DROP INDEX IF EXISTS public.crypto_deposit_receipts_tx_log_idx;
DROP INDEX IF EXISTS public.crypto_wallet_sweeps_status_idx;
DROP INDEX IF EXISTS public.hermes_conversations_last_active_idx;
DROP INDEX IF EXISTS public.hermes_conversations_soft_deleted_idx;
DROP INDEX IF EXISTS public.hermes_instances_proxmox_template_vmid_idx;
DROP INDEX IF EXISTS public.idx_hermes_instances_standing_task_unseeded;
DROP INDEX IF EXISTS public.hermes_messages_upstream_message_idx;
DROP INDEX IF EXISTS public.idx_hermes_subs_upgraded_at;
DROP INDEX IF EXISTS public.instance_alerts_created_at_idx;
DROP INDEX IF EXISTS public.instance_bankr_wallets_normalized_evm_idx;
DROP INDEX IF EXISTS public.instance_deletion_archives_expires_at_idx;
DROP INDEX IF EXISTS public.instance_deletion_archives_original_instance_id_idx;
DROP INDEX IF EXISTS public.instance_dormancy_archives_source_vmid_idx;
DROP INDEX IF EXISTS public.instance_dormancy_archives_user_id_idx;
DROP INDEX IF EXISTS public.instance_flags_open_idx;
DROP INDEX IF EXISTS public.idx_instances_coolify_uuid;
DROP INDEX IF EXISTS public.idx_instances_pool_server_id;
DROP INDEX IF EXISTS public.idx_instances_scheduled_deletion;
DROP INDEX IF EXISTS public.idx_instances_scheduled_update;
DROP INDEX IF EXISTS public.idx_instances_storage_status;
DROP INDEX IF EXISTS public.idx_ip_blocklist_blocked_until;
DROP INDEX IF EXISTS public.llm_usage_events_reference_idx;
DROP INDEX IF EXISTS public.managed_venice_token_lots_user_active_idx;
DROP INDEX IF EXISTS public.managed_venice_user_rate_limit_buckets_bucket_start_idx;
DROP INDEX IF EXISTS public.openclaw_backups_created_at_idx;
DROP INDEX IF EXISTS public.openclaw_backups_expires_at_idx;
DROP INDEX IF EXISTS public.operator_usage_snapshots_source_type_idx;
DROP INDEX IF EXISTS public.operator_usage_sources_active_idx;
DROP INDEX IF EXISTS public.provider_model_catalogs_checked_at_idx;
DROP INDEX IF EXISTS public.idx_proxy_access_logs_method;
DROP INDEX IF EXISTS public.idx_proxy_access_logs_session;
DROP INDEX IF EXISTS public.idx_proxy_access_logs_user;
DROP INDEX IF EXISTS public.idx_rate_limit_blocked;
DROP INDEX IF EXISTS public.idx_rate_limit_user;
DROP INDEX IF EXISTS public.idx_referral_attributions_referrer;
DROP INDEX IF EXISTS public.idx_referral_attributions_status;
DROP INDEX IF EXISTS public.idx_referral_codes_code;
DROP INDEX IF EXISTS public.idx_referrals_status;
DROP INDEX IF EXISTS public.reservations_position_idx;
DROP INDEX IF EXISTS public.reservations_status_position_idx;
DROP INDEX IF EXISTS public.runtime_leases_deadline_idx;
DROP INDEX IF EXISTS public.idx_server_metrics_server_time;
DROP INDEX IF EXISTS public.idx_signup_risk_assessments_card_fingerprint;
DROP INDEX IF EXISTS public.idx_signup_risk_assessments_fingerprint;
DROP INDEX IF EXISTS public.idx_signup_risk_assessments_ip;
DROP INDEX IF EXISTS public.idx_signup_risk_assessments_setup_intent;
DROP INDEX IF EXISTS public.idx_subscriptions_stripe_customer_id;
DROP INDEX IF EXISTS public.idx_subscriptions_stripe_sub;
DROP INDEX IF EXISTS public.token_tier_qualifications_breach_idx;
DROP INDEX IF EXISTS public.token_tier_qualifications_cooldown_idx;
DROP INDEX IF EXISTS public.token_tier_qualifications_currently_eligible_idx;
DROP INDEX IF EXISTS public.idx_user_servers_status;
DROP INDEX IF EXISTS public.venice_compute_boost_qualifications_breach_idx;
DROP INDEX IF EXISTS public.venice_compute_boost_qualifications_eligible_idx;
DROP INDEX IF EXISTS public.wallet_verification_challenges_address_idx;
DROP INDEX IF EXISTS public.wallet_verification_challenges_expires_idx;
DROP INDEX IF EXISTS public.workspace_cloud_handoff_codes_expires_at_idx;

-- ── Reversibility: recreate DDL for every index dropped above ────────────────
--   CREATE INDEX idx_access_sessions_user ON public.access_sessions USING btree (user_id);
--   CREATE INDEX idx_agent_templates_share_token ON public.agent_templates USING btree (share_token);
--   CREATE INDEX idx_audit_log_user_id ON public.audit_log USING btree (user_id);
--   CREATE INDEX idx_auth_attempts_created ON public.auth_attempts USING btree (created_at);
--   CREATE INDEX idx_auth_attempts_ip ON public.auth_attempts USING btree (ip_address);
--   CREATE INDEX idx_auto_reload_queue_pending ON public.auto_reload_queue USING btree (status) WHERE (status = 'pending'::text);
--   CREATE INDEX idx_bankr_withdrawals_user_token ON public.bankr_withdrawals USING btree (user_id, chain, token_symbol, created_at DESC);
--   CREATE INDEX idx_blog_posts_slug ON public.blog_posts USING btree (slug);
--   CREATE INDEX idx_channel_connections_channel_connected_at ON public.channel_connections USING btree (channel, connected_at);
--   CREATE INDEX idx_channel_connections_connected_at ON public.channel_connections USING btree (connected_at);
--   CREATE INDEX idx_channel_connections_user ON public.channel_connections USING btree (user_id);
--   CREATE INDEX idx_churn_surveys_created_at ON public.churn_surveys USING btree (created_at);
--   CREATE INDEX idx_churn_surveys_user ON public.churn_surveys USING btree (user_id);
--   CREATE INDEX compute_usage_events_reference_idx ON public.compute_usage_events USING btree (usage_kind, reference_id);
--   CREATE INDEX crypto_deposit_receipts_deposit_address_idx ON public.crypto_deposit_receipts USING btree (chain_id, normalized_deposit_address, detected_at DESC);
--   CREATE INDEX crypto_deposit_receipts_reference_idx ON public.crypto_deposit_receipts USING btree (provider, reference_id);
--   CREATE INDEX crypto_deposit_receipts_tx_log_idx ON public.crypto_deposit_receipts USING btree (chain_id, tx_hash, log_index);
--   CREATE INDEX crypto_wallet_sweeps_status_idx ON public.crypto_wallet_sweeps USING btree (status, created_at DESC);
--   CREATE INDEX hermes_conversations_last_active_idx ON public.hermes_conversations USING btree (user_id, instance_id, profile_name, last_active_at DESC) WHERE (last_active_at IS NOT NULL);
--   CREATE INDEX hermes_conversations_soft_deleted_idx ON public.hermes_conversations USING btree (user_id, instance_id, profile_name, soft_deleted_at) WHERE (soft_deleted_at IS NOT NULL);
--   CREATE INDEX hermes_instances_proxmox_template_vmid_idx ON public.hermes_instances USING btree (proxmox_template_vmid) WHERE (proxmox_template_vmid IS NOT NULL);
--   CREATE INDEX idx_hermes_instances_standing_task_unseeded ON public.hermes_instances USING btree (status) WHERE ((standing_task_seeded_at IS NULL) AND (deleted_at IS NULL));
--   CREATE INDEX hermes_messages_upstream_message_idx ON public.hermes_messages USING btree (conversation_id, upstream_message_id) WHERE (upstream_message_id IS NOT NULL);
--   CREATE INDEX idx_hermes_subs_upgraded_at ON public.hermes_subscriptions USING btree (upgraded_at) WHERE (upgraded_at IS NOT NULL);
--   CREATE INDEX instance_alerts_created_at_idx ON public.instance_alerts USING btree (created_at DESC);
--   CREATE INDEX instance_bankr_wallets_normalized_evm_idx ON public.instance_bankr_wallets USING btree (normalized_evm_address);
--   CREATE INDEX instance_deletion_archives_expires_at_idx ON public.instance_deletion_archives USING btree (expires_at);
--   CREATE INDEX instance_deletion_archives_original_instance_id_idx ON public.instance_deletion_archives USING btree (original_instance_id);
--   CREATE INDEX instance_dormancy_archives_source_vmid_idx ON public.instance_dormancy_archives USING btree (source_proxmox_node, source_proxmox_vmid) WHERE ((source_proxmox_node IS NOT NULL) AND (source_proxmox_vmid IS NOT NULL));
--   CREATE INDEX instance_dormancy_archives_user_id_idx ON public.instance_dormancy_archives USING btree (user_id, created_at DESC);
--   CREATE INDEX instance_flags_open_idx ON public.instance_flags USING btree (created_at DESC) WHERE (resolved_at IS NULL);
--   CREATE INDEX idx_instances_coolify_uuid ON public.instances USING btree (coolify_uuid);
--   CREATE INDEX idx_instances_pool_server_id ON public.instances USING btree (pool_server_id);
--   CREATE INDEX idx_instances_scheduled_deletion ON public.instances USING btree (scheduled_deletion_at) WHERE ((scheduled_deletion_at IS NOT NULL) AND (status = 'scheduled_for_deletion'::text));
--   CREATE INDEX idx_instances_scheduled_update ON public.instances USING btree (scheduled_update_at) WHERE (scheduled_update_at IS NOT NULL);
--   CREATE INDEX idx_instances_status ON public.instances USING btree (status);
--   CREATE INDEX idx_instances_storage_status ON public.instances USING btree (storage_status);
--   CREATE INDEX idx_instances_user_id ON public.instances USING btree (user_id);
--   CREATE INDEX idx_ip_blocklist_blocked_until ON public.ip_blocklist USING btree (blocked_until);
--   CREATE INDEX llm_usage_events_reference_idx ON public.llm_usage_events USING btree (billing_source, reference_id);
--   CREATE INDEX managed_venice_token_lots_user_active_idx ON public.managed_venice_token_lots USING btree (user_id, created_at) WHERE ((status = 'active'::text) AND (remaining_value_micro_usd > 0));
--   CREATE INDEX managed_venice_user_rate_limit_buckets_bucket_start_idx ON public.managed_venice_user_rate_limit_buckets USING btree (bucket_start);
--   CREATE INDEX openclaw_backups_created_at_idx ON public.openclaw_backups USING btree (created_at DESC);
--   CREATE INDEX openclaw_backups_expires_at_idx ON public.openclaw_backups USING btree (expires_at) WHERE (expires_at IS NOT NULL);
--   CREATE INDEX operator_usage_snapshots_source_type_idx ON public.operator_usage_snapshots USING btree (source_type, stat_date);
--   CREATE INDEX operator_usage_sources_active_idx ON public.operator_usage_sources USING btree (active) WHERE active;
--   CREATE UNIQUE INDEX profiles_instance_name_idx ON public.profiles USING btree (instance_id, name);
--   CREATE INDEX provider_model_catalogs_checked_at_idx ON public.provider_model_catalogs USING btree (checked_at DESC);
--   CREATE INDEX idx_proxy_access_logs_method ON public.proxy_access_logs USING btree (rpc_method);
--   CREATE INDEX idx_proxy_access_logs_session ON public.proxy_access_logs USING btree (session_id);
--   CREATE INDEX idx_proxy_access_logs_user ON public.proxy_access_logs USING btree (user_id);
--   CREATE INDEX idx_rate_limit_blocked ON public.rate_limit_events USING btree (was_blocked) WHERE (was_blocked = true);
--   CREATE INDEX idx_rate_limit_user ON public.rate_limit_events USING btree (user_id);
--   CREATE INDEX idx_referral_attributions_referrer ON public.referral_attributions USING btree (referrer_user_id);
--   CREATE INDEX idx_referral_attributions_status ON public.referral_attributions USING btree (status);
--   CREATE INDEX idx_referral_codes_code ON public.referral_codes USING btree (code);
--   CREATE INDEX idx_referrals_status ON public.referrals USING btree (status);
--   CREATE INDEX reservations_position_idx ON public.reservations USING btree ("position");
--   CREATE INDEX reservations_status_position_idx ON public.reservations USING btree (status, "position");
--   CREATE INDEX runtime_leases_deadline_idx ON public.runtime_leases USING btree (deadline_at) WHERE (status = ANY (ARRAY['reserved'::text, 'active'::text]));
--   CREATE INDEX idx_server_metrics_server_time ON public.server_metrics USING btree (pool_server_id, created_at DESC);
--   CREATE INDEX idx_signup_risk_assessments_card_fingerprint ON public.signup_risk_assessments USING btree (card_fingerprint) WHERE ((card_fingerprint IS NOT NULL) AND (card_satisfied_at IS NOT NULL));
--   CREATE INDEX idx_signup_risk_assessments_fingerprint ON public.signup_risk_assessments USING btree (fingerprint_visitor_id) WHERE (fingerprint_visitor_id IS NOT NULL);
--   CREATE INDEX idx_signup_risk_assessments_ip ON public.signup_risk_assessments USING btree (ip_address) WHERE (ip_address IS NOT NULL);
--   CREATE INDEX idx_signup_risk_assessments_setup_intent ON public.signup_risk_assessments USING btree (card_setup_intent_id) WHERE (card_setup_intent_id IS NOT NULL);
--   CREATE INDEX idx_subscriptions_stripe_customer_id ON public.subscriptions USING btree (stripe_customer_id);
--   CREATE INDEX idx_subscriptions_stripe_sub ON public.subscriptions USING btree (stripe_subscription_id);
--   CREATE INDEX token_tier_qualifications_breach_idx ON public.token_tier_qualifications USING btree (last_breach_at) WHERE ((last_breach_at IS NOT NULL) AND (last_suspend_at IS NULL));
--   CREATE INDEX token_tier_qualifications_cooldown_idx ON public.token_tier_qualifications USING btree (cooldown_ends_at) WHERE (cooldown_ends_at IS NOT NULL);
--   CREATE INDEX token_tier_qualifications_currently_eligible_idx ON public.token_tier_qualifications USING btree (currently_eligible, last_evaluated_at DESC);
--   CREATE INDEX idx_user_servers_status ON public.user_servers USING btree (status);
--   CREATE INDEX venice_compute_boost_qualifications_breach_idx ON public.venice_compute_boost_qualifications USING btree (last_breach_at) WHERE (last_breach_at IS NOT NULL);
--   CREATE INDEX venice_compute_boost_qualifications_eligible_idx ON public.venice_compute_boost_qualifications USING btree (currently_eligible, last_evaluated_at DESC);
--   CREATE INDEX wallet_verification_challenges_address_idx ON public.wallet_verification_challenges USING btree (normalized_address, chain_id, created_at DESC);
--   CREATE INDEX wallet_verification_challenges_expires_idx ON public.wallet_verification_challenges USING btree (expires_at) WHERE (status = 'pending'::text);
--   CREATE INDEX workspace_cloud_handoff_codes_expires_at_idx ON public.workspace_cloud_handoff_codes USING btree (expires_at);

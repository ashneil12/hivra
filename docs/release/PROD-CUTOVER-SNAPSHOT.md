# Production cutover snapshot: candidate `1f825ba` (2026-09-23)

A worked run of [PROD-CUTOVER-PACKET.md](PROD-CUTOVER-PACKET.md). Everything here
was read-only. It goes stale as soon as `canary` or either database changes;
recompute with the packet before acting on it.

## Pinned state

| Item | Value |
|---|---|
| Candidate (served on Canary) | `1f825bae078877665945a14c23f4c72f9fded12e` (PR #50 merge), Canary deployment `dpl_4gMzs5JdWi2yY33GGsDuHFdHAWju`, source git, READY |
| `origin/main` | `16b2b55` (release PR #42), staged as `dpl_J1E2d1kQ6G8BnHdpsY9Ddd4EFUWz`, never promoted |
| Live hivra.cloud = **rollback target** | `dpl_2qvRnKdbJtTZ4PnLK89oiRwHG1dF`, **source cli**, retired private repository @ `a688d4a`, READY |
| Live public pages | `/` title "Hermes OS is now Hivra \| Deploy Any AI Agent in One Click"; `/token` 200; `/docs/litepaper`, `/LITEPAPER.md`, `/WHITEPAPER.md` 404 |
| Candidate staged on `hermesos` | none yet. It exists only after the owner merges the release PR |

Release contents over `main`: PRs #40, #41, #43, #44, #45, #47, #48, #49, #50. No
main-only commits other than earlier release merges, no direct commits, no
provisioner or sealed-runtime changes. Two migrations are new over `main`
(`20260923001301`, `20260923120000`), but production lacks far more than that.

## Schema diff (Canary DB vs prod DB, `public` schema, 2026-09-23 18:3x UTC)

| Category | canary | prod | only canary | only prod | differ |
|---|---:|---:|---:|---:|---:|
| tables | 147 | 112 | 71 | 36 | 0 |
| views | 6 | 6 | 0 | 0 | 0 |
| columns | 2017 | 1420 | 81 (+906 on canary-only tables) | 47 (+343 on prod-only tables) | 9 |
| functions | 372 | 39 | 337 | 4 | 5 |
| function_grants | 288 | 23 | 268 | 3 | 3 |
| policies | 90 | 175 | 0 (+9 on canary-only tables) | 17 (+77 on prod-only tables) | 0 |
| table_grants | 459 | 354 | 0 (+213 on canary-only tables) | 0 (+108 on prod-only tables) | 34 |
| triggers | 124 | 52 | 30 (+51 on canary-only tables) | 3 (+6 on prod-only tables) | 0 |
| constraints | 1020 | 475 | 40 (+611 on canary-only tables) | 6 (+100 on prod-only tables) | 10 |
| indexes | 481 | 370 | 29 (+183 on canary-only tables) | 9 (+92 on prod-only tables) | 2 |
| enums | 0 | 0 | 0 | 0 | 0 |
| extensions | 5 | 8 | 0 | 3 | 0 |
| buckets | 1 | 4 | 0 | 3 | 0 |

What matters for the cutover:

- **Tables.** 69 tables exist only on Canary, among them `apple_iap_subscriptions`,
  `apple_iap_account_tokens`, `apple_webhook_events`, `yearly_token_reconciliation_items`,
  `device_tokens`, `deployment_targets`, the `infrastructure_*` family and 50-odd
  `hivra_*` tables. Nine of them (`hivra_native_*`, `hivra_run_access_records`,
  `hivra_workspace_conversations`, `hivra_workspace_native_sessions`,
  `hivra_workspace_run_admissions`) were created by migrations that are not in this
  repository, and the candidate's code does not reference them, so production does
  not need them. 36 tables exist only on production (legacy `instances`, `users`,
  `subscriptions`, `user_balances`, `seo_*`, `runtime_*` and others). The
  candidate leaves them in place.
- **`refresh-token-tiers` cron.** Its route reads `apple_iap_subscriptions` and returns
  500 ("Apple subscription scan failed") before any tier decision. Production lacks
  the table, so this cron fails on every run until `20260716120000_apple_iap_lane`
  is applied.
- **`hivra_agents`** (~107 prod rows): Canary adds 50 columns, 26 triggers (mostly guards) and
  several validated CHECK constraints plus NOT NULL columns. The live build writes this
  table in about 20 files. These migrations are data-dependent (existing rows must
  satisfy the constraints) and they break the live build's writes once applied.
- **Money tables.** `crypto_deposit_receipts` (3 rows), `yearly_token_quotes`,
  `yearly_token_subscriptions` (2 active), `managed_venice_token_*`, `deposit_quotes` and
  `token_*` lack Canary's token-key/sweep/attribution columns. Ten constraints differ in
  definition (source, wallet-type and status checks, and the `token_entitlement_configs`
  primary key).
- **Functions.** Production has 39 `public` functions against Canary's 366. Four
  shared functions have different bodies: `get_public_stats`,
  `reconcile_stale_subscription_state_to_free` (production still has the old body
  without the tier rank), `roll_token_anchor` and `update_updated_at`.
- **Security on production now.** `record_cron_heartbeat(text)` and
  `refresh_credit_account_cached_balance(uuid)` are SECURITY DEFINER and callable by
  `anon` and `authenticated`. `20260923001301` fixes both. No `public` table has RLS off
  on either side.
- **Grants drift the other way.** On shared tables, Canary grants `anon` full CRUD
  on 28 tables (and `authenticated` on `instances` and `user_api_keys`) where production grants none (RLS still gates rows). Production grants
  `authenticated` CRUD on `hivra_agents`, `instance_deletion_archives`,
  `referral_attributions` and `referral_codes`, which Canary does not. Neither is a
  cutover blocker. The Canary `anon` grants are a separate hardening item.
- **Legacy-table policies.** Production has 17 policies on `instances`, `profiles` and
  `user_api_keys` that Canary lacks, and the nullability of `profiles.*`,
  `user_api_keys.*` and `hermes_instances.product_surface` differs. No migration in this
  repository reconciles these. Check whether the candidate inserts rows that rely on
  Canary's looser nullability before Promote.
- **Extensions and storage.** Production has `pg_cron`, `pg_net` and `pgmq`, and the
  `avatars`, `blog-images` and `openclaw-backups` buckets, which Canary lacks. Production's
  `cron.job` has no rows. Canary has no `pg_cron`.

## Migrations production lacks at `1f825ba` (apply in this order)

Production's ledger has no row, by name or version, for 162 of the 341 files. By
objects: **0** are fully present. 113 have none of their objects. 2 are partial
(`20260922234806`: the function exists with the old body; `20260923001301`: 2 of 15
grant checks already hold). 47 need a manual check because they are data-only,
DO-block or dynamic SQL, and all but 5 of those have none of their checkable
objects either. Production also has 19 ledger rows for files that are not in this
repository (April and May cleanup one-offs, the retired repository's
`seo_engine`, `card_free_trial_clock`, `trial_offer_promo_code` and
`seo_index_coverage`). Their objects stay.

Static risk verdicts from `prod-migration-risk.mjs`: ADDITIVE 106, NOT-AS-IS 16, REVIEW 40.

Not safe as-is, and why:

- The `hivra_agents` chain (`20260826130000` through `20260923120000`, 14 files): NOT NULL
  and validated CHECK constraints on a populated table, and guard triggers the live
  build does not satisfy. Rehearse against production-shaped `hivra_agents` rows. Apply
  in the Promote window, not before.
- `20260922185029_credit_deposit_sweep_state` and
  `20260922222737_yearly_token_payment_attribution`: constraints on production money
  tables plus data statements. The row counts are small; check each existing row
  against the new constraints before applying.
- `20260716120100_credit_ledger_source_apple`: rewrites the `credit_ledger_entries`
  source constraint through dynamic SQL. Production's constraint exists without
  `'apple'`.
- `20260922172439_enable_rls_remaining_public_tables`: dynamic SQL over every
  `public` table, including production-only legacy tables.
- `20260922234806_reconcile_rpc_yearly_tier_rank`: replaces a function the live build
  calls. It is backward compatible by signature, but the live build then gets the new
  tier behaviour.
- The `*_release` files (provider and desktop release admissions): data inserts that
  depend on tables created earlier in the chain.

Nothing is parked in `_pending_destructive_migrations/` for this release, and no
file uses `CONCURRENTLY`.

| # | Migration | Verdict | Flags |
|---:|---|---|---|
| 1 | `20260705120000_daily_brief_seeded_at` | ADDITIVE |  |
| 2 | `20260716120000_apple_iap_lane` | REVIEW | DROP: drops an object (check it is not one prod-only code or the live build uses) |
| 3 | `20260716120100_credit_ledger_source_apple` | REVIEW | DO_BLOCK: procedural block: effects not visible to object checks; DYNAMIC_SQL: EXECUTE inside a body |
| 4 | `20260716140000_mobile_device_tokens` | ADDITIVE |  |
| 5 | `20260825170000_infrastructure_connections` | REVIEW | DROP: drops an object (check it is not one prod-only code or the live build uses) |
| 6 | `20260826120000_portable_hivra_target_bindings` | REVIEW | DROP: drops an object (check it is not one prod-only code or the live build uses); DATA: top-level data statement: row effects depend on prod data; DO_BLOCK: procedural block: effects not visible to object checks |
| 7 | `20260826130000_hivra_agent_authority_operations` | NOT-AS-IS | NOT_NULL_ON_PROD_TABLE: hivra_agents (~107 rows); RLS_ON_PROD_TABLE: hivra_agents: old code must use service_role or have policies; DROP: drops an object (check it is not one prod-only code or the live build uses); DATA: top-level data statement: row effects depend on prod data |
| 8 | `20260826140000_host_connections_v2` | ADDITIVE |  |
| 9 | `20260826150000_host_discovery_snapshots` | REVIEW | DROP: drops an object (check it is not one prod-only code or the live build uses) |
| 10 | `20260826160000_hetzner_cloud_connections` | REVIEW | DROP: drops an object (check it is not one prod-only code or the live build uses); DO_BLOCK: procedural block: effects not visible to object checks |
| 11 | `20260826170000_hetzner_cloud_capacity_orders` | REVIEW | DROP: drops an object (check it is not one prod-only code or the live build uses) |
| 12 | `20260827090000_hivra_delete_credential_guard` | REVIEW | DROP: drops an object (check it is not one prod-only code or the live build uses) |
| 13 | `20260827150000_hetzner_creation_resource_receipts` | ADDITIVE |  |
| 14 | `20260827160000_hetzner_scoped_cleanup` | REVIEW | DROP: drops an object (check it is not one prod-only code or the live build uses) |
| 15 | `20260827190000_hetzner_first_boot_enrollment` | ADDITIVE |  |
| 16 | `20260827200000_hetzner_first_boot_operations` | ADDITIVE |  |
| 17 | `20260827210000_hetzner_first_boot_cleanup` | ADDITIVE |  |
| 18 | `20260827220000_hetzner_first_boot_recipe_admission` | ADDITIVE |  |
| 19 | `20260827230000_hetzner_enrolled_guest_lease` | ADDITIVE |  |
| 20 | `20260828010000_provider_computer_ownership` | NOT-AS-IS | CONSTRAINT_ON_PROD_TABLE: hivra_agents (~107 rows): validated against existing rows; DROP: drops an object (check it is not one prod-only code or the live build uses) |
| 21 | `20260828020000_provider_installer_operation_fence` | NOT-AS-IS | CONSTRAINT_ON_PROD_TABLE: hivra_agents (~107 rows): validated against existing rows |
| 22 | `20260828030000_provider_computer_preparation` | ADDITIVE |  |
| 23 | `20260828040000_provider_power_operation_fence` | ADDITIVE |  |
| 24 | `20260828050000_provider_power_journal_privileges` | ADDITIVE |  |
| 25 | `20260828060000_provider_computer_launch_admission` | ADDITIVE |  |
| 26 | `20260828070000_provider_provisioner_versions` | ADDITIVE |  |
| 27 | `20260828080000_hivra_model_key_operations` | ADDITIVE |  |
| 28 | `20260828090000_hivra_launch_model_custody` | ADDITIVE |  |
| 29 | `20260828100000_hetzner_external_cleanup_resolution` | REVIEW | DROP: drops an object (check it is not one prod-only code or the live build uses) |
| 30 | `20260828110000_provider_public_bootstrap_version` | ADDITIVE |  |
| 31 | `20260828120000_provider_responses_bundle_version` | ADDITIVE |  |
| 32 | `20260829010000_legacy_encryption_rewrap_cas` | ADDITIVE |  |
| 33 | `20260829020000_provider_runtime_update_bundle_version` | ADDITIVE |  |
| 34 | `20260829040000_runtime_receipt_bundle_version` | ADDITIVE |  |
| 35 | `20260829050000_runtime_receipt_os_identity` | ADDITIVE |  |
| 36 | `20260829060000_runtime_evidence_bundle_version` | ADDITIVE |  |
| 37 | `20260829210000_self_host_operator_settings` | ADDITIVE |  |
| 38 | `20260829211000_self_host_service_role_baseline` | ADDITIVE |  |
| 39 | `20260829212000_provider_runtime_receipt_inventory_fix` | ADDITIVE |  |
| 40 | `20260830132000_launch_fingerprint_key_separation` | REVIEW | SECDEF_NO_REVOKE: SECURITY DEFINER without revoke from anon/authenticated in this file |
| 41 | `20260830150000_complete_encryption_rotation_cas` | ADDITIVE |  |
| 42 | `20260830170000_recursive_runtime_inventory` | ADDITIVE |  |
| 43 | `20260830180000_hivra_agent_restore_points` | REVIEW | DROP: drops an object (check it is not one prod-only code or the live build uses) |
| 44 | `20260830181000_hivra_agent_restore_points_rls_portability` | REVIEW | DROP: drops an object (check it is not one prod-only code or the live build uses) |
| 45 | `20260830182000_hivra_agent_restore_point_resources` | ADDITIVE |  |
| 46 | `20260830190000_standalone_provider_direct_access` | ADDITIVE |  |
| 47 | `20260831220000_provider_guest_gateway_revision` | ADDITIVE |  |
| 48 | `20260831230000_provider_guest_native_composition` | ADDITIVE |  |
| 49 | `20260831233000_provider_native_cleanup_worker` | ADDITIVE |  |
| 50 | `20260831234500_provider_native_cleanup_fence` | ADDITIVE |  |
| 51 | `20260831235500_provider_native_access_binding` | NOT-AS-IS | CONSTRAINT_ON_PROD_TABLE: hivra_agents (~107 rows): validated against existing rows |
| 52 | `20260831235900_provider_native_gateway_credentials` | NOT-AS-IS | CONSTRAINT_ON_PROD_TABLE: hivra_agents (~107 rows): validated against existing rows; DATA: top-level data statement: row effects depend on prod data |
| 53 | `20260901000000_hivra_buzz_connections` | ADDITIVE |  |
| 54 | `20260901010000_hivra_buzz_runtime` | ADDITIVE |  |
| 55 | `20260901020000_hivra_remote_desktop_sessions` | ADDITIVE |  |
| 56 | `20260901030000_hivra_remote_desktop_guest_receipts` | ADDITIVE |  |
| 57 | `20260901031000_provider_native_remote_desktop_release` | ADDITIVE |  |
| 58 | `20260901032000_provider_bounded_remote_desktop_release` | ADDITIVE |  |
| 59 | `20260901033000_provider_immutable_remote_desktop_release` | ADDITIVE |  |
| 60 | `20260901034000_provider_remote_desktop_readiness_release` | ADDITIVE |  |
| 61 | `20260901035000_provider_remote_desktop_auth_release` | ADDITIVE |  |
| 62 | `20260901036000_provider_remote_desktop_container_readiness_release` | ADDITIVE |  |
| 63 | `20260901037000_provider_deepseek_proxmox_release` | ADDITIVE |  |
| 64 | `20260901210000_hivra_remote_desktop_session_renewal` | ADDITIVE |  |
| 65 | `20260901211000_provider_desktop_renewal_release` | ADDITIVE |  |
| 66 | `20260901235500_provider_desktop_timing_release` | ADDITIVE |  |
| 67 | `20260902010000_hivra_buzz_venice_runtime` | ADDITIVE |  |
| 68 | `20260902020000_hivra_buzz_sprig_pin` | ADDITIVE |  |
| 69 | `20260902030000_provider_native_proxmox_handoff_release` | ADDITIVE |  |
| 70 | `20260902060000_provider_native_vmid_ssh_release` | ADDITIVE |  |
| 71 | `20260902070000_provider_native_lifecycle_ssh_release` | ADDITIVE |  |
| 72 | `20260902080000_provider_native_qga_bootstrap_release` | ADDITIVE |  |
| 73 | `20260902120000_provider_public_source_release` | ADDITIVE |  |
| 74 | `20260902170000_provider_public_source_hygiene_release` | ADDITIVE |  |
| 75 | `20260902180000_provider_public_export_review_release` | ADDITIVE |  |
| 76 | `20260902190000_provider_linux_desktop_release` | ADDITIVE |  |
| 77 | `20260903010000_hivra_computer_profiles` | REVIEW | DATA: top-level data statement: row effects depend on prod data; DO_BLOCK: procedural block: effects not visible to object checks |
| 78 | `20260904100000_hivra_canonical_resource_shadow` | REVIEW | DATA: top-level data statement: row effects depend on prod data |
| 79 | `20260904110000_hivra_launch_operations` | ADDITIVE |  |
| 80 | `20260904130000_hivra_provider_resize_operations` | ADDITIVE |  |
| 81 | `20260904140000_provider_current_bundle_release` | ADDITIVE |  |
| 82 | `20260905070000_hivra_provider_resize_action_command` | REVIEW | DO_BLOCK: procedural block: effects not visible to object checks |
| 83 | `20260905071000_hivra_provider_resize_shutdown` | ADDITIVE |  |
| 84 | `20260905072000_hivra_provider_resize_absence` | ADDITIVE |  |
| 85 | `20260905073000_hivra_provider_resize_dispatch_version` | ADDITIVE |  |
| 86 | `20260905090000_hivra_provider_resize_readiness` | ADDITIVE |  |
| 87 | `20260905091000_hivra_provider_resize_readiness_dispatch` | ADDITIVE |  |
| 88 | `20260905100000_hivra_folder_recovery` | ADDITIVE |  |
| 89 | `20260905110000_provider_desktop_workspace_identity_release` | ADDITIVE |  |
| 90 | `20260905130000_provider_desktop_special_modes_release` | ADDITIVE |  |
| 91 | `20260905140000_managed_provisioner_channels` | NOT-AS-IS | CONSTRAINT_ON_PROD_TABLE: hivra_agents (~107 rows): validated against existing rows; DROP: drops an object (check it is not one prod-only code or the live build uses) |
| 92 | `20260905150000_hivra_desktop_prepare_lifecycle` | NOT-AS-IS | CONSTRAINT_ON_PROD_TABLE: hivra_agents (~107 rows): validated against existing rows |
| 93 | `20260905160000_provider_desktop_symlink_identity_release` | ADDITIVE |  |
| 94 | `20260905170000_provider_desktop_session_binding_release` | ADDITIVE |  |
| 95 | `20260905180000_provider_desktop_alignment_release` | ADDITIVE |  |
| 96 | `20260905190000_provider_resize_setup_handoff` | ADDITIVE |  |
| 97 | `20260905200000_provider_desktop_worker_release` | ADDITIVE |  |
| 98 | `20260905210000_provider_desktop_cleanup_contract` | ADDITIVE |  |
| 99 | `20260905220000_provider_desktop_lifecycle` | NOT-AS-IS | CONSTRAINT_ON_PROD_TABLE: hivra_agents (~107 rows): validated against existing rows |
| 100 | `20260905230000_provider_desktop_framing_release` | ADDITIVE |  |
| 101 | `20260906000000_provider_desktop_capability_refresh` | ADDITIVE |  |
| 102 | `20260906010000_provider_desktop_power_completion` | ADDITIVE |  |
| 103 | `20260906020000_provider_desktop_resize_floor` | ADDITIVE |  |
| 104 | `20260906030000_provider_usd_capacity_ceiling` | ADDITIVE |  |
| 105 | `20260906040000_provider_desktop_absent_handoff` | REVIEW | DO_BLOCK: procedural block: effects not visible to object checks |
| 106 | `20260906050000_provider_desktop_teardown_authority` | REVIEW | DO_BLOCK: procedural block: effects not visible to object checks |
| 107 | `20260906060000_provider_desktop_cold_start_release` | REVIEW | DO_BLOCK: procedural block: effects not visible to object checks |
| 108 | `20260906070000_provider_workspace_sessions` | ADDITIVE |  |
| 109 | `20260906080000_provider_workspace_release` | REVIEW | DO_BLOCK: procedural block: effects not visible to object checks |
| 110 | `20260906090000_provider_node_ownership_release` | REVIEW | DO_BLOCK: procedural block: effects not visible to object checks |
| 111 | `20260906110000_agent_zero_editor_release` | REVIEW | DO_BLOCK: procedural block: effects not visible to object checks |
| 112 | `20260906120000_desktop_prepared_image_release` | REVIEW | DO_BLOCK: procedural block: effects not visible to object checks |
| 113 | `20260906130000_desktop_image_transfer_release` | REVIEW | DO_BLOCK: procedural block: effects not visible to object checks |
| 114 | `20260906140000_desktop_image_inventory_release` | REVIEW | DO_BLOCK: procedural block: effects not visible to object checks |
| 115 | `20260906150000_hivra_canonical_binding_provenance` | ADDITIVE |  |
| 116 | `20260906160000_hivra_canonical_parity_coverage` | REVIEW | SECDEF_NO_REVOKE: SECURITY DEFINER without revoke from anon/authenticated in this file |
| 117 | `20260906170000_hivra_canonical_relationship_authority` | REVIEW | DATA: top-level data statement: row effects depend on prod data; DO_BLOCK: procedural block: effects not visible to object checks; DYNAMIC_SQL: EXECUTE inside a body |
| 118 | `20260906180000_hivra_canonical_relationship_reader` | ADDITIVE |  |
| 119 | `20260906190000_hivra_attachment_lease` | NOT-AS-IS | CONSTRAINT_ON_PROD_TABLE: hivra_agents (~107 rows): validated against existing rows |
| 120 | `20260906200000_hivra_attachment_dispatch` | REVIEW | DROP: drops an object (check it is not one prod-only code or the live build uses) |
| 121 | `20260906210000_hivra_attachment_installation_reservation` | ADDITIVE |  |
| 122 | `20260906220000_hivra_attachment_guest_observation` | ADDITIVE |  |
| 123 | `20260906230000_hivra_attachment_staging_result` | ADDITIVE |  |
| 124 | `20260906233000_hivra_attachment_execution_snapshot` | ADDITIVE |  |
| 125 | `20260906234000_hivra_attachment_activation_dispatch` | ADDITIVE |  |
| 126 | `20260906235000_hivra_attachment_activation_observations` | ADDITIVE |  |
| 127 | `20260907010000_hivra_attachment_native_observations` | ADDITIVE |  |
| 128 | `20260907153000_desktop_96_dpi_release` | REVIEW | DO_BLOCK: procedural block: effects not visible to object checks |
| 129 | `20260908023000_hq_streaming_profiles_release` | REVIEW | DO_BLOCK: procedural block: effects not visible to object checks |
| 130 | `20260908050000_remote_desktop_streaming_mode` | ADDITIVE |  |
| 131 | `20260908063000_native_desktop_client_identity` | ADDITIVE |  |
| 132 | `20260908070000_omarchy_native_activation_claim` | ADDITIVE |  |
| 133 | `20260908073000_omarchy_native_activation_grant` | ADDITIVE |  |
| 134 | `20260908074000_omarchy_native_activation_grant_reader` | ADDITIVE |  |
| 135 | `20260908075000_omarchy_native_rolling_renewal` | ADDITIVE |  |
| 136 | `20260908080000_first_frame_streaming_profile_release` | REVIEW | DO_BLOCK: procedural block: effects not visible to object checks |
| 137 | `20260908090000_desktop_handoff_latency_release` | REVIEW | DO_BLOCK: procedural block: effects not visible to object checks |
| 138 | `20260908100000_windows_desktop_prepare_receipt` | ADDITIVE |  |
| 139 | `20260908110000_desktop_prepare_profiles` | ADDITIVE |  |
| 140 | `20260909160000_desktop_resolution_profiles` | REVIEW | DO_BLOCK: procedural block: effects not visible to object checks |
| 141 | `20260909163000_omarchy_wayland_web_transport` | REVIEW | DO_BLOCK: procedural block: effects not visible to object checks |
| 142 | `20260910120000_omarchy_wayland_web_admission_consistency` | REVIEW | DO_BLOCK: procedural block: effects not visible to object checks |
| 143 | `20260915120000_remote_desktop_boot_identity_fence` | REVIEW | DROP: drops an object (check it is not one prod-only code or the live build uses) |
| 144 | `20260915130000_windows_byo_iso_launch` | ADDITIVE |  |
| 145 | `20260915143000_windows_iso_source` | NOT-AS-IS | CONSTRAINT_ON_PROD_TABLE: hivra_agents (~107 rows): validated against existing rows |
| 146 | `20260915150000_hivra_resource_envelopes` | NOT-AS-IS | CONSTRAINT_ON_PROD_TABLE: hivra_agents (~107 rows): validated against existing rows; DATA: top-level data statement: row effects depend on prod data |
| 147 | `20260915153000_hivra_private_access` | NOT-AS-IS | CONSTRAINT_ON_PROD_TABLE: hivra_agents (~107 rows): validated against existing rows |
| 148 | `20260915170000_hivra_gvisor_computers` | NOT-AS-IS | CONSTRAINT_ON_PROD_TABLE: hivra_agents (~107 rows): validated against existing rows |
| 149 | `20260915183000_host_discovery_inspection_time` | REVIEW | DROP: drops an object (check it is not one prod-only code or the live build uses) |
| 150 | `20260915184000_infrastructure_capacity_policy_rebind` | ADDITIVE |  |
| 151 | `20260915190000_gvisor_preflight_external_id_text` | ADDITIVE |  |
| 152 | `20260915190100_gvisor_preflight_connection_columns` | ADDITIVE |  |
| 153 | `20260918120000_hivra_activity_read_path_indexes` | ADDITIVE |  |
| 154 | `20260922172439_enable_rls_remaining_public_tables` | REVIEW | DO_BLOCK: procedural block: effects not visible to object checks; DYNAMIC_SQL: EXECUTE inside a body |
| 155 | `20260922185029_credit_deposit_sweep_state` | NOT-AS-IS | CONSTRAINT_ON_PROD_TABLE: crypto_deposit_receipts (~-1 rows): validated against existing rows; DROP: drops an object (check it is not one prod-only code or the live build uses); DATA: top-level data statement: row effects depend on prod data |
| 156 | `20260922190915_hivra_activity_collectors` | ADDITIVE |  |
| 157 | `20260922201510_provider_release_admission_2026_09_22` | REVIEW | DO_BLOCK: procedural block: effects not visible to object checks |
| 158 | `20260922222737_yearly_token_payment_attribution` | NOT-AS-IS | CONSTRAINT_ON_PROD_TABLE: yearly_token_quotes (~-1 rows): validated against existing rows; CONSTRAINT_ON_PROD_TABLE: yearly_token_subscriptions (~1 rows): validated against existing rows; DROP: drops an object (check it is not one prod-only code or the live build uses); DATA: top-level data statement: row effects depend on prod data |
| 159 | `20260922224500_managed_venice_token_transfer_dedupe` | ADDITIVE |  |
| 160 | `20260922234806_reconcile_rpc_yearly_tier_rank` | REVIEW | REPLACES_PROD_FUNCTION: reconcile_stale_subscription_state_to_free exists on prod (body/grants change for the live build too) |
| 161 | `20260923001301_revoke_api_execute_on_definer_functions` | ADDITIVE |  |
| 162 | `20260923120000_digitalocean_managed_agent_sessions` | NOT-AS-IS | CONSTRAINT_ON_PROD_TABLE: hivra_agents (~107 rows): validated against existing rows |

## Environment variable names (hermesos-canary vs hermesos, production scope)

338 names are set on both (values may still differ and are unreadable by design).
"Read" means the name appears in the candidate's `dashboard/src`, including tests,
so treat it as a pointer rather than proof. 24 per-host fleet override names and
one host-fingerprint name are withheld from this public file; the packet's command
lists them.

- **Canary only, read by the candidate:** `ACTIVITY_COLLECTOR_SIGNING_SECRET`, `APP_URL`, `DAILY_BRIEF_SEED_ENABLED`, `DAILY_VM_BACKUPS_BATCH_SIZE`, `DAILY_VM_BACKUPS_ENABLED`, `DAILY_VM_BACKUPS_TIERS`, `HERMES_AGENT_BROWSER_CDP_ENABLED`, `HERMES_BROWSER_SIDECAR_IMAGE`, `HERMES_PROXMOX_LEGACY_HOST_SLUG`, `HERMES_WEBUI_DOCKER_IMAGE`, `HIVRA_CANARY_CONSOLE_ORIGIN`, `HIVRA_CANARY_PREPARED_COMPUTERS_JSON`, `HIVRA_MANAGED_PROVISIONER_CHANNEL`, `HIVRA_WINDOWS_RDP_GATEWAY_CONFIG`, `NEXT_PUBLIC_HERMES_DEPLOY_ENV`, `NEXT_PUBLIC_HERMES_UPSELL_PREVIEW`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_WORKFLOWS_RUN_ENABLED`, `PROXMOX_VM_DISK_GB`, `SUPABASE_URL`.
  `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` matters most: without it the card-verification
  step reports "not configured", and as a `NEXT_PUBLIC_` name it must be set before
  the candidate is built.
- **Canary only, not read:** `HERMES_VERBOSE_ERROR_MESSAGES`, `NEXT_PUBLIC_PIPEDREAM_CONNECT_ENABLED`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `PIPEDREAM_CLIENT_ID`, `PIPEDREAM_CLIENT_SECRET`, `PIPEDREAM_ENVIRONMENT`, `PIPEDREAM_PROJECT_ID`.
- **Production only, read by the candidate (never exercised on Canary):** `BILLING_SETTLEMENT_SECRET`, `CAPACITY_PRESSURE_DRY_RUN`, `CAPACITY_PRESSURE_SWEEP_ENABLED`, `CLAIM_WINDOW_HOURS`, `COLD_STORAGE_ARCHIVE_BATCH_SIZE`, `COLD_STORAGE_ARCHIVE_ENABLED`, `COLD_STORAGE_ARCHIVE_THRESHOLD_HOURS`, `COLD_STORAGE_AUDIT_HOST`, `COLD_STORAGE_NOTIFICATIONS_ENABLED`, `COLD_STORAGE_RESTORE_ON_START_ENABLED`, `COLD_STORAGE_RETENTION_ENABLED`, `COLD_STORAGE_RETENTION_FREE_DAYS`, `COLD_STORAGE_RETENTION_PAID_DAYS`, `CRYPTO_BILLING_ENABLED`, `DAILY_INSTANCE_BACKUPS_BATCH_SIZE`, `FINGERPRINT_SECRET_KEY`, `HERMES_ADMIN_ALERT_EMAIL`, `HERMES_FOUNDERS_RATE_USER_IDS`, `HERMES_INACTIVITY_PAID_DAYS`, `HERMES_INACTIVITY_SWEEP_ENABLED`, `HERMES_ORPHAN_LV_REAP_ENABLED`, `HERMES_PROXMOX_CPU_OVERCOMMIT_RATIO`, `HERMES_PROXMOX_MAX_TENANT_INSTANCES`, `HERMES_PROXMOX_TARGET`, `HERMES_RESTORE_CLONE_REAPER_ENABLED`, `HERMES_SELF_SERVE_DOWNGRADE_ENABLED`, `HERMES_TREASURY_ADDRESS`, `HERMES_WEBUI_AGENT_PROVISION_IMAGE`, `HERMES_WEBUI_AGENT_UPDATE_IMAGE`, `HETZNER_LOCATION`, `HETZNER_SERVER_TYPE`, `HIVRA_CLAUDE_CODE_PROXMOX_HOST`, `HIVRA_IDLE_PARK_ENABLED`, `INDEXNOW_KEY`, `INDEXNOW_TRIGGER_SECRET`, `INSTANCE_BACKEND`, `LIFECYCLE_EMAILS_BATCH_SIZE`, `MANAGED_VENICE_MULTIMODAL_MARKUP`, `MANAGED_VENICE_SETTLEMENT_SECRET`, `MAX_FREE_INSTANCES`, `NEXT_PUBLIC_CRYPTO_BILLING_ENABLED`, `NEXT_PUBLIC_FINGERPRINT_PUBLIC_KEY`, `NEXT_PUBLIC_HERMES_ARCHIVE_UPGRADE_WALL_ENABLED`, `NEXT_PUBLIC_HERMES_SECOND_AGENT_UPGRADE_ENABLED`, `NEXT_PUBLIC_HERMES_SLEEP_UPGRADE_PROMPT_ENABLED`, `NEXT_PUBLIC_HERMES_USAGE_UPGRADE_CTA_ENABLED`, `NEXT_PUBLIC_HIVRA_AGENTS`, `NEXT_PUBLIC_POSTHOG_API_HOST`, `NEXT_PUBLIC_SELF_SERVE_DOWNGRADE_ENABLED`, `PROXMOX_CADDY_SITES_DIR`, `PROXMOX_GATEWAY_DOMAIN`, `PROXMOX_PRIVATE_GATEWAY`, `PROXMOX_PRIVATE_SUBNET_PREFIX`, `PROXMOX_PUBLIC_IP`, `PROXMOX_SSH_HOST`, `PROXMOX_SSH_USER`, `PROXMOX_TEMPLATE_ID`, `PROXMOX_VM_BALLOON_FLOOR_MB`, `PROXMOX_VM_CORES`, `PROXMOX_VM_MEMORY_MB`, `PROXMOX_VM_SSH_KEY_PATH`, `PROXYCHECK_API_KEY`, `RESEND_FROM_EMAIL`, `RESERVATION_AUTO_INVITE_ENABLED`, `STRIPE_BACKUP_ADDON_PRICE_ID`, `STRIPE_COMMAND_PRICE_ID`, `STRIPE_FLEET_PRICE_ID`, `STRIPE_FLEET_YEARLY_PRICE_ID`, `STRIPE_MANAGED_VENICE_CREDITS_PRODUCT_ID`, `STRIPE_OPERATOR_PRICE_ID`, `STRIPE_OPERATOR_YEARLY_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`, `VENICE_API_KEY`, `VOICE_TRANSCRIPTION_OPENAI_API_KEY`.
- **Production only, not read (disappears at Promote):** `GSC_SA_KEY`, `HERMES_CARD_FREE_TRIAL_ENABLED`, `HERMES_CARD_FREE_TRIAL_EPOCH`, `HERMES_CARD_REQUIRED_TRIAL_ENABLED`, `HERMES_CHAT_JOBS_SIDECAR_ENABLED`, `HERMES_DUNNING_SWEEP_ENABLED`, `HERMES_TRIAL_EMAILS_ENABLED`, `HERMES_TRIAL_EXPIRY_SWEEP_ENABLED`, `HERMES_WEBUI_AGENT_PROVISION_CANARY_IMAGE`, `HERMES_WEBUI_PROVISION_CANARY_EMAILS`, `HIVRA_PROD_ENABLED`, `MANAGED_VENICE_PER_USER_RPM`, `NEXT_PUBLIC_GOOGLE_AUTH_ENABLED`, `NEXT_PUBLIC_HERMES_CARD_REQUIRED_TRIAL_ENABLED`, `NEXT_PUBLIC_HERMES_CHAT_JOBS_SIDECAR_ENABLED`, `NEXT_PUBLIC_HERMES_TRIAL_UI_ENABLED`, `NEXT_PUBLIC_HETZNER_LOCATION`, `NEXT_PUBLIC_HETZNER_SERVER_TYPE`, `NEXT_PUBLIC_HIVRA_PROD_ENABLED`, `NEXT_PUBLIC_WEBUI_IFRAME_ENABLED`, `NEXT_PUBLIC_WEBUI_IFRAME_USER_IDS`, `PROXMOX_AGENT_PROBE_TIMEOUT_MS`, `STRIPE_STORAGE_ADDON_PRICE_ID`, `STRIPE_TRIAL_OFFER_COUPON_ID`.

Newly referenced by the candidate over `main`: `HERMES_BILLING_LEGACY_HARD_DELETE`
(test only), `NEXT_PUBLIC_CRYPTO_BILLING_ENABLED`, `NEXT_PUBLIC_HIVRA_AGENTS`,
`NEXT_PUBLIC_HIVRA_AUTH_MODE`, `NEXT_PUBLIC_HIVRA_REFERRAL_ENABLED`,
`NEXT_PUBLIC_SELF_SERVE_DOWNGRADE_ENABLED`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`.

## Cron differences (live `a688d4a` vs candidate `dashboard/vercel.json`)

61 live crons, 58 candidate crons, 54 unchanged.

| Path | Live | Candidate | Effect at Promote |
|---|---|---|---|
| `/api/cron/trial-expiry` | `35 * * * *` | removed | trial expiry stops; 1 production trial is still open |
| `/api/cron/dunning-sweep` | `30 5 * * *` | removed | dunning sweep stops |
| `/api/cron/seo/gsc-pull` | `10 6 * * *` | removed | SEO jobs stop |
| `/api/cron/seo/inventory-check` | `0 7 * * 1` | removed | |
| `/api/cron/seo/index-coverage` | `30 7 * * 1` | removed | |
| `/api/cron/seed-daily-brief` | none | `0 7 * * *` | new; inert unless `DAILY_BRIEF_SEED_ENABLED=true`, which is set on Canary only |
| `/api/cron/sync-connectors` | none | `0 */12 * * *` | new |
| `/api/cron/daily-instance-backups` | `0 1,7,13,19 * * *` | `0 4 * * *` | backups go from 4 a day to 1 |
| `/api/cron/recover-stuck-hivra-agents` | `*/5 * * * *` | `*/2 * * * *` | runs more often, against the migrated `hivra_agents` |

Database cron: `pg_cron` is installed on production with no jobs.

First runs on production data (aggregate counts, read-only): 130 Managed Venice token
quotes are `active`, 51 `expired`, 11 `settled` and 1 in `manual_review_required`
(an owner decision; leave it manual). There are 10 expired and 1 consumed yearly
token quotes, 2 active yearly subscriptions and 3 crypto deposit receipts. Read the
release PRs for #36/#37 (quote retirement) and #41/#45 (yearly tiers) for what their
crons do on a first run.

<details>
<summary>Full object diff (generated by prod-schema-diff.mjs)</summary>

### tables: only canary (71)

- `apple_iap_account_tokens`
- `apple_iap_subscriptions`
- `apple_webhook_events`
- `deployment_targets`
- `device_tokens`
- `hivra_activity_collectors`
- `hivra_agent_attachment_activation_dispatches`
- `hivra_agent_attachment_activation_observation_outbox`
- `hivra_agent_attachment_activation_observations`
- `hivra_agent_attachment_activation_outbox`
- `hivra_agent_attachment_dispatches`
- `hivra_agent_attachment_guest_observations`
- `hivra_agent_attachment_installations`
- `hivra_agent_attachment_outbox`
- `hivra_agent_attachment_staging_results`
- `hivra_agent_attachments`
- `hivra_agent_snapshots`
- `hivra_buzz_agent_bindings`
- `hivra_buzz_connections`
- `hivra_canonical_agent_identities`
- `hivra_canonical_authority_commands`
- `hivra_canonical_authority_outbox`
- `hivra_canonical_computers`
- `hivra_canonical_primary_bindings`
- `hivra_canonical_reconciliation_errors`
- `hivra_canonical_relationship_authority`
- `hivra_canonical_runtime_installations`
- `hivra_canonical_shadow_control`
- `hivra_canonical_source_events`
- `hivra_canonical_source_mappings`
- `hivra_desktop_preparations`
- `hivra_do_session_inputs`
- `hivra_folder_recoveries`
- `hivra_launch_model_requests`
- `hivra_launch_operations`
- `hivra_model_key_operations`
- `hivra_native_activation_attempts`
- `hivra_native_activation_observations`
- `hivra_native_host_bindings`
- `hivra_native_installation_attempts`
- `hivra_native_installation_reservations`
- `hivra_omarchy_native_activation_grants`
- `hivra_omarchy_native_renewals`
- `hivra_private_access_connections`
- `hivra_private_access_operations`
- `hivra_provider_desktop_absence`
- `hivra_provider_desktop_cleanup`
- `hivra_provider_native_cleanup`
- `hivra_provider_power_operations`
- `hivra_provider_resize_operations`
- `hivra_remote_desktop_capabilities`
- `hivra_remote_desktop_sessions`
- `hivra_run_access_records`
- `hivra_windows_byo_iso_launches`
- `hivra_workspace_conversations`
- `hivra_workspace_native_sessions`
- `hivra_workspace_run_admissions`
- `hivra_workspace_sessions`
- `infrastructure_capacity_inventory`
- `infrastructure_capacity_orders`
- `infrastructure_connection_secrets`
- `infrastructure_connections`
- `infrastructure_external_cleanup_resolutions`
- `infrastructure_first_boot_enrollments`
- `infrastructure_first_boot_operations`
- `infrastructure_host_discovery_runs`
- `infrastructure_host_discovery_snapshots`
- `platform_token_activations`
- `self_host_operator_settings`
- `token_grandfather_cohort`
- `yearly_token_reconciliation_items`

### tables: only prod (36)

- `access_sessions`
- `audit_log`
- `auth_attempts`
- `auto_reload_queue`
- `blog_posts`
- `game_stats`
- `instance_alerts`
- `instance_backup_config`
- `instance_configs`
- `ip_blocklist`
- `managed_venice_user_rate_limit_buckets`
- `openclaw_backups`
- `operator_usage_snapshots`
- `operator_usage_sources`
- `pool_servers`
- `proxy_access_logs`
- `rate_limit_events`
- `referrals`
- `reward_events`
- `runtime_cooldowns`
- `runtime_daily_rollups`
- `runtime_leases`
- `runtime_tier_configs`
- `runtime_usage_events`
- `seo_actions`
- `seo_gsc_daily`
- `seo_index_coverage`
- `seo_indexing_log`
- `seo_page_inventory`
- `seo_targets`
- `server_metrics`
- `subscriptions`
- `usage_transactions`
- `user_balances`
- `user_servers`
- `users`

### tables: differ (0)

- none

### views: only canary (0)

- none

### views: only prod (0)

- none

### views: differ (0)

- none

### columns: only canary (81)

- `_deprecated_scheduled_tasks_20260511.profile_name`
- `_deprecated_task_history_20260511.profile_name`
- `crypto_deposit_receipts.sweep_attempted_at`
- `crypto_deposit_receipts.sweep_attempts`
- `crypto_deposit_receipts.sweep_claim_block`
- `crypto_deposit_receipts.sweep_confirmed_at`
- `crypto_deposit_receipts.sweep_destination_address`
- `crypto_deposit_receipts.sweep_error`
- `crypto_deposit_receipts.sweep_submitted_at`
- `crypto_deposit_receipts.sweep_transfer_requested_at`
- `deposit_quotes.token_address`
- `deposit_quotes.token_key`
- `hermes_instances.daily_brief_seeded_at`
- `hivra_agents.allocation_operation_id`
- `hivra_agents.computer_profile`
- `hivra_agents.computer_substrate`
- `hivra_agents.cpu_max`
- `hivra_agents.deployment_mode`
- `hivra_agents.deployment_target_id`
- `hivra_agents.desired_state`
- `hivra_agents.do_cleanup_receipt`
- `hivra_agents.do_launch_request_id`
- `hivra_agents.do_session_harness`
- `hivra_agents.do_session_id`
- `hivra_agents.do_session_name`
- `hivra_agents.do_session_observation`
- `hivra_agents.do_session_size`
- `hivra_agents.gvisor_adapter_sha256`
- `hivra_agents.gvisor_adapter_version`
- `hivra_agents.gvisor_cleanup_receipt`
- `hivra_agents.gvisor_launch_request_id`
- `hivra_agents.gvisor_observation`
- `hivra_agents.gvisor_runtime_sha256`
- `hivra_agents.gvisor_sandbox_id`
- `hivra_agents.infrastructure_binding_token_enforced`
- `hivra_agents.infrastructure_binding_token_hash`
- `hivra_agents.infrastructure_connection_id`
- `hivra_agents.infrastructure_connection_revision`
- `hivra_agents.managed_provisioner_channel`
- `hivra_agents.operation_id`
- `hivra_agents.operation_kind`
- `hivra_agents.operation_payload`
- `hivra_agents.operation_started_at`
- `hivra_agents.provider_capacity_order_id`
- `hivra_agents.provider_enrollment_attempt_id`
- `hivra_agents.provider_install_desktop_access`
- `hivra_agents.provider_install_dispatched_at`
- `hivra_agents.provider_install_identity`
- `hivra_agents.provider_install_native_access`
- `hivra_agents.provider_install_not_after`
- `hivra_agents.provider_install_outcome`
- `hivra_agents.provider_install_stopped_at`
- `hivra_agents.provider_server_id`
- `hivra_agents.ram_max`
- `hivra_agents.windows_disk_gb`
- `hivra_agents.windows_iso_file_identity_sha256`
- `hivra_agents.windows_iso_modified_at_seconds`
- `hivra_agents.windows_iso_size_bytes`
- `hivra_agents.windows_iso_source`
- `hivra_agents.windows_iso_volume`
- `hivra_agents.windows_rights_attested_at`
- `hivra_agents.windows_rights_attested_by`
- `hivra_agents.windows_rights_terms_version`
- `managed_venice_reconciliation_items.dedupe_key`
- `managed_venice_reconciliation_items.token_address`
- `managed_venice_token_lots.token_address`
- `managed_venice_token_lots.token_key`
- `managed_venice_token_quotes.token_address`
- `managed_venice_token_quotes.token_key`
- `managed_venice_token_quotes.transfer_surfacing_pending`
- `token_entitlement_configs.token_key`
- `token_tier_qualifications.token_key`
- `yearly_token_quotes.attribution_closed_at`
- `yearly_token_quotes.consumed_log_index`
- `yearly_token_quotes.token_address`
- `yearly_token_quotes.token_key`
- `yearly_token_subscriptions.deposit_address`
- `yearly_token_subscriptions.deposit_log_index`
- `yearly_token_subscriptions.sweep_submitted_at`
- `yearly_token_subscriptions.token_address`
- `yearly_token_subscriptions.token_key`

### columns: only prod (47)

- `_deprecated_hermes_scheduled_tasks_20260511.profile_name`
- `hermes_instances.first_session_at`
- `hermes_subscriptions.trial_ends_at`
- `hermes_subscriptions.trial_expired_processed_at`
- `hermes_subscriptions.trial_offer_promo_code`
- `hermes_subscriptions.trial_started_at`
- `instances.allocated_cpus`
- `instances.allocated_memory_mb`
- `instances.allocated_storage_mb`
- `instances.allowed_ip`
- `instances.backups_enabled`
- `instances.billing_mode`
- `instances.cloudflare_dns_record_id`
- `instances.config`
- `instances.config_version`
- `instances.coolify_app_id`
- `instances.coolify_service_id`
- `instances.coolify_uuid`
- `instances.created_at`
- `instances.current_storage_mb`
- `instances.error_message`
- `instances.gateway_port`
- `instances.gateway_token`
- `instances.gateway_url`
- `instances.health_check_failures`
- `instances.hetzner_server_id`
- `instances.is_configured`
- `instances.last_deployed_at`
- `instances.last_health_check`
- `instances.memory_settings`
- `instances.migration_old_server_id`
- `instances.migration_snapshot_id`
- `instances.migration_status`
- `instances.name`
- `instances.pending_restore_backup_id`
- `instances.pending_restore_key`
- `instances.pool_server_id`
- `instances.scheduled_deletion_at`
- `instances.scheduled_update_at`
- `instances.sentinel_pro_token`
- `instances.sentinel_pro_url`
- `instances.status`
- `instances.storage_check_at`
- `instances.storage_status`
- `instances.subdomain`
- `instances.sudo_disabled`
- `instances.updated_at`

### columns: differ (9)

- `hermes_instances.product_surface` — canary: text not null default 'hermesos'::text / prod: text
- `profiles.instance_id` — canary: uuid / prod: uuid not null
- `profiles.name` — canary: text / prod: text not null
- `profiles.status` — canary: text not null default 'running'::text / prod: text not null default 'stopped'::text
- `profiles.user_id` — canary: text / prod: text not null
- `user_api_keys.created_at` — canary: timestamp with time zone not null default now() / prod: timestamp with time zone default now()
- `user_api_keys.encrypted_key` — canary: text / prod: text not null
- `user_api_keys.is_active` — canary: boolean not null default true / prod: boolean default true
- `user_api_keys.updated_at` — canary: timestamp with time zone not null default now() / prod: timestamp with time zone default now()

### functions: only canary (337)

- `abandon_hetzner_cleanup(p_user_id text, p_connection_id uuid, p_order_id uuid, p_idempotency_key uuid, p_fingerprint text)`
- `abandon_hetzner_first_boot_operation(p_user_id text, p_connection_id uuid, p_revision bigint, p_order_id uuid, p_attempt_id uuid, p_quote text, p_server text, p_server_name text, p_confirmation text)`
- `abandon_hivra_buzz_membership(p_user_id text, p_binding_id uuid, p_lease_id uuid, p_error_code text)`
- `accept_hivra_launch_operation(p_user_id text, p_request_id uuid, p_operation_id uuid, p_request_digest text, p_intent_digest text, p_agent_id uuid, p_response_status integer)`
- `accept_windows_byo_iso_launch(p_user_id text, p_request_id uuid, p_agent_id uuid, p_operation_id uuid, p_vmid integer)`
- `admit_hivra_buzz_binding(p_user_id text, p_binding_id uuid, p_connection_id uuid, p_agent_id uuid, p_operation_id uuid, p_request_digest text, p_public_key text, p_encrypted_private_key text, p_encrypted_invite_code text)`
- `admit_hivra_model_key_operation(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_binding jsonb, p_request jsonb)`
- `admit_hivra_workspace_run(p_owner text, p_computer uuid, p_conversation uuid, p_revision bigint, p_run uuid, p_message_sha256 text)`
- `admit_prepared_provider_computer(p_user_id text, p_connection_id uuid, p_revision bigint, p_order_id uuid, p_attempt_id uuid, p_server text, p_lease_id uuid, p_target_id uuid, p_receipt jsonb)`
- `apply_hivra_canonical_source_event(p_event_id bigint)`
- `arm_hetzner_first_boot(p_user_id text, p_connection_id uuid, p_revision bigint, p_order_id uuid, p_attempt_id uuid, p_capacity_key uuid, p_server_id text, p_creation_receipt jsonb)`
- `authorize_hivra_remote_desktop_session(p_session_token_hash text, p_computer_kind text, p_computer_id uuid, p_transport text, p_wants_input boolean)`
- `authorize_hivra_workspace_session(p_id uuid, p_computer uuid, p_surface text, p_audience text, p_token_hash text)`
- `begin_hivra_agent_attachment(p_owner text, p_computer_id uuid, p_operation_id uuid, p_expected_generation bigint, p_expected_authority jsonb, p_intent jsonb)`
- `begin_hivra_agent_snapshot(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_snapshot_id uuid, p_provider_snapshot_id text)`
- `begin_hivra_agent_snapshot_restore(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_snapshot_id uuid)`
- `begin_hivra_buzz_runtime_install(p_user_id text, p_binding_id uuid, p_operation_id uuid, p_request_digest text, p_provider text, p_model text, p_owner_public_key text, p_encrypted_api_key text)`
- `begin_hivra_desktop_prepare(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_expected_authority jsonb)`
- `begin_hivra_folder_recovery(p_user_id text, p_source_id uuid, p_destination_id uuid, p_source_binding_hash text, p_artifact_sha256 text, p_operation_id uuid, p_revoke_source_sessions boolean)`
- `begin_hivra_native_activation_attempt(p_owner text, p_installation uuid, p_lease uuid)`
- `begin_hivra_native_installation_attempt(p_owner text, p_reservation uuid, p_lease uuid)`
- `begin_hivra_private_access_operation(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_action text, p_login_server text, p_expected_authority jsonb)`
- `begin_hivra_provider_desktop_cleanup(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_identity jsonb)`
- `begin_hivra_provider_desktop_install(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_identity jsonb, p_access jsonb)`
- `begin_hivra_provider_install(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_identity jsonb)`
- `begin_hivra_provider_install_bound(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_identity jsonb, p_native_access jsonb)`
- `begin_hivra_provider_native_cleanup(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_identity jsonb)`
- `begin_hivra_provider_native_install(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_identity jsonb, p_access jsonb)`
- `begin_hivra_provider_power_dispatch(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_before_boot_id uuid)`
- `begin_hivra_provider_resize_dispatch(p_user_id text, p_agent_id uuid, p_operation_id uuid)`
- `begin_hivra_provider_resize_dispatch_v2(p_user_id text, p_agent_id uuid, p_operation_id uuid)`
- `begin_hivra_provider_resize_dispatch_v3(p_user_id text, p_agent_id uuid, p_operation_id uuid)`
- `begin_hivra_provider_resize_shutdown(p_user_id text, p_agent_id uuid, p_operation_id uuid)`
- `begin_hivra_provider_resize_shutdown_v2(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_readiness jsonb)`
- `begin_infrastructure_connection_preflight(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_run_id uuid, p_started_at timestamp with time zone)`
- `begin_infrastructure_connection_preparation(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_run_id uuid, p_started_at timestamp with time zone)`
- `begin_infrastructure_host_discovery(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_run_id uuid)`
- `bind_hivra_launch_operation_agent(p_user_id text, p_request_id uuid, p_operation_id uuid, p_request_digest text, p_intent_digest text, p_agent_id uuid)`
- `bind_hivra_provider_direct_access(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_address text)`
- `bind_hivra_remote_desktop_session_boot_identity()`
- `cancel_hivra_launch_model_request(p_user_id text, p_agent_id uuid, p_request_id uuid)`
- `cancel_hivra_provider_power_before_dispatch(p_user_id text, p_agent_id uuid, p_operation_id uuid)`
- `cancel_hivra_provider_resize_operation(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_failure_code text)`
- `cancel_undispatched_hivra_agent_attachment(p_owner text, p_operation_id uuid)`
- `cancel_undispatched_hivra_desktop_prepare(p_user_id text, p_operation_id uuid)`
- `cancel_undispatched_hivra_private_access_operation(p_user_id text, p_operation_id uuid)`
- `capture_hivra_canonical_hermes_source_event()`
- `capture_hivra_canonical_hivra_source_event()`
- `checkpoint_hetzner_first_boot_operation(p_user_id text, p_connection_id uuid, p_revision bigint, p_order_id uuid, p_attempt_id uuid, p_quote text, p_server text, p_lease_id uuid, p_event text, p_evidence jsonb, p_observed_at timestamp with time zone)`
- `checkpoint_hivra_agent_operation(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_expected_desired_state text)`
- `claim_hetzner_cleanup(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_order_id uuid, p_idempotency_key uuid, p_lease_id uuid, p_fingerprint text, p_server_name text)`
- `claim_hetzner_cleanup_with_firewall(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_order_id uuid, p_idempotency_key uuid, p_lease_id uuid, p_fingerprint text, p_server_name text, p_expected_firewall_receipt jsonb)`
- `claim_hetzner_cloud_capacity_order(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_quote_id uuid, p_idempotency_key uuid, p_encrypted_bootstrap_bundle text, p_bootstrap_key_version smallint, p_bootstrap_public_key text, p_bootstrap_public_key_fingerprint text, p_now timestamp with time zone)`
- `claim_hetzner_enrolled_guest_operation(p_user_id text, p_connection_id uuid, p_revision bigint, p_order_id uuid, p_attempt_id uuid, p_quote text, p_server text)`
- `claim_hetzner_first_boot_operation(p_user_id text, p_connection_id uuid, p_revision bigint, p_order_id uuid, p_attempt_id uuid, p_quote text, p_server text)`
- `claim_hivra_agent_operation(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_operation_kind text, p_desired_state text, p_operation_payload jsonb)`
- `claim_hivra_agent_operation_recovery(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_expected_operation_started_at timestamp with time zone, p_recovered_at timestamp with time zone)`
- `claim_hivra_buzz_leave(p_user_id text, p_binding_id uuid)`
- `claim_hivra_buzz_membership(p_user_id text, p_binding_id uuid)`
- `claim_hivra_buzz_runtime_install(p_user_id text, p_binding_id uuid)`
- `claim_hivra_buzz_runtime_remove(p_user_id text, p_binding_id uuid)`
- `claim_hivra_launch_model_attempt(p_user_id text, p_agent_id uuid, p_request_id uuid, p_automatic boolean)`
- `claim_hivra_model_key_delivery(p_user_id text, p_agent_id uuid, p_operation_id uuid)`
- `claim_hivra_omarchy_native_activation(p_user_id text, p_session_id uuid, p_session_token_hash text, p_activation_id uuid)`
- `claim_hivra_omarchy_native_renewal(p_user_id text, p_session_id uuid, p_activation_id uuid, p_renewal_id uuid, p_ttl_seconds integer)`
- `claim_hivra_provider_power_operation(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_kind text)`
- `claim_hivra_provider_resize_operation(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_quote_fingerprint text, p_billing_confirmation text)`
- `clean_hivra_deleted_launch_models()`
- `clean_hivra_deleted_model_keys()`
- `clear_hivra_private_access_after_delete(p_user_id text, p_agent_id uuid, p_operation_id uuid)`
- `commit_hivra_gvisor_target_preflight(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_checked_at timestamp with time zone, p_run_id uuid, p_target jsonb)`
- `complete_hivra_agent_delete(p_user_id text, p_agent_id uuid, p_operation_id uuid)`
- `complete_hivra_agent_operation(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_expected_desired_state text, p_status text, p_cpu numeric, p_ram integer)`
- `complete_hivra_agent_running(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_operation_kind text, p_chat_url text, p_ip text, p_api_token text, p_provisioned_at timestamp with time zone)`
- `complete_hivra_agent_snapshot(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_snapshot_id uuid, p_provider_status text, p_snapshot_config_sha256 text)`
- `complete_hivra_agent_snapshot_restore(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_snapshot_id uuid, p_snapshot_config_sha256 text)`
- `complete_hivra_desktop_prepare(p_user_id text, p_operation_id uuid, p_receipt jsonb)`
- `complete_hivra_folder_recovery(p_user_id text, p_operation_id uuid, p_artifact_sha256 text, p_file_count integer, p_byte_count integer)`
- `complete_hivra_private_access_operation(p_user_id text, p_operation_id uuid, p_success boolean, p_receipt jsonb)`
- `complete_hivra_provider_desktop_power(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_kind text, p_chat_url text, p_ip text)`
- `complete_hivra_provider_desktop_running(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_chat_url text, p_ip text, p_provisioned_at timestamp with time zone)`
- `complete_hivra_provider_native_running(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_chat_url text, p_ip text, p_provisioned_at timestamp with time zone)`
- `complete_hivra_provider_resize_operation(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_observed_at timestamp with time zone)`
- `complete_infrastructure_connection_preflight(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_run_id uuid, p_connection_status text, p_checked_at timestamp with time zone, p_last_error_code text, p_target jsonb)`
- `complete_infrastructure_host_discovery(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_run_id uuid, p_observed_at timestamp with time zone, p_expires_at timestamp with time zone, p_host_identity_digest text, p_snapshot jsonb)`
- `confirm_hivra_buzz_health(p_user_id text, p_binding_id uuid, p_receipt jsonb)`
- `confirm_hivra_buzz_runtime_health(p_user_id text, p_binding_id uuid, p_receipt jsonb)`
- `confirm_hivra_remote_desktop_input_transition_by_token(p_session_token_hash text, p_receipt jsonb)`
- `confirm_hivra_remote_desktop_release(p_user_id text, p_session_id uuid, p_receipt jsonb)`
- `confirm_hivra_remote_desktop_takeover(p_user_id text, p_session_id uuid, p_receipt jsonb)`
- `consume_hetzner_first_boot(p_user_id text, p_connection_id uuid, p_revision bigint, p_order_id uuid, p_attempt_id uuid, p_server_id text, p_verifier text, p_host_key text, p_host_fingerprint text, p_provider_observed_at timestamp with time zone)`
- `continue_hivra_agent_operation(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_expected_desired_state text, p_status text, p_cpu numeric, p_ram integer)`
- `continue_hivra_agent_resize_operation(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_expected_desired_state text, p_status text, p_cpu numeric, p_ram integer, p_cpu_max numeric, p_ram_max integer)`
- `create_digitalocean_infrastructure_connection(p_connection_id uuid, p_user_id text, p_name text, p_encrypted_bundle text, p_key_version smallint, p_checked_at timestamp with time zone, p_target jsonb)`
- `create_hetzner_cloud_capacity_quote(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_quote_id uuid, p_server_name text, p_provider_labels jsonb, p_quote_snapshot jsonb, p_quote_fingerprint_sha256 text, p_quote_expires_at timestamp with time zone, p_now timestamp with time zone)`
- `create_hetzner_cloud_infrastructure_connection(p_user_id text, p_name text, p_encrypted_bundle text, p_key_version smallint, p_discovered_at timestamp with time zone, p_inventory jsonb)`
- `create_hetzner_cloud_infrastructure_connection_v2(p_connection_id uuid, p_user_id text, p_name text, p_encrypted_bundle text, p_key_version smallint, p_discovered_at timestamp with time zone, p_inventory jsonb)`
- `create_hivra_provider_resize_quote(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_connection_id uuid, p_connection_revision bigint, p_target_id uuid, p_capacity_order_id uuid, p_enrollment_attempt_id uuid, p_allocation_operation_id uuid, p_provider_server_id text, p_plan_fingerprint text, p_quote_fingerprint text, p_quote jsonb, p_quote_observed_at timestamp with time zone, p_quote_expires_at timestamp with time zone)`
- `create_hivra_workspace_conversation(p_owner text, p_computer uuid, p_agent uuid, p_installation uuid, p_id uuid, p_title text)`
- `create_host_infrastructure_connection(p_user_id text, p_name text, p_ssh_host text, p_ssh_port integer, p_ssh_user text, p_ssh_host_fingerprint_sha256 text, p_encrypted_bundle text, p_key_version smallint)`
- `create_infrastructure_connection(p_user_id text, p_name text, p_setup_mode text, p_ssh_host text, p_ssh_port integer, p_ssh_user text, p_ssh_host_fingerprint_sha256 text, p_config jsonb, p_encrypted_bundle text, p_key_version smallint)`
- `crypto_deposit_receipts_require_sweep()`
- `delete_infrastructure_connection(p_user_id text, p_connection_id uuid)`
- `dispatch_hivra_agent_attachment(p_owner text, p_operation_id uuid, p_dispatch_id uuid, p_expected_generation bigint, p_expected_authority jsonb, p_installer_sha256 text)`
- `dispatch_hivra_attachment_activation(p_owner text, p_operation_id uuid, p_activation_id uuid, p_expected_generation bigint, p_expected_authority jsonb, p_observed_boot_id uuid, p_expected_staged jsonb, p_service_policy_sha256 text, p_service_definition_sha256 text)`
- `dispatch_hivra_desktop_prepare(p_user_id text, p_operation_id uuid)`
- `dispatch_hivra_private_access_operation(p_user_id text, p_operation_id uuid)`
- `enforce_hivra_agent_deployment_authority()`
- `enforce_infrastructure_connection_delete_authority()`
- `ensure_token_grandfather_membership(p_user_id text, p_now timestamp with time zone)`
- `exchange_hivra_remote_desktop_session(p_exchange_code_hash text, p_pkce_challenge text, p_session_token_hash text)`
- `exchange_hivra_workspace_session(p_id uuid, p_computer uuid, p_surface text, p_audience text, p_exchange_hash text, p_challenge text, p_token_hash text)`
- `expire_unstarted_provider_agent(p_user_id text, p_agent_id uuid, p_operation_id uuid)`
- `fail_hivra_agent_snapshot(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_snapshot_id uuid, p_provider_status text, p_error text)`
- `fail_hivra_agent_snapshot_restore(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_snapshot_id uuid, p_provider_status text, p_error text)`
- `fail_hivra_launch_operation(p_user_id text, p_request_id uuid, p_operation_id uuid, p_request_digest text, p_intent_digest text, p_failure_status integer, p_failure_code text)`
- `fail_hivra_provider_resize_operation(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_failure_code text)`
- `finalize_hivra_native_installation(p_owner text, p_reservation uuid, p_attempt uuid, p_lease uuid, p_guest_origin text, p_receipt jsonb)`
- `finish_hivra_workspace_run(p_owner text, p_computer uuid, p_conversation uuid, p_run uuid, p_revision bigint, p_state text)`
- `first_boot_retains_connection(p_connection uuid)`
- `force_forget_hetzner_cloud_connection(p_user_id text, p_connection_id uuid)`
- `guard_first_boot_enrollment()`
- `guard_first_boot_operation()`
- `guard_first_boot_operation_connection()`
- `guard_first_boot_operation_order()`
- `guard_first_boot_operation_revocation()`
- `guard_first_boot_operation_secret()`
- `guard_hetzner_cleanup_connection()`
- `guard_hetzner_cleanup_order()`
- `guard_hetzner_cleanup_secret()`
- `guard_hetzner_cleanup_target_publication()`
- `guard_hetzner_creation_receipt()`
- `guard_hetzner_deleted_inventory()`
- `guard_hetzner_external_cleanup_resolution()`
- `guard_hetzner_resolved_order()`
- `guard_hivra_agent_attachment_lease()`
- `guard_hivra_agent_delete_credentials()`
- `guard_hivra_attachment_guest_dispatch()`
- `guard_hivra_attachment_installation_dispatch()`
- `guard_hivra_canonical_source_provenance()`
- `guard_hivra_desktop_prepare_lease()`
- `guard_hivra_do_managed_session()`
- `guard_hivra_folder_recovery_lease()`
- `guard_hivra_gvisor_computer()`
- `guard_hivra_launch_model_agent()`
- `guard_hivra_launch_model_journal()`
- `guard_hivra_managed_provisioner_channel()`
- `guard_hivra_model_key_agent()`
- `guard_hivra_pending_model_proxy_key()`
- `guard_hivra_private_access_lease()`
- `guard_hivra_provider_agent()`
- `guard_hivra_provider_current_shape()`
- `guard_hivra_provider_desktop_access()`
- `guard_hivra_provider_desktop_lifecycle()`
- `guard_hivra_provider_desktop_resize_floor()`
- `guard_hivra_provider_installer()`
- `guard_hivra_provider_native_access()`
- `guard_hivra_provider_native_lifecycle()`
- `guard_hivra_provider_power_journal()`
- `guard_hivra_provider_power_lifecycle()`
- `guard_hivra_provider_resize_journal()`
- `guard_hivra_provider_resize_lifecycle()`
- `guard_hivra_provider_resize_readiness()`
- `guard_hivra_provider_resize_shutdown()`
- `guard_hivra_snapshot_from_buzz_runtime()`
- `guard_provider_agent_parent()`
- `guard_provider_launch_model()`
- `guard_provider_target_identity()`
- `handoff_hivra_absent_desktop_provision(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_connection_id uuid, p_revision bigint, p_target_id uuid, p_order_id uuid, p_attempt_id uuid, p_server_id text, p_observed_at timestamp with time zone)`
- `hermesos_grandfather_evidence(p_user_id text, p_activated_at timestamp with time zone)`
- `hetzner_external_cleanup_eligible(o infrastructure_capacity_orders)`
- `hetzner_external_cleanup_scope(p_user_id text, p_connection_id uuid, p_order_id uuid)`
- `hivra_canonical_actions(p_source_kind text, p_payload jsonb, p_is_computer boolean, p_deleted boolean)`
- `hivra_canonical_desired_state(p_source_kind text, p_payload jsonb, p_deleted boolean)`
- `hivra_canonical_hermes_event_payload(v_row hermes_instances)`
- `hivra_canonical_hivra_event_payload(v_row hivra_agents)`
- `hivra_canonical_installation_status(p_status text, p_deleted boolean)`
- `hivra_canonical_observed_state(p_status text)`
- `hivra_canonical_operation_state(p_source_kind text, p_payload jsonb, p_deleted boolean)`
- `hivra_canonical_shadow_parity()`
- `hivra_canonical_surfaces(p_source_kind text, p_payload jsonb, p_is_computer boolean, p_deleted boolean)`
- `hivra_desktop_prepare_authority(a hivra_agents)`
- `hivra_desktop_prepare_binding_ready(a hivra_agents)`
- `hivra_folder_recovery_authority(a hivra_agents)`
- `hivra_launch_model_binding(a hivra_agents)`
- `hivra_model_key_binding(a hivra_agents)`
- `hivra_native_activation_current(p_owner text, p_installation uuid)`
- `hivra_native_host_revocation_only()`
- `hivra_private_access_authority(a hivra_agents)`
- `hivra_private_access_binding_ready(a hivra_agents)`
- `hivra_provider_cleanup_verified(p_user_id text, p_agent_id uuid, p_operation_id uuid)`
- `hivra_provider_current_shape_valid(p_shape jsonb, p_order_id uuid, p_connection_id uuid, p_connection_revision bigint, p_server_id text)`
- `hivra_provider_desktop_absence_verified(a hivra_agents)`
- `hivra_provider_desktop_access_matches(p_access jsonb, a hivra_agents)`
- `hivra_provider_desktop_access_valid(p_access jsonb)`
- `hivra_provider_desktop_cleanup_verified(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_identity jsonb, p_outcome text)`
- `hivra_provider_desktop_identity_valid(p_identity jsonb, p_agent_id uuid, p_operation_id uuid)`
- `hivra_provider_desktop_stopped_receipt_valid(p_receipt jsonb, p_agent_id uuid, p_operation_id uuid)`
- `hivra_provider_desktop_teardown_allowed(a hivra_agents)`
- `hivra_provider_direct_access_valid(a hivra_agents)`
- `hivra_provider_install_identity_valid(p_identity jsonb, p_agent_id uuid, p_operation_id uuid)`
- `hivra_provider_native_access_matches(p_access jsonb, a hivra_agents)`
- `hivra_provider_native_access_valid(p_access jsonb)`
- `hivra_provider_native_cleanup_verified(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_identity jsonb, p_outcome text)`
- `hivra_provider_native_identity_valid(p_identity jsonb, p_agent_id uuid, p_operation_id uuid)`
- `hivra_provider_native_stopped_receipt_valid(p_receipt jsonb, p_agent_id uuid, p_operation_id uuid)`
- `hivra_provider_power_action_valid(p_action jsonb, p_server_id text, p_kind text)`
- `hivra_provider_resize_action_valid(p_action jsonb, p_server_id text)`
- `hivra_provider_resize_binding_valid(p_user_id text, p_agent_id uuid, p_connection_id uuid, p_connection_revision bigint, p_target_id uuid, p_capacity_order_id uuid, p_enrollment_attempt_id uuid, p_allocation_operation_id uuid, p_provider_server_id text)`
- `hivra_provider_resize_quote_valid(p_quote jsonb, p_operation_id uuid, p_agent_id uuid, p_provider_server_id text, p_quote_fingerprint text, p_observed_at timestamp with time zone, p_expires_at timestamp with time zone)`
- `hivra_provider_resize_size_valid(p_size jsonb)`
- `hivra_run_access_revocation_only()`
- `hivra_workspace_binding_current(s hivra_workspace_sessions)`
- `hivra_workspace_conversation_metadata(c hivra_workspace_conversations)`
- `initialize_hivra_canonical_relationship_authority()`
- `invalidate_hivra_workspace_sessions_on_agent_change()`
- `invalidate_hivra_workspace_sessions_on_connection_change()`
- `invalidate_infrastructure_connection_preflight(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_checked_at timestamp with time zone, p_last_error_code text)`
- `is_valid_first_boot_firewall_receipt(p_receipt jsonb, p_order uuid, p_attempt uuid, p_quote text, p_server text)`
- `is_valid_first_boot_host_key(p_key text, p_fingerprint text)`
- `is_valid_first_boot_power_action(p_action jsonb, p_server text)`
- `is_valid_hetzner_action_receipts(p_actions jsonb, p_require_success boolean)`
- `is_valid_hetzner_cleanup_absence(p_absence jsonb, p_has_firewall boolean)`
- `is_valid_hetzner_cleanup_firewall_receipt(p_receipt jsonb, p_order uuid, p_quote text, p_server text)`
- `is_valid_hetzner_creation_receipt(p_receipt jsonb)`
- `issue_hivra_remote_desktop_session(p_user_id text, p_session_id uuid, p_computer_kind text, p_computer_id uuid, p_transport text, p_input_role text, p_handoff text, p_exchange_code_hash text, p_pkce_challenge text, p_issued_at timestamp with time zone, p_expires_at timestamp with time zone, p_relay_credential_expires_at timestamp with time zone)`
- `issue_hivra_remote_desktop_session_v2(p_user_id text, p_session_id uuid, p_computer_kind text, p_computer_id uuid, p_transport text, p_input_role text, p_handoff text, p_exchange_code_hash text, p_pkce_challenge text, p_issued_at timestamp with time zone, p_expires_at timestamp with time zone, p_relay_credential_expires_at timestamp with time zone, p_streaming_mode text)`
- `issue_hivra_remote_desktop_session_v3(p_user_id text, p_session_id uuid, p_computer_kind text, p_computer_id uuid, p_transport text, p_input_role text, p_handoff text, p_exchange_code_hash text, p_pkce_challenge text, p_issued_at timestamp with time zone, p_expires_at timestamp with time zone, p_relay_credential_expires_at timestamp with time zone, p_streaming_mode text, p_native_client_id uuid, p_native_client_certificate_pem text, p_native_client_certificate_sha256 text)`
- `issue_hivra_workspace_session(p_user text, p_computer uuid, p_id uuid, p_surface text, p_audience text, p_identity jsonb, p_access jsonb, p_exchange_hash text, p_challenge text)`
- `list_hivra_workspace_conversations(p_owner text, p_computer uuid, p_before uuid)`
- `list_hivra_workspace_runs(p_owner text, p_computer uuid, p_conversation uuid)`
- `load_hivra_native_activation_target(p_owner text, p_installation uuid)`
- `load_hivra_native_installation_reservation(p_owner text, p_reservation uuid)`
- `load_hivra_omarchy_native_activation_grant(p_user_id text, p_session_id uuid, p_activation_id uuid)`
- `lookup_hivra_native_host_binding(p_owner text, p_installation uuid)`
- `lookup_hivra_run_access_record(p_owner text, p_token_sha256 text)`
- `mark_hetzner_cloud_server_post_attempted(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_order_id uuid, p_idempotency_key uuid, p_provider_ssh_key_id text, p_attempted_at timestamp with time zone)`
- `mark_hetzner_cloud_ssh_key_post_attempted(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_order_id uuid, p_idempotency_key uuid, p_attempted_at timestamp with time zone)`
- `mark_hetzner_server_post_for_recipe(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_order_id uuid, p_idempotency_key uuid, p_provider_ssh_key_id text, p_attempted_at timestamp with time zone, p_expected_enrollment jsonb)`
- `mark_hivra_native_activation_outcome_unknown(p_owner text, p_installation uuid, p_attempt uuid)`
- `mark_hivra_native_installation_outcome_unknown(p_owner text, p_reservation uuid, p_attempt uuid)`
- `normalize_hivra_agent_operation_compatibility()`
- `observe_hivra_attachment_guest(p_owner text, p_operation_id uuid, p_expected_generation bigint, p_expected_authority jsonb, p_boot_id uuid, p_worker_sha256 text)`
- `persist_hivra_agent_provision_identity(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_vmid integer, p_ip text)`
- `preserve_hivra_remote_desktop_boot_identity()`
- `prevent_preflight_during_host_discovery()`
- `promote_hivra_launch_model_request(p_user_id text, p_agent_id uuid, p_request_id uuid, p_attempt_id uuid, p_binding jsonb, p_request jsonb)`
- `publish_prepared_provider_computer(p_user_id text, p_connection_id uuid, p_revision bigint, p_order_id uuid, p_attempt_id uuid, p_quote text, p_server text, p_lease_id uuid, p_snapshot jsonb, p_receipt jsonb, p_power_action jsonb)`
- `read_hivra_attachment_activation(p_owner text, p_operation_id uuid)`
- `read_hivra_attachment_execution(p_owner text, p_operation_id uuid)`
- `read_hivra_canonical_computer_relationships(p_owner text, p_computer_id uuid)`
- `read_hivra_workspace_conversation(p_owner text, p_computer uuid, p_id uuid)`
- `reconcile_hetzner_cloud_inventory(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_discovered_at timestamp with time zone, p_inventory jsonb)`
- `reconcile_hivra_canonical_source_events(p_limit integer)`
- `reconcile_hivra_launch_operation(p_user_id text, p_request_id uuid, p_operation_id uuid, p_request_digest text, p_intent_digest text)`
- `record_hetzner_cleanup_observation(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_order_id uuid, p_lease_id uuid, p_absence jsonb, p_error text)`
- `record_hetzner_cloud_capacity_creation_progress(p_user_id text, p_connection_id uuid, p_order_id uuid, p_idempotency_key uuid, p_provider_resource_id text, p_provider_action_id text, p_provider_action_command text, p_provider_action_status text, p_provider_next_actions jsonb, p_provider_observed_at timestamp with time zone, p_observed_server_status text, p_expected_revision bigint, p_creation_receipt jsonb)`
- `record_hetzner_cloud_capacity_order_progress(p_user_id text, p_connection_id uuid, p_order_id uuid, p_idempotency_key uuid, p_provider_resource_id text, p_provider_action_id text, p_provider_action_command text, p_provider_action_status text, p_provider_next_actions jsonb, p_provider_observed_at timestamp with time zone, p_observed_server_status text)`
- `record_hetzner_cloud_capacity_order_result(p_user_id text, p_connection_id uuid, p_order_id uuid, p_idempotency_key uuid, p_status text, p_provider_resource_id text, p_provider_action_id text, p_provider_action_command text, p_provider_action_status text, p_provider_next_actions jsonb, p_provider_observed_at timestamp with time zone, p_observed_server_status text, p_last_error_code text)`
- `record_hetzner_cloud_inventory_failure(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_checked_at timestamp with time zone, p_last_error_code text)`
- `record_hetzner_cloud_ssh_key_result(p_user_id text, p_connection_id uuid, p_order_id uuid, p_idempotency_key uuid, p_status text, p_provider_ssh_key_id text, p_last_error_code text)`
- `record_hivra_agent_operation_failure(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_error text)`
- `record_hivra_attachment_activation_observation(p_owner text, p_operation_id uuid, p_expected_generation bigint, p_expected_authority jsonb, p_expected_request jsonb, p_observation_id uuid, p_result jsonb)`
- `record_hivra_attachment_staging_result(p_owner text, p_operation_id uuid, p_expected_generation bigint, p_expected_authority jsonb, p_observed_boot_id uuid, p_result jsonb)`
- `record_hivra_native_activation(p_owner text, p_installation uuid, p_attempt uuid, p_lease uuid, p_guest_origin text, p_receipt jsonb)`
- `record_hivra_omarchy_native_activation_grant(p_user_id text, p_session_id uuid, p_activation_id uuid, p_guardian_grant jsonb)`
- `record_hivra_omarchy_native_renewal(p_user_id text, p_session_id uuid, p_activation_id uuid, p_renewal_id uuid, p_guardian_renewal jsonb)`
- `record_hivra_private_access_observation(p_user_id text, p_agent_id uuid, p_expected_authority jsonb, p_receipt jsonb)`
- `record_hivra_provider_desktop_capability(p_user_id text, p_agent_id uuid, p_identity jsonb, p_access jsonb, p_ip text, p_target_id uuid, p_receipt jsonb, p_expires_at timestamp with time zone)`
- `record_hivra_provider_desktop_cleanup(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_observation_id uuid, p_receipt jsonb)`
- `record_hivra_provider_install_stopped(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_receipt jsonb)`
- `record_hivra_provider_native_cleanup(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_observation_id uuid, p_receipt jsonb)`
- `record_hivra_provider_power_action(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_action jsonb)`
- `record_hivra_provider_resize_action(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_action jsonb)`
- `record_hivra_provider_resize_observation(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_observed_at timestamp with time zone, p_provider_status text, p_server_type_id bigint, p_server_type text, p_architecture text, p_cores integer, p_memory_gb integer, p_advertised_disk_gb bigint, p_cpu_type text, p_disk_gb bigint, p_stage text)`
- `record_hivra_provider_resize_readiness(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_readiness jsonb)`
- `record_hivra_provider_resize_server_absent(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_server_id text, p_observed_at timestamp with time zone)`
- `record_hivra_provider_resize_shutdown(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_action jsonb)`
- `record_hivra_remote_desktop_capability(p_user_id text, p_computer_kind text, p_computer_id uuid, p_generation uuid, p_receipt jsonb, p_expires_at timestamp with time zone)`
- `record_hivra_remote_desktop_capability_v2(p_user_id text, p_computer_kind text, p_computer_id uuid, p_generation uuid, p_receipt jsonb, p_expires_at timestamp with time zone, p_boot_identity_sha256 text)`
- `record_hivra_workspace_native_session(p_owner text, p_computer uuid, p_conversation uuid, p_run uuid, p_revision bigint, p_native text)`
- `record_infrastructure_host_discovery_time()`
- `record_platform_token_activation(p_token_key text, p_chain_id integer, p_token_address text, p_token_symbol text, p_token_decimals integer, p_activated_at timestamp with time zone, p_now timestamp with time zone)`
- `recover_expired_infrastructure_connection_run(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_expected_run_id uuid, p_recovered_at timestamp with time zone)`
- `recover_infrastructure_connection_credentials(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_encrypted_bundle text, p_key_version smallint)`
- `refresh_digitalocean_infrastructure_target(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_checked_at timestamp with time zone, p_target jsonb, p_error_code text)`
- `refresh_hivra_omarchy_native_capability(p_user_id text, p_computer_id uuid, p_generation uuid, p_observed_revision text, p_observed_at timestamp with time zone, p_expires_at timestamp with time zone)`
- `reject_infrastructure_host_discovery_snapshot_update()`
- `release_hetzner_first_boot_operation(p_user_id text, p_connection_id uuid, p_revision bigint, p_order_id uuid, p_attempt_id uuid, p_quote text, p_server text, p_lease_id uuid)`
- `release_hivra_agent_operation(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_error text, p_mark_error boolean)`
- `release_infrastructure_host_discovery(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_run_id uuid)`
- `renew_hivra_remote_desktop_session_by_token(p_session_token_hash text, p_ttl_seconds integer)`
- `request_hivra_agent_delete(p_user_id text, p_agent_id uuid, p_operation_id uuid)`
- `reserve_hivra_attachment_installation(p_owner text, p_operation_id uuid, p_expected_generation bigint, p_installation_id uuid, p_binding_id uuid, p_architecture text)`
- `reserve_hivra_launch_model_request(p_user_id text, p_request_id uuid, p_fingerprints jsonb, p_model_operation_id uuid, p_agent jsonb, p_selection jsonb, p_encrypted_key text)`
- `reserve_hivra_launch_model_request_v2(p_user_id text, p_request_id uuid, p_fingerprints jsonb, p_model_operation_id uuid, p_agent jsonb, p_selection jsonb, p_encrypted_key text)`
- `reserve_hivra_launch_operation(p_user_id text, p_request_id uuid, p_operation_id uuid, p_request_digest text, p_intent_digest text, p_resource_kind text, p_runtime_id text)`
- `reserve_hivra_native_installation(p_owner text, p_operation uuid, p_computer uuid, p_agent uuid, p_installation uuid, p_manifest text, p_control_origin text)`
- `reserve_windows_byo_iso_launch(p_user_id text, p_request_id uuid, p_request_digest text, p_media_evidence jsonb)`
- `resolve_hetzner_external_cleanup(p_user_id text, p_connection_id uuid, p_revision bigint, p_order_id uuid, p_idempotency_key uuid, p_server_name text, p_state_sha256 text, p_evidence jsonb)`
- `resolve_hivra_run_access_scope(p_owner text, p_id uuid)`
- `resolve_hivra_run_access_target(p_owner text, p_computer uuid, p_agent uuid, p_installation uuid)`
- `resolve_hivra_workspace_conversation(p_owner text, p_computer uuid, p_id uuid)`
- `resolve_hivra_workspace_conversation_target(p_owner text, p_computer uuid, p_agent uuid, p_installation uuid)`
- `retire_hivra_buzz_runtime_after_agent_delete()`
- `retire_hivra_provider_target(p_user_id text, p_connection_id uuid, p_revision bigint, p_target_id uuid, p_order_id uuid, p_server_id text, p_agent_id uuid, p_operation_id uuid)`
- `revoke_first_boot_on_connection_change()`
- `revoke_first_boot_on_order_change()`
- `revoke_first_boot_on_secret_change()`
- `revoke_hivra_remote_desktop_capability(p_user_id text, p_computer_kind text, p_computer_id uuid, p_generation uuid)`
- `revoke_hivra_remote_desktop_session(p_user_id text, p_session_id uuid, p_reason text)`
- `revoke_hivra_remote_desktop_session_by_token(p_session_token_hash text, p_reason text)`
- `revoke_hivra_workspace_conversation(p_owner text, p_computer uuid, p_id uuid, p_revision bigint)`
- `revoke_hivra_workspace_session(p_user text, p_id uuid)`
- `rewrap_encryption_surface_v2(p_surface text, p_id uuid, p_expected jsonb, p_patch jsonb)`
- `rewrap_legacy_encryption_row(p_surface text, p_id uuid, p_expected jsonb, p_patch jsonb)`
- `rotate_hivra_agent_llm_secret(p_id uuid, p_expected text, p_replacement text)`
- `rotate_infrastructure_connection_secret(p_connection_id uuid, p_expected_encrypted_bundle text, p_encrypted_bundle text, p_key_version smallint)`
- `seed_hivra_canonical_source_events(p_limit integer)`
- `set_hivra_canonical_inventory_read_mode(p_mode text)`
- `settle_hivra_buzz_leave(p_user_id text, p_binding_id uuid, p_lease_id uuid, p_receipt jsonb)`
- `settle_hivra_buzz_membership(p_user_id text, p_binding_id uuid, p_lease_id uuid, p_receipt jsonb)`
- `settle_hivra_buzz_runtime_install(p_user_id text, p_binding_id uuid, p_lease_id uuid, p_receipt jsonb)`
- `settle_hivra_buzz_runtime_remove(p_user_id text, p_binding_id uuid, p_lease_id uuid, p_receipt jsonb)`
- `settle_hivra_model_key_operation(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_lease_id uuid, p_receipt jsonb)`
- `settle_yearly_platform_token_payment(p_quote_id uuid, p_transaction_hash text, p_log_index integer, p_amount_raw numeric, p_block_timestamp timestamp with time zone, p_token_address text, p_now timestamp with time zone)`
- `settle_yearly_token_payment(p_quote_id uuid, p_transaction_hash text, p_log_index integer, p_amount_raw numeric, p_block_timestamp timestamp with time zone, p_now timestamp with time zone)`
- `stage_hetzner_first_boot(p_user_id text, p_connection_id uuid, p_revision bigint, p_order_id uuid, p_capacity_key uuid, p_attempt_id uuid, p_quote_fingerprint text, p_recipe_version text, p_issued_at timestamp with time zone, p_expires_at timestamp with time zone, p_verifier text, p_encrypted_token text, p_confirmation text)`
- `token_key_allowed_for_user(p_user_id text, p_token_key text, p_now timestamp with time zone)`
- `token_tier_row_counts_for_user(p_user_id text, p_token_key text, p_now timestamp with time zone)`
- `transfer_hivra_canonical_relationship_authority(p_owner text, p_computer_id uuid, p_expected_source_event_id bigint, p_expected_generation bigint, p_command_id uuid)`
- `update_infrastructure_capacity_policy(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_capacity_policy jsonb)`
- `update_infrastructure_connection(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_patch jsonb, p_operational_change boolean, p_rotate_credentials boolean, p_encrypted_bundle text, p_key_version smallint)`
- `upsert_hetzner_cloud_inventory_server(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_discovered_at timestamp with time zone, p_server jsonb)`
- `upsert_hivra_buzz_connection(p_user_id text, p_id uuid, p_relay_url text, p_http_origin text, p_relay_public_key text, p_display_name text, p_software text, p_relay_version text, p_requires_membership boolean)`
- `verify_hetzner_cleanup_lease(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_order_id uuid, p_lease_id uuid)`
- `verify_hivra_provider_power_result(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_observed_at timestamp with time zone, p_status text, p_boot_id uuid, p_runtime_ready boolean, p_public_ready boolean)`

### functions: only prod (4)

- `managed_venice_check_and_increment_user_rate_limit(p_user_id text, p_bucket_start timestamp with time zone, p_window_start timestamp with time zone, p_limit integer)`
- `managed_venice_cleanup_user_rate_limit_buckets(p_cutoff timestamp with time zone)`
- `operator_usage_tokens_total()`
- `update_blog_posts_updated_at()`

### functions: differ (5)

- `enforce_managed_venice_reservation_balance()` — canary: body=dd611448769ad331e996616cb21a2280 secdef=true config=search_path=public / prod: body=944314c3b3be21ee40e882d38857bf0e secdef=true config=search_path=public
- `get_public_stats()` — canary: body=0b031c4d7931280dc4fd430b7ba9ff52 secdef=true config=search_path=public, pg_temp / prod: body=545b5309c47539a9a53bbe13c6ebfd23 secdef=true config=search_path=public, pg_temp
- `reconcile_stale_subscription_state_to_free(p_user_id text, p_observed_plan text, p_observed_status text, p_observed_stripe_subscription_id text, p_observed_updated_at timestamp with time zone, p_now timestamp with time zone)` — canary: body=05a217943ff49c2e1b3e420abf76f929 secdef=true config=search_path=public / prod: body=35a47de93b9b264cf335c35a02ad46f8 secdef=true config=search_path=public
- `roll_token_anchor()` — canary: body=ca3891d86ef62ba02bec47556f3b381d secdef=true config=search_path=public, pg_temp / prod: body=6eaab719adf92c8fc68a9d9dd2099b63 secdef=true config=search_path=public, pg_temp
- `update_updated_at()` — canary: body=e48740bd35e2a9e17c5e8ae049421527 secdef=false config=search_path="" / prod: body=f5136f454cce5ef7776e2d9f49b633f9 secdef=false config=search_path=""

### function_grants: only canary (268)

- `abandon_hetzner_cleanup(p_user_id text, p_connection_id uuid, p_order_id uuid, p_idempotency_key uuid, p_fingerprint text)`
- `abandon_hetzner_first_boot_operation(p_user_id text, p_connection_id uuid, p_revision bigint, p_order_id uuid, p_attempt_id uuid, p_quote text, p_server text, p_server_name text, p_confirmation text)`
- `abandon_hivra_buzz_membership(p_user_id text, p_binding_id uuid, p_lease_id uuid, p_error_code text)`
- `accept_hivra_launch_operation(p_user_id text, p_request_id uuid, p_operation_id uuid, p_request_digest text, p_intent_digest text, p_agent_id uuid, p_response_status integer)`
- `accept_windows_byo_iso_launch(p_user_id text, p_request_id uuid, p_agent_id uuid, p_operation_id uuid, p_vmid integer)`
- `admit_hivra_buzz_binding(p_user_id text, p_binding_id uuid, p_connection_id uuid, p_agent_id uuid, p_operation_id uuid, p_request_digest text, p_public_key text, p_encrypted_private_key text, p_encrypted_invite_code text)`
- `admit_hivra_model_key_operation(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_binding jsonb, p_request jsonb)`
- `admit_hivra_workspace_run(p_owner text, p_computer uuid, p_conversation uuid, p_revision bigint, p_run uuid, p_message_sha256 text)`
- `admit_prepared_provider_computer(p_user_id text, p_connection_id uuid, p_revision bigint, p_order_id uuid, p_attempt_id uuid, p_server text, p_lease_id uuid, p_target_id uuid, p_receipt jsonb)`
- `apply_hivra_canonical_source_event(p_event_id bigint)`
- `arm_hetzner_first_boot(p_user_id text, p_connection_id uuid, p_revision bigint, p_order_id uuid, p_attempt_id uuid, p_capacity_key uuid, p_server_id text, p_creation_receipt jsonb)`
- `authorize_hivra_remote_desktop_session(p_session_token_hash text, p_computer_kind text, p_computer_id uuid, p_transport text, p_wants_input boolean)`
- `authorize_hivra_workspace_session(p_id uuid, p_computer uuid, p_surface text, p_audience text, p_token_hash text)`
- `begin_hivra_agent_attachment(p_owner text, p_computer_id uuid, p_operation_id uuid, p_expected_generation bigint, p_expected_authority jsonb, p_intent jsonb)`
- `begin_hivra_agent_snapshot(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_snapshot_id uuid, p_provider_snapshot_id text)`
- `begin_hivra_agent_snapshot_restore(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_snapshot_id uuid)`
- `begin_hivra_buzz_runtime_install(p_user_id text, p_binding_id uuid, p_operation_id uuid, p_request_digest text, p_provider text, p_model text, p_owner_public_key text, p_encrypted_api_key text)`
- `begin_hivra_desktop_prepare(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_expected_authority jsonb)`
- `begin_hivra_folder_recovery(p_user_id text, p_source_id uuid, p_destination_id uuid, p_source_binding_hash text, p_artifact_sha256 text, p_operation_id uuid, p_revoke_source_sessions boolean)`
- `begin_hivra_native_activation_attempt(p_owner text, p_installation uuid, p_lease uuid)`
- `begin_hivra_native_installation_attempt(p_owner text, p_reservation uuid, p_lease uuid)`
- `begin_hivra_private_access_operation(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_action text, p_login_server text, p_expected_authority jsonb)`
- `begin_hivra_provider_desktop_cleanup(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_identity jsonb)`
- `begin_hivra_provider_desktop_install(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_identity jsonb, p_access jsonb)`
- `begin_hivra_provider_install(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_identity jsonb)`
- `begin_hivra_provider_install_bound(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_identity jsonb, p_native_access jsonb)`
- `begin_hivra_provider_native_cleanup(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_identity jsonb)`
- `begin_hivra_provider_native_install(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_identity jsonb, p_access jsonb)`
- `begin_hivra_provider_power_dispatch(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_before_boot_id uuid)`
- `begin_hivra_provider_resize_dispatch(p_user_id text, p_agent_id uuid, p_operation_id uuid)`
- `begin_hivra_provider_resize_dispatch_v2(p_user_id text, p_agent_id uuid, p_operation_id uuid)`
- `begin_hivra_provider_resize_dispatch_v3(p_user_id text, p_agent_id uuid, p_operation_id uuid)`
- `begin_hivra_provider_resize_shutdown(p_user_id text, p_agent_id uuid, p_operation_id uuid)`
- `begin_hivra_provider_resize_shutdown_v2(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_readiness jsonb)`
- `begin_infrastructure_connection_preflight(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_run_id uuid, p_started_at timestamp with time zone)`
- `begin_infrastructure_connection_preparation(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_run_id uuid, p_started_at timestamp with time zone)`
- `begin_infrastructure_host_discovery(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_run_id uuid)`
- `bind_hivra_launch_operation_agent(p_user_id text, p_request_id uuid, p_operation_id uuid, p_request_digest text, p_intent_digest text, p_agent_id uuid)`
- `bind_hivra_provider_direct_access(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_address text)`
- `cancel_hivra_launch_model_request(p_user_id text, p_agent_id uuid, p_request_id uuid)`
- `cancel_hivra_provider_power_before_dispatch(p_user_id text, p_agent_id uuid, p_operation_id uuid)`
- `cancel_hivra_provider_resize_operation(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_failure_code text)`
- `cancel_undispatched_hivra_agent_attachment(p_owner text, p_operation_id uuid)`
- `cancel_undispatched_hivra_desktop_prepare(p_user_id text, p_operation_id uuid)`
- `cancel_undispatched_hivra_private_access_operation(p_user_id text, p_operation_id uuid)`
- `checkpoint_hetzner_first_boot_operation(p_user_id text, p_connection_id uuid, p_revision bigint, p_order_id uuid, p_attempt_id uuid, p_quote text, p_server text, p_lease_id uuid, p_event text, p_evidence jsonb, p_observed_at timestamp with time zone)`
- `checkpoint_hivra_agent_operation(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_expected_desired_state text)`
- `claim_hetzner_cleanup(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_order_id uuid, p_idempotency_key uuid, p_lease_id uuid, p_fingerprint text, p_server_name text)`
- `claim_hetzner_cleanup_with_firewall(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_order_id uuid, p_idempotency_key uuid, p_lease_id uuid, p_fingerprint text, p_server_name text, p_expected_firewall_receipt jsonb)`
- `claim_hetzner_cloud_capacity_order(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_quote_id uuid, p_idempotency_key uuid, p_encrypted_bootstrap_bundle text, p_bootstrap_key_version smallint, p_bootstrap_public_key text, p_bootstrap_public_key_fingerprint text, p_now timestamp with time zone)`
- `claim_hetzner_enrolled_guest_operation(p_user_id text, p_connection_id uuid, p_revision bigint, p_order_id uuid, p_attempt_id uuid, p_quote text, p_server text)`
- `claim_hetzner_first_boot_operation(p_user_id text, p_connection_id uuid, p_revision bigint, p_order_id uuid, p_attempt_id uuid, p_quote text, p_server text)`
- `claim_hivra_agent_operation(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_operation_kind text, p_desired_state text, p_operation_payload jsonb)`
- `claim_hivra_agent_operation_recovery(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_expected_operation_started_at timestamp with time zone, p_recovered_at timestamp with time zone)`
- `claim_hivra_buzz_leave(p_user_id text, p_binding_id uuid)`
- `claim_hivra_buzz_membership(p_user_id text, p_binding_id uuid)`
- `claim_hivra_buzz_runtime_install(p_user_id text, p_binding_id uuid)`
- `claim_hivra_buzz_runtime_remove(p_user_id text, p_binding_id uuid)`
- `claim_hivra_launch_model_attempt(p_user_id text, p_agent_id uuid, p_request_id uuid, p_automatic boolean)`
- `claim_hivra_model_key_delivery(p_user_id text, p_agent_id uuid, p_operation_id uuid)`
- `claim_hivra_omarchy_native_activation(p_user_id text, p_session_id uuid, p_session_token_hash text, p_activation_id uuid)`
- `claim_hivra_omarchy_native_renewal(p_user_id text, p_session_id uuid, p_activation_id uuid, p_renewal_id uuid, p_ttl_seconds integer)`
- `claim_hivra_provider_power_operation(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_kind text)`
- `claim_hivra_provider_resize_operation(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_quote_fingerprint text, p_billing_confirmation text)`
- `clear_hivra_private_access_after_delete(p_user_id text, p_agent_id uuid, p_operation_id uuid)`
- `commit_hivra_gvisor_target_preflight(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_checked_at timestamp with time zone, p_run_id uuid, p_target jsonb)`
- `complete_hivra_agent_delete(p_user_id text, p_agent_id uuid, p_operation_id uuid)`
- `complete_hivra_agent_operation(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_expected_desired_state text, p_status text, p_cpu numeric, p_ram integer)`
- `complete_hivra_agent_running(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_operation_kind text, p_chat_url text, p_ip text, p_api_token text, p_provisioned_at timestamp with time zone)`
- `complete_hivra_agent_snapshot(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_snapshot_id uuid, p_provider_status text, p_snapshot_config_sha256 text)`
- `complete_hivra_agent_snapshot_restore(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_snapshot_id uuid, p_snapshot_config_sha256 text)`
- `complete_hivra_desktop_prepare(p_user_id text, p_operation_id uuid, p_receipt jsonb)`
- `complete_hivra_folder_recovery(p_user_id text, p_operation_id uuid, p_artifact_sha256 text, p_file_count integer, p_byte_count integer)`
- `complete_hivra_private_access_operation(p_user_id text, p_operation_id uuid, p_success boolean, p_receipt jsonb)`
- `complete_hivra_provider_desktop_power(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_kind text, p_chat_url text, p_ip text)`
- `complete_hivra_provider_desktop_running(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_chat_url text, p_ip text, p_provisioned_at timestamp with time zone)`
- `complete_hivra_provider_native_running(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_chat_url text, p_ip text, p_provisioned_at timestamp with time zone)`
- `complete_hivra_provider_resize_operation(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_observed_at timestamp with time zone)`
- `complete_infrastructure_connection_preflight(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_run_id uuid, p_connection_status text, p_checked_at timestamp with time zone, p_last_error_code text, p_target jsonb)`
- `complete_infrastructure_host_discovery(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_run_id uuid, p_observed_at timestamp with time zone, p_expires_at timestamp with time zone, p_host_identity_digest text, p_snapshot jsonb)`
- `confirm_hivra_buzz_health(p_user_id text, p_binding_id uuid, p_receipt jsonb)`
- `confirm_hivra_buzz_runtime_health(p_user_id text, p_binding_id uuid, p_receipt jsonb)`
- `confirm_hivra_remote_desktop_input_transition_by_token(p_session_token_hash text, p_receipt jsonb)`
- `confirm_hivra_remote_desktop_release(p_user_id text, p_session_id uuid, p_receipt jsonb)`
- `confirm_hivra_remote_desktop_takeover(p_user_id text, p_session_id uuid, p_receipt jsonb)`
- `consume_hetzner_first_boot(p_user_id text, p_connection_id uuid, p_revision bigint, p_order_id uuid, p_attempt_id uuid, p_server_id text, p_verifier text, p_host_key text, p_host_fingerprint text, p_provider_observed_at timestamp with time zone)`
- `continue_hivra_agent_operation(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_expected_desired_state text, p_status text, p_cpu numeric, p_ram integer)`
- `continue_hivra_agent_resize_operation(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_expected_desired_state text, p_status text, p_cpu numeric, p_ram integer, p_cpu_max numeric, p_ram_max integer)`
- `create_digitalocean_infrastructure_connection(p_connection_id uuid, p_user_id text, p_name text, p_encrypted_bundle text, p_key_version smallint, p_checked_at timestamp with time zone, p_target jsonb)`
- `create_hetzner_cloud_capacity_quote(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_quote_id uuid, p_server_name text, p_provider_labels jsonb, p_quote_snapshot jsonb, p_quote_fingerprint_sha256 text, p_quote_expires_at timestamp with time zone, p_now timestamp with time zone)`
- `create_hetzner_cloud_infrastructure_connection(p_user_id text, p_name text, p_encrypted_bundle text, p_key_version smallint, p_discovered_at timestamp with time zone, p_inventory jsonb)`
- `create_hetzner_cloud_infrastructure_connection_v2(p_connection_id uuid, p_user_id text, p_name text, p_encrypted_bundle text, p_key_version smallint, p_discovered_at timestamp with time zone, p_inventory jsonb)`
- `create_hivra_provider_resize_quote(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_connection_id uuid, p_connection_revision bigint, p_target_id uuid, p_capacity_order_id uuid, p_enrollment_attempt_id uuid, p_allocation_operation_id uuid, p_provider_server_id text, p_plan_fingerprint text, p_quote_fingerprint text, p_quote jsonb, p_quote_observed_at timestamp with time zone, p_quote_expires_at timestamp with time zone)`
- `create_hivra_workspace_conversation(p_owner text, p_computer uuid, p_agent uuid, p_installation uuid, p_id uuid, p_title text)`
- `create_host_infrastructure_connection(p_user_id text, p_name text, p_ssh_host text, p_ssh_port integer, p_ssh_user text, p_ssh_host_fingerprint_sha256 text, p_encrypted_bundle text, p_key_version smallint)`
- `create_infrastructure_connection(p_user_id text, p_name text, p_setup_mode text, p_ssh_host text, p_ssh_port integer, p_ssh_user text, p_ssh_host_fingerprint_sha256 text, p_config jsonb, p_encrypted_bundle text, p_key_version smallint)`
- `delete_infrastructure_connection(p_user_id text, p_connection_id uuid)`
- `dispatch_hivra_agent_attachment(p_owner text, p_operation_id uuid, p_dispatch_id uuid, p_expected_generation bigint, p_expected_authority jsonb, p_installer_sha256 text)`
- `dispatch_hivra_attachment_activation(p_owner text, p_operation_id uuid, p_activation_id uuid, p_expected_generation bigint, p_expected_authority jsonb, p_observed_boot_id uuid, p_expected_staged jsonb, p_service_policy_sha256 text, p_service_definition_sha256 text)`
- `dispatch_hivra_desktop_prepare(p_user_id text, p_operation_id uuid)`
- `dispatch_hivra_private_access_operation(p_user_id text, p_operation_id uuid)`
- `ensure_token_grandfather_membership(p_user_id text, p_now timestamp with time zone)`
- `exchange_hivra_remote_desktop_session(p_exchange_code_hash text, p_pkce_challenge text, p_session_token_hash text)`
- `exchange_hivra_workspace_session(p_id uuid, p_computer uuid, p_surface text, p_audience text, p_exchange_hash text, p_challenge text, p_token_hash text)`
- `expire_unstarted_provider_agent(p_user_id text, p_agent_id uuid, p_operation_id uuid)`
- `fail_hivra_agent_snapshot(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_snapshot_id uuid, p_provider_status text, p_error text)`
- `fail_hivra_agent_snapshot_restore(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_snapshot_id uuid, p_provider_status text, p_error text)`
- `fail_hivra_launch_operation(p_user_id text, p_request_id uuid, p_operation_id uuid, p_request_digest text, p_intent_digest text, p_failure_status integer, p_failure_code text)`
- `fail_hivra_provider_resize_operation(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_failure_code text)`
- `finalize_hivra_native_installation(p_owner text, p_reservation uuid, p_attempt uuid, p_lease uuid, p_guest_origin text, p_receipt jsonb)`
- `finish_hivra_workspace_run(p_owner text, p_computer uuid, p_conversation uuid, p_run uuid, p_revision bigint, p_state text)`
- `first_boot_retains_connection(p_connection uuid)`
- `force_forget_hetzner_cloud_connection(p_user_id text, p_connection_id uuid)`
- `handoff_hivra_absent_desktop_provision(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_connection_id uuid, p_revision bigint, p_target_id uuid, p_order_id uuid, p_attempt_id uuid, p_server_id text, p_observed_at timestamp with time zone)`
- `hermesos_grandfather_evidence(p_user_id text, p_activated_at timestamp with time zone)`
- `hetzner_external_cleanup_eligible(o infrastructure_capacity_orders)`
- `hetzner_external_cleanup_scope(p_user_id text, p_connection_id uuid, p_order_id uuid)`
- `hivra_canonical_actions(p_source_kind text, p_payload jsonb, p_is_computer boolean, p_deleted boolean)`
- `hivra_canonical_desired_state(p_source_kind text, p_payload jsonb, p_deleted boolean)`
- `hivra_canonical_hermes_event_payload(v_row hermes_instances)`
- `hivra_canonical_hivra_event_payload(v_row hivra_agents)`
- `hivra_canonical_installation_status(p_status text, p_deleted boolean)`
- `hivra_canonical_observed_state(p_status text)`
- `hivra_canonical_operation_state(p_source_kind text, p_payload jsonb, p_deleted boolean)`
- `hivra_canonical_shadow_parity()`
- `hivra_canonical_surfaces(p_source_kind text, p_payload jsonb, p_is_computer boolean, p_deleted boolean)`
- `hivra_desktop_prepare_authority(a hivra_agents)`
- `hivra_desktop_prepare_binding_ready(a hivra_agents)`
- `hivra_folder_recovery_authority(a hivra_agents)`
- `hivra_launch_model_binding(a hivra_agents)`
- `hivra_model_key_binding(a hivra_agents)`
- `hivra_native_activation_current(p_owner text, p_installation uuid)`
- `hivra_private_access_authority(a hivra_agents)`
- `hivra_private_access_binding_ready(a hivra_agents)`
- `hivra_provider_cleanup_verified(p_user_id text, p_agent_id uuid, p_operation_id uuid)`
- `hivra_provider_current_shape_valid(p_shape jsonb, p_order_id uuid, p_connection_id uuid, p_connection_revision bigint, p_server_id text)`
- `hivra_provider_desktop_absence_verified(a hivra_agents)`
- `hivra_provider_desktop_access_matches(p_access jsonb, a hivra_agents)`
- `hivra_provider_desktop_access_valid(p_access jsonb)`
- `hivra_provider_desktop_cleanup_verified(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_identity jsonb, p_outcome text)`
- `hivra_provider_desktop_identity_valid(p_identity jsonb, p_agent_id uuid, p_operation_id uuid)`
- `hivra_provider_desktop_stopped_receipt_valid(p_receipt jsonb, p_agent_id uuid, p_operation_id uuid)`
- `hivra_provider_desktop_teardown_allowed(a hivra_agents)`
- `hivra_provider_direct_access_valid(a hivra_agents)`
- `hivra_provider_install_identity_valid(p_identity jsonb, p_agent_id uuid, p_operation_id uuid)`
- `hivra_provider_native_access_matches(p_access jsonb, a hivra_agents)`
- `hivra_provider_native_access_valid(p_access jsonb)`
- `hivra_provider_native_cleanup_verified(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_identity jsonb, p_outcome text)`
- `hivra_provider_native_identity_valid(p_identity jsonb, p_agent_id uuid, p_operation_id uuid)`
- `hivra_provider_native_stopped_receipt_valid(p_receipt jsonb, p_agent_id uuid, p_operation_id uuid)`
- `hivra_provider_power_action_valid(p_action jsonb, p_server_id text, p_kind text)`
- `hivra_provider_resize_action_valid(p_action jsonb, p_server_id text)`
- `hivra_provider_resize_binding_valid(p_user_id text, p_agent_id uuid, p_connection_id uuid, p_connection_revision bigint, p_target_id uuid, p_capacity_order_id uuid, p_enrollment_attempt_id uuid, p_allocation_operation_id uuid, p_provider_server_id text)`
- `hivra_provider_resize_quote_valid(p_quote jsonb, p_operation_id uuid, p_agent_id uuid, p_provider_server_id text, p_quote_fingerprint text, p_observed_at timestamp with time zone, p_expires_at timestamp with time zone)`
- `hivra_provider_resize_size_valid(p_size jsonb)`
- `hivra_workspace_binding_current(s hivra_workspace_sessions)`
- `hivra_workspace_conversation_metadata(c hivra_workspace_conversations)`
- `invalidate_infrastructure_connection_preflight(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_checked_at timestamp with time zone, p_last_error_code text)`
- `is_valid_first_boot_firewall_receipt(p_receipt jsonb, p_order uuid, p_attempt uuid, p_quote text, p_server text)`
- `is_valid_first_boot_host_key(p_key text, p_fingerprint text)`
- `is_valid_first_boot_power_action(p_action jsonb, p_server text)`
- `is_valid_hetzner_action_receipts(p_actions jsonb, p_require_success boolean)`
- `is_valid_hetzner_cleanup_absence(p_absence jsonb, p_has_firewall boolean)`
- `is_valid_hetzner_cleanup_firewall_receipt(p_receipt jsonb, p_order uuid, p_quote text, p_server text)`
- `is_valid_hetzner_creation_receipt(p_receipt jsonb)`
- `issue_hivra_remote_desktop_session(p_user_id text, p_session_id uuid, p_computer_kind text, p_computer_id uuid, p_transport text, p_input_role text, p_handoff text, p_exchange_code_hash text, p_pkce_challenge text, p_issued_at timestamp with time zone, p_expires_at timestamp with time zone, p_relay_credential_expires_at timestamp with time zone)`
- `issue_hivra_remote_desktop_session_v2(p_user_id text, p_session_id uuid, p_computer_kind text, p_computer_id uuid, p_transport text, p_input_role text, p_handoff text, p_exchange_code_hash text, p_pkce_challenge text, p_issued_at timestamp with time zone, p_expires_at timestamp with time zone, p_relay_credential_expires_at timestamp with time zone, p_streaming_mode text)`
- `issue_hivra_remote_desktop_session_v3(p_user_id text, p_session_id uuid, p_computer_kind text, p_computer_id uuid, p_transport text, p_input_role text, p_handoff text, p_exchange_code_hash text, p_pkce_challenge text, p_issued_at timestamp with time zone, p_expires_at timestamp with time zone, p_relay_credential_expires_at timestamp with time zone, p_streaming_mode text, p_native_client_id uuid, p_native_client_certificate_pem text, p_native_client_certificate_sha256 text)`
- `issue_hivra_workspace_session(p_user text, p_computer uuid, p_id uuid, p_surface text, p_audience text, p_identity jsonb, p_access jsonb, p_exchange_hash text, p_challenge text)`
- `list_hivra_workspace_conversations(p_owner text, p_computer uuid, p_before uuid)`
- `list_hivra_workspace_runs(p_owner text, p_computer uuid, p_conversation uuid)`
- `load_hivra_native_activation_target(p_owner text, p_installation uuid)`
- `load_hivra_native_installation_reservation(p_owner text, p_reservation uuid)`
- `load_hivra_omarchy_native_activation_grant(p_user_id text, p_session_id uuid, p_activation_id uuid)`
- `lookup_hivra_native_host_binding(p_owner text, p_installation uuid)`
- `lookup_hivra_run_access_record(p_owner text, p_token_sha256 text)`
- `mark_hetzner_cloud_server_post_attempted(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_order_id uuid, p_idempotency_key uuid, p_provider_ssh_key_id text, p_attempted_at timestamp with time zone)`
- `mark_hetzner_cloud_ssh_key_post_attempted(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_order_id uuid, p_idempotency_key uuid, p_attempted_at timestamp with time zone)`
- `mark_hetzner_server_post_for_recipe(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_order_id uuid, p_idempotency_key uuid, p_provider_ssh_key_id text, p_attempted_at timestamp with time zone, p_expected_enrollment jsonb)`
- `mark_hivra_native_activation_outcome_unknown(p_owner text, p_installation uuid, p_attempt uuid)`
- `mark_hivra_native_installation_outcome_unknown(p_owner text, p_reservation uuid, p_attempt uuid)`
- `observe_hivra_attachment_guest(p_owner text, p_operation_id uuid, p_expected_generation bigint, p_expected_authority jsonb, p_boot_id uuid, p_worker_sha256 text)`
- `persist_hivra_agent_provision_identity(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_vmid integer, p_ip text)`
- `promote_hivra_launch_model_request(p_user_id text, p_agent_id uuid, p_request_id uuid, p_attempt_id uuid, p_binding jsonb, p_request jsonb)`
- `publish_prepared_provider_computer(p_user_id text, p_connection_id uuid, p_revision bigint, p_order_id uuid, p_attempt_id uuid, p_quote text, p_server text, p_lease_id uuid, p_snapshot jsonb, p_receipt jsonb, p_power_action jsonb)`
- `read_hivra_attachment_activation(p_owner text, p_operation_id uuid)`
- `read_hivra_attachment_execution(p_owner text, p_operation_id uuid)`
- `read_hivra_canonical_computer_relationships(p_owner text, p_computer_id uuid)`
- `read_hivra_workspace_conversation(p_owner text, p_computer uuid, p_id uuid)`
- `reconcile_hetzner_cloud_inventory(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_discovered_at timestamp with time zone, p_inventory jsonb)`
- `reconcile_hivra_canonical_source_events(p_limit integer)`
- `reconcile_hivra_launch_operation(p_user_id text, p_request_id uuid, p_operation_id uuid, p_request_digest text, p_intent_digest text)`
- `record_hetzner_cleanup_observation(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_order_id uuid, p_lease_id uuid, p_absence jsonb, p_error text)`
- `record_hetzner_cloud_capacity_creation_progress(p_user_id text, p_connection_id uuid, p_order_id uuid, p_idempotency_key uuid, p_provider_resource_id text, p_provider_action_id text, p_provider_action_command text, p_provider_action_status text, p_provider_next_actions jsonb, p_provider_observed_at timestamp with time zone, p_observed_server_status text, p_expected_revision bigint, p_creation_receipt jsonb)`
- `record_hetzner_cloud_capacity_order_progress(p_user_id text, p_connection_id uuid, p_order_id uuid, p_idempotency_key uuid, p_provider_resource_id text, p_provider_action_id text, p_provider_action_command text, p_provider_action_status text, p_provider_next_actions jsonb, p_provider_observed_at timestamp with time zone, p_observed_server_status text)`
- `record_hetzner_cloud_capacity_order_result(p_user_id text, p_connection_id uuid, p_order_id uuid, p_idempotency_key uuid, p_status text, p_provider_resource_id text, p_provider_action_id text, p_provider_action_command text, p_provider_action_status text, p_provider_next_actions jsonb, p_provider_observed_at timestamp with time zone, p_observed_server_status text, p_last_error_code text)`
- `record_hetzner_cloud_inventory_failure(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_checked_at timestamp with time zone, p_last_error_code text)`
- `record_hetzner_cloud_ssh_key_result(p_user_id text, p_connection_id uuid, p_order_id uuid, p_idempotency_key uuid, p_status text, p_provider_ssh_key_id text, p_last_error_code text)`
- `record_hivra_agent_operation_failure(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_error text)`
- `record_hivra_attachment_activation_observation(p_owner text, p_operation_id uuid, p_expected_generation bigint, p_expected_authority jsonb, p_expected_request jsonb, p_observation_id uuid, p_result jsonb)`
- `record_hivra_attachment_staging_result(p_owner text, p_operation_id uuid, p_expected_generation bigint, p_expected_authority jsonb, p_observed_boot_id uuid, p_result jsonb)`
- `record_hivra_native_activation(p_owner text, p_installation uuid, p_attempt uuid, p_lease uuid, p_guest_origin text, p_receipt jsonb)`
- `record_hivra_omarchy_native_activation_grant(p_user_id text, p_session_id uuid, p_activation_id uuid, p_guardian_grant jsonb)`
- `record_hivra_omarchy_native_renewal(p_user_id text, p_session_id uuid, p_activation_id uuid, p_renewal_id uuid, p_guardian_renewal jsonb)`
- `record_hivra_private_access_observation(p_user_id text, p_agent_id uuid, p_expected_authority jsonb, p_receipt jsonb)`
- `record_hivra_provider_desktop_capability(p_user_id text, p_agent_id uuid, p_identity jsonb, p_access jsonb, p_ip text, p_target_id uuid, p_receipt jsonb, p_expires_at timestamp with time zone)`
- `record_hivra_provider_desktop_cleanup(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_observation_id uuid, p_receipt jsonb)`
- `record_hivra_provider_install_stopped(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_receipt jsonb)`
- `record_hivra_provider_native_cleanup(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_observation_id uuid, p_receipt jsonb)`
- `record_hivra_provider_power_action(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_action jsonb)`
- `record_hivra_provider_resize_action(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_action jsonb)`
- `record_hivra_provider_resize_observation(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_observed_at timestamp with time zone, p_provider_status text, p_server_type_id bigint, p_server_type text, p_architecture text, p_cores integer, p_memory_gb integer, p_advertised_disk_gb bigint, p_cpu_type text, p_disk_gb bigint, p_stage text)`
- `record_hivra_provider_resize_readiness(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_readiness jsonb)`
- `record_hivra_provider_resize_server_absent(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_server_id text, p_observed_at timestamp with time zone)`
- `record_hivra_provider_resize_shutdown(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_action jsonb)`
- `record_hivra_remote_desktop_capability(p_user_id text, p_computer_kind text, p_computer_id uuid, p_generation uuid, p_receipt jsonb, p_expires_at timestamp with time zone)`
- `record_hivra_remote_desktop_capability_v2(p_user_id text, p_computer_kind text, p_computer_id uuid, p_generation uuid, p_receipt jsonb, p_expires_at timestamp with time zone, p_boot_identity_sha256 text)`
- `record_hivra_workspace_native_session(p_owner text, p_computer uuid, p_conversation uuid, p_run uuid, p_revision bigint, p_native text)`
- `record_platform_token_activation(p_token_key text, p_chain_id integer, p_token_address text, p_token_symbol text, p_token_decimals integer, p_activated_at timestamp with time zone, p_now timestamp with time zone)`
- `recover_expired_infrastructure_connection_run(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_expected_run_id uuid, p_recovered_at timestamp with time zone)`
- `recover_infrastructure_connection_credentials(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_encrypted_bundle text, p_key_version smallint)`
- `refresh_digitalocean_infrastructure_target(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_checked_at timestamp with time zone, p_target jsonb, p_error_code text)`
- `refresh_hivra_omarchy_native_capability(p_user_id text, p_computer_id uuid, p_generation uuid, p_observed_revision text, p_observed_at timestamp with time zone, p_expires_at timestamp with time zone)`
- `release_hetzner_first_boot_operation(p_user_id text, p_connection_id uuid, p_revision bigint, p_order_id uuid, p_attempt_id uuid, p_quote text, p_server text, p_lease_id uuid)`
- `release_hivra_agent_operation(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_error text, p_mark_error boolean)`
- `release_infrastructure_host_discovery(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_run_id uuid)`
- `renew_hivra_remote_desktop_session_by_token(p_session_token_hash text, p_ttl_seconds integer)`
- `request_hivra_agent_delete(p_user_id text, p_agent_id uuid, p_operation_id uuid)`
- `reserve_hivra_attachment_installation(p_owner text, p_operation_id uuid, p_expected_generation bigint, p_installation_id uuid, p_binding_id uuid, p_architecture text)`
- `reserve_hivra_launch_model_request(p_user_id text, p_request_id uuid, p_fingerprints jsonb, p_model_operation_id uuid, p_agent jsonb, p_selection jsonb, p_encrypted_key text)`
- `reserve_hivra_launch_model_request_v2(p_user_id text, p_request_id uuid, p_fingerprints jsonb, p_model_operation_id uuid, p_agent jsonb, p_selection jsonb, p_encrypted_key text)`
- `reserve_hivra_launch_operation(p_user_id text, p_request_id uuid, p_operation_id uuid, p_request_digest text, p_intent_digest text, p_resource_kind text, p_runtime_id text)`
- `reserve_hivra_native_installation(p_owner text, p_operation uuid, p_computer uuid, p_agent uuid, p_installation uuid, p_manifest text, p_control_origin text)`
- `reserve_windows_byo_iso_launch(p_user_id text, p_request_id uuid, p_request_digest text, p_media_evidence jsonb)`
- `resolve_hetzner_external_cleanup(p_user_id text, p_connection_id uuid, p_revision bigint, p_order_id uuid, p_idempotency_key uuid, p_server_name text, p_state_sha256 text, p_evidence jsonb)`
- `resolve_hivra_run_access_scope(p_owner text, p_id uuid)`
- `resolve_hivra_run_access_target(p_owner text, p_computer uuid, p_agent uuid, p_installation uuid)`
- `resolve_hivra_workspace_conversation(p_owner text, p_computer uuid, p_id uuid)`
- `resolve_hivra_workspace_conversation_target(p_owner text, p_computer uuid, p_agent uuid, p_installation uuid)`
- `retire_hivra_provider_target(p_user_id text, p_connection_id uuid, p_revision bigint, p_target_id uuid, p_order_id uuid, p_server_id text, p_agent_id uuid, p_operation_id uuid)`
- `revoke_hivra_remote_desktop_capability(p_user_id text, p_computer_kind text, p_computer_id uuid, p_generation uuid)`
- `revoke_hivra_remote_desktop_session(p_user_id text, p_session_id uuid, p_reason text)`
- `revoke_hivra_remote_desktop_session_by_token(p_session_token_hash text, p_reason text)`
- `revoke_hivra_workspace_conversation(p_owner text, p_computer uuid, p_id uuid, p_revision bigint)`
- `revoke_hivra_workspace_session(p_user text, p_id uuid)`
- `rewrap_encryption_surface_v2(p_surface text, p_id uuid, p_expected jsonb, p_patch jsonb)`
- `rewrap_legacy_encryption_row(p_surface text, p_id uuid, p_expected jsonb, p_patch jsonb)`
- `rotate_hivra_agent_llm_secret(p_id uuid, p_expected text, p_replacement text)`
- `rotate_infrastructure_connection_secret(p_connection_id uuid, p_expected_encrypted_bundle text, p_encrypted_bundle text, p_key_version smallint)`
- `seed_hivra_canonical_source_events(p_limit integer)`
- `set_hivra_canonical_inventory_read_mode(p_mode text)`
- `settle_hivra_buzz_leave(p_user_id text, p_binding_id uuid, p_lease_id uuid, p_receipt jsonb)`
- `settle_hivra_buzz_membership(p_user_id text, p_binding_id uuid, p_lease_id uuid, p_receipt jsonb)`
- `settle_hivra_buzz_runtime_install(p_user_id text, p_binding_id uuid, p_lease_id uuid, p_receipt jsonb)`
- `settle_hivra_buzz_runtime_remove(p_user_id text, p_binding_id uuid, p_lease_id uuid, p_receipt jsonb)`
- `settle_hivra_model_key_operation(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_lease_id uuid, p_receipt jsonb)`
- `settle_yearly_platform_token_payment(p_quote_id uuid, p_transaction_hash text, p_log_index integer, p_amount_raw numeric, p_block_timestamp timestamp with time zone, p_token_address text, p_now timestamp with time zone)`
- `settle_yearly_token_payment(p_quote_id uuid, p_transaction_hash text, p_log_index integer, p_amount_raw numeric, p_block_timestamp timestamp with time zone, p_now timestamp with time zone)`
- `stage_hetzner_first_boot(p_user_id text, p_connection_id uuid, p_revision bigint, p_order_id uuid, p_capacity_key uuid, p_attempt_id uuid, p_quote_fingerprint text, p_recipe_version text, p_issued_at timestamp with time zone, p_expires_at timestamp with time zone, p_verifier text, p_encrypted_token text, p_confirmation text)`
- `token_key_allowed_for_user(p_user_id text, p_token_key text, p_now timestamp with time zone)`
- `token_tier_row_counts_for_user(p_user_id text, p_token_key text, p_now timestamp with time zone)`
- `transfer_hivra_canonical_relationship_authority(p_owner text, p_computer_id uuid, p_expected_source_event_id bigint, p_expected_generation bigint, p_command_id uuid)`
- `update_infrastructure_capacity_policy(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_capacity_policy jsonb)`
- `update_infrastructure_connection(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_patch jsonb, p_operational_change boolean, p_rotate_credentials boolean, p_encrypted_bundle text, p_key_version smallint)`
- `upsert_hetzner_cloud_inventory_server(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_discovered_at timestamp with time zone, p_server jsonb)`
- `upsert_hivra_buzz_connection(p_user_id text, p_id uuid, p_relay_url text, p_http_origin text, p_relay_public_key text, p_display_name text, p_software text, p_relay_version text, p_requires_membership boolean)`
- `verify_hetzner_cleanup_lease(p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_order_id uuid, p_lease_id uuid)`
- `verify_hivra_provider_power_result(p_user_id text, p_agent_id uuid, p_operation_id uuid, p_observed_at timestamp with time zone, p_status text, p_boot_id uuid, p_runtime_ready boolean, p_public_ready boolean)`

### function_grants: only prod (3)

- `managed_venice_check_and_increment_user_rate_limit(p_user_id text, p_bucket_start timestamp with time zone, p_window_start timestamp with time zone, p_limit integer)`
- `managed_venice_cleanup_user_rate_limit_buckets(p_cutoff timestamp with time zone)`
- `operator_usage_tokens_total()`

### function_grants: differ (3)

- `record_cron_heartbeat(p_cron_name text)` — canary: anon=false authenticated=false service_role=true / prod: anon=true authenticated=true service_role=true
- `refresh_credit_account_cached_balance(p_account_id uuid)` — canary: anon=false authenticated=false service_role=true / prod: anon=true authenticated=true service_role=true
- `requesting_user_id()` — canary: anon=false authenticated=true service_role=true / prod: anon=true authenticated=true service_role=true

### policies: only canary (0)

- none

### policies: only prod (17)

- `instances.Service role can delete instances`
- `instances.Service role can insert instances`
- `instances.Service role can update instances`
- `instances.authenticated_select_own_instances`
- `instances.deny_anon_access`
- `instances.deny_authenticated_delete_instances`
- `instances.deny_authenticated_insert_instances`
- `instances.deny_authenticated_update_instances`
- `profiles.profiles_delete`
- `profiles.profiles_insert`
- `profiles.profiles_select`
- `profiles.profiles_update`
- `user_api_keys.Service role can manage all keys`
- `user_api_keys.authenticated_select_own_api_keys`
- `user_api_keys.deny_anon_access`
- `user_api_keys.deny_authenticated_insert_keys`
- `user_api_keys.deny_authenticated_update_keys`

### policies: differ (0)

- none

### table_grants: only canary (0)

- none

### table_grants: only prod (0)

- none

### table_grants: differ (34)

- `_deprecated_scheduled_tasks_20260511:anon` — canary: SELECT,INSERT,UPDATE,DELETE / prod: 
- `_deprecated_task_history_20260511:anon` — canary: SELECT,INSERT,UPDATE,DELETE / prod: 
- `agent_templates:anon` — canary: SELECT,INSERT,UPDATE,DELETE / prod: 
- `bankr_withdrawals:anon` — canary: SELECT,INSERT,UPDATE,DELETE / prod: 
- `channel_connections:anon` — canary: SELECT,INSERT,UPDATE,DELETE / prod: 
- `compute_usage_events:anon` — canary: SELECT,INSERT,UPDATE,DELETE / prod: 
- `credit_accounts:anon` — canary: SELECT,INSERT,UPDATE,DELETE / prod: 
- `credit_ledger_entries:anon` — canary: SELECT,INSERT,UPDATE,DELETE / prod: 
- `credit_reservations:anon` — canary: SELECT,INSERT,UPDATE,DELETE / prod: 
- `crypto_deposit_receipts:anon` — canary: SELECT,INSERT,UPDATE,DELETE / prod: 
- `hermes_chat_stream_jobs:anon` — canary: SELECT,INSERT,UPDATE,DELETE / prod: 
- `hivra_agent_events:anon` — canary: SELECT,INSERT,UPDATE,DELETE / prod: 
- `hivra_agents:authenticated` — canary:  / prod: SELECT,INSERT,UPDATE,DELETE
- `instance_bankr_wallet_recipients:anon` — canary: SELECT,INSERT,UPDATE,DELETE / prod: 
- `instance_bankr_wallets:anon` — canary: SELECT,INSERT,UPDATE,DELETE / prod: 
- `instance_deletion_archives:authenticated` — canary:  / prod: SELECT,INSERT,UPDATE,DELETE
- `instance_dormancy_archives:anon` — canary: SELECT,INSERT,UPDATE,DELETE / prod: 
- `instance_flags:anon` — canary: SELECT,INSERT,UPDATE,DELETE / prod: 
- `instances:anon` — canary: SELECT,INSERT,UPDATE,DELETE / prod: 
- `instances:authenticated` — canary: SELECT,INSERT,UPDATE,DELETE / prod: 
- `llm_usage_events:anon` — canary: SELECT,INSERT,UPDATE,DELETE / prod: 
- `payment_transactions:anon` — canary: SELECT,INSERT,UPDATE,DELETE / prod: 
- `platform_geo:anon` — canary: SELECT,INSERT,UPDATE,DELETE / prod: 
- `pools:anon` — canary: SELECT,INSERT,UPDATE,DELETE / prod: 
- `proxmox_hosts:anon` — canary: SELECT,INSERT,UPDATE,DELETE / prod: 
- `referral_attributions:authenticated` — canary:  / prod: SELECT,INSERT,UPDATE,DELETE
- `referral_codes:authenticated` — canary:  / prod: SELECT,INSERT,UPDATE,DELETE
- `signup_risk_assessments:anon` — canary: SELECT,INSERT,UPDATE,DELETE / prod: 
- `stripe_checkout_session_activations:anon` — canary: SELECT,INSERT,UPDATE,DELETE / prod: 
- `user_api_keys:authenticated` — canary: SELECT,INSERT,UPDATE,DELETE / prod: 
- `user_memory:anon` — canary: SELECT,INSERT,UPDATE,DELETE / prod: 
- `vm_response_seconds_daily:anon` — canary: SELECT,INSERT,UPDATE,DELETE / prod: 
- `workspace_cloud_handoff_codes:anon` — canary: SELECT,INSERT,UPDATE,DELETE / prod: 
- `workspace_cloud_subscriptions:anon` — canary: SELECT,INSERT,UPDATE,DELETE / prod: 

### triggers: only canary (30)

- `crypto_deposit_receipts.crypto_deposit_receipts_require_sweep`
- `hermes_instances.hivra_canonical_hermes_source_event`
- `hivra_agents.a_hivra_agents_operation_compatibility`
- `hivra_agents.hivra_agent_attachment_lease_guard`
- `hivra_agents.hivra_agents_delete_credential_guard`
- `hivra_agents.hivra_agents_deployment_authority_guard`
- `hivra_agents.hivra_agents_launch_model_cleanup`
- `hivra_agents.hivra_agents_launch_model_guard`
- `hivra_agents.hivra_agents_managed_provisioner_channel_guard`
- `hivra_agents.hivra_agents_model_key_cleanup`
- `hivra_agents.hivra_agents_model_key_guard`
- `hivra_agents.hivra_agents_provider_desktop_access_guard`
- `hivra_agents.hivra_agents_provider_desktop_lifecycle_guard`
- `hivra_agents.hivra_agents_provider_installer_guard`
- `hivra_agents.hivra_agents_provider_launch_model_guard`
- `hivra_agents.hivra_agents_provider_native_access_guard`
- `hivra_agents.hivra_agents_provider_native_lifecycle_guard`
- `hivra_agents.hivra_agents_provider_ownership_guard`
- `hivra_agents.hivra_agents_provider_power_guard`
- `hivra_agents.hivra_agents_provider_resize_guard`
- `hivra_agents.hivra_canonical_hivra_source_event`
- `hivra_agents.hivra_desktop_prepare_lease_guard`
- `hivra_agents.hivra_do_managed_session_guard`
- `hivra_agents.hivra_folder_recovery_lease_guard`
- `hivra_agents.hivra_gvisor_computer_guard`
- `hivra_agents.hivra_private_access_lease_guard`
- `hivra_agents.invalidate_hivra_workspace_sessions`
- `hivra_agents.retire_hivra_buzz_runtime_after_agent_delete`
- `managed_venice_proxy_keys.managed_venice_pending_model_guard`
- `user_api_keys.user_api_keys_updated_at`

### triggers: only prod (3)

- `instances.instances_updated_at`
- `instances.update_instances_updated_at`
- `user_api_keys.update_user_api_keys_updated_at_trigger`

### triggers: differ (0)

- none

### constraints: only canary (40)

- `crypto_deposit_receipts.crypto_deposit_receipts_sweep_attempts_check`
- `crypto_deposit_receipts.crypto_deposit_receipts_sweep_claim_check`
- `crypto_deposit_receipts.crypto_deposit_receipts_sweep_confirmed_check`
- `deposit_quotes.deposit_quotes_token_address_check`
- `deposit_quotes.deposit_quotes_token_key_check`
- `hermes_instances.hermes_instances_product_surface_check`
- `hivra_agents.hivra_agents_binding_token_hash_check`
- `hivra_agents.hivra_agents_canary_provisioner_binding_check`
- `hivra_agents.hivra_agents_computer_profile_check`
- `hivra_agents.hivra_agents_computer_substrate_check`
- `hivra_agents.hivra_agents_cpu_max_valid`
- `hivra_agents.hivra_agents_deployment_authority_matrix_check`
- `hivra_agents.hivra_agents_deployment_mode_check`
- `hivra_agents.hivra_agents_desired_state_check`
- `hivra_agents.hivra_agents_do_session_identity_check`
- `hivra_agents.hivra_agents_gvisor_observation_check`
- `hivra_agents.hivra_agents_managed_provisioner_channel_check`
- `hivra_agents.hivra_agents_operation_shape_check`
- `hivra_agents.hivra_agents_provider_capacity_order_id_fkey`
- `hivra_agents.hivra_agents_provider_enrollment_attempt_id_fkey`
- `hivra_agents.hivra_agents_provider_identity_check`
- `hivra_agents.hivra_agents_provider_install_shape_check`
- `hivra_agents.hivra_agents_ram_max_valid`
- `hivra_agents.hivra_agents_self_managed_binding_complete_check`
- `hivra_agents.hivra_agents_self_managed_target_fk`
- `hivra_agents.hivra_agents_windows_iso_source_check`
- `hivra_agents.hivra_provider_desktop_access_shape`
- `hivra_agents.hivra_provider_native_access_shape`
- `hivra_agents.hivra_provider_native_running_no_api_token`
- `hivra_agents.hivra_windows_byo_iso_shape_check`
- `managed_venice_token_lots.managed_venice_token_lots_token_address_check`
- `managed_venice_token_lots.managed_venice_token_lots_token_key_check`
- `managed_venice_token_quotes.managed_venice_token_quotes_token_address_check`
- `managed_venice_token_quotes.managed_venice_token_quotes_token_key_check`
- `token_entitlement_configs.token_entitlement_configs_token_key_check`
- `token_tier_qualifications.token_tier_qualifications_token_key_check`
- `yearly_token_quotes.yearly_token_quotes_token_address_check`
- `yearly_token_quotes.yearly_token_quotes_token_key_check`
- `yearly_token_subscriptions.yearly_token_subscriptions_token_address_check`
- `yearly_token_subscriptions.yearly_token_subscriptions_token_key_check`

### constraints: only prod (6)

- `instances.instances_billing_mode_check`
- `instances.instances_pending_restore_backup_id_fkey`
- `instances.instances_pool_server_id_fkey`
- `instances.instances_subdomain_key`
- `instances.instances_user_id_fkey`
- `profiles.profiles_instance_id_name_key`

### constraints: differ (10)

- `credit_ledger_entries.credit_ledger_entries_source_check` — canary: c:84b7ae5dfaef33912aa8cad4dfc83c59 / prod: c:55e1cc974855ade20f499469748cb559
- `managed_venice_financial_events.managed_venice_financial_events_wallet_type_check` — canary: c:d2f0eccddacfee868c3e96f22c799a38 / prod: c:4d0c1098bf7f038d891a0fb6f2dbab84
- `managed_venice_reservations.managed_venice_reservations_wallet_type_check` — canary: c:d2f0eccddacfee868c3e96f22c799a38 / prod: c:4d0c1098bf7f038d891a0fb6f2dbab84
- `managed_venice_token_lots.managed_venice_token_lots_source_check` — canary: c:f398220f891c55e548c5dafa19e10058 / prod: c:1b641e246c1afc23426bf855ec87cd3a
- `managed_venice_usage_events.managed_venice_usage_events_wallet_type_check` — canary: c:d2f0eccddacfee868c3e96f22c799a38 / prod: c:4d0c1098bf7f038d891a0fb6f2dbab84
- `managed_venice_wallet_accounts.managed_venice_wallet_accounts_default_payment_wallet_check` — canary: c:f237a67040d432f894fc20aa461839f8 / prod: c:ee6a0401c3dfd2eabcd28bcf1013839f
- `token_entitlement_configs.token_entitlement_configs_pkey` — canary: p:9ec9d784a36df44481e93ba1936c56e7 / prod: p:e875d9cd77e0162792f8c8dd01610802
- `yearly_token_quotes.yearly_token_quotes_status_check` — canary: c:65935cb0afac3f5ac79ec237e2f9255f / prod: c:5f74b69dcdd8eb594ae4b9e7ce9cc812
- `yearly_token_subscriptions.yearly_token_subscriptions_status_check` — canary: c:e14f09efd65ed50c046c224dedc5e90d / prod: c:d646a60396dcaf0a093065fe7d0ca090
- `yearly_token_subscriptions.yearly_token_subscriptions_sweep_status_check` — canary: c:6ed78a48b2775278c953622db8ab8ba9 / prod: c:81b45e60721bd7fe044db48e481b20e5

### indexes: only canary (29)

- `churn_surveys.idx_churn_surveys_created_at`
- `churn_surveys.idx_churn_surveys_user`
- `crypto_deposit_receipts.crypto_deposit_receipts_sweep_tx_hash_key`
- `hermes_instances.idx_hermes_instances_daily_brief_unseeded`
- `hermes_instances.idx_hermes_instances_standing_task_unseeded`
- `hermes_subscriptions.idx_hermes_subs_upgraded_at`
- `hivra_agents.hivra_agents_active_self_managed_target_vmid_idx`
- `hivra_agents.hivra_agents_computer_profile_idx`
- `hivra_agents.hivra_agents_deployment_target_idx`
- `hivra_agents.hivra_agents_do_launch_request_unique`
- `hivra_agents.hivra_agents_do_session_name_unique`
- `hivra_agents.hivra_agents_gvisor_launch_request_unique`
- `hivra_agents.hivra_agents_gvisor_sandbox_unique`
- `hivra_agents.hivra_agents_infrastructure_connection_idx`
- `hivra_agents.hivra_agents_provider_order_unique`
- `hivra_agents.hivra_agents_provider_target_unique`
- `managed_venice_reconciliation_items.uq_managed_venice_reconciliation_items_dedupe_key`
- `managed_venice_token_quotes.ix_managed_venice_token_quotes_deposit_address_quoted_at`
- `managed_venice_token_quotes.ix_managed_venice_token_quotes_transfer_surfacing_pending`
- `managed_venice_token_quotes.uq_managed_venice_token_quotes_address_transfer_binding`
- `referral_attributions.idx_referral_attributions_referrer`
- `referral_attributions.idx_referral_attributions_status`
- `referral_codes.idx_referral_codes_code`
- `yearly_token_quotes.ix_yearly_token_quotes_attribution_open`
- `yearly_token_quotes.ix_yearly_token_quotes_user_quoted_at`
- `yearly_token_quotes.uq_yearly_token_quotes_consumed_transfer`
- `yearly_token_subscriptions.ix_yearly_token_subscriptions_sweep_queue`
- `yearly_token_subscriptions.uq_yearly_token_subscriptions_deposit_transfer`
- `yearly_token_subscriptions.uq_yearly_token_subscriptions_yearly_quote_id`

### indexes: only prod (9)

- `hermes_subscriptions.hermes_subscriptions_trial_expiry_due_idx`
- `instances.idx_instances_subdomain`
- `instances.instances_status_idx`
- `instances.instances_subdomain_key`
- `instances.instances_user_id_idx`
- `instances.ix_instances_pending_restore_backup_id`
- `managed_venice_reservations.managed_venice_reservations_created_idx`
- `profiles.profiles_instance_id_name_key`
- `user_api_keys.idx_user_api_keys_provider`

### indexes: differ (2)

- `hivra_agents.hivra_agents_active_proxmox_host_vmid_idx` — canary: 4a97a47c6413a32673eef9f92fcc5d41 / prod: a2374faba29ef500c369d87de0e14e54
- `token_entitlement_configs.token_entitlement_configs_pkey` — canary: 1a2e3016c9a5507f1de29250b4334b48 / prod: 1a64e5ca11f85c6e570c00df8b26b215

### enums: only canary (0)

- none

### enums: only prod (0)

- none

### enums: differ (0)

- none

### extensions: only canary (0)

- none

### extensions: only prod (3)

- `pg_cron`
- `pg_net`
- `pgmq`

### extensions: differ (0)

- none

### buckets: only canary (0)

- none

### buckets: only prod (3)

- `avatars`
- `blog-images`
- `openclaw-backups`

### buckets: differ (0)

- none

### SECURITY DEFINER callable by anon/authenticated on canary (0)

- none

### SECURITY DEFINER callable by anon/authenticated on prod (2)

- `record_cron_heartbeat(p_cron_name text)`
- `refresh_credit_account_cached_balance(p_account_id uuid)`

### RLS disabled on canary (0)

- none

### RLS disabled on prod (0)

- none


</details>

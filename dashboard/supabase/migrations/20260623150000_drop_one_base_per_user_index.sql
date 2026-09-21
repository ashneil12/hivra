-- Reverse migration 20260623120000_hermes_instances_one_base_per_user_index.
--
-- The partial unique index uq_hermes_instances_one_base_per_user was found to
-- be unsound: its predicate (resource_tier IN ('free','credit_base',
-- 'token_base') AND status <> 'deleted') does not match the real lifecycle of
-- a base instance — rows legitimately transition through non-'deleted' states
-- for more than one base instance per user (e.g. a re-create while the prior
-- row is still 'archived'/'stopped'), so the index would reject valid writes
-- and surface as a spurious 23505. The race it was meant to backstop is being
-- handled at the application layer instead, so the index and its create-path
-- 23505 mapping have been removed (see instance-service.ts in the same change).
--
-- Migrations are append-only, so rather than editing 20260623120000 we drop the
-- index here. IF EXISTS keeps this idempotent and safe whether or not the index
-- was ever applied (it was never applied to prod or canary).

DROP INDEX IF EXISTS uq_hermes_instances_one_base_per_user;

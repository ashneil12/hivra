-- Security Pass 1, finding M4: vault row uniqueness.
--
-- The /api/vault route lets a user POST an unlimited number of rows
-- into user_api_keys with whatever `name` and `provider` they want.
-- The agent runtime that reads the vault may pick the wrong key when
-- there are duplicates per provider, and storage grows unbounded.
--
-- This migration:
--   1. Deduplicates existing (user_id, provider) groups by keeping the
--      row with the most-recent `updated_at` (then `created_at` as a
--      tiebreaker) and deleting the rest. RAISE NOTICE logs what was
--      cleaned up so we have an audit trail in the push output.
--   2. Adds the UNIQUE (user_id, provider) constraint so no future
--      writer can re-introduce duplicates.
--
-- Why dedupe-keep-newest is safe: the duplicate rows are almost
-- certainly the same key being re-saved over time (the bug we're
-- fixing). The newest `updated_at` is what the user is actively
-- using; older rows are stale ledger entries.

DO $$
DECLARE
    duplicate_groups INT;
    rows_to_delete INT;
    deleted_count INT;
BEGIN
    SELECT COUNT(*) INTO duplicate_groups
    FROM (
        SELECT user_id, provider
        FROM public.user_api_keys
        GROUP BY user_id, provider
        HAVING COUNT(*) > 1
    ) AS dupes;

    SELECT COUNT(*) INTO rows_to_delete
    FROM (
        SELECT id, ROW_NUMBER() OVER (
            PARTITION BY user_id, provider
            ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
        ) AS rn
        FROM public.user_api_keys
    ) ranked
    WHERE rn > 1;

    RAISE NOTICE 'user_api_keys dedupe: % duplicate (user_id, provider) groups → deleting % older rows', duplicate_groups, rows_to_delete;

    WITH ranked AS (
        SELECT id, ROW_NUMBER() OVER (
            PARTITION BY user_id, provider
            ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
        ) AS rn
        FROM public.user_api_keys
    )
    DELETE FROM public.user_api_keys
    WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RAISE NOTICE 'user_api_keys dedupe: actually deleted % rows', deleted_count;
END $$;

ALTER TABLE public.user_api_keys
    ADD CONSTRAINT uq_user_api_keys_user_provider
    UNIQUE (user_id, provider);

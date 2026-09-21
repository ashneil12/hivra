-- Add `backend` discriminator to hermes_instances so dashboard can dispatch chat
-- routes to either the legacy gateway/PATCH-001 overlay or hermes-webui.
--
-- Defaults to 'gateway' for backwards compatibility. New provisioning flows
-- set 'webui' explicitly when the WebUI-mode image is used.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'hermes_instances'
      AND column_name = 'backend'
  ) THEN
    ALTER TABLE public.hermes_instances
      ADD COLUMN backend TEXT NOT NULL DEFAULT 'gateway'
        CHECK (backend IN ('gateway', 'webui'));

    COMMENT ON COLUMN public.hermes_instances.backend IS
      'Per-instance chat backend. "gateway" = vanilla-hermes-agent fork with PATCH-001 dashboard overlay. "webui" = hermes-webui Docker image (Phase 2 migration target).';

    CREATE INDEX IF NOT EXISTS idx_hermes_instances_backend ON public.hermes_instances(backend);
  END IF;
END $$;

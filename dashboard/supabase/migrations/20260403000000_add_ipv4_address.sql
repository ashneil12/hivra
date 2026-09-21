-- Add ipv4_address to hermes_instances for direct access tracking
ALTER TABLE hermes_instances ADD COLUMN IF NOT EXISTS ipv4_address text;

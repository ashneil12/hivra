ALTER TABLE hermes_hosts
    ADD COLUMN IF NOT EXISTS ipv4_address text,
    ADD COLUMN IF NOT EXISTS ssh_host_fingerprint_sha256 text;

ALTER TABLE hermes_instances
    ADD COLUMN IF NOT EXISTS ipv4_address text,
    ADD COLUMN IF NOT EXISTS ssh_host_fingerprint_sha256 text;

CREATE INDEX IF NOT EXISTS hermes_hosts_ipv4_address_idx ON hermes_hosts(ipv4_address);
CREATE INDEX IF NOT EXISTS hermes_instances_ipv4_address_idx ON hermes_instances(ipv4_address);

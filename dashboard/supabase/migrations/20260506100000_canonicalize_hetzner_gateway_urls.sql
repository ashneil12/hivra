-- Hetzner instances must use self-resolving sslip.io gateway hostnames.
--
-- Root cause behind the 2026-05-06 Hermes prat outage: an old redeploy path
-- persisted a custom hermesos.cloud hostname for a Hetzner instance, but no
-- DNS record was ever created for that hostname. The app-level provisioning
-- path already returns sslip.io for Hetzner; this trigger makes the invariant
-- database-level so side scripts, redeploy paths, and manual updates cannot
-- reintroduce an NXDOMAIN gateway_url.

create or replace function public.hermes_instances_canonicalize_hetzner_gateway_url()
returns trigger
language plpgsql
as $$
declare
  canonical_gateway_url text;
begin
  if (new.hetzner_server_id is not null or new.infrastructure_provider = 'hetzner')
     and nullif(trim(new.ipv4_address), '') is not null then
    canonical_gateway_url := 'https://' || replace(trim(new.ipv4_address), '.', '-') || '.sslip.io';

    if new.gateway_url is distinct from canonical_gateway_url then
      new.gateway_url := canonical_gateway_url;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists hermes_instances_canonicalize_hetzner_gateway_url_trg
  on public.hermes_instances;

create trigger hermes_instances_canonicalize_hetzner_gateway_url_trg
before insert or update of gateway_url, ipv4_address, hetzner_server_id, infrastructure_provider
on public.hermes_instances
for each row
execute function public.hermes_instances_canonicalize_hetzner_gateway_url();

update public.hermes_instances
set gateway_url = 'https://' || replace(trim(ipv4_address), '.', '-') || '.sslip.io'
where (hetzner_server_id is not null or infrastructure_provider = 'hetzner')
  and nullif(trim(ipv4_address), '') is not null
  and gateway_url is distinct from 'https://' || replace(trim(ipv4_address), '.', '-') || '.sslip.io';

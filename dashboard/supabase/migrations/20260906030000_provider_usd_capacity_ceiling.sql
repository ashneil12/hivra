-- Align the shared USD monthly rate ceiling with current provider offers.
-- Preserve original owner, identity, disk, expiry and explicit billing checks.
create or replace function public.hivra_provider_resize_quote_valid(
  p_quote jsonb,
  p_operation_id uuid,
  p_agent_id uuid,
  p_provider_server_id text,
  p_quote_fingerprint text,
  p_observed_at timestamptz,
  p_expires_at timestamptz
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_existing_disk numeric;
  v_observed timestamptz;
  v_expires timestamptz;
begin
  if jsonb_typeof(p_quote) is distinct from 'object'
    or (p_quote - array['operationId','quoteFingerprint','agentId','providerServerId','location','source','target',
      'existingDiskGb','upgradeDisk','observedAt','expiresAt','downtimeNotice','billingConfirmation']) <> '{}'::jsonb
    or p_quote->>'operationId' is distinct from p_operation_id::text
    or p_quote->>'agentId' is distinct from p_agent_id::text
    or p_quote->>'providerServerId' is distinct from p_provider_server_id
    or p_quote->>'quoteFingerprint' is distinct from p_quote_fingerprint
    or coalesce(p_quote->>'location','') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    or p_quote->'upgradeDisk' is distinct from 'false'::jsonb
    or p_quote->>'billingConfirmation' is distinct from 'Resize this server and accept the new Hetzner billing'
    or p_quote->>'downtimeNotice' is distinct from
      'The computer must stay powered off while Hetzner changes its server type. Hivra leaves it stopped after the resize so you can review the result before starting it again.'
    or public.hivra_provider_resize_size_valid(p_quote->'source') is distinct from true
    or public.hivra_provider_resize_size_valid(p_quote->'target') is distinct from true
    or p_quote#>>'{source,serverType}' is not distinct from p_quote#>>'{target,serverType}'
    or p_quote#>>'{source,architecture}' is distinct from p_quote#>>'{target,architecture}'
    or p_quote#>>'{source,price,currency}' is distinct from p_quote#>>'{target,price,currency}'
    or jsonb_typeof(p_quote->'existingDiskGb') is distinct from 'number'
  then
    return false;
  end if;
  begin
    v_existing_disk := (p_quote->>'existingDiskGb')::numeric;
    v_observed := (p_quote->>'observedAt')::timestamptz;
    v_expires := (p_quote->>'expiresAt')::timestamptz;
  exception when others then
    return false;
  end;
  return v_observed is not distinct from p_observed_at
    and v_expires is not distinct from p_expires_at
    and p_expires_at is not distinct from p_observed_at + interval '5 minutes'
    and v_existing_disk = trunc(v_existing_disk)
    and v_existing_disk between 1 and 9007199254740991
    and (p_quote#>>'{target,cores}')::numeric between 2 and 8
    and (p_quote#>>'{target,memoryGb}')::numeric between 4 and 32
    and (p_quote#>>'{target,advertisedDiskGb}')::numeric <= 320
    and (p_quote#>>'{target,price,monthlyGross}')::numeric
      <= case p_quote#>>'{target,price,currency}' when 'EUR' then 45 else 60 end
    and (p_quote#>>'{source,advertisedDiskGb}')::numeric >= v_existing_disk
    and (p_quote#>>'{target,advertisedDiskGb}')::numeric >= v_existing_disk;
end;
$$;

-- Windows does not expose Linux's /proc boot UUID. Accept its inspected
-- SHA-256 boot identity in the existing desktop-preparation terminal receipt.

create or replace function public.complete_hivra_desktop_prepare(p_user_id text,p_operation_id uuid,p_receipt jsonb)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype; p public.hivra_desktop_preparations%rowtype; success boolean;
begin
  select * into p from public.hivra_desktop_preparations where id=p_operation_id and user_id=p_user_id;
  if not found then return false; end if;
  select * into a from public.hivra_agents where id=p.agent_id and user_id=p_user_id for update;
  if not found or public.hivra_desktop_prepare_authority(a) is distinct from p.authority then return false; end if;
  select * into p from public.hivra_desktop_preparations where id=p_operation_id for update;
  if p.phase in ('complete','failed') then return p.terminal_receipt=p_receipt; end if;
  if p.phase<>'dispatched' or a.operation_id is distinct from p.id or a.operation_kind is distinct from 'desktop_prepare'
    or jsonb_typeof(p_receipt) is distinct from 'object'
    or p_receipt-array['version','operationId','computerId','vmid','guestIp','bindingTag','bootId','exitCode']<>'{}'::jsonb
    or p_receipt->'version' is distinct from '1'::jsonb or p_receipt->>'operationId' is distinct from p.id::text
    or p_receipt->>'computerId' is distinct from a.id::text or p_receipt->'vmid' is distinct from to_jsonb(a.vmid)
    or p_receipt->>'guestIp' is distinct from a.ip
    or p_receipt->>'bindingTag' is distinct from 'hivra-bind-'||left(a.infrastructure_binding_token_hash,32)
    or not coalesce(
      p_receipt->>'bootId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or (a.computer_profile='windows' and p_receipt->>'bootId' ~ '^[a-f0-9]{64}$'),
      false
    )
    or jsonb_typeof(p_receipt->'exitCode') is distinct from 'number'
    or not coalesce(p_receipt->>'exitCode' ~ '^(0|[1-9][0-9]{0,2})$',false)
  then return false; end if;
  if (p_receipt->>'exitCode')::integer>255 then return false; end if;
  success=(p_receipt->>'exitCode')::integer=0;
  update public.hivra_desktop_preparations set phase=case when success then 'complete' else 'failed' end,
    completed_at=clock_timestamp(),terminal_receipt=p_receipt where id=p.id;
  update public.hivra_agents set operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null,
    error=case when success then null else 'Desktop preparation failed. The guest installer stopped; inspect Desktop before retrying.' end
    where id=a.id;
  return true;
end;
$$;

revoke all on function public.complete_hivra_desktop_prepare(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.complete_hivra_desktop_prepare(text,uuid,jsonb) to service_role;

-- First-boot evidence remains retained after setup. Permit only the verified
-- successor-shape publication enforced by guard_hivra_provider_current_shape;
-- it is not a new setup lease or permission to change creation receipts.
create or replace function public.guard_first_boot_operation_order()
returns trigger language plpgsql set search_path=public,pg_temp as $$
declare v_operation public.infrastructure_first_boot_operations%rowtype;
begin
  select * into v_operation from public.infrastructure_first_boot_operations where order_id=old.id;
  if not found then
    if tg_op='DELETE' then return old; end if;
    if new.cleanup_firewall_receipt is not null then
      raise exception 'No owned first-boot firewall' using errcode='55006'; end if;
    return new;
  end if;
  if tg_op='DELETE' then raise exception 'Retain first-boot resource evidence' using errcode='55006'; end if;
  if new.status in ('cleaning','deleted','cleanup_abandoned') then
    if v_operation.lease_expires_at>clock_timestamp() then
      raise exception 'First-boot setup is still leased' using errcode='55006'; end if;
    if v_operation.firewall_post_attempted_at is not null and (v_operation.firewall_receipt is null
      or new.cleanup_firewall_receipt is distinct from v_operation.firewall_receipt) then
      raise exception 'First-boot firewall requires complete resource cleanup' using errcode='55006'; end if;
    if v_operation.firewall_post_attempted_at is null and new.cleanup_firewall_receipt is not null then
      raise exception 'No owned first-boot firewall' using errcode='55006'; end if;
    if old.status='created_off' and (new.status<>'cleaning' or new.cleanup_lease_id is null
      or new.cleanup_lease_expires_at<=clock_timestamp()) then
      raise exception 'First-boot cleanup requires an owned lease' using errcode='55006'; end if;
    return new;
  end if;
  -- A completed resize updates only its chained shape. The separate shape
  -- trigger checks the exact owner/order/server, terminal operation, quote,
  -- fingerprint, retained disk and stopped observation. Active setup still wins.
  if (v_operation.lease_expires_at is null or v_operation.lease_expires_at<=clock_timestamp())
    and old.status='created_off' and new.status='created_off'
    and new.current_server_shape is not null
    and new.current_server_shape_fingerprint_sha256 is not null
    and row(old.current_server_shape,old.current_server_shape_fingerprint_sha256)
      is distinct from row(new.current_server_shape,new.current_server_shape_fingerprint_sha256)
    and (to_jsonb(old)-array['current_server_shape','current_server_shape_fingerprint_sha256','updated_at'])
      is not distinct from (to_jsonb(new)-array['current_server_shape','current_server_shape_fingerprint_sha256','updated_at'])
  then return new; end if;
  if v_operation.abandoned_at is null
    and (v_operation.lease_expires_at>clock_timestamp() or v_operation.firewall_post_attempted_at is not null)
    and (to_jsonb(old)-array['updated_at','provider_observed_at','observed_server_status','last_error_code'])
      is distinct from (to_jsonb(new)-array['updated_at','provider_observed_at','observed_server_status','last_error_code']) then
    raise exception 'First-boot setup owns the capacity order' using errcode='55006'; end if;
  return new;
end;
$$;

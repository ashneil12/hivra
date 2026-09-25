-- The final step of attach's database work (docs/superpowers/specs/
-- 2026-09-24-agent-computer-contract-and-attach.md, 5.6 and build step 8):
-- service_role may EXECUTE exactly the functions the attach routes and the
-- minute worker call. public, anon and authenticated stay revoked on every
-- one of them, and every attach table keeps RLS on with no client grant.
--
-- The application keeps the routes and the worker behind a Canary-only switch
-- (deployment channel), so on production these grants are reachable only by
-- code that is switched off there.
--
-- Rollout: additive. Apply together with the lifecycle migration, before the
-- code that calls these functions serves. Idempotent.

-- Called by the attach routes and the minute worker.
revoke all on function public.read_hivra_agent_attach_target(text,uuid),
  public.claim_hivra_agent_attachment(text,uuid,uuid,uuid,jsonb,jsonb,integer),
  public.dispatch_hivra_agent_attachment_v2(text,uuid,uuid,bigint,jsonb,text),
  public.cancel_hivra_agent_attachment(text,uuid,text),
  public.dispatch_hivra_attachment_activation_v2(text,uuid,uuid,bigint,jsonb,uuid,jsonb,text,text,text,text),
  public.read_hivra_attachment_instance_token(text,uuid),
  public.complete_hivra_agent_attachment(text,uuid,bigint,jsonb,uuid),
  public.fail_hivra_agent_attachment(text,uuid,bigint,jsonb,jsonb,text),
  public.record_hivra_attachment_contract(text,uuid,integer,text,text,text,jsonb,jsonb),
  public.begin_hivra_agent_attachment_operation(text,uuid,uuid,text,jsonb,jsonb,text),
  public.dispatch_hivra_agent_attachment_operation(text,uuid),
  public.cancel_hivra_agent_attachment_operation(text,uuid),
  public.complete_hivra_agent_attachment_operation(text,uuid,jsonb),
  public.fail_hivra_agent_attachment_operation(text,uuid,text,jsonb),
  public.read_hivra_agent_attachments(text,uuid),
  public.read_hivra_owner_attached_agents(text),
  public.list_open_hivra_agent_attachment_work(integer),
  public.read_hivra_agent_attachment_state(text,uuid),
  public.read_hivra_agent_attachment_operation(text,uuid)
  from public,anon,authenticated;
grant execute on function public.read_hivra_agent_attach_target(text,uuid),
  public.claim_hivra_agent_attachment(text,uuid,uuid,uuid,jsonb,jsonb,integer),
  public.dispatch_hivra_agent_attachment_v2(text,uuid,uuid,bigint,jsonb,text),
  public.cancel_hivra_agent_attachment(text,uuid,text),
  public.dispatch_hivra_attachment_activation_v2(text,uuid,uuid,bigint,jsonb,uuid,jsonb,text,text,text,text),
  public.read_hivra_attachment_instance_token(text,uuid),
  public.complete_hivra_agent_attachment(text,uuid,bigint,jsonb,uuid),
  public.fail_hivra_agent_attachment(text,uuid,bigint,jsonb,jsonb,text),
  public.record_hivra_attachment_contract(text,uuid,integer,text,text,text,jsonb,jsonb),
  public.begin_hivra_agent_attachment_operation(text,uuid,uuid,text,jsonb,jsonb,text),
  public.dispatch_hivra_agent_attachment_operation(text,uuid),
  public.cancel_hivra_agent_attachment_operation(text,uuid),
  public.complete_hivra_agent_attachment_operation(text,uuid,jsonb),
  public.fail_hivra_agent_attachment_operation(text,uuid,text,jsonb),
  public.read_hivra_agent_attachments(text,uuid),
  public.read_hivra_owner_attached_agents(text),
  public.list_open_hivra_agent_attachment_work(integer),
  public.read_hivra_agent_attachment_state(text,uuid),
  public.read_hivra_agent_attachment_operation(text,uuid)
  to service_role;

-- The existing staging chain the worker drives (reservation, boot observation,
-- staging result, activation observation). Reads were already service-only.
revoke all on function public.reserve_hivra_attachment_installation(text,uuid,bigint,uuid,uuid,text),
  public.observe_hivra_attachment_guest(text,uuid,bigint,jsonb,uuid,text),
  public.record_hivra_attachment_staging_result(text,uuid,bigint,jsonb,uuid,jsonb),
  public.record_hivra_attachment_activation_observation(text,uuid,bigint,jsonb,jsonb,uuid,jsonb)
  from public,anon,authenticated;
grant execute on function public.reserve_hivra_attachment_installation(text,uuid,bigint,uuid,uuid,text),
  public.observe_hivra_attachment_guest(text,uuid,bigint,jsonb,uuid,text),
  public.record_hivra_attachment_staging_result(text,uuid,bigint,jsonb,uuid,jsonb),
  public.record_hivra_attachment_activation_observation(text,uuid,bigint,jsonb,jsonb,uuid,jsonb)
  to service_role;

-- The v1 begin, dispatch and activation, and the authority transfer on its
-- own, stay closed to every role: v1 admission has no plan limit or review,
-- its app-server unit is retired, and the transfer runs only inside the claim.
revoke all on function public.begin_hivra_agent_attachment(text,uuid,uuid,bigint,jsonb,jsonb),
  public.dispatch_hivra_agent_attachment(text,uuid,uuid,bigint,jsonb,text),
  public.cancel_undispatched_hivra_agent_attachment(text,uuid),
  public.dispatch_hivra_attachment_activation(text,uuid,uuid,bigint,jsonb,uuid,jsonb,text,text),
  public.transfer_hivra_canonical_relationship_authority(text,uuid,bigint,bigint,uuid)
  from public,anon,authenticated,service_role;

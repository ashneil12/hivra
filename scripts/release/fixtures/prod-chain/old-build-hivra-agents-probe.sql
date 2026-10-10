-- Old-build write probe for public.hivra_agents.
--
-- Each block (introduced by "-- @probe <label>") runs in its own transaction
-- that is ALWAYS rolled back. They use only the columns that existed before the
-- chain, which is all the build that was live before the cutover knows about,
-- and only the lifecycle moves it made: create, mark running, stop and start,
-- record an error, soft delete, hard delete, and the same moves on rows that
-- already existed. The harness runs every block as service_role with the
-- service_role JWT claims set, which is how the live build reaches the database.
--
-- Before the chain every block passes. After the chain, a block that is
-- REJECTED names a guard the old build would trip over.

-- @probe insert-provisioning
insert into public.hivra_agents (user_id, type, name, status, proxmox_host, cpu, ram)
values ('probe_user', 'hermes', 'probe-insert', 'provisioning', 'local', 1, 4);

-- @probe insert-claude-code
insert into public.hivra_agents (user_id, type, name, status, proxmox_host, cpu, ram)
values ('probe_user', 'claude-code', 'probe-insert-cc', 'provisioning', 'node-1', 2, 8);

-- @probe mark-running
insert into public.hivra_agents (id, user_id, type, name, status, proxmox_host, cpu, ram)
values ('00000000-0000-4000-8000-0000000000a1', 'probe_user', 'hermes', 'probe-run', 'provisioning', 'node-1', 1, 4);
update public.hivra_agents
   set status = 'running', vmid = 9001, ip = 'probe-host-1', chat_url = 'https://probe.example.invalid',
       api_token = 'tok_probe', provisioned_at = now()
 where id = '00000000-0000-4000-8000-0000000000a1';

-- @probe stop-and-start
insert into public.hivra_agents (id, user_id, type, name, status, proxmox_host, vmid, ip, chat_url, api_token, provisioned_at)
values ('00000000-0000-4000-8000-0000000000a2', 'probe_user', 'hermes', 'probe-cycle', 'running', 'node-1', 9002, 'probe-host-2', 'https://probe2.example.invalid', 'tok_probe2', now());
update public.hivra_agents set status = 'stopped' where id = '00000000-0000-4000-8000-0000000000a2';
update public.hivra_agents set status = 'running' where id = '00000000-0000-4000-8000-0000000000a2';

-- @probe record-error
insert into public.hivra_agents (id, user_id, type, name, status, proxmox_host)
values ('00000000-0000-4000-8000-0000000000a3', 'probe_user', 'codex', 'probe-error', 'provisioning', 'local');
update public.hivra_agents set status = 'error', error = 'provision timed out' where id = '00000000-0000-4000-8000-0000000000a3';

-- @probe soft-delete
insert into public.hivra_agents (id, user_id, type, name, status, proxmox_host, vmid)
values ('00000000-0000-4000-8000-0000000000a4', 'probe_user', 'hermes', 'probe-soft', 'running', 'node-1', 9004);
update public.hivra_agents set status = 'deleted', vmid = null where id = '00000000-0000-4000-8000-0000000000a4';

-- @probe hard-delete
insert into public.hivra_agents (id, user_id, type, name, status, proxmox_host)
values ('00000000-0000-4000-8000-0000000000a5', 'probe_user', 'hermes', 'probe-hard', 'error', 'local');
delete from public.hivra_agents where id = '00000000-0000-4000-8000-0000000000a5';

-- @probe update-existing-row
update public.hivra_agents set error = 'probe', status = 'stopped'
 where id = (select id from public.hivra_agents where status = 'running' order by created_at limit 1);

-- @probe delete-existing-row
delete from public.hivra_agents
 where id = (select id from public.hivra_agents where status = 'deleted' order by created_at limit 1);

-- ---------------------------------------------------------------------------
-- CONTROLS. These are NOT old-build writes. They prove the probe can see a
-- guard at all: each is rejected while the guards are in place and accepted
-- once the down plan has removed them.

-- @probe control-bogus-deployment-mode
insert into public.hivra_agents (user_id, type, name, status, proxmox_host, deployment_mode)
values ('probe_user', 'hermes', 'control-mode', 'provisioning', 'local', 'not-a-mode');

-- @probe control-flip-substrate
update public.hivra_agents set computer_substrate = 'provider-vm'
 where id = (select id from public.hivra_agents where status = 'running' order by created_at limit 1);

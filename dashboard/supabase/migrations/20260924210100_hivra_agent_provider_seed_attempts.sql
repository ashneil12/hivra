-- Launch seeds for Claude Code and Codex on a computer in the owner's own cloud
-- (provider VMs) run in the background after an agent page loads. Each
-- attempt reaches the computer over its enrolled provider pin, so an attempt
-- is claimed first: this column records when the last one started, and a
-- conditional update on it lets exactly one request try at a time and makes
-- the next try wait (dashboard/src/lib/hivra/provider-agent-upkeep.ts).
--
-- Only the service role writes it. It holds a time, nothing secret, and no
-- workspace session or lifecycle guard reads it.
--
-- Idempotent: every statement can be re-run.

alter table public.hivra_agents
  add column if not exists provider_seed_attempted_at timestamptz;

comment on column public.hivra_agents.provider_seed_attempted_at is
  'When Hivra last started sending the launch seeds to this provider computer. Claimed with a conditional update so attempts never overlap and a retry waits.';

# Hivra Marketplace — Architecture Seams (design-only, Phase 7)

**Status:** Design only. Nothing here is built. The point of this doc is to make sure
the V1 data model + catalog do NOT have to be redesigned when the marketplace ships.

The future: an **App Store for AI workers** — discover agents built by the community,
deploy in one click, publish your own, and monetise usage (settled in $HermesOS).
"Today you launch agents. Tomorrow you'll discover, deploy, and monetise them."

---

## Seams already in place after V1 (do not break)

| Seam | Where | Why it's marketplace-ready |
|---|---|---|
| **Agent-type registry** | `lib/hivra/agent-catalog.ts` (`AGENTS`) | The catalog is already the single list of "what you can launch", with per-type `minCpu/minRam/minPlan/weight/browser`. A marketplace is this list, sourced from a table instead of a constant. |
| **Authoritative slots/priority** | `lib/subscription/agent-slots.ts` | Slot + priority limits are centralized — community agents consume the same pool budget; no per-agent billing rewrite needed. |
| **Pool = user budget** | `pools` table | Installing a marketplace agent just spends pool budget like any other agent (one VM each). No new accounting. |
| **Unified read model** | `lib/hivra/unified-agent.ts` | Any agent type (builtin or community) normalizes into `UnifiedAgent` for the dashboard. |
| **Lifecycle telemetry** | `hivra_agent_events` | `launch_requested/provisioned/...` already capture per-agent usage — the basis for usage-based payouts. |

---

## Usage and cost records in place now (no payouts)

Added 2026-11-12 (migration `20261112230000_agent_usage_and_host_costs`). Records
only: nothing here bills, pays or switches anything on. Service role only.

| Record | What it holds |
|---|---|
| `hivra_host_costs` | What each server costs per month (minor units, EUR/USD/GBP). Add a row with a later `effective_from` when a price changes; the latest row on or before a date is the price that day. |
| `managed_venice_proxy_keys.metadata->>'agentId'` | The agent each managed inference key belongs to. Stamped by a trigger whenever an agent's `llm_config` names a key, and kept after the agent is deleted. |
| `hivra_agent_active_hours` (view) | One row per agent per hour in which Hivra saw it work: managed inference requests (charged and upstream cost) and run events (`otel_log`). |

Not visible yet: agents on the owner's own model key with no run reporter, and
older keys made before the link existed for agents that were already deleted.

Example queries:

```sql
-- Active hours per agent type this month.
select agent_type, count(distinct agent_id) as agents, count(*) as active_hours
  from public.hivra_agent_active_hours
 where hour >= date_trunc('month', now())
 group by 1 order by 3 desc;

-- Record a server price.
insert into public.hivra_host_costs (host_id, monthly_cost_minor, currency, effective_from, note)
values ('<host id>', 3990, 'EUR', '2026-11-01', 'monthly price');

-- Server cost per active agent hour this month, per host.
with price as (
  select distinct on (host_id) host_id, monthly_cost_minor, currency
    from public.hivra_host_costs
   where effective_from <= current_date
   order by host_id, effective_from desc
), hours as (
  select a.proxmox_host as host_id, count(*) as active_hours
    from public.hivra_agent_active_hours h
    join public.hivra_agents a on a.id = h.agent_id
   where h.hour >= date_trunc('month', now())
   group by 1
)
select p.host_id, p.monthly_cost_minor, p.currency, h.active_hours,
       round(p.monthly_cost_minor::numeric / nullif(h.active_hours, 0), 2) as cost_minor_per_active_hour
  from price p left join hours h on h.host_id = p.host_id;
```

---

## What the marketplace adds later (NOT now)

### Data model (additive — mirrors how `agent-catalog.ts` is shaped today)
```
catalog_entries
  id            uuid pk
  slug          text unique          -- 'claude-code', 'community/foo-bar'
  source        text                 -- 'builtin' | 'community'
  published_by  text                 -- Clerk user id (null for builtin)
  name, vendor, tagline, blurb
  min_cpu, min_ram, min_plan, weight, browser   -- same fields as AgentDef
  install_image / installer_ref      -- how the box is provisioned
  status        text                 -- 'draft' | 'published' | 'delisted'
  installs      int, rating numeric
  created_at, updated_at

catalog_installs                     -- who installed what (powers payouts)
  id, catalog_entry_id fk, user_id, agent_id fk hivra_agents, created_at

catalog_payouts                      -- usage → $HermesOS settlement (later)
  id, catalog_entry_id, period, usage_units, amount_hermesos, status
```
`agent-catalog.ts` becomes a loader: `AGENTS = builtin ∪ published catalog_entries`. The
existing `AgentDef` shape is the contract — keep new fields optional so builtin entries
don't need migrating.

### API shape (later)
- `GET /api/hivra/catalog` — discover (builtin + published)
- `POST /api/hivra/catalog` — publish (community)
- `POST /api/hivra/agents { catalog_slug }` — install (already most of the launch path)
- payouts cron — aggregate `hivra_agent_events` per `catalog_entry` → settle in $HermesOS

### Provisioning
A community agent is just another **isolated VM** (architecture lock v1.1 — one agent =
one VM). The installer/image comes from `catalog_entries.install_image`; the existing
fixturenodea box provisioner generalizes to "provision agent of type X" — no shared-VM work.

---

## Rules so we don't paint ourselves into a corner

1. **Keep `AgentDef` the contract.** Anything the marketplace needs about an agent should
   fit `AgentDef` (add optional fields), so builtin and community agents are interchangeable.
2. **Never special-case builtin in the launch path.** Launch should take an agent *slug* and
   resolve it through the registry — builtin vs community is just `source`.
3. **Slots + pool budget are the only gates.** Don't invent a separate "marketplace limit".
4. **Telemetry is the payout ledger.** Keep `hivra_agent_events` clean and per-agent.
5. **One agent = one VM still holds.** The marketplace does not require shared-VM.

This is the entire Phase 7 deliverable: the seams above already exist; this doc records the
target so a future build is additive, not a redesign.

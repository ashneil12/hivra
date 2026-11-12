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

### Month report by agent type (read-only)

Added 2026-11-13 (migration `20261113021500_usage_by_user_and_type`). Still
records and reading only.

| Piece | What it does |
|---|---|
| `managed_venice_proxy_keys.metadata->>'agentType'` | The type of the agent a managed inference key belongs to, stamped next to `agentId`, so usage keeps its type after the agent is deleted. |
| `hivra_usage_by_user_and_type(from, to)` | One row per person and agent type between two times: agents, active hours, managed inference requests with charged and upstream cost, run events. Service role only. |
| `src/lib/billing/usage-share.ts` | Pure what-if sums: subscriptions, minus payment fees, minus servers, then a share of what is left split by use. Each paying person's part follows what they pay and is divided between the agent types they used, by active hours. A paying person with no measured use leaves their part unassigned. |
| `/dashboard/ops/margins` | Operator-only page over those sums for one month. The share is typed in and has no default; with none typed the page shows usage and margins only. |

The page counts subscriptions at the monthly list price for the people on a paid
plan today, so earlier months are approximate. It warns when server prices are
missing, when a currency has no rate, and when paid-plan accounts have no payment
on record.

```sql
-- The rows behind the page for one month.
select * from public.hivra_usage_by_user_and_type('2026-11-01', '2026-12-01');
```

### Use measured on every agent's computer

Added 2026-11-13 (migration `20261113033000_agent_activity_samples`). Managed
inference and run events miss an agent that runs on its owner's own model key.
Each computer's connection service already reports when the agent's app was
last used through it, how many of its connections are open, whether a reply is
being written and whether a terminal is attached. A sampler stores those
answers: counts and times only, never content.

| Piece | What it does |
|---|---|
| `hivra_agent_activity` | The latest reading per agent. A part the computer did not report is null, never 0. `last_used_at` is the last moment Hivra knows the agent was used. |
| `hivra_agent_activity_hours` | Per agent and hour: readings taken (`samples`) and readings that found the agent in use (`active_samples`). Carries owner and agent type, and stays after the agent is deleted. |
| `hivra_record_agent_activity(...)` | Stores one reading in both. A reading older than the stored one is dropped. Service role only. |
| `src/lib/hivra/agent-activity-sampler.ts` | Reads every running agent Hivra can read and decides what the reading says: in use now (open app connection, reply being written, attached terminal) or used since the previous reading (a newer reply, or the app's last-used time moving forward under the same connection service start). |
| `/api/cron/sample-agent-activity` | Runs the sampler every 10 minutes. Off unless `HIVRA_AGENT_ACTIVITY_SAMPLING=1`. |

`hivra_agent_active_hours` and `hivra_usage_by_user_and_type` count an hour with
an in-use reading as an active hour, once, together with any inference or run
events in the same hour.

Still not visible: an agent that works only through a messaging channel or on a
schedule, on its owner's own model key, with nobody connected. An open app tab
counts as use for as long as its connection stays open.

### A catalog view of Launch (behind a switch)

`NEXT_PUBLIC_HIVRA_LAUNCH_CATALOG=1` turns on the catalog view of Launch's Choose
step. It is off by default and adds nothing that can launch: it only presents the
tiles Launch already offers.

- `src/lib/launch/launch-catalog.ts` holds what nothing else records about each
  launch profile: its jobs, search words, how you talk to it, its maker's page, a
  picture and a few first tasks. The maker's name, places, browser and model access
  are read from `agent-catalog.ts`, `PROFILE_DETAILS` and `model-access.ts`, not
  repeated.
- Choose gains a search (every word has to match a tile's name, description, jobs or
  search words), an All / Agents / Computers filter and "Browse by job".
- A tile opens its page before Review. The page has its own history entry, so Back
  returns to the list, and `?about=<profile>` opens one directly.
- Each page view sends `launch_catalog_page_viewed` with the profile, next to the
  launch events that already exist. That is the "saw the page, then launched" count a
  maker page would show.
- A picture is a file under `public/` named by the entry's `cover`. The computers use
  the workspace pictures already in the repository; an agent without a picture shows
  its icon on a wash of its catalog colour.

- Home gains "Try next" under the owner's own agents and computers: up to two agents
  they do not run yet, one that does a job they already use an agent for first
  ("Because you run Codex"). Each opens its page in Launch. Nothing is suggested to an
  owner who runs no agent, or during a search.
- The tiles themselves live in `src/components/launch/launch-tiles.ts`, so Home and
  Launch name and describe a thing in the same words.

Not built yet: ordering by how many people keep using a thing, pages a maker can
claim and edit, and adding a new agent without a code change.

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

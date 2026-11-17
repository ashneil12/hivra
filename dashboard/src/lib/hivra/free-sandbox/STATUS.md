# Free sandbox: status

Everything here is off. Nothing runs unless `FREE_SANDBOX_ENABLED=true`, the free section of the plan ladder settings is complete, and something constructs the bridge with real ports. No migration is applied, and no server, database or setting has been changed. For what Hivra offers today, `docs/STATUS.md` is the source of truth. It still says Hivra runs no free computer, and that stays true until this ships.

## What is built (branch `claude/free-sandbox-hivra`)

**Settings** (`settings.ts`). Every value is read from the free section of `HIVRA_PLAN_LADDER_CONFIG`, with no defaults in code:
- clocks, size and quota;
- places per server and the paid reserve;
- the opening step and the refused-reply stop;
- the turn limit and the daily reply cap (0 is off);
- plan limits and free models.

If a required value is missing, the feature is off. A missing optional value (daily cap, burst rule, second place class) turns only that part off.

**Lifecycle rules** (`policy.ts`, `placement.ts`):
- A sandbox stops after quiet minutes and is packed after quiet hours.
- Only a person counts as use: a scheduled job can delay a stop but never moves either clock.
- Paid computers keep their reserve, and Free never pushes them out.
- Places open in steps.
- A server whose replies are being refused takes nobody new.

**The bridge** (`bridge.ts`), one pass against the agent app's operator API (`operator-api.ts`):
- It sets the plan limits and makes the computer row first, so an early message waits rather than being refused.
- It places the workspace, enrolls the sandbox, stops it, packs it with a verified copy, wakes it on `machine.wake_wanted` (queued at the running cap), and erases only when the workspace is deleted.
- It counts the free AI's replies per server and day (answered, refused, failed). It remembers a server as refused until a given time.
- Every half-done step leaves a record that a later pass finishes or flags.

**Ports, the real implementations** (wiring off):
- `sandbox-host.ts`: the gVisor adapter over SSH.
- `archive-store.ts`: Storage Box archives, published only after read-back.
- `account-directory.ts`: Clerk, by verified address only.
- `supabase-store.ts`: the bridge tables.

**Turn gate** (`provisioner/gvisor/free-sandbox/free-turn-gate.py`, config built by `turn-gate.ts`):
- It is a per-server CONNECT proxy.
- It enforces the replies-at-once limit and the daily reply cap.
- It allows listed hosts only, on port 443.

**gVisor adapter** (`provisioner/gvisor/hivra-gvisor-adapter.py`):
- A free class runs the pinned free image with its own command.
- It handles pack, release and restore, with a verified archive and safe unpacking.
- It enrolls with the code on stdin only, through the image's shim.
- It applies a file quota, and CPU overcommit for the free pool only.

**Free image** (`provisioner/gvisor/free-sandbox/Dockerfile`):
- The agent app's runner, Bun, the enroll shim and OpenCode, run as an unprivileged user on a read-only root.
- OpenCode's managed config in the image still defaults to OpenCode's free models. It must change before any use (see the next section).
- It was built and run locally for a test only. It is not pushed or pinned (`FREE_IMAGE` is empty).

**Tables** (`supabase/migrations/20261117210000_free_sandbox_bridge.sql`):
- pool servers, placements, wakes, waiting list, daily AI counts, pending erasures and the events cursor;
- service role only; written but not applied.

**Tests**: Jest for everything under `src/lib/hivra/free-sandbox`; Python unittest for the adapter, the enroll shim and the turn gate. CI runs neither Python suite yet.

## What a free agent thinks with: undecided

OpenCode's free AI is out for shared servers: its free models are meant only for OpenCode's own clients, and only for a person's own use. Two candidates are open:

- **A small one-time starter that Hivra pays for.** This is awaiting the owner's decision.
- **The person's own free AI key** (for example Google or OpenRouter). The agent could think inside the agent app's server, so chat needs no sandbox at all, and the sandbox wakes only when the agent has to run something.

The bridge does not depend on which AI is chosen. Its `machine.ai_limit` handling is harmless either way. The sandbox image must not assume OpenCode's free models. OpenCode the program (MIT) can stay in the image. The image has not been rebuilt for this.

## What is not built

- **Live wiring.** Nothing constructs the bridge or runs it on a schedule, so nothing gives it the agent app's operator token and address, or the pool resolver (address, keys, adapter and runtime digests per server).
- **Pool servers.** None has been chosen, prepared or registered, and `free_sandbox_pool_servers` is empty.
- **Network isolation.**
  - Sandboxes are not yet forced through the turn gate. That needs:
    - firewall rules so that only the gate reaches the internet;
    - `HTTPS_PROXY` set by the adapter for the free class;
    - the gate running as a service on the host.
  - The pool must have no route to paid VMs or Proxmox management.
  - Free traffic must not leave from an address that paid agents use.
- **Abuse controls** beyond the gate: sign-up limits, mining detection from gate logs, and a per-person awake budget.
- **Archive encryption per person.** This is required before any sign-in (an AI key or account) can live in a sandbox, because a packed archive would otherwise carry it in the clear.
- **Moving to a paid computer.** A person who upgrades should have their workspace moved to a paid computer and the free sandbox removed.
- **Monitoring and alerts** for flagged placements, refused servers and a stalled events feed.
- **Status and public copy.** `docs/STATUS.md` and the public copy must change in the same PR as any launch.

## What must be true before a first test on a test machine

1. **A test pool server.** It is x86_64 with Docker and gVisor (`prepare-gvisor-host.sh`). It runs on Canary infrastructure only, apart from customer machines and their addresses, and has CPU and memory caps.
2. **The free image.** It is rebuilt without any assumption about OpenCode's free models, pushed to a private registry, and pinned by digest in `FREE_IMAGE`. The adapter is redeployed to the test server with its digest recorded.
3. **The thinking question answered** (section above), and the image and plan limits set to match.
4. **The migration applied to Canary only,** and the test server inserted in `free_sandbox_pool_servers`.
5. **Settings complete on Canary:**
   - the free section, including `freeModels` or its replacement;
   - `placesOpenPerServer` set low;
   - `FREE_SANDBOX_ENABLED=true` on Canary only.
6. **The bridge wired on Canary** to the agent app's Canary operator API, run by hand first, then on a schedule.
7. **The turn gate running** on the test server, with the firewall forcing sandboxes through it.
8. **Acceptance:**
   - a new free workspace gets its computer;
   - a message waits for it, then is answered;
   - the sandbox stops when quiet, is packed after the store clock, and comes back on a message with its files intact;
   - deleting the workspace removes its sandbox and every stored copy;
   - nothing touches a paid computer.

---
name: hivra-add-launch-agent
description: Add a new agent (or computer) to Hivra's Launch page and prove it before customers see it. Use whenever a new launch profile or catalog tile is added; covers the launch sweep, idle-use measurement and the Free vs Pro call.
---

# Add an agent to Launch

A new agent is done when a customer can launch it, chat with it, and Hivra knows
what it costs to keep running. All three come from the launch sweep
(`dashboard/e2e/README.md`, LAUNCH SWEEP).

## Steps

1. **Install from upstream.** The agent installs from its official upstream repo
   or installer, newest version, no Hivra fork. Owners update it themselves.
2. **Add the launch profile** behind its own feature switch, off in production.
3. **Add a sweep target** in `dashboard/e2e/launch-sweep/targets.ts`: the tile's
   exact visible name, `kind`, and how it proves itself (`hivra-chat`,
   `agent-ui-chat` or `computer-open`). The "every tile is covered" test fails
   until you do.
4. **Launch it on Canary like a customer**, one target on the standing account:
   `LAUNCH_SWEEP_ONLY=<profile-id> npm run test:launch-sweep` then
   `npm run test:launch-sweep:summary`. It must reach its proof stage. Inspect
   the recorded evidence if it fails, and verify the run's computer was removed.
5. **Read its idle use** from the summary's Idle use table (10 minutes by
   default): RAM median and peak, CPU median, disk used. Compare it with the
   Linux computer row, the bare computer every agent runs on; the difference is
   what the agent itself costs.
6. **Decide Free or Pro.** Put the numbers in front of the owner of pricing
   with a recommendation. Until thresholds are agreed, a light agent (idle RAM
   close to the bare computer, idle CPU near zero, small disk) is a Free
   candidate; anything holding a browser, a large model runtime or a GB-class
   process idle is Pro only. Record the decision with the numbers.
7. **Ship.** Turn the switch on for Canary, let the weekly sweep include it, and
   only then ask for production.

## Never

- Ship a tile the sweep has not launched and chatted with.
- Guess idle cost from the agent's docs; measure it.
- Leave computers from the sweep running. Keep the standing account intact.

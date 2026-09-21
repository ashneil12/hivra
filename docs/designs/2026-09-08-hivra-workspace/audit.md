# Hivra core interface audit

**Observed:** 8 September 2026, authenticated Canary in Chrome and the running
Mac Alpha. **Source baseline:** `2c4c5519cf2b42b61b3539595c6691a9f5d0bacb`
on `Redesign`. The deployed commit was not independently resolved; screenshots
and accessibility observations establish the visible behavior, not revision parity.

This is a design review, not a runtime repair or release receipt. Account names,
email addresses, resource IDs and customer content are intentionally omitted.
The adjacent prototype uses fictional examples, not a copy of the account.

## Finding

Hivra has a recognizable visual identity but does not maintain one working
context. The user repeatedly changes between a dashboard, a catalogue, a launch
form and a resource console. Each screen asks them to relearn where the work and
controls live. The redesign should make the selected agent/computer persistent
and reserve most of the window for its actual work.

The approved reset already describes the intended simple behavior. The gap is
partly **unimplemented target behavior** (shared context, comprehensive Settings,
unified activity and conversation support), and partly **UI implementation
debt** (oversized headings, repeated actions, competing promotions and tabs).
The proposal does not change the resource/lifecycle model to make the UI easier.

## Walkthrough and decisions

| Surface inspected | What was visible | Redesign decision |
| --- | --- | --- |
| Home, `/dashboard` | Large “Pick up your work” heading, separate computer/agent lists, activity below. Sidebar initially collapsed; expanded view puts a tall install prompt above navigation. | Compact welcome, a direct resume path, attention only when present, recent resources. Give switching priority over installation and social links. |
| Computers, `/dashboard/computers` | Intro, summary counts, nested inventory, then OS catalogue and runtime explanation. Existing resources and acquisition choices share the same page. | Owned computers are the page. Move new OS selection to Launch. Keep resource name, OS, observed state and Open immediately scannable. |
| Agents, `/dashboard/agents` | “Runtime inventory,” “Launch agent,” a second “Deploy agent,” card inventory, and an experimental runtime promotion. | One launch entry, one compact list, current interface and associated computer. Put catalogue/exploration in Launch. |
| Codex detail, `/dashboard/agent/[id]` | Eleven top-level tabs: Chat, Desktop, Codex Terminal, Browser, Box Terminal, Files, Git, Skills, Telegram, Tasks, Manage. Return label is “Command center” while global navigation says Home. | Conversation/native surface is the primary work area. Group tools under Computer and configuration under Manage; keep labels consistent and the target explicit. |
| Launch, `/dashboard/launch` | Agent/Computer choice, profile, capacity/name/Advanced, then review. The agent profile step supports Codex and sends other choices to the established catalogue. Large headings and review rows push controls below the desktop viewport. | Three visual stages: Choose, Configure, Review. Keep conceptual and authority boundaries intact. Recommended configuration first, one Advanced disclosure, compact review with exact effects. |
| Infrastructure, `/dashboard/infrastructure` | Giant heading, three summary cards and a general caution precede actual capacity. Provider project controls and computer lists create another place to browse resources. | Connection list and usable capacity first; open a connection for its setup/diagnostics. Place mutation-specific explanations beside the action that needs them. |
| Settings, `/dashboard/settings` | Appearance/chat preferences, shared memory, cache reset. No hub for the other routes classified as Settings in navigation. | A real settings index for account, billing, credentials, appearance, connections and applications. Resource controls remain with their resource. |
| Activity, `/dashboard/activity` | Empty usage view despite resources present elsewhere; a notice explains coverage is managed Hermes usage only. | Separate attention from history. Show source coverage and unavailable sources precisely; never imply that empty partial-source usage means all agents are idle. |
| Running Mac Alpha | The same web sidebar plus native toolbar, resource header, surface tabs, desktop toolbar and environment banner. Most vertical layers repeat context before the desktop begins. | Share the compact web shell; native toolbar owns connection/window navigation, web content owns selected resource and work. No second product hierarchy. |
| Installation | Browser shows “Install Hivra” within the main sidebar; Mac app omits the PWA prompt. | Small Applications entry opens platform-appropriate access choices. Distinguish browser installation from native distribution and its actual release status. |

## Keep the identity; remove the visual competition

Preserve the unboxed italic H. wordmark, near-black `#0d0d0d`, paper `#fdfcf9`,
crimson `#ff3a3b`, etched rectangular borders, white primary actions, vellum
grain and red particle connections. These are product identity, not clutter.
The first preview incorrectly softened them into olive, salmon and rounded cards;
the user's review explicitly rejected that loss of character.

Live computed styles resolve an important typography distinction: Home headings
use the browser's serif stack (Georgia/Cambria/Times), body text uses Outfit,
metadata uses Space Mono, and the `.serif` utility/brand uses Space Grotesk.
The first prototype's Playfair attribution was incorrect. Preserve this contrast:
editorial Home/section headings, compact technical resource headings, and tracked
mono eyebrows/statuses. Keep explanatory text readable and resource names intact.

The moving particle background is visible behind inventories, settings, launch
and the blocked chat surface. Retain it as low-contrast ambient character, with
translucent etched panels, stronger reading surfaces, bounded animation and a
static reduced-motion mode. Simplifying navigation should not flatten the canvas.

Color must have a stable meaning. Crimson can mark an action or
selection without resembling a failure. Error/warning content also needs a label
and specific next action. Running compute does not mean an available chat or
connected desktop; show those states separately.

## The proposed working layout

1. A persistent left rail holds navigation and direct resource switching.
   “All agents” and “All computers” open inventory; subordinate resource rows
   switch directly to an individual item. The resource list scrolls separately
   from global controls. Search and a keyboard switcher serve larger fleets.
2. A compact context bar identifies the exact resource, runtime/OS and access
   state. Agent and computer remain distinct concepts with an explicit binding.
3. The center shows one useful surface. Supported agents open conversation or
   their preferred native interface; standalone computers open Desktop. A user
   does not need a project, task or orchestration setup to talk to an agent.
4. Details and Manage open deliberately. The inspector defaults closed and
   becomes an overlay on smaller windows; it never permanently squeezes chat.
   Its resource name remains visible while a consequential action is reviewed.
5. One New entry leads to Agent or Computer. The review states whether a new
   computer is created and what the agent receives. Attachment/migration cannot
   be smuggled into a generic New action.

## Preserve power without forcing it into the first view

| Daily action | Primary location | Deeper controls |
| --- | --- | --- |
| Resume/switch an agent | Sidebar or keyboard switcher | Search/filter full inventory |
| Talk/work with the agent | Center conversation or native surface | Per-agent sessions and interface preference |
| Open its computer | Named computer link and surface chooser | Files, terminal, browser and Git where supported |
| Create another resource | New → Agent/Computer | Capacity, supported allocation and advanced placement |
| Maintain a resource | Its Manage panel | Power, update, recovery, resize and export when supported |
| Change shared configuration | Settings | Billing, credentials, memory, infrastructure and applications |

Keep a direct native-interface route for every supported runtime. A central
conversation pane is an optional enhancement until its capability coverage and
real execution behavior are accepted. An orchestration board, multiple parallel
agent panes and dispatcher controls are later work.

## Current implementation boundaries

- `dashboard/src/lib/dashboard-navigation.ts` is the existing navigation map.
  Agent and computer detail URLs must remain valid during migration.
- `dashboard/src/components/workspace/UnifiedWorkspace.tsx` already provides
  selection and pane groundwork, behind the workspace feature gate. Reuse its
  identity, persistence and request-isolation rules.
- `workspace-surface-adapters.tsx` does not implement Desktop. The working
  computer path remains `/dashboard/agent/[id]?tab=desktop` until parity exists.
- `workspace-conversation-adapters.tsx` excludes dashboard-style Hivra agents
  from the CLI conversation adapter. Native-only runtimes need a deliberate
  native view, not an empty composer.
- The currently inspected Agents page has two launch destinations. The complete
  established catalogue must survive consolidation; the short new launch flow
  is not evidence of whole-catalogue support.
- Sidebar preference persistence and launch-step focus were recently accepted.
  Preserve them. The reset plan records a rejected sticky footer that covered a
  name input at 980×690; use in-flow form actions and verify small heights.
- Current infrastructure labels can expose underlying runtime names rather than
  OS profiles. Use verified product projections consistently instead of changing
  backend identity to solve display naming.

## Runtime observations outside this redesign

The inspected Codex Chat surface reported that a Chat runtime update was needed;
it offered native sign-in through the Codex terminal. The Mac Omarchy view showed
“Desktop disconnected” and a safe native-open failure message. These are observed
blocked states, not proof of their causes. No update, reconnect, power operation,
agent message or resource launch was sent as part of this review. The prototype
does not represent either issue as repaired.

## Review limits

This walkthrough covered the authenticated core navigation, one CLI agent,
computer inventory, launch through review, infrastructure, settings, activity,
installation prompt and the running Mac desktop screen. It did not exhaustively
exercise every runtime, billing/credential flow, recovery dialog, public marketing
page, native installation or supported mobile device. Those remain explicit
implementation acceptance work in `implementation-plan.md`.

The prototype is a design artifact with example data and local interactions.
Production source, live resources and distribution artifacts are not changed by
the proposal. Browser observations establish the present usability problems;
prototype browser checks establish the proposed layout's interactions only.

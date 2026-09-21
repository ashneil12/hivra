# Hivra: a simpler place to work

**Design proposal · 8 September 2026**

A clickable redesign of Hivra's core layout, informed by a walkthrough of the
authenticated Canary and the running Mac app. Keep the black/paper/crimson identity;
make launching, finding and switching agents/computers straightforward.

The prototype is separate from the dashboard application. It uses fictional
example data and local interactions. It cannot launch a VM, send an agent
message, operate a computer, purchase capacity or install an application.

## Open the prototype

From the repository root:

```sh
python3 -m http.server 4196 --bind 127.0.0.1 --directory docs/designs/2026-09-08-hivra-workspace
```

Open **http://127.0.0.1:4196** in a browser. The included assets work without a
CDN, account or dashboard backend. Stop the preview server with Ctrl+C.

To run the interaction checks after installing the dashboard's development
dependencies:

```sh
node --test docs/designs/2026-09-08-hivra-workspace/prototype.test.cjs
```

## The design in one sentence

Choose the agent or computer on the left, work in the center, and open details
or advanced controls when you need them.

## What to try

1. Open Home and resume an example agent or computer.
2. Switch directly between resources in the sidebar; open the full inventories
   to search and filter them.
3. Open an agent, inspect its associated computer, and compare conversation
   with native-interface access. The composer is a local draft, not a live chat.
4. Open a standalone computer. Desktop is its starting surface; an agent is
   optional and attachment is not implied.
5. Use New to compare Agent and Computer, open Advanced in configuration, and
   review the resulting local launch draft. No deployment is submitted.
6. Use the keyboard switcher with Cmd/Ctrl+K, inspect Settings and Applications,
   and compare the dark and light themes.

## Main decisions

Following visual review, the revised preview restores Hivra's grain, red particle
network, sharp etched panels, white primary buttons and mixed editorial/technical
typography. Home brings agents and computers together in adjacent panels on wide
screens. Navigation is simpler; the visual language comes from the current app.

| Today | Proposed |
| --- | --- |
| Inventory, catalogue and promotion compete | Inventory shows what you own; New contains acquisition choices |
| Agent switching changes the whole layout | Persistent resource selection and a stable work area |
| Many peer tabs and repeated context bars | One main surface, optional computer tools, contextual Manage |
| Large page introductions and repeated actions | Compact headings and one clear primary action |
| Installation and social links dominate the rail | Small secondary Applications/Help access |
| Partial activity can appear to describe all agents | Explicit source coverage and actionable attention |

The first implementation should improve the existing shell and resource routes.
The optional shared conversation pane comes after its supported paths are
verified. Full Conductor-style orchestration is a later phase with its own
execution, recovery and authority requirements.

## Supporting documents

- [Live-screen audit and design rationale](audit.md)
- [Phased implementation plan and acceptance criteria](implementation-plan.md)
- [Prototype verification and limitations](verification.md)

The proposal does not supersede `VISION.md`, the product architecture, the
canonical Agent Computers specification or their existing release gates.
Prototype usability is separate from runtime integration and live acceptance.

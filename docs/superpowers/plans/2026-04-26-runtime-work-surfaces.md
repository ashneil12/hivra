# Runtime Work Surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose only the chat-adjacent runtime features in the chat sidebar: projects and workspace selection. Other runtime surfaces should live where the dashboard already has a natural home.

**Architecture:** Keep the chat sidebar small. Scheduled jobs belong in Scheduled Tasks, memory belongs in the advanced console/settings flow, skills belong in Skills, backups belong in the backup flow, and TUI stays its own surface. Reuse existing instance APIs for projects, workspaces, runtime commands, and sessions. Keep backend implementation names out of visible copy.

**Tech Stack:** Next.js App Router API routes, React client components, existing Hermes chat state/hooks, runtime adapter routes under `dashboard/src/app/api/instances/[id]`.

---

### Task 1: Scheduled Tasks Placement

**Files:**
- Existing: `dashboard/src/app/dashboard/scheduled-tasks/page.tsx`
- Existing: `dashboard/src/app/api/scheduled-tasks/live/route.ts`
- Existing: `dashboard/src/app/api/scheduled-tasks/live/action/route.ts`

- [x] Confirm scheduled tasks already read and mutate runtime cron jobs for runtime-backed instances.
- [x] Do not duplicate scheduled task management in the chat sidebar.

### Task 2: Runtime Work Panel Component

**Files:**
- Create: `dashboard/src/components/chat/ProjectSurface.tsx`

- [ ] Add internal section tabs: Projects and Workspaces.
- [ ] Load projects and let the user create/delete projects.
- [ ] Let the user move the active chat into or out of a project.
- [ ] Load/add/remove workspaces and expose workspace selection for new chat context.

### Task 3: Chat Sidebar Integration

**Files:**
- Modify: `dashboard/src/components/chat/ChatSidebar.tsx`
- Modify: `dashboard/src/components/chat/HermesChat.tsx`

- [ ] Add a Projects tab beside Chats and Settings.
- [ ] Pass active session, profile, and refresh handlers into the panel.
- [ ] Refresh conversations after project moves.
- [ ] Keep chat list grouping stable and avoid changing unrelated chat persistence behavior.

### Task 4: Focused Verification

**Files:**
- Existing relevant tests under `dashboard/src/components/chat/__tests__`
- [ ] Run chat sidebar/render tests touched by the Projects tab.
- [ ] Run typecheck if focused tests pass.

### Task 5: Full Confirmation

- [ ] Run `npm run lint`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run test:ci`.
- [ ] Commit only this feature set, leaving unrelated dirty chat-cache work untouched where possible.

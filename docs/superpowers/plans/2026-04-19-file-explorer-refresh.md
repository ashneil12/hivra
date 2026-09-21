# File Explorer Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing remote file explorer into a polished, desktop-style experience that is reachable from chat controls and the sidebar, with single-click dossier inspection and double-click open behavior for folders and text files.

**Architecture:** Reuse the existing instance-page explorer modal and dedicated explorer route, wire the hidden launcher controls back into the chat shell, and upgrade the explorer component from a plain list/editor overlay into a Finder-style browser with selection state, a dossier side panel, and safe preview support for Markdown and text-like files only.

**Tech Stack:** Next.js 16, React 19, Jest, Testing Library, Framer Motion, existing SFTP route and explorer/editor components.

---

### Task 1: Lock in Access and Interaction Regressions First

**Files:**
- Create: `dashboard/src/components/explorer/__tests__/FileExplorer.test.tsx`
- Modify: `dashboard/src/components/chat/__tests__/ChatHeader.test.tsx`

- [ ] **Step 1: Extend the chat header test to require a File Explorer launcher when the toggle callback is provided**
- [ ] **Step 2: Run the header test to verify it fails because the launcher is not currently rendered**
- [ ] **Step 3: Add a file explorer test that requires single-click selection to show dossier details without opening the editor**
- [ ] **Step 4: Run the explorer test to verify it fails against the current immediate-open behavior**
- [ ] **Step 5: Add a file explorer test that requires double-clicking a folder to navigate into it**
- [ ] **Step 6: Run the explorer navigation test to verify it fails or is incomplete against the current component behavior**

### Task 2: Reconnect Explorer Entry Points

**Files:**
- Modify: `dashboard/src/components/chat/ChatHeader.tsx`
- Modify: `dashboard/src/components/chat/ChatSidebar.tsx`
- Modify: `dashboard/src/components/chat/HermesChat.tsx`

- [ ] **Step 1: Add explicit `onToggleExplorer` and `explorerOpen` props to the chat header contract**
- [ ] **Step 2: Render the desktop and mobile explorer launch actions next to the existing terminal/browser controls**
- [ ] **Step 3: Thread the explorer props through `HermesChatInner` so the callbacks are no longer dropped**
- [ ] **Step 4: Restore the sidebar explorer entry in the node management area**
- [ ] **Step 5: Run the updated header test to verify the launcher wiring passes**

### Task 3: Upgrade the Explorer to a Desktop-Style Browser

**Files:**
- Modify: `dashboard/src/components/explorer/FileExplorer.tsx`
- Modify: `dashboard/src/components/explorer/FileEditor.tsx`
- Modify: `dashboard/src/components/explorer/FileIcon.tsx`

- [ ] **Step 1: Change the explorer default view to the polished icon/grid layout while keeping the compact list view available**
- [ ] **Step 2: Add explicit selection state so single click highlights an item and populates a dossier panel**
- [ ] **Step 3: Add double-click handling so folders navigate and text-like files open the editor**
- [ ] **Step 4: Add a dossier side panel that shows item metadata, path, quick actions, and safe preview states**
- [ ] **Step 5: Reuse existing text reads for text/code/Markdown previews and avoid binary reads for PDFs/images**
- [ ] **Step 6: Refresh the editor styling so it matches the upgraded explorer shell without changing save semantics**
- [ ] **Step 7: Run the new explorer tests to verify the red-green cycle completes**

### Task 4: Verification and Scope Review

**Files:**
- Verify only

- [ ] **Step 1: Run the targeted explorer and chat header Jest tests**
- [ ] **Step 2: Run the broader related chat/explorer test files if the targeted tests pass**
- [ ] **Step 3: Run `npm run test -- --runInBand` for the touched test files if Jest filtering requires explicit execution**
- [ ] **Step 4: Run `npm run typecheck` in `dashboard/` if the local environment is stable enough for a full pass**
- [ ] **Step 5: Review the final diff to confirm the change stays within explorer UX, wiring, and tests only**

# Chat Live Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent chat activity strip plus inline blank-gap cue so users can tell the agent is still working during long chat turns.

**Architecture:** Derive one `ChatActivityStatus` object from existing conversation/message/tool state, then render it above the composer and use message-level streaming state for inline blank-gap activity. Keep stream transport unchanged and avoid adding persisted state unless a terminal failure needs existing metadata preserved.

**Tech Stack:** Next.js, React 19, TypeScript, Jest, React Testing Library, CSS modules, lucide-react.

---

## Files And Responsibilities

- Create `dashboard/src/components/chat/hooks/chat-activity-status.ts`
  - Pure helper for deriving a user-facing activity phase from existing chat state.
- Create `dashboard/src/components/chat/hooks/__tests__/chat-activity-status.test.ts`
  - Unit coverage for thinking, tool, writing, reconnecting, failed, and idle phases.
- Modify `dashboard/src/components/chat/chat-types.ts`
  - Export the `ChatActivityStatus` type if it is shared outside the helper.
- Modify `dashboard/src/components/chat/hooks/useChatEngine.ts`
  - Derive and expose `activityStatus` for the active conversation.
- Modify `dashboard/src/components/chat/ChatMessageList.tsx`
  - Accept `activityStatus` and render the persistent composer-level status strip in the list footer.
- Modify `dashboard/src/components/chat/ChatMessageList.module.css`
  - Add compact status strip styling that matches existing Hermes chat surfaces.
- Modify `dashboard/src/components/chat/HermesChat.tsx`
  - Pass `activityStatus` from the engine into `ChatMessageList`.
- Modify `dashboard/src/components/chat/ChatMessage.tsx`
  - Keep the current blank streaming placeholder behavior and make it explicit/tested.
- Modify tests:
  - `dashboard/src/components/chat/__tests__/ChatMessage.test.tsx`
  - `dashboard/src/components/chat/__tests__/ChatMessageList.test.tsx`
  - `dashboard/src/components/chat/hooks/__tests__/useChatEngine.test.tsx` only if the hook return contract needs direct coverage.

## Verification Commands

Run focused tests while developing:

```bash
cd dashboard
npm test -- --runTestsByPath src/components/chat/hooks/__tests__/chat-activity-status.test.ts src/components/chat/__tests__/ChatMessage.test.tsx src/components/chat/__tests__/ChatMessageList.test.tsx
```

Run full verification after each implementation commit:

```bash
cd dashboard
npm run test:ci
npm run typecheck
npm run lint
```

## Task 1: Activity Status Helper

**Files:**
- Create: `dashboard/src/components/chat/hooks/chat-activity-status.ts`
- Create: `dashboard/src/components/chat/hooks/__tests__/chat-activity-status.test.ts`
- Modify: `dashboard/src/components/chat/chat-types.ts` if shared type export is cleaner

- [ ] **Step 1: Write failing helper tests**

Cover these cases:

```ts
expect(deriveChatActivityStatus({ isLoading: true, isThinking: true, latestMessage: emptyStreamingAssistant })).toMatchObject({
  phase: 'thinking',
  label: 'Thinking...',
  canStop: true,
});

expect(deriveChatActivityStatus({ isLoading: true, latestMessage: streamingAssistantWithRunningTool })).toMatchObject({
  phase: 'tool',
  label: 'Running tool...',
  activeToolName: 'terminal',
});

expect(deriveChatActivityStatus({ isLoading: true, latestMessage: streamingAssistantWithText })).toMatchObject({
  phase: 'writing',
  label: 'Writing response...',
});

expect(deriveChatActivityStatus({ isBooting: true, isLoading: true })).toMatchObject({
  phase: 'reconnecting',
  label: 'Reconnecting...',
});

expect(deriveChatActivityStatus({ error: 'The agent timed out' })).toMatchObject({
  phase: 'failed',
  label: 'Failed',
  canStop: false,
});
```

- [ ] **Step 2: Run focused helper test and confirm failure**

Run:

```bash
cd dashboard
npm test -- --runTestsByPath src/components/chat/hooks/__tests__/chat-activity-status.test.ts
```

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement the helper**

Implement a pure function:

```ts
export type ChatActivityPhase = 'idle' | 'thinking' | 'tool' | 'writing' | 'reconnecting' | 'stopped' | 'failed';

export interface ChatActivityStatus {
  phase: ChatActivityPhase;
  label: string;
  detail?: string;
  activeToolName?: string;
  canStop: boolean;
}

export function deriveChatActivityStatus(input: {
  isLoading: boolean;
  isThinking: boolean;
  isBooting?: boolean;
  error?: string | null;
  latestMessage?: MessageData;
}): ChatActivityStatus
```

Rules:

- `failed` if `error` is present and not booting.
- `reconnecting` if `isBooting` is true.
- `tool` if latest assistant message has any `tool_calls` with `status === 'running'`.
- `writing` if latest assistant message is streaming and has visible `content.trim()`.
- `thinking` if `isLoading`, `isThinking`, or latest assistant message is streaming.
- `idle` otherwise.

- [ ] **Step 4: Run focused helper test and confirm pass**

Run:

```bash
cd dashboard
npm test -- --runTestsByPath src/components/chat/hooks/__tests__/chat-activity-status.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run full verification**

Run:

```bash
cd dashboard
npm run test:ci
npm run typecheck
npm run lint
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/components/chat/hooks/chat-activity-status.ts dashboard/src/components/chat/hooks/__tests__/chat-activity-status.test.ts dashboard/src/components/chat/chat-types.ts
git commit -m "feat: chat live status - derive activity state"
```

## Task 2: Expose Activity Status From Chat Engine

**Files:**
- Modify: `dashboard/src/components/chat/hooks/useChatEngine.ts`
- Test: `dashboard/src/components/chat/hooks/__tests__/useChatEngine.test.tsx` if needed

- [ ] **Step 1: Write or update failing hook contract test**

If existing hook tests can cheaply cover the return value, assert that `activityStatus.phase` reflects the active state. If setup is too heavy, rely on helper tests and component integration tests.

- [ ] **Step 2: Derive activity status in `useChatEngine`**

Use the active state's latest displayed assistant message:

```ts
const activityStatus = useMemo(() => deriveChatActivityStatus({
  isLoading: activeState?.isLoading || false,
  isThinking: activeState?.isThinking || false,
  isBooting: activeState?.isBooting || false,
  error: activeState?.error || null,
  latestMessage: displayMessages[displayMessages.length - 1],
}), [activeState?.isLoading, activeState?.isThinking, activeState?.isBooting, activeState?.error, displayMessages]);
```

Return `activityStatus` from the hook.

- [ ] **Step 3: Run focused tests**

Run:

```bash
cd dashboard
npm test -- --runTestsByPath src/components/chat/hooks/__tests__/chat-activity-status.test.ts src/components/chat/hooks/__tests__/useChatEngine.test.tsx
```

Expected: PASS.

- [ ] **Step 4: Run full verification**

Run:

```bash
cd dashboard
npm run test:ci
npm run typecheck
npm run lint
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/components/chat/hooks/useChatEngine.ts dashboard/src/components/chat/hooks/__tests__/useChatEngine.test.tsx
git commit -m "feat: chat live status - expose engine activity"
```

## Task 3: Render Composer-Level Status Strip

**Files:**
- Modify: `dashboard/src/components/chat/ChatMessageList.tsx`
- Modify: `dashboard/src/components/chat/ChatMessageList.module.css`
- Modify: `dashboard/src/components/chat/HermesChat.tsx`
- Test: `dashboard/src/components/chat/__tests__/ChatMessageList.test.tsx`
- Test: `dashboard/src/components/chat/__tests__/HermesChat.test.tsx` only if prop plumbing requires mock updates

- [ ] **Step 1: Write failing component tests**

In `ChatMessageList.test.tsx`, assert:

```ts
render(<ChatMessageList {...baseProps} activityStatus={{ phase: 'tool', label: 'Running tool...', activeToolName: 'terminal', canStop: true }} />);
expect(screen.getByText(/Running tool/i)).toBeInTheDocument();
expect(screen.getByText(/terminal/i)).toBeInTheDocument();
```

Add a writing-phase case:

```ts
render(<ChatMessageList {...baseProps} activityStatus={{ phase: 'writing', label: 'Writing response...', canStop: true }} />);
expect(screen.getByText(/Writing response/i)).toBeInTheDocument();
```

Assert idle hides the strip.

- [ ] **Step 2: Run focused component test and confirm failure**

Run:

```bash
cd dashboard
npm test -- --runTestsByPath src/components/chat/__tests__/ChatMessageList.test.tsx
```

Expected: FAIL because the prop/rendering does not exist.

- [ ] **Step 3: Implement status strip**

Add an optional `activityStatus` prop to `ChatMessageList`.

Render in the footer above existing boot/thinking fallback:

```tsx
{activityStatus && activityStatus.phase !== 'idle' && (
  <div className={styles.liveStatusStrip} role="status" aria-live="polite">
    <span className={styles.liveStatusDot} />
    <span className={styles.liveStatusLabel}>{activityStatus.label}</span>
    {activityStatus.activeToolName ? <span className={styles.liveStatusDetail}>{activityStatus.activeToolName}</span> : null}
  </div>
)}
```

Keep styling compact, non-card-heavy, and responsive. Avoid duplicate stop buttons in this task; keep the existing Stop Generating control in `ChatInput`.

- [ ] **Step 4: Wire prop through `HermesChat`**

Read `activityStatus` from `useChatEngine()` and pass it to `ChatMessageList`.

- [ ] **Step 5: Run focused component tests**

Run:

```bash
cd dashboard
npm test -- --runTestsByPath src/components/chat/__tests__/ChatMessageList.test.tsx src/components/chat/__tests__/HermesChat.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Run full verification**

Run:

```bash
cd dashboard
npm run test:ci
npm run typecheck
npm run lint
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/components/chat/ChatMessageList.tsx dashboard/src/components/chat/ChatMessageList.module.css dashboard/src/components/chat/HermesChat.tsx dashboard/src/components/chat/__tests__/ChatMessageList.test.tsx dashboard/src/components/chat/__tests__/HermesChat.test.tsx
git commit -m "feat: chat live status - show composer activity strip"
```

## Task 4: Lock Inline Blank-Gap Cue

**Files:**
- Modify: `dashboard/src/components/chat/ChatMessage.tsx`
- Test: `dashboard/src/components/chat/__tests__/ChatMessage.test.tsx`

- [ ] **Step 1: Write failing test for empty streaming assistant**

Add a test:

```tsx
render(<ChatMessage message={{ id: 'assistant-empty', role: 'assistant', content: '', isStreaming: true }} ... />);
expect(screen.getByTestId('chat-thinking')).toHaveTextContent('pending activity');
```

- [ ] **Step 2: Run focused test**

Run:

```bash
cd dashboard
npm test -- --runTestsByPath src/components/chat/__tests__/ChatMessage.test.tsx
```

Expected: PASS if the existing uncommitted `ChatMessage.tsx` change already covers it, or FAIL if the implementation needs adjustment.

- [ ] **Step 3: Keep or refine the implementation**

Use the existing approach:

```ts
const shouldShowStreamingPlaceholder =
  message.isStreaming && !message.content.trim() && !message.reasoning_content;
```

Then include it in the `ChatThinking` condition and exclude it from the older fallback to avoid duplicate cues.

- [ ] **Step 4: Run focused tests**

Run:

```bash
cd dashboard
npm test -- --runTestsByPath src/components/chat/__tests__/ChatMessage.test.tsx src/components/chat/__tests__/ChatThinking.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Run full verification**

Run:

```bash
cd dashboard
npm run test:ci
npm run typecheck
npm run lint
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/components/chat/ChatMessage.tsx dashboard/src/components/chat/__tests__/ChatMessage.test.tsx
git commit -m "feat: chat live status - preserve inline activity"
```

## Task 5: Failure/Cutoff Guard Review

**Files:**
- Modify: `dashboard/src/components/chat/hooks/useChatStreaming.ts` only if tests reveal a stuck loading state.
- Test: `dashboard/src/components/chat/hooks/__tests__/useChatStreaming.test.ts`

- [ ] **Step 1: Add focused regression test if missing**

Cover a stream error/timeout path that confirms:

- Conversation `isLoading` becomes false.
- Conversation `isThinking` becomes false.
- Assistant message `isStreaming` becomes false or empty placeholder is removed.
- User-visible `error` is set.

- [ ] **Step 2: Run focused streaming test**

Run:

```bash
cd dashboard
npm test -- --runTestsByPath src/components/chat/hooks/__tests__/useChatStreaming.test.ts
```

Expected: PASS if existing behavior already clears state. If it fails, implement the smallest correction.

- [ ] **Step 3: Implement only if needed**

Do not rewrite transport. Only normalize terminal UI state in the catch/error path or terminal snapshot path if a test proves the UI can spin forever.

- [ ] **Step 4: Run full verification**

Run:

```bash
cd dashboard
npm run test:ci
npm run typecheck
npm run lint
```

Expected: all pass.

- [ ] **Step 5: Commit if code changed**

```bash
git add dashboard/src/components/chat/hooks/useChatStreaming.ts dashboard/src/components/chat/hooks/__tests__/useChatStreaming.test.ts
git commit -m "feat: chat live status - clear failed stream activity"
```

## Final Verification

- [ ] Run full verification one more time:

```bash
cd dashboard
npm run test:ci
npm run typecheck
npm run lint
```

- [ ] Check final diff:

```bash
git status --short
git log --oneline -5
```

- [ ] Plain-English review:
  - Confirm the composer strip appears while the agent is working.
  - Confirm blank assistant stream gaps still show inline activity.
  - Confirm failed/stopped turns do not keep spinning forever.

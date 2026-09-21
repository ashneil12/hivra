# Chat Live Status Design

## Goal

Make long-running chat turns feel trustworthy and alive. A user should always be able to tell whether the agent is still working, writing, using a tool, reconnecting, stopped, or failed. The UI must also avoid the current blank gaps where the assistant appears frozen before text or tool cards resume.

## Selected Direction

Use option 2 from the visual exploration: a persistent composer-level status strip plus a compact inline cue inside the latest assistant message.

The composer strip is the primary reassurance surface. It stays visible for the whole active turn and gives the user one stable place to check the run state.

The inline cue is secondary. It appears only when the latest assistant message would otherwise look empty or frozen, such as before the first visible token arrives or while a hidden running tool is active.

## User Experience

During an active run, show a slim status strip above the composer. It should fit the existing Hermes chat styling: compact, work-focused, restrained, and not card-heavy. It should include:

- A live activity indicator.
- A short human-readable phase label.
- Elapsed time for reassurance.
- A recency hint such as "Updated just now" or "Last update 12s ago" when available.
- Access to the existing Stop Generating action without duplicating confusing controls.

Suggested phase labels:

- `Thinking...` when the assistant has started but no visible output exists yet.
- `Running tool...` when any visible or hidden tool call is running.
- `Writing response...` when assistant text is streaming.
- `Reconnecting...` if the stream is booting or retrying after a transient gateway state.
- `Stopped` after the user stops generation.
- `Failed` or `Cut off` when the stream ends with an error, timeout, or empty close.

The strip should not imply exact progress. It should communicate liveness, not a fake percentage.

## Inline Cue

Keep the latest assistant message from going visually blank while the stream is alive. The inline cue should use the existing compact `ChatThinking` language or a close sibling component, but it should be driven by message state rather than generic fallback rendering.

Show the inline cue when:

- The latest assistant message is streaming.
- The message has no visible assistant text.
- There is no completed tool card to render.
- Reasoning content is absent or hidden.

Also show a compact cue near hidden running tool activity when tool details are not expanded.

Hide the inline cue when:

- Assistant text is visible and streaming normally.
- Completed tool cards or visible tool cards are already providing status.
- The run has stopped, failed, or completed.

## State Model

Add a small derived chat activity helper that converts existing state into one UI-friendly status object. It should read from existing state instead of introducing a second source of truth.

Inputs:

- Conversation state: `isLoading`, `isThinking`, `isBooting`, `error`.
- Latest assistant message: `isStreaming`, `content`, `reasoning_content`, `tool_calls`, `metadata.stream_state`, `metadata.stream_updated_at`, `metadata.stream_error`.
- Tool calls: `running`, `success`, `error`, and `complete` statuses.

Output shape:

```ts
type ChatActivityStatus = {
  phase: 'idle' | 'thinking' | 'tool' | 'writing' | 'reconnecting' | 'stopped' | 'failed';
  label: string;
  detail?: string;
  elapsedSeconds?: number;
  lastUpdateSeconds?: number;
  activeToolName?: string;
  canStop: boolean;
};
```

This helper should prefer the clearest user-facing phase:

1. Failed state if the run has ended with an error or timeout.
2. Reconnecting if booting/retry state is active.
3. Running tool if any current tool call is running.
4. Writing response if visible assistant text is streaming.
5. Thinking if the run is loading but no visible output exists yet.
6. Idle otherwise.

## Failure Handling

The UI must not spin forever after a bad stream end. When the stream reports `error`, `timeout`, or an empty premature close, clear active streaming flags and show a visible failure/cutoff state.

The failed state should be plain English and recoverable:

- "The response was cut off."
- "The agent timed out."
- "The connection dropped before the reply finished."

Existing retry behavior should remain available.

## Implementation Notes

Expected code areas:

- `dashboard/src/components/chat/hooks/useChatEngine.ts` to expose the derived activity status, or a nearby helper used by it.
- `dashboard/src/components/chat/hooks/useChatStreaming.ts` if additional terminal metadata must be preserved on failed/stopped messages.
- `dashboard/src/components/chat/ChatMessageList.tsx` for rendering the composer-level strip.
- `dashboard/src/components/chat/ChatMessage.tsx` for the compact inline blank-gap cue.
- Focused tests in the chat component and hook test suites.

The implementation should keep the current chat transport architecture intact. This is a UX/state derivation refinement, not a stream transport rewrite.

## Testing Plan

Add or update tests for:

- Streaming assistant message with no visible text still shows inline activity.
- Running hidden tool call shows activity and does not render a blank gap.
- Composer status strip shows thinking, tool, and writing phases.
- Stop generation clears active status and message streaming flags.
- Error or timeout does not leave the UI in an infinite generating state.

Run the normal dashboard checks after implementation: test suite, type check, and lint.

## Decisions

- Chosen approach: persistent status strip plus inline cue.
- Avoid fake progress bars or percentages.
- Keep wording compact and reassuring.
- Derive status from existing chat state before adding new persisted fields.

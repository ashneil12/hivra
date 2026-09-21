import type { WorkspaceConversationAdapter } from "./workspace-conversation-adapters";

/**
 * The conversation pane for a resolved adapter.
 *
 * This used to carry an unconditional "Legacy session — this session has no
 * canonical run acknowledgement" header. It sat AFTER the no-conversation guard
 * in UnifiedWorkspace, so it only ever rendered above a conversation that HAD
 * resolved — meaning it labelled every healthy conversation a legacy session and
 * described a run-acknowledgement model that does not exist anywhere in the
 * product yet. It carried no state of its own, so there is nothing to keep.
 *
 * When such an acknowledgement model is actually built, the honest place to
 * surface its absence is the unsupported case, not on top of every working chat.
 */
export interface WorkspaceConversationProps {
  adapter: WorkspaceConversationAdapter;
}

export function WorkspaceConversation({ adapter }: WorkspaceConversationProps) {
  return (
    <section
      aria-label={`Conversation for ${adapter.computer.name}`}
      className="flex min-h-0 flex-1 flex-col bg-[var(--bg-surface)]"
      data-conversation-uid={adapter.uid}
    >
      <div key={adapter.uid} className="min-h-0 flex-1 overflow-hidden">
        {adapter.renderConversation()}
      </div>
    </section>
  );
}

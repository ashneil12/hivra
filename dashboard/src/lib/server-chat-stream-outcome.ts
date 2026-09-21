import { detectSoftChatError } from "@/lib/ops-event-classification";

// SCRIPTURE_ANCHOR: stream-end | 2 Timothy 4:7 | Verse: I have fought the good fight. I have finished the course. I have kept the faith.
export interface ServerChatStreamTerminalOutcome {
  shouldDropMessage: boolean;
  finalStatus: "completed" | "failed";
  error?: string;
}

export function resolveServerChatStreamTerminalOutcome(params: {
  assistantContent: string;
  terminalState: "done" | "error" | "timeout" | "close" | "stopped";
  hasRenderableOutput: boolean;
}): ServerChatStreamTerminalOutcome {
  const softErrorDetection = detectSoftChatError(params.assistantContent);
  if (softErrorDetection) {
    return {
      shouldDropMessage: true,
      finalStatus: "failed",
      error: softErrorDetection.excerpt,
    };
  }

  const isFailedTerminalState = params.terminalState === "error" || params.terminalState === "timeout";
  return {
    shouldDropMessage: !params.hasRenderableOutput && isFailedTerminalState,
    finalStatus: isFailedTerminalState ? "failed" : "completed",
  };
}

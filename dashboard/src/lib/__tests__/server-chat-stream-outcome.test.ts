import { resolveServerChatStreamTerminalOutcome } from "../server-chat-stream-outcome";

describe("resolveServerChatStreamTerminalOutcome", () => {
  it("drops assistant messages when terminal content is a soft chat error", () => {
    expect(resolveServerChatStreamTerminalOutcome({
      assistantContent: "Error code: 401 - {'error': {'message': 'Missing Authentication header', 'code': 401}}",
      terminalState: "done",
      hasRenderableOutput: true,
    })).toEqual({
      shouldDropMessage: true,
      finalStatus: "failed",
      error: "Error code: 401 - {'error': {'message': 'Missing Authentication header', 'code': 401}}",
    });
  });

  it("keeps normal completed assistant replies", () => {
    expect(resolveServerChatStreamTerminalOutcome({
      assistantContent: "Hello from Hermes",
      terminalState: "done",
      hasRenderableOutput: true,
    })).toEqual({
      shouldDropMessage: false,
      finalStatus: "completed",
    });
  });

  it("drops empty terminal error messages that never produced renderable output", () => {
    expect(resolveServerChatStreamTerminalOutcome({
      assistantContent: "",
      terminalState: "error",
      hasRenderableOutput: false,
    })).toEqual({
      shouldDropMessage: true,
      finalStatus: "failed",
    });
  });
});

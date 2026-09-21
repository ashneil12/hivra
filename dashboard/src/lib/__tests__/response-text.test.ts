import { extractCompletedAssistantContent, extractResponseText } from "@/lib/response-text";

describe("extractResponseText", () => {
  it("returns trimmed chat completions content", () => {
    expect(
      extractResponseText({
        choices: [
          {
            message: {
              content: "  Hello Hermes  ",
            },
          },
        ],
      })
    ).toBe("Hello Hermes");
  });

  it("returns concatenated Responses API output text", () => {
    expect(
      extractResponseText({
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: "Ops" },
              { type: "output_text", text: " Feed" },
            ],
          },
        ],
      })
    ).toBe("Ops Feed");
  });

  it("returns null for unusable payloads", () => {
    expect(extractResponseText({ output: [{ type: "message", role: "assistant", content: [] }] })).toBeNull();
    expect(extractResponseText({ choices: [{ message: { content: null } }] })).toBeNull();
  });

  it("ignores non-assistant response output items", () => {
    expect(
      extractResponseText({
        output: [
          {
            type: "message",
            role: "user",
            content: [{ type: "output_text", text: "User text" }],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Assistant text" }],
          },
        ],
      })
    ).toBe("Assistant text");
  });
});

describe("extractCompletedAssistantContent", () => {
  it("prefers top-level content when present", () => {
    expect(
      extractCompletedAssistantContent({
        content: "Direct assistant completion",
      })
    ).toBe("Direct assistant completion");
  });

  it("extracts structured assistant text from nested response payloads", () => {
    expect(
      extractCompletedAssistantContent({
        type: "response.completed",
        response: {
          output: [
            {
              type: "message",
              role: "assistant",
              content: [
                { type: "output_text", text: "Nested final answer" },
              ],
            },
          ],
        },
      })
    ).toBe("Nested final answer");
  });

  it("falls back to direct responses-style output on the payload itself", () => {
    expect(
      extractCompletedAssistantContent({
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: "Direct output answer" },
            ],
          },
        ],
      })
    ).toBe("Direct output answer");
  });

  it("falls back to nested response output when top-level content is blank", () => {
    expect(
      extractCompletedAssistantContent({
        content: "   ",
        response: {
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Nested fallback answer" }],
            },
          ],
        },
      })
    ).toBe("Nested fallback answer");
  });
});

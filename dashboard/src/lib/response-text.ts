type ChatCompletionChoice = {
  message?: {
    content?: string | null;
  };
};

type ResponsesOutputItem = {
  type?: string;
  role?: string;
  content?: Array<{
    type?: string;
    text?: string | null;
  }>;
};

type ResponseTextPayload = {
  type?: string;
  choices?: ChatCompletionChoice[];
  output?: ResponsesOutputItem[];
  response?: ResponseTextPayload;
  content?: string | null;
};

export function extractResponseText(data: ResponseTextPayload): string | null {
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed ? trimmed : null;
  }

  let aggregatedContent = "";

  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (item.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content)) {
        continue;
      }

      for (const part of item.content) {
        if (part.type === "output_text" && typeof part.text === "string") {
          aggregatedContent += part.text;
        }
      }
    }
  }

  const trimmed = aggregatedContent.trim();
  return trimmed ? trimmed : null;
}

export function extractCompletedAssistantContent(data: ResponseTextPayload): string | null {
  if (typeof data.content === "string") {
    const trimmed = data.content.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  if (data.response && typeof data.response === "object") {
    const nested = extractResponseText(data.response);
    if (nested) {
      return nested;
    }
  }

  return extractResponseText(data);
}

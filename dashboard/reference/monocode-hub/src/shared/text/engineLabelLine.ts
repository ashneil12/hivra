/**
 * r91 (Critiquito 8): the engine label a Lead adds after a launch ("Grok 4.7 · High · DeepSeek wasn't available")
 * goes on a line of its own. The launch note asks for that, but in the blind and scripted runs the Lead still ran it on
 * from the sentence ("That work is running. Grok 4.7 · High · ..."), so the reply is split where it renders. Only a
 * label that ends a prose line after a full stop moves; code fences are left alone.
 */
const FENCE = /^[ \t]*(`{3,}|~{3,})/;
const TRAILING_LABEL =
  /([.!?])[ \t]+((?:Grok|DeepSeek|Claude|Haiku|Sonnet|Opus|GPT|Gemini|Kimi|Qwen)\b[^\n·`]{0,24} · [^\n`]*)$/;

/**
 * r94 (Critiquito d, s15 3cde): the Lead wrote the label on the next line with a single newline ("That's running now.\n
 * Grok 4.7 · High · ..."). Markdown reads one newline as a soft break, so the label rendered inline again. A label line
 * straight under a prose line gets a blank line before it, so it is a paragraph of its own.
 */
const LABEL_LINE = /^[ \t]*(?:Grok|DeepSeek|Claude|Haiku|Sonnet|Opus|GPT|Gemini|Kimi|Qwen)\b[^\n·`]{0,24} · [^\n`]*$/;

export function engineLabelOnOwnLine(text: string): string {
  if (!text || !text.includes(" · ")) return text;
  let inFence = false;
  let prev = "";
  return text
    .split("\n")
    .map((line) => {
      if (FENCE.test(line)) {
        inFence = !inFence;
        prev = line;
        return line;
      }
      if (inFence) return line;
      const out = LABEL_LINE.test(line) && prev.trim() && !LABEL_LINE.test(prev) ? `\n${line}` : line.replace(TRAILING_LABEL, "$1\n\n$2");
      prev = line;
      return out;
    })
    .join("\n");
}

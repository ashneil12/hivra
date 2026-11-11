/**
 * r95 (c02 BLIND 0774): the Lead told Ash its own tool rule in the chat: "I need to delegate before using any other
 * tool." It echoed the team-chat rule ("first one delegate_task per area, before any other tool", monoFiles.ts
 * TEAM_CHAT_RULES), and "Loading the hub tools first." the same way. Those are the app's rules for the Lead, not news for
 * Ash: where a reply renders (and in Copy) such a sentence goes. Code fences are left alone.
 */
const RULE_TALK = [
  // "I need to delegate before using any other tool." / "I must call delegate_task first." / "I have to hand off before I use other tools."
  /(?:^|(?<=[.!?]\s))(?:First,?\s+)?I(?:'ll| will)? (?:need|have|must|am (?:supposed|required|only allowed)|'m (?:supposed|required|only allowed)|should)(?: to)? (?:delegate|call delegate_task|use delegate_task|hand (?:it |each area |the work )?off)\b[^.!?\n]{0,60}\b(?:before|first)\b[^.!?\n]{0,60}(?:[.!]|$)\s*/gi,
  // "My rules say I delegate first." / "The hub requires delegate_task before other tools."
  /(?:^|(?<=[.!?]\s))(?:My (?:rules?|instructions?)|The (?:hub|app|team(?:-chat)? rules?)) (?:says?|requires?|wants?|asks?)\b[^.!?\n]{0,80}\b(?:tools?|delegate(?:_task)?)\b[^.!?\n]{0,60}(?:[.!]|$)\s*/gi,
  // "Loading the hub tools first." (a tool lookup, said out loud)
  /(?:^|(?<=[.!?]\s))(?:Loading|Fetching|Looking up) (?:the )?(?:hub |MonoCode |MCP )?tools?(?: first)?[.!]?\s*(?=$|\n)/gi,
  // r97 (frank e, c02 BLIND 242d +23s): "I'll load the delegate and memory tools first, then hand each area off …":
  // the lookup clause goes and the rest of the sentence stays ("I'll hand each area off …").
  /\b(?:load|fetch|look up|pull in|grab)(?:ing)? (?:the |my )?(?:[\w-]+(?:,| and)? ){0,5}tools?(?: first)?,? (?:and )?then /gi,
  // "I'll load the delegate and memory tools first." / "Let me load the tools." / "Loading the delegate and memory tools."
  /(?:^|(?<=[.!?]\s))(?:(?:First,? )?I(?:'ll| will| need to| have to|'m going to| am going to)|Let me|First,?) (?:load|fetch|look up|pull in|grab)\b[^.!?\n]{0,60}\btools?\b[^.!?\n]{0,30}(?:[.!]|$)\s*/gi,
  /(?:^|(?<=[.!?]\s))(?:Loading|Fetching|Looking up|Pulling in) (?:the |my )?(?:[\w-]+(?:,| and)? ){0,5}tools?(?: first)?(?:[.!]\s*|\s*$)/gi,
];
const FENCE = /^[ \t]*(`{3,}|~{3,})/;

export function withoutToolRuleTalk(text: string): string {
  if (!text || !/\b(?:tools?|delegate)/i.test(text)) return text;
  let inFence = false;
  let dropped = false;
  const lines = text.split("\n").flatMap((line) => {
    if (FENCE.test(line)) {
      inFence = !inFence;
      return [line];
    }
    if (inFence) return [line];
    let out = line;
    for (const rule of RULE_TALK) out = out.replace(rule, "");
    out = out.replace(/[ \t]+$/, "");
    if (out !== line.replace(/[ \t]+$/, "")) {
      dropped = true;
      if (!out.trim()) return [];
    }
    return [out];
  });
  return dropped ? lines.join("\n").replace(/\n{3,}/g, "\n\n") : text;
}

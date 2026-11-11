/**
 * r94 (Critiquito g, c02 8ff9): asked "anything need me", the Lead said "Nothing needs you. No questions are waiting."
 * The second sentence says the first again. Where a reply renders, "Nothing needs you" stands alone; the doubled
 * sentence after it goes. Code fences are left alone.
 */
const ALL_CLEAR = /\b(Nothing (?:needs|is waiting on|is waiting for) you(?: right now| now| yet| at the moment)?)/i;
/**
 * The sentence after it that says the same thing again: "No questions are waiting.", "No one is stuck on a question."
 * (c02 0774), "Nobody is waiting on you.", ", no questions pending". It opens with No / No one / Nobody / There are no and
 * speaks only of questions, decisions, approvals, asks, answers, or being stuck or waiting, in one short sentence.
 */
const ECHO =
  /^(?:[.!,;]|\s+[-–])\s*(?:and\s+)?((?:there (?:are|is) )?(?:no one|nobody|no)\b[^.!?\n]{0,60}?\b(?:questions?|decisions?|approvals?|asks?|answers?|stuck|waiting|pending|blocked)\b[^.!?\n]{0,30}?)(?:[.!]|(?=\n)|$)/i;

function collapse(line: string): string {
  let out = "";
  let rest = line;
  for (;;) {
    const hit = ALL_CLEAR.exec(rest);
    if (!hit) return out + rest;
    const after = rest.slice(hit.index + hit[0].length);
    const echo = ECHO.exec(after);
    if (echo && !/\d/.test(echo[1])) {
      out += `${rest.slice(0, hit.index)}${hit[1]}.`;
      rest = after.slice(echo[0].length);
    } else {
      out += rest.slice(0, hit.index + hit[0].length);
      rest = after;
    }
  }
}
const FENCE = /^[ \t]*(`{3,}|~{3,})/;

export function withoutDoubledAllClear(text: string): string {
  if (!text || !/nothing (?:needs|is waiting)/i.test(text)) return text;
  let inFence = false;
  return text
    .split("\n")
    .map((line) => {
      if (FENCE.test(line)) {
        inFence = !inFence;
        return line;
      }
      return inFence ? line : collapse(line);
    })
    .join("\n");
}

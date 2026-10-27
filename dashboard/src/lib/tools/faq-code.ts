// Commands, keys and flags quoted in a tool's FAQ answers, found by exact phrase.
//
// The answers stay plain strings in the catalog (they are what the FAQPage structured data carries).
// A tool that quotes commands lists them in `faqCode`, and the page sets those phrases in the monospace
// face, so `cat >> ~/NAME.log` is not read as prose with a gap in the middle. The text is unchanged:
// joining the parts gives the original answer back.

export interface FaqPart {
  text: string;
  code: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Splits an answer into plain and code parts. At each position the longest listed phrase wins, and a
 * phrase only counts as a whole token: it may not touch a letter, digit, underscore or hyphen on
 * either side, so "-s" is found in "The -s flag" but not in "-is" or "systemd-inhibit".
 */
export function splitFaqCode(answer: string, phrases: readonly string[]): FaqPart[] {
  const listed = [...new Set(phrases)].filter((phrase) => phrase.length > 0).sort((a, b) => b.length - a.length);
  if (listed.length === 0) return [{ text: answer, code: false }];

  const pattern = new RegExp(`(?<![\\w-])(?:${listed.map(escapeRegExp).join("|")})(?![\\w-])`, "g");
  const parts: FaqPart[] = [];
  let last = 0;
  for (const match of answer.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) parts.push({ text: answer.slice(last, start), code: false });
    parts.push({ text: match[0], code: true });
    last = start + match[0].length;
  }
  if (last < answer.length) parts.push({ text: answer.slice(last), code: false });
  return parts;
}

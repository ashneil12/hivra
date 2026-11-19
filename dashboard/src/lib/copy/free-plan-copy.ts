// Once the Free plan is closed to new sign-ups (HIVRA_FREE_PLAN_CLOSED_AT has
// passed where the page is rendered), docs and articles stop describing a free
// account. Sentences that do are dropped; a remaining mention becomes "your
// account". With the Free plan open, text is returned unchanged.

import { isFreePlanClosed } from "@/lib/billing/free-plan-cutoff";

const FREE_ACCOUNT_SENTENCE = /(^|[.!?]["”]?[ \t]+|\n|\|[ \t]*)[^.!?\n|]*\bfree (?:Hivra )?account\b[^.!?\n|]*[.!?]["”]?[ \t]?/gi;

export function withoutFreeAccount(text: string): string {
  return text
    .replace(FREE_ACCOUNT_SENTENCE, "$1")
    .replace(/\b[Aa] free (?:Hivra )?account\b/g, "your account")
    .replace(/\bfree (?:Hivra )?account\b/gi, "account");
}

function mapStrings<T>(value: T, fn: (text: string) => string): T {
  if (typeof value === "string") return fn(value) as T;
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, fn)])) as T;
  }
  return value;
}

/** The content as the current Free plan state should show it. */
export function forFreePlanState<T>(content: T, closed: boolean = isFreePlanClosed()): T {
  return closed ? mapStrings(content, withoutFreeAccount) : content;
}

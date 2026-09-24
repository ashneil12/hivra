// Browser-safe helpers for owner-declared provider token expiry.

import type { CredentialExpiryDto, ProviderTokenExpiryInput } from "./contracts";

/** Remind this many days ahead of the declared date. */
export const TOKEN_EXPIRY_WARNING_DAYS = 7;

export type TokenExpiryChoice = "unknown" | "none" | "30" | "60" | "90" | "365" | "date";

export const TOKEN_EXPIRY_CHOICES: Array<{ value: TokenExpiryChoice; label: string }> = [
  { value: "unknown", label: "Not sure" },
  { value: "none", label: "No expiry" },
  { value: "30", label: "30 days from today" },
  { value: "60", label: "60 days from today" },
  { value: "90", label: "90 days from today" },
  { value: "365", label: "1 year from today" },
  { value: "date", label: "On a date…" },
];

function localDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Today's calendar date in the viewer's time zone, as YYYY-MM-DD. */
export function todayDateString(now: Date = new Date()): string {
  return localDateString(now);
}

/** Turn the picker's choice into what the API records, or undefined for "Not sure". */
export function tokenExpiryInputFor(choice: TokenExpiryChoice, date: string, now: Date = new Date()): ProviderTokenExpiryInput | undefined {
  if (choice === "unknown") return undefined;
  if (choice === "none") return { mode: "none" };
  if (choice === "date") return { mode: "date", date };
  const target = new Date(now);
  target.setDate(target.getDate() + Number(choice));
  return { mode: "date", date: localDateString(target) };
}

/** Whole calendar days from the viewer's today until a YYYY-MM-DD date. */
export function daysUntil(expiresOn: string, now: Date = new Date()): number {
  const [year, month, day] = expiresOn.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86_400_000);
}

export type TokenExpiryState =
  | { kind: "unknown" }
  | { kind: "never" }
  | { kind: "later"; expiresOn: string; days: number }
  | { kind: "soon"; expiresOn: string; days: number }
  | { kind: "expired"; expiresOn: string };

export function tokenExpiryState(expiry: CredentialExpiryDto | null | undefined, now: Date = new Date()): TokenExpiryState {
  if (!expiry) return { kind: "unknown" };
  if (expiry.noExpiry || !expiry.expiresOn) return { kind: "never" };
  const days = daysUntil(expiry.expiresOn, now);
  if (days < 0) return { kind: "expired", expiresOn: expiry.expiresOn };
  if (days <= TOKEN_EXPIRY_WARNING_DAYS) return { kind: "soon", expiresOn: expiry.expiresOn, days };
  return { kind: "later", expiresOn: expiry.expiresOn, days };
}

export function formatExpiryDate(expiresOn: string): string {
  const [year, month, day] = expiresOn.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** "today", "tomorrow", or "in 5 days". */
export function relativeDays(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

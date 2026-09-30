import type { supabaseAdmin } from "@/lib/supabase";

/**
 * Looks up a reservation by email without letting the email act as a pattern.
 *
 * The old lookups used `.ilike("email", email)`, which treats `%` and `_` in
 * the caller's email as wildcards. `a%@gmail.com` matched another person's row,
 * and `john_smith@x.com` matched `john.smith@x.com`. The route's own email
 * check accepts both characters.
 *
 * Every writer stores the email trimmed and lower-cased, so the lookup is an
 * exact match on that form: no pattern, no wildcards.
 *
 * The one extra step is for a row written before every writer lower-cased (the
 * table only has a unique index on lower(email), no CHECK). If the exact match
 * finds nothing, try a case-insensitive match with `\`, `%` and `_` escaped, so
 * the value is literal. PostgREST turns `*` into `%` inside like and ilike
 * values and offers no way to escape it, so an email containing `*` never takes
 * that step.
 */

type AdminClient = NonNullable<typeof supabaseAdmin>;

export interface ReservationLookupResult<Row> {
  data: Row | null;
  error: { code?: string; message?: string } | null;
}

export function normalizeReservationEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export async function findReservationByEmail<Row>(
  client: AdminClient,
  email: string,
  columns: string,
): Promise<ReservationLookupResult<Row>> {
  const normalized = normalizeReservationEmail(email);

  const exact = await client
    .from("reservations")
    .select(columns)
    .eq("email", normalized)
    .maybeSingle<Row>();
  if (exact.error || exact.data || normalized.includes("*")) {
    return exact as ReservationLookupResult<Row>;
  }

  const legacyCase = await client
    .from("reservations")
    .select(columns)
    .ilike("email", escapeLikeLiteral(normalized))
    .maybeSingle<Row>();
  return legacyCase as ReservationLookupResult<Row>;
}

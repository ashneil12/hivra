/**
 * Split an array into fixed-size chunks. Commonly used to page Supabase
 * `.in(...)` queries (PostgREST caps the in-list size) and to batch fan-out
 * work. Extracted from six byte-identical local copies.
 */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

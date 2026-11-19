// A PostgREST-shaped client over PGlite running the REAL migrations, so the
// promo tests exercise the actual SQL functions (row lock, budget, expiry).
import fs from "node:fs";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS = path.resolve(__dirname, "../../../../../supabase/migrations");
const FILES = [
  "20260512180000_managed_venice_wallets.sql",
  "20260606140100_managed_venice_reservation_balance_guard.sql",
  "20260925201500_managed_venice_atomic_wallet_debits.sql",
  "20260605120000_hivra_agents.sql",
  "20260613170000_commit_hivra_llm_config_drift.sql",
  "20261111143017_venice_promo_campaigns.sql",
];

export async function createPromoDb() {
  const pg = new PGlite();
  await pg.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
    create schema auth;
    create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
    create function public.update_updated_at() returns trigger language plpgsql as $$
      begin new.updated_at = now(); return new; end $$;
  `);
  for (const f of FILES) await pg.exec(fs.readFileSync(path.join(MIGRATIONS, f), "utf8"));

  type Filter = { col: string; op: string; val: unknown };
  function builder(table: string) {
    const filters: Filter[] = [];
    let orderBy: string | null = null;
    let orderAsc = true;
    let lim: number | null = null;
    let insertRow: Record<string, unknown> | null = null;
    let single = false;

    async function run(): Promise<{ data: unknown; error: { code?: string; message?: string } | null }> {
      try {
        if (insertRow) {
          const cols = Object.keys(insertRow);
          await pg.query(
            `insert into public.${table} (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")})`,
            cols.map((c) => insertRow![c])
          );
          return { data: null, error: null };
        }
        const params: unknown[] = [];
        const where = filters.map((f) => {
          if (f.op === "in") {
            params.push(f.val);
            return `${f.col} = any($${params.length})`;
          }
          params.push(f.val);
          const sym = { eq: "=", gte: ">=", lte: "<=", lt: "<" }[f.op];
          return `${f.col} ${sym} $${params.length}`;
        });
        const sql =
          `select * from public.${table}` +
          (where.length ? ` where ${where.join(" and ")}` : "") +
          (orderBy ? ` order by ${orderBy} ${orderAsc ? "asc" : "desc"}` : "") +
          (lim !== null ? ` limit ${lim}` : "");
        const res = await pg.query(sql, params);
        const rows = res.rows as Record<string, unknown>[];
        return { data: single ? (rows[0] ?? null) : rows, error: null };
      } catch (e) {
        const err = e as { code?: string; message?: string };
        return { data: null, error: { code: err.code, message: err.message } };
      }
    }

    const b: Record<string, unknown> = {
      select: () => b,
      eq: (col: string, val: unknown) => (filters.push({ col, op: "eq", val }), b),
      in: (col: string, val: unknown) => (filters.push({ col, op: "in", val }), b),
      gte: (col: string, val: unknown) => (filters.push({ col, op: "gte", val }), b),
      lte: (col: string, val: unknown) => (filters.push({ col, op: "lte", val }), b),
      lt: (col: string, val: unknown) => (filters.push({ col, op: "lt", val }), b),
      order: (col: string, opts?: { ascending?: boolean }) => ((orderBy = col), (orderAsc = opts?.ascending !== false), b),
      limit: (n: number) => ((lim = n), b),
      insert: (row: Record<string, unknown>) => ((insertRow = row), b),
      maybeSingle: () => ((single = true), run()),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => run().then(res, rej),
    };
    return b;
  }

  const db = {
    from: (table: string) => builder(table),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      try {
        const keys = Object.keys(args);
        const res = await pg.query(
          `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`,
          keys.map((k) => args[k])
        );
        return { data: (res.rows[0] as { r: unknown }).r, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    },
  };

  return { pg, db };
}

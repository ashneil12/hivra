/**
 * A small in-memory `reservations` table with the query behaviour that the
 * email lookups depend on, for tests that must prove a pattern email matches
 * nothing.
 *
 * `eq` compares exactly. `ilike` follows PostgreSQL LIKE, case-insensitively:
 * `%` is any run of characters, `_` is any one character, and a backslash
 * makes the next character literal. PostgREST also turns `*` into `%` inside a
 * like or ilike value before it reaches the database, and the fake does the
 * same, because that is what the real server does with the value.
 */

export type ReservationFakeRow = Record<string, unknown> & { id: string; email: string };

export interface ReservationsFake {
  rows: ReservationFakeRow[];
  admin: { from: (table: string) => unknown };
  /** Every `ilike` pattern received, in order. */
  ilikePatterns: string[];
  /** Every `eq("email", ...)` value received, in order. */
  emailEqValues: string[];
}

function likeToRegExp(pattern: string): RegExp {
  const withStar = pattern.replace(/\*/g, "%");
  let source = "";
  for (let index = 0; index < withStar.length; index += 1) {
    const char = withStar[index];
    if (char === "\\" && index + 1 < withStar.length) {
      index += 1;
      source += withStar[index].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (char === "%") {
      source += "[\\s\\S]*";
    } else if (char === "_") {
      source += "[\\s\\S]";
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, "i");
}

export function createReservationsFake(initial: ReservationFakeRow[] = []): ReservationsFake {
  const fake: ReservationsFake = {
    rows: initial.map((row) => ({ ...row })),
    ilikePatterns: [],
    emailEqValues: [],
    admin: { from: () => undefined },
  };

  let nextId = 1000;

  function table() {
    type Predicate = (row: ReservationFakeRow) => boolean;

    const query = (mode: "select" | "update", patch?: Record<string, unknown>, columns?: string) => {
      const predicates: Predicate[] = [];
      const project = (row: ReservationFakeRow) => {
        if (!columns) return row;
        const out: Record<string, unknown> = {};
        for (const column of columns.split(",").map((part) => part.trim())) out[column] = row[column];
        return out;
      };
      const matching = () => fake.rows.filter((row) => predicates.every((predicate) => predicate(row)));

      const settle = async () => {
        const rows = matching();
        if (mode === "update") {
          for (const row of rows) Object.assign(row, patch);
          return { data: rows.map((row) => project(row)), error: null };
        }
        return { data: rows.map((row) => project(row)), error: null };
      };

      const builder = {
        eq(column: string, value: unknown) {
          if (column === "email") fake.emailEqValues.push(String(value));
          predicates.push((row) => row[column] === value);
          return builder;
        },
        ilike(column: string, pattern: string) {
          if (column === "email") fake.ilikePatterns.push(pattern);
          const regexp = likeToRegExp(pattern);
          predicates.push((row) => regexp.test(String(row[column] ?? "")));
          return builder;
        },
        in(column: string, values: unknown[]) {
          predicates.push((row) => values.includes(row[column]));
          return builder;
        },
        async maybeSingle() {
          const result = await settle();
          const data = result.data as unknown[];
          if (data.length > 1) {
            return { data: null, error: { code: "PGRST116", message: "multiple rows returned" } };
          }
          return { data: data[0] ?? null, error: null };
        },
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          return settle().then(resolve, reject);
        },
      };
      return builder;
    };

    return {
      select: (columns: string) => query("select", undefined, columns),
      update: (patch: Record<string, unknown>) => query("update", patch),
      insert: (row: Record<string, unknown>) => ({
        select: () => ({
          single: async () => {
            const email = String(row.email ?? "");
            if (fake.rows.some((existing) => existing.email.toLowerCase() === email.toLowerCase())) {
              return {
                data: null,
                error: { code: "23505", message: "duplicate key value violates unique constraint" },
              };
            }
            const created: ReservationFakeRow = { id: `res-${nextId++}`, position: fake.rows.length + 1, status: "queued", ...row, email };
            fake.rows.push(created);
            return { data: { position: created.position, tier_intent: created.tier_intent, status: created.status }, error: null };
          },
        }),
      }),
    };
  }

  fake.admin = {
    from: (name: string) => {
      if (name !== "reservations") throw new Error(`Unexpected table: ${name}`);
      return table();
    },
  };
  return fake;
}

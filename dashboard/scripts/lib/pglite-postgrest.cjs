// A PostgREST-shaped client over PGlite, for tests that run real application
// modules against the real migrations. It implements the subset of the
// supabase-js query builder those modules use (select / update, eq / in / is /
// lt, order, limit, maybeSingle / single, `.select()` after a write) as real
// SQL, and answers `{ data, error }` the way PostgREST does: statement errors
// come back as `error` (never thrown), timestamps as ISO strings, bigint as a
// JSON number.
//
// `failNextWrite(predicate)` makes the next matching write return an error
// without touching the database, to reproduce a write that never lands.

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function identifier(name) {
  if (!IDENTIFIER.test(name)) throw new Error(`unsupported identifier: ${name}`);
  return name;
}

function columnList(columns) {
  const trimmed = (columns || "*").trim();
  if (trimmed === "*") return "*";
  return trimmed
    .split(",")
    .map((column) => identifier(column.trim()))
    .join(", ");
}

function toParam(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (value && typeof value === "object") return JSON.stringify(value);
  return value;
}

function toJson(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return Number(value);
  return value;
}

function shapeRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, toJson(value)]));
}

function asError(error) {
  return { message: error.message, code: error.code || null, details: error.detail || null };
}

function createPgliteSupabase(db) {
  const writeFaults = [];

  class Query {
    constructor(table, operation, values) {
      this.table = identifier(table);
      this.operation = operation;
      this.values = values;
      this.filters = [];
      this.orders = [];
      this.limitCount = null;
      this.returning = null;
      this.columns = "*";
      this.mode = "many";
    }

    select(columns) {
      if (this.operation === "select") this.columns = columns;
      else this.returning = columns || "*";
      return this;
    }

    eq(column, value) {
      this.filters.push({ column: identifier(column), op: "=", value });
      return this;
    }

    lt(column, value) {
      this.filters.push({ column: identifier(column), op: "<", value });
      return this;
    }

    in(column, values) {
      this.filters.push({ column: identifier(column), op: "in", value: Array.from(values) });
      return this;
    }

    is(column, value) {
      if (value !== null) throw new Error("only .is(column, null) is supported");
      this.filters.push({ column: identifier(column), op: "is null" });
      return this;
    }

    order(column, options = {}) {
      this.orders.push(`${identifier(column)} ${options.ascending === false ? "desc" : "asc"}`);
      return this;
    }

    limit(count) {
      this.limitCount = Math.floor(count);
      return this;
    }

    maybeSingle() {
      this.mode = "maybeSingle";
      return this;
    }

    single() {
      this.mode = "single";
      return this;
    }

    build() {
      const params = [];
      const bind = (value) => {
        params.push(toParam(value));
        return `$${params.length}`;
      };
      const where = this.filters.map(({ column, op, value }) => {
        if (op === "is null") return `${column} is null`;
        if (op === "in") return value.length ? `${column} in (${value.map(bind).join(", ")})` : "false";
        return `${column} ${op} ${bind(value)}`;
      });
      const whereSql = where.length ? ` where ${where.join(" and ")}` : "";

      if (this.operation === "select") {
        const orderSql = this.orders.length ? ` order by ${this.orders.join(", ")}` : "";
        const limitSql = this.limitCount === null ? "" : ` limit ${this.limitCount}`;
        return {
          sql: `select ${columnList(this.columns)} from public.${this.table}${whereSql}${orderSql}${limitSql}`,
          params,
        };
      }

      const entries = Object.entries(this.values).map(([column, value]) => [identifier(column), value]);
      const returningSql = this.returning ? ` returning ${columnList(this.returning)}` : "";
      if (this.operation === "update") {
        const set = entries.map(([column, value]) => `${column} = ${bind(value)}`).join(", ");
        return { sql: `update public.${this.table} set ${set}${whereSql}${returningSql}`, params };
      }
      const columns = entries.map(([column]) => column).join(", ");
      const placeholders = entries.map(([, value]) => bind(value)).join(", ");
      return {
        sql: `insert into public.${this.table} (${columns}) values (${placeholders})${returningSql}`,
        params,
      };
    }

    async execute() {
      if (this.operation !== "select") {
        const faultIndex = writeFaults.findIndex((fault) => fault(this));
        if (faultIndex !== -1) {
          writeFaults.splice(faultIndex, 1);
          return { data: null, error: { message: "injected write failure", code: "TEST" } };
        }
      }

      const { sql, params } = this.build();
      let rows;
      try {
        rows = (await db.query(sql, params)).rows.map(shapeRow);
      } catch (error) {
        return { data: null, error: asError(error) };
      }

      if (this.operation !== "select" && !this.returning) return { data: null, error: null };
      if (this.mode === "many") return { data: rows, error: null };
      if (rows.length > 1) {
        return { data: null, error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" } };
      }
      if (rows.length === 0 && this.mode === "single") {
        return { data: null, error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" } };
      }
      return { data: rows[0] ?? null, error: null };
    }

    then(onFulfilled, onRejected) {
      return this.execute().then(onFulfilled, onRejected);
    }
  }

  return {
    client: {
      from(table) {
        return {
          select: (columns) => new Query(table, "select").select(columns),
          update: (values) => new Query(table, "update", values),
          insert: (values) => new Query(table, "insert", values),
        };
      },
    },
    // predicate receives { table, operation, values, filters }.
    failNextWrite(predicate) {
      writeFaults.push(predicate);
    },
  };
}

module.exports = { createPgliteSupabase };

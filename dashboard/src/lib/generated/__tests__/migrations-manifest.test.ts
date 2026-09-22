import { readdirSync } from "fs";
import { join } from "path";

import { LOCAL_MIGRATIONS } from "../migrations-manifest";

// The committed manifest is what the migration drift check compares against
// production. A migration file added without regenerating it would be reported
// as "unexpected" once applied, and a missing one would never be flagged.
it("lists exactly the migration files in supabase/migrations, in version order", () => {
  const files = readdirSync(join(__dirname, "../../../../supabase/migrations"))
    .map((name) => /^(\d{14})_(.+)\.sql$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(([, version, name]) => ({ version, name }))
    .sort((a, b) => a.version.localeCompare(b.version));
  expect(LOCAL_MIGRATIONS).toEqual(files);
  expect(LOCAL_MIGRATIONS).toContainEqual({ version: "20260922120000", name: "hivra_activity_collectors" });
});

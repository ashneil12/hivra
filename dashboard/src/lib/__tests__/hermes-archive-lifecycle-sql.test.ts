import { execFileSync } from "node:child_process";
import { join } from "node:path";

it("enforces archive transitions in Postgres", () => {
  execFileSync(process.execPath, ["-e", `
    const assert = require("node:assert/strict");
    const { readFileSync } = require("node:fs");
    const { PGlite } = require("@electric-sql/pglite");

    (async () => {
      const db = new PGlite();
      try {
        await db.exec("create table public.hermes_instances (" +
          "id text primary key, lifecycle_state text not null, lifecycle_substate text, " +
          "archive_uri text, archive_sha256 text, proxmox_vmid integer)");
        await db.exec(readFileSync(process.argv[1], "utf8"));
        await db.exec("insert into public.hermes_instances values " +
          "('pending', 'pending_deletion', null, 'archive', 'sha', null), " +
          "('archived', 'failed', null, 'archive', 'sha', null), " +
          "('live', 'failed', null, null, null, 101)");

        const move = (id, state) => db.query(
          "update public.hermes_instances set lifecycle_state = $1 where id = $2", [state, id]);
        const rejectsTransition = (error) => error.code === "23514";
        await assert.rejects(move("pending", "provisioning"), rejectsTransition);
        await assert.rejects(move("pending", "deleted"), rejectsTransition);
        await assert.rejects(move("archived", "active"), rejectsTransition);
        await move("archived", "restoring");
        await move("live", "active");

        await db.exec("update public.hermes_instances set lifecycle_state = 'deleting', " +
          "lifecycle_substate = 'owner_archive_delete' where id = 'pending'");
        await assert.rejects(move("pending", "failed"), rejectsTransition);
        await assert.rejects(move("pending", "deleted"), rejectsTransition);
        await db.exec("update public.hermes_instances set lifecycle_state = 'deleted', " +
          "lifecycle_substate = null, archive_uri = null where id = 'pending'");
      } finally {
        await db.close();
      }
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `, join(__dirname, "../../../supabase/migrations/20261123110000_protect_hermes_archive_lifecycle.sql")], {
    cwd: join(__dirname, "../../.."),
    timeout: 30_000,
  });
});

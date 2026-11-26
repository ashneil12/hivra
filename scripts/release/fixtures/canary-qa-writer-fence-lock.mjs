import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

const container = process.argv[2];
assert.match(container, /^canary-qa-fence-test-[0-9]+$/);
const args = ["exec", "-i", container, "psql", "-X", "-d", "postgres", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-qtA"];
const locker = spawn("docker", args, { stdio: ["pipe", "pipe", "inherit"] });
const output = createInterface({ input: locker.stdout });
let timer;
try {
  const held = Promise.race([
    once(output, "line").then(([line]) => line),
    once(output, "close").then(() => { throw new Error("Scope lock session closed early"); }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Scope lock was not acquired")), 10_000); }),
  ]);
  locker.stdin.write("begin; do $$begin perform 1 from canary_qa_writer_private.scope where singleton for update; end;$$; select 'held';\n");
  assert.equal(await held, "held");
  const other = spawnSync("docker", args, {
    input: `begin;
set local role service_role;
set local lock_timeout='500ms';
insert into public.hermes_instances(user_id,name) values
  ('user_ControlOne','Other owner'),('user_ControlTwo','Other owner'),
  ('user_ControlThree','Other owner'),('user_ControlFour','Other owner');
rollback;
`,
    encoding: "utf8", timeout: 10_000,
  });
  assert.equal(other.status, 0, other.stderr);
  const qa = spawnSync("docker", args, {
    input: `\\set VERBOSITY verbose
begin;
set local role service_role;
set local lock_timeout='250ms';
insert into public.hermes_instances(user_id,name) values('user_CanaryQaFixture','QA owner');
rollback;
`,
    encoding: "utf8", timeout: 10_000,
  });
  assert.notEqual(qa.status, 0);
  assert.match(qa.stderr, /55P03: canceling statement due to lock timeout/);
  const exited = once(locker, "exit");
  locker.stdin.end("rollback;\n\\q\n");
  assert.deepEqual(await exited, [0, null]);
  console.log("PASS a held QA scope lock does not block writes by four other owners");
} finally {
  clearTimeout(timer);
  output.close();
  if (locker.exitCode === null) locker.kill();
}

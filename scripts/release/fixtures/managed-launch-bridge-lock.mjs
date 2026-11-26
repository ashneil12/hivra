import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

const [container, epoch, next, mode] = process.argv.slice(2);
assert.ok(container.startsWith("managed-launch-bridge-test-"));
assert.ok((epoch === "legacy" && next === "funding") || (epoch === "funding" && next === "placement"));
const args = ["exec", "-i", container, "psql", "-X", "-d", "postgres", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-qtA"];
const writer = spawn("docker", args, { stdio: ["pipe", "pipe", "inherit"] });
const output = createInterface({ input: writer.stdout });
const rawWrite = "insert into public.hermes_instances(user_id,name,status,lifecycle_state) values('bridge-race','raw writer','provisioning','provisioning') returning name;";
let timer;
try {
  const acquired = Promise.race([
    once(output, "line").then(([line]) => line),
    once(output, "close").then(() => { throw new Error("Writer closed before taking the epoch lock"); }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Writer did not acquire the epoch lock")), 10_000); }),
  ]);
  writer.stdin.write(mode === "cutover"
    ? `begin; do $$begin perform managed_launch_bridge_private.begin_transition('${epoch}','${next}'); end;$$; select 'cutover held';\n`
    : `begin; set local role service_role; ${rawWrite}\n`);
  assert.equal(await acquired, mode === "cutover" ? "cutover held" : "raw writer");
  const operator = spawnSync("docker", args, {
    input: mode === "cutover" ? `\\set VERBOSITY verbose
begin;
set local lock_timeout = '500ms';
set local role service_role;
${rawWrite}
rollback;
` : `\\set VERBOSITY verbose
begin;
set local lock_timeout = '100ms';
select managed_launch_bridge_private.set_writer_drain('${epoch}',true);
rollback;
`,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.notEqual(operator.status, 0);
  assert.match(operator.stderr, mode === "cutover"
    ? /P0059: managed writer drain is closed/
    : /55P03: canceling statement due to lock timeout/);
  const exited = once(writer, "exit");
  writer.stdin.end(mode === "cutover"
    ? "lock table public.hermes_instances in access exclusive mode nowait;\nrollback;\n\\q\n"
    : "rollback;\n\\q\n");
  assert.deepEqual(await exited, [0, null]);
  console.log(mode === "cutover"
    ? `PASS ${epoch} late raw writer cannot enter or obstruct DDL after the close commits`
    : `PASS ${epoch} drain waits for an in-flight raw Classic writer`);
} finally {
  clearTimeout(timer);
  output.close();
  if (writer.exitCode === null) writer.kill();
}

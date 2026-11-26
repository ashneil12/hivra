import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

const [container, epoch, next] = process.argv.slice(2);
assert.ok(container.startsWith("managed-launch-bridge-test-"));
assert.ok((epoch === "legacy" && next === "funding") || (epoch === "funding" && next === "placement"));
const args = ["exec", "-i", container, "psql", "-X", "-d", "postgres", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-qtA"];
const writer = spawn("docker", args, { stdio: ["pipe", "pipe", "inherit"] });
const output = createInterface({ input: writer.stdout });
let timer;
try {
  const acquired = Promise.race([
    once(output, "line").then(([line]) => line),
    once(output, "close").then(() => { throw new Error("Writer closed before taking the epoch lock"); }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Writer did not acquire the epoch lock")), 10_000); }),
  ]);
  writer.stdin.write(`begin;
set local role service_role;
select public.insert_hivra_managed_agent_bridge_v1('${epoch}','{}',1,1,false)->>'status';
`);
  assert.equal(await acquired, "invalid_request");
  const operator = spawnSync("docker", args, {
    input: `\\set VERBOSITY verbose
begin;
set local lock_timeout = '100ms';
select managed_launch_bridge_private.begin_transition('${epoch}','${next}');
rollback;
`,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.notEqual(operator.status, 0);
  assert.match(operator.stderr, /55P03: canceling statement due to lock timeout/);
  const exited = once(writer, "exit");
  writer.stdin.end("rollback;\n\\q\n");
  assert.deepEqual(await exited, [0, null]);
  console.log(`PASS ${epoch} cutover waits for an in-flight bridge writer`);
} finally {
  clearTimeout(timer);
  output.close();
  if (writer.exitCode === null) writer.kill();
}

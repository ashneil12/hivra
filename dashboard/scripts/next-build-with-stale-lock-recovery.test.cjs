const assert = require("node:assert/strict");
const { test } = require("node:test");

const { nextBuildCommand } = require("./next-build-with-stale-lock-recovery.cjs");

test("forwards an explicitly selected Next build engine", () => {
  const command = nextBuildCommand("/fixture/next", ["--webpack"]);
  assert.deepEqual(command.slice(-3), ["/fixture/next", "build", "--webpack"]);
});

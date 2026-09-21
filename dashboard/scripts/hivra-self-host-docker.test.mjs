import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assertLoopbackContainer, loopbackDockerArgs, loopbackDockerEnvironment } from "./hivra-self-host-docker.mjs";

const scope = { projectId: "hivra-0123456789", network: "hivra-local-0123456789" };
function createArgs(...ports) {
  return ["create", "--name", `supabase_db_${scope.projectId}`, "--network", scope.network,
    "--label", `com.supabase.cli.project=${scope.projectId}`, ...ports,
    "-e", "POSTGRES_PASSWORD", "supabase/postgres:pinned", "sh", "-c", "do-not-rewrite -p 12:34"];
}
function container(hostIp = "127.0.0.1") {
  return {
    labels: { "com.supabase.cli.project": scope.projectId }, network: scope.network,
    bindings: { "5432/tcp": [{ HostIp: hostIp, HostPort: "55322" }] },
    ports: { "5432/tcp": [{ HostIp: hostIp, HostPort: "55322" }], "internal/tcp": null },
  };
}

test("binds every published service port explicitly before Docker creates it", () => {
  const actual = loopbackDockerArgs(createArgs("-p", "55322:5432", "--publish", "55321:8000/tcp"), scope);
  assert.ok(actual.includes("127.0.0.1:55322:5432"));
  assert.ok(actual.includes("127.0.0.1:55321:8000/tcp"));
  assert.ok(actual.includes("POSTGRES_PASSWORD"));
  assert.equal(actual.at(-1), "do-not-rewrite -p 12:34");
  assert.deepEqual(loopbackDockerArgs(actual, scope), actual);
  assert.deepEqual(loopbackDockerArgs(["container", ...createArgs("-p", "55322:5432")], scope), ["container", ...loopbackDockerArgs(createArgs("-p", "55322:5432"), scope)]);
});

test("refuses ambiguous, wildcard, public, IPv6, UDP, automatic and out-of-range publications", () => {
  for (const port of ["0.0.0.0:55322:5432", "192.0.2.1:55322:5432", "[::]:55322:5432", "55322:5432/udp", "5432", "0:5432", "65536:5432", "55322:0", "55322:65536"]) {
    assert.throws(() => loopbackDockerArgs(createArgs("-p", port), scope), /isolation/);
  }
  for (const flags of [["-P"], ["--publish-all"], ["--publish=55322:5432"], ["-p55322:5432"], ["--privileged"]]) {
    assert.throws(() => loopbackDockerArgs(createArgs(...flags), scope), /isolation/);
  }
});

test("fails closed on the wrong network, owner, duplicate identity or unexpected CLI shape", () => {
  for (const args of [
    createArgs().map(x => x === scope.network ? "host" : x),
    createArgs().map(x => x === `supabase_db_${scope.projectId}` ? "other-app" : x),
    createArgs().map(x => x === `com.supabase.cli.project=${scope.projectId}` ? "com.supabase.cli.project=other" : x),
    createArgs("--network", scope.network), createArgs("--name", `supabase_kong_${scope.projectId}`),
    ["create", "--network", scope.network, "image"],
  ]) assert.throws(() => loopbackDockerArgs(args, scope), /isolation/);
  assert.throws(() => loopbackDockerArgs(["ps"], { ...scope, network: "other" }), /isolation/);
});

test("leaves reads and opaque one-shot image commands intact", () => {
  for (const args of [
    ["inspect", "supabase_db_0123"], ["exec", "-i", "container", "psql"],
    ["run", "--rm", "--network", scope.network, "-e", "PGPASSWORD", "image", "-p", "1234"],
  ]) assert.deepEqual(loopbackDockerArgs(args, scope), args);
});

test("supports a restored installation with a preserved project ID and new path-derived network", () => {
  const restoredScope = { ...scope, network: "hivra-local-abcdef0123" };
  const args = createArgs("-p", "55322:5432").map(value => value === scope.network ? restoredScope.network : value);
  assert.ok(loopbackDockerArgs(args, restoredScope).includes("127.0.0.1:55322:5432"));
});

test("checks stored HostConfig and actual IPv4/IPv6 mappings, not just network defaults", () => {
  assert.doesNotThrow(() => assertLoopbackContainer(container(), scope));
  assert.doesNotThrow(() => assertLoopbackContainer({ ...container(), ports: {} }, scope));
  for (const address of ["", "0.0.0.0", "::", "[::]", "192.0.2.1", "localhost"]) {
    assert.throws(() => assertLoopbackContainer(container(address), scope), /isolation/);
    const actual = container();
    actual.ports["5432/tcp"].push({ HostIp: address, HostPort: "55322" });
    assert.throws(() => assertLoopbackContainer(actual, scope), /isolation/);
  }
  for (const override of [{ labels: {} }, { network: "bridge" }, { bindings: null }, { ports: [] }]) {
    assert.throws(() => assertLoopbackContainer({ ...container(), ...override }, scope), /isolation/);
  }
});

test("the scoped executable rewrites creation and blocks unsafe restart before forwarding", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hivra-docker-guard-"));
  try {
    const docker = path.join(directory, "fixture-docker");
    await writeFile(docker, '#!/usr/bin/env node\nconst args = process.argv.slice(2); if (args[0] === "container" && args[1] === "inspect") process.stdout.write(process.env.FIXTURE_INSPECT); else process.stdout.write(JSON.stringify(args));\n', { mode: 0o700 });
    const env = await loopbackDockerEnvironment({ directory: path.join(directory, "bin"), docker, ...scope });
    const created = spawnSync(path.join(directory, "bin", "docker"), createArgs("-p", "55322:5432"), { env, encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    assert.ok(JSON.parse(created.stdout).includes("127.0.0.1:55322:5432"));
    for (const command of ["start", "restart"]) {
      for (const address of ["127.0.0.1", "", "0.0.0.0", "::"]) {
        const result = spawnSync(path.join(directory, "bin", "docker"), [command, "0123456789abcdef"], {
          env: { ...env, FIXTURE_INSPECT: JSON.stringify(container(address)) }, encoding: "utf8",
        });
        assert.equal(result.status, address === "127.0.0.1" ? 0 : 1);
        if (address !== "127.0.0.1") assert.equal(result.stdout, "");
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

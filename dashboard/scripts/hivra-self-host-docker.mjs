import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// The pinned Supabase CLI shells out to Docker. Scope this adapter to that
// child process, not the user's daemon or global Docker configuration. Docker
// Desktop can ignore a bridge's default host_binding_ipv4 when publishing ports.
const VALUE_FLAGS = new Set([
  "--name", "--hostname", "-e", "--env", "-v", "--volume", "--volumes-from",
  "--tmpfs", "-p", "--publish", "--expose", "--health-cmd", "--health-interval",
  "--health-timeout", "--health-retries", "--health-start-period", "--restart",
  "--security-opt", "--add-host", "--network", "--network-alias", "--label",
  "--entrypoint", "--user", "-u", "--workdir", "-w",
]);
const BOOLEAN_FLAGS = new Set(["--rm", "--init", "--read-only", "-i", "--interactive", "-t", "--tty"]);

function fail() {
  throw new Error("Local database Docker isolation check failed. No command or credentials were logged.");
}

function validateScope({ projectId, network }) {
  // Restore preserves a database project ID when its state directory moves;
  // the installation's network name is independently derived from that path.
  if (!/^hivra-[a-f0-9]{10}$/.test(projectId) || !/^hivra-local-[a-f0-9]{10}$/.test(network)) fail();
}

export function loopbackDockerArgs(args, scope) {
  validateScope(scope);
  const offset = args[0] === "container" ? 1 : 0;
  const command = args[offset];
  if (command !== "create" && command !== "run") return [...args];
  const result = args.slice(0, offset + 1);
  let network, name, projectLabel;
  let index = offset + 1;
  for (; index < args.length && args[index].startsWith("-"); index += 1) {
    const flag = args[index];
    if (BOOLEAN_FLAGS.has(flag)) { result.push(flag); continue; }
    // Accept only the pinned CLI's unambiguous argv shape. In particular,
    // --publish-all, host networking and unknown/combined flags fail closed.
    if (!VALUE_FLAGS.has(flag) || index + 1 >= args.length) fail();
    let value = args[++index];
    if (flag === "--network") { if (network !== undefined) fail(); network = value; }
    if (flag === "--name") { if (name !== undefined) fail(); name = value; }
    if (flag === "--label" && value.startsWith("com.supabase.cli.project=")) {
      if (projectLabel !== undefined) fail();
      projectLabel = value.slice("com.supabase.cli.project=".length);
    }
    if (flag === "-p" || flag === "--publish") {
      const match = value.match(/^(?:127\.0\.0\.1:)?([0-9]{1,5}):([0-9]{1,5})(\/tcp)?$/);
      if (!match || [match[1], match[2]].some((port) => Number(port) < 1 || Number(port) > 65535)) fail();
      value = `127.0.0.1:${match[1]}:${match[2]}${match[3] || ""}`;
    }
    result.push(flag, value);
  }
  if (index === args.length || network !== scope.network) fail();
  if (name !== undefined && !new RegExp(`^supabase_[a-z0-9_-]+_${scope.projectId}$`).test(name)) fail();
  if (projectLabel !== undefined && projectLabel !== scope.projectId) fail();
  // Named service containers require the owner label; one-shot bootstrap
  // helpers may legitimately be unnamed and have no published ports.
  if (command === "create" && (!name || projectLabel !== scope.projectId)) fail();
  return [...result, ...args.slice(index)]; // Image command is opaque, never rewritten.
}

export function assertLoopbackContainer(container, scope) {
  validateScope(scope);
  if (container?.labels?.["com.supabase.cli.project"] !== scope.projectId ||
      container.network !== scope.network) fail();
  for (const ports of [container.bindings, container.ports]) {
    if (!ports || typeof ports !== "object" || Array.isArray(ports)) fail();
    for (const bindings of Object.values(ports)) {
      if (bindings === null) continue; // Exposed internally, not published.
      if (!Array.isArray(bindings)) fail();
      for (const binding of bindings) {
        if (binding?.HostIp !== "127.0.0.1" || !/^\d+$/.test(binding.HostPort) ||
            Number(binding.HostPort) < 1 || Number(binding.HostPort) > 65535) fail();
      }
    }
  }
}

export const DOCKER_BINDING_FORMAT = '{"labels":{{json .Config.Labels}},"network":{{json .HostConfig.NetworkMode}},"bindings":{{json .HostConfig.PortBindings}},"ports":{{json .NetworkSettings.Ports}}}';

export function inspectLoopbackContainer(docker, target, scope) {
  if (!/^(?:[a-f0-9]{12,64}|supabase_[a-z0-9_-]+)$/.test(target)) fail();
  const result = spawnSync(docker, ["container", "inspect", "--format", DOCKER_BINDING_FORMAT, target], {
    encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) fail();
  assertLoopbackContainer(JSON.parse(result.stdout), scope);
}

export function assertOwnedLoopbackContainers(docker, scope) {
  validateScope(scope);
  const result = spawnSync(docker, ["ps", "--all", "--quiet", "--filter", `label=com.supabase.cli.project=${scope.projectId}`], {
    encoding: "utf8", timeout: 30_000,
  });
  if (result.error || result.status !== 0) fail();
  const ids = result.stdout.trim().split(/\s+/).filter(Boolean);
  for (const id of ids) inspectLoopbackContainer(docker, id, scope);
  return ids.length;
}

export async function loopbackDockerEnvironment({ directory, docker, ...scope }) {
  validateScope(scope);
  if (process.platform === "win32") throw new Error("Use WSL 2 for the self-host review path.");
  if (!path.isAbsolute(docker)) fail();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const wrapper = path.join(directory, "docker");
  await writeFile(wrapper, `#!/usr/bin/env node\nimport(${JSON.stringify(import.meta.url)}).then(m => m.runLoopbackDocker(process.argv.slice(2))).catch(() => { process.stderr.write("Hivra local database Docker guard failed.\\n"); process.exitCode = 1; });\n`, { mode: 0o700 });
  await chmod(wrapper, 0o700);
  return {
    ...process.env,
    PATH: `${directory}${path.delimiter}${process.env.PATH || ""}`,
    HIVRA_LOCAL_DOCKER_BINARY: docker,
    HIVRA_LOCAL_DOCKER_PROJECT: scope.projectId,
    HIVRA_LOCAL_DOCKER_NETWORK: scope.network,
  };
}

export async function runLoopbackDocker(args) {
  const docker = process.env.HIVRA_LOCAL_DOCKER_BINARY;
  const scope = { projectId: process.env.HIVRA_LOCAL_DOCKER_PROJECT, network: process.env.HIVRA_LOCAL_DOCKER_NETWORK };
  if (!docker || !path.isAbsolute(docker)) fail();
  const nextArgs = loopbackDockerArgs(args, scope);
  const offset = args[0] === "container" ? 1 : 0;
  if (["start", "restart"].includes(args[offset])) {
    const targets = args.slice(offset + 1);
    if (!targets.length) fail();
    for (const target of targets) inspectLoopbackContainer(docker, target, scope);
  }
  const child = spawn(docker, nextArgs, { stdio: "inherit" });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
}

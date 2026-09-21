import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";

const INSPECT = '{"id":{{json .Id}},"image":{{json .Image}},"user":{{json .Config.User}},"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}},"running":{{json .State.Running}},"fileBackend":{{range .Config.Env}}{{if eq . "STORAGE_BACKEND=file"}}true{{end}}{{end}},"localTenant":{{range .Config.Env}}{{if eq . "TENANT_ID=stub"}}true{{end}}{{end}},"mountedFilePath":{{range .Config.Env}}{{if eq . "FILE_STORAGE_BACKEND_PATH=/mnt"}}true{{end}}{{end}}}';
function fail(message) { throw new Error(message); }
function runDocker(docker, args) {
  const result = spawnSync(docker, args, { encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) fail("The scoped local storage operation failed; no container output was logged.");
  return result.stdout;
}

export function validateStorageTarget(value, projectId) {
  if (!/^hivra-[a-f0-9]{10}$/.test(projectId) ||
      !/^[a-f0-9]{64}$/.test(value?.id || "") || !/^sha256:[a-f0-9]{64}$/.test(value?.image || "") ||
      value?.labels?.["com.supabase.cli.project"] !== projectId ||
      typeof value.running !== "boolean" || typeof value.user !== "string" ||
      value.fileBackend !== true || value.localTenant !== true || value.mountedFilePath !== true ||
      !Array.isArray(value.mounts) || value.mounts.length !== 1 ||
      value.mounts[0].Type !== "volume" || value.mounts[0].Destination !== "/mnt" ||
      value.mounts[0].Name !== `supabase_storage_${projectId}`) {
    fail("Local storage identity or backend is not supported; backup/restore stopped before volume access.");
  }
  return { id: value.id, image: value.image, user: value.user, volume: value.mounts[0].Name, running: value.running };
}

export async function withQuiescedStorage(docker, projectId, action) {
  const target = validateStorageTarget(JSON.parse(runDocker(docker, ["inspect", "--format", INSPECT, `supabase_storage_${projectId}`])), projectId);
  let primaryError;
  try {
    if (target.running) {
      runDocker(docker, ["stop", "--timeout", "30", target.id]);
    }
    if (runDocker(docker, ["inspect", "--format", "{{.State.Running}}", target.id]).trim() !== "false") {
      fail("Local storage did not stop; a consistent backup cannot be taken.");
    }
    return await action(target);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (target.running) {
      try {
        // A stop can take effect even if its client loses the acknowledgement.
        // Reconcile the immutable container ID, never its reusable name. Do not
        // snapshot an uncertain stop or start a previously stopped service.
        const running = runDocker(docker, ["inspect", "--format", "{{.State.Running}}", target.id]).trim();
        if (running === "false") runDocker(docker, ["start", target.id]);
        else if (running !== "true") fail("The prior storage running state could not be reconciled.");
        const deadline = Date.now() + 30_000;
        let healthy = false;
        while (Date.now() < deadline) {
          if (runDocker(docker, ["inspect", "--format", "{{.State.Health.Status}}", target.id]).trim() === "healthy") { healthy = true; break; }
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        if (!healthy) fail("Local storage did not become healthy after backup/restore; the snapshot operation is not complete.");
      } catch (recoveryError) {
        if (primaryError) {
          throw new AggregateError([primaryError, recoveryError], "Local storage operation failed and its prior running state could not be restored; inspect the local Docker runtime. No container output was logged.");
        }
        throw recoveryError;
      }
    }
  }
}

export async function transferStorageSnapshot({ docker, target, file, restore = false }) {
  if (runDocker(docker, ["inspect", "--format", "{{.State.Running}}", target.id]).trim() !== "false") {
    fail("Storage must remain stopped throughout snapshot transfer.");
  }
  const helper = `hivra-storage-transfer-${randomBytes(12).toString("hex")}`;
  const program = await readFile(new URL("./hivra-storage-snapshot.cjs", import.meta.url), "utf8");
  const args = ["run", "--rm", "--pull", "never", "--name", helper, "--network", "none", "--read-only",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--entrypoint", "node",
    ...(target.user ? ["--user", target.user] : []),
    "--mount", `type=volume,src=${target.volume},dst=/hivra-storage${restore ? "" : ",readonly"}`,
    ...(restore ? ["-i"] : []), target.image, "-e",
    `${program}\nmain(process.argv.slice(1)).catch(error => { process.stderr.write(safeFailure(error) + "\\n"); process.exitCode = 1; });`,
    restore ? "unpack" : "pack", "/hivra-storage"];
  const child = spawn(docker, args, { stdio: [restore ? "pipe" : "ignore", "pipe", "pipe"] });
  let safeFailureCode = "HIVRA_STORAGE_TRANSFER_FAILED";
  child.stderr.on("data", chunk => {
    const code = chunk.toString("utf8").match(/\bHIVRA_STORAGE_[A-Z0-9_]+\b/)?.[0];
    if (code) safeFailureCode = code.slice(0, 100);
  });
  if (restore) child.stdout.resume();
  const deadline = setTimeout(() => child.kill("SIGTERM"), 30 * 60 * 1000);
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error("Storage snapshot transfer failed.")));
  });
  try {
    await Promise.all([
      exited,
      restore ? pipeline(createReadStream(file), child.stdin) : pipeline(child.stdout, createWriteStream(file, { flags: "wx", mode: 0o600 })),
    ]);
  } catch {
    child.kill("SIGTERM");
    if (!restore) await rm(file, { force: true });
    fail(`Local storage snapshot transfer failed (${safeFailureCode}); file bytes and paths were not logged.`);
  } finally {
    clearTimeout(deadline);
    // A killed Docker client can leave its helper alive. This exact random
    // name is owned by this invocation; never prune other containers/volumes.
    const cleanup = spawnSync(docker, ["rm", "--force", helper], { encoding: "utf8", timeout: 60_000 });
    if (cleanup.status !== 0 && !/No such container/i.test(cleanup.stderr || "")) {
      fail("The storage helper cleanup could not be verified; inspect the local Docker runtime.");
    }
  }
}

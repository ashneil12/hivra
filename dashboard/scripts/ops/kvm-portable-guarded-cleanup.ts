import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { runPortableKvmGuardedCleanup, type PortableKvmCleanupAuthority, type PortableKvmCleanupRun } from "../../src/lib/hivra/portable-kvm/cleanup";

const runInput = z.object({
  authority: z.custom<PortableKvmCleanupAuthority>(value => typeof value === "object" && value !== null),
  run: z.custom<PortableKvmCleanupRun>(value => typeof value === "object" && value !== null),
}).strict();

async function main() {
  const [flag, manifest, driver, ...other] = process.argv.slice(2);
  if (flag !== "--apply-canary" || !manifest || !driver || !isAbsolute(manifest) || !isAbsolute(driver) || other.length) {
    process.stderr.write("Usage: kvm-portable-guarded-cleanup.ts --apply-canary ABSOLUTE_MANIFEST ABSOLUTE_OPERATOR_DRIVER\n");
    process.exitCode = 2;
    return;
  }

  const fd = openSync(manifest, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let request;
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 65_536) {
      throw new Error("Invalid operator manifest");
    }
    request = runInput.parse(JSON.parse(readFileSync(fd, "utf8")));
  } finally {
    closeSync(fd);
  }

  function call(action: "read" | "host" | "connectors" | "finish", input: object) {
    const result = spawnSync(driver, [action], {
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: 145_000,
      maxBuffer: 100_000,
      stdio: ["pipe", "pipe", "ignore"],
    });
    if (result.error || result.status !== 0) throw new Error("Portable cleanup driver failed");
    return JSON.parse(result.stdout);
  }

  const result = await runPortableKvmGuardedCleanup(request.authority, request.run, {
    readHeldAuthority: async authority => call("read", { authority }),
    runExactHost: async (placement, script) => z.object({ ok: z.boolean(), stdout: z.string() }).strict()
      .parse(call("host", { authority: request.authority, placement, script })),
    readActiveConnectorIds: async authority => z.array(z.string().uuid()).parse(call("connectors", { authority })),
    finish: async (authority, evidence) => call("finish", { authority, evidence }) === true,
  });
  process.stdout.write(JSON.stringify({ state: result.state }) + "\n");
}

main().catch(() => {
  process.stderr.write("Portable Canary cleanup did not confirm a terminal state. Reconcile the exact held journal and host proofs before retrying.\n");
  process.exitCode = 1;
});

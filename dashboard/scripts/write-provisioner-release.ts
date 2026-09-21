import { createHash } from "node:crypto";
import { access, lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES,
  PORTABLE_HIVRA_PROVISIONER_VERSION,
} from "@/lib/infrastructure/portable-provisioner-contract";

async function main() {
  if (!process.argv.includes("--apply")) {
    process.stdout.write(`${JSON.stringify({ version: PORTABLE_HIVRA_PROVISIONER_VERSION, mutatesRepository: false })}\n`);
    return;
  }
  const destination = path.join(process.cwd(), "provisioner-releases", `${PORTABLE_HIVRA_PROVISIONER_VERSION}.json`);
  try {
    await access(destination);
    throw new Error(`Release manifest already exists: ${destination}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Release manifest already exists:")) throw error;
  }
  const bundleRoot = await realpath(path.join(process.cwd(), "provisioner"));
  const assets = await Promise.all(PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES.map(async relativePath => {
    const candidate = path.join(bundleRoot, relativePath);
    const canonical = await realpath(candidate);
    const info = await lstat(candidate);
    if (!canonical.startsWith(`${bundleRoot}${path.sep}`) || !info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Unsafe provisioner release asset: ${relativePath}`);
    }
    return { relativePath, content: await readFile(candidate) };
  }));
  const manifest = {
    schema: 1,
    version: PORTABLE_HIVRA_PROVISIONER_VERSION,
    files: assets.map(asset => ({
      path: asset.relativePath,
      bytes: asset.content.length,
      sha256: createHash("sha256").update(asset.content).digest("hex"),
    })),
  };
  await writeFile(destination, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o644 });
  process.stdout.write(`${JSON.stringify({ version: manifest.version, files: manifest.files.length, destination })}\n`);
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : "Release manifest generation failed"}\n`);
  process.exitCode = 1;
});

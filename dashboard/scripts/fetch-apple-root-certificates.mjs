#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APPLE_ROOT_CERTIFICATES = Object.freeze([
  {
    name: "AppleComputerRootCertificate.cer",
    sourceUrl: "https://www.apple.com/certificateauthority/AppleComputerRootCertificate.cer",
    sha256: "0d83b611b648a1a75eb8558400795375cad92e264ed8e9d7a757c1f5ee2bb22d",
    bytes: 1470,
  },
  {
    name: "AppleIncRootCertificate.cer",
    sourceUrl: "https://www.apple.com/appleca/AppleIncRootCertificate.cer",
    sha256: "b0b1730ecbc7ff4505142c49f1295e6eda6bcaed7e2c68c5be91b5a11001f024",
    bytes: 1215,
  },
  {
    name: "AppleRootCA-G2.cer",
    sourceUrl: "https://www.apple.com/certificateauthority/AppleRootCA-G2.cer",
    sha256: "c2b9b042dd57830e7d117dac55ac8ae19407d38e41d88f3215bc3a890444a050",
    bytes: 1430,
  },
  {
    name: "AppleRootCA-G3.cer",
    sourceUrl: "https://www.apple.com/certificateauthority/AppleRootCA-G3.cer",
    sha256: "63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179",
    bytes: 583,
  },
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function matches(bytes, entry) {
  return bytes.length === entry.bytes && sha256(bytes) === entry.sha256;
}

export async function ensureAppleRootCertificates({
  dashboardRoot = process.cwd(),
  fetchImpl = globalThis.fetch,
  certificates = APPLE_ROOT_CERTIFICATES,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("Apple certificate acquisition requires a fetch implementation.");
  }
  const targetDir = path.join(dashboardRoot, ".generated", "apple-certs");
  mkdirSync(targetDir, { recursive: true });

  const pending = [];
  for (const entry of certificates) {
    const target = path.join(targetDir, entry.name);
    try {
      if (matches(readFileSync(target), entry)) continue;
    } catch {
      // Missing or unreadable cache entries are acquired again below.
    }
    pending.push({ entry, target });
  }

  const acquired = await Promise.all(pending.map(async ({ entry, target }) => {
    const response = await fetchImpl(entry.sourceUrl, { redirect: "follow" });
    if (!response?.ok) {
      throw new Error(`Apple certificate download failed (${response?.status ?? "unknown"}): ${entry.name}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!matches(bytes, entry)) {
      throw new Error(`Apple certificate integrity check failed: ${entry.name}`);
    }
    return { entry, target, bytes };
  }));

  for (const { entry, target, bytes } of acquired) {
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, bytes, { mode: 0o644 });
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
    process.stdout.write(`acquired ${entry.name} from Apple (${entry.bytes} bytes)\n`);
  }
  if (acquired.length === 0) {
    process.stdout.write("Apple root certificate cache verified\n");
  }
  return { targetDir, acquired: acquired.map(({ entry }) => entry.name) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureAppleRootCertificates().catch((error) => {
    console.error(error instanceof Error ? error.message : "Apple certificate acquisition failed.");
    process.exitCode = 1;
  });
}

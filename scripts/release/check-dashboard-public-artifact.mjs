#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FORBIDDEN_PAYLOADS = [
  Buffer.from('@fingerprintjs/fingerprintjs-pro'),
  Buffer.from('node_modules/@fingerprintjs/fingerprintjs-pro'),
  Buffer.from('Fingerprint v3.12.9 - Copyright (c) FingerprintJS, Inc, 2026 (https://fingerprint.com)'),
];

// Exact npm artifact @fingerprintjs/fingerprintjs-pro@3.12.9 dist/* SHA-256.
// Hash checks catch unmodified copied files; the banner/package signatures
// above catch bundler concatenation and source-map embedding.
const FORBIDDEN_SHA256 = new Set([
  'ce16d54ef51bd7bfcb35a5a59c2dd85b659b6f3469154183122408cf518be9bd',
  'b82f185a2b3902fff0ffd3ee47d7cc244cc817419f4a448ad27ca5d2d29f6ba7',
  'c205a23b354cf4e5a09043e79057f5b580a376771d02103aa5cd71b1780417ea',
  '9f23467ca8bb9ffb0bf3276b4ed5f75b8f3b6aae49a17f3a110aa5e7c46fc405',
  '2409edc3a66a6cba81a5d1e968c79c90b885cefdc6eed79c58415a4e49e44f49',
]);

async function existingDirectories(paths) {
  const directories = [];
  for (const candidate of paths) {
    const absolute = resolve(candidate);
    try {
      if ((await stat(absolute)).isDirectory()) directories.push(absolute);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return directories;
}

async function* filesUnder(directory, artifactRoot = directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory() && path === resolve(artifactRoot, 'cache')) continue;
    if (entry.isDirectory()) {
      yield* filesUnder(path, artifactRoot);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

export async function inspectDashboardArtifact(paths) {
  const roots = await existingDirectories(paths);
  if (roots.length === 0) {
    throw new Error(`No dashboard build artifact found in: ${paths.join(', ')}`);
  }

  let filesChecked = 0;
  for (const root of roots) {
    for await (const path of filesUnder(root)) {
      filesChecked += 1;
      const content = await readFile(path);
      const digest = createHash('sha256').update(content).digest('hex');
      if (
        FORBIDDEN_SHA256.has(digest) ||
        FORBIDDEN_PAYLOADS.some((needle) => content.includes(needle))
      ) {
        throw new Error(`Proprietary Fingerprint Pro package payload found in build artifact: ${path}`);
      }
    }
  }

  return { rootsChecked: roots.length, filesChecked };
}

async function main() {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    throw new Error('Pass at least one dashboard build directory.');
  }
  const result = await inspectDashboardArtifact(paths);
  console.log(JSON.stringify({ status: 'pass', ...result }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

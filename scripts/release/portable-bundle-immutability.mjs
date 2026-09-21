import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function bundleContract(source) {
  const version = source.match(/export const PORTABLE_HIVRA_PROVISIONER_VERSION = "([0-9.]+)";/)?.[1];
  const block = source.match(/export const PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES = \[([\s\S]*?)\] as const;/)?.[1];
  if (!version || !/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(version) || !block) throw new Error('Unrecognized portable bundle contract');
  const files = block.trim().split('\n').map(line => {
    const name = line.trim().match(/^"([a-zA-Z0-9._/-]+)",$/)?.[1];
    if (!name || name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe portable bundle path');
    return name;
  });
  if (new Set(files).size !== files.length || !files.includes('VERSION')) throw new Error('Invalid portable bundle allowlist');
  return { version, files };
}

export function captureBundle(contract, readAsset) {
  return { schema: 1, version: contract.version, files: contract.files.map(name => {
    const bytes = readAsset(name);
    return { path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }) };
}

export function verifyBundle({ contractSource, manifest, readAsset }) {
  const contract = bundleContract(contractSource);
  if (readAsset('VERSION').toString().trim() !== contract.version) throw new Error('Portable bundle version differs');
  const actual = captureBundle(contract, readAsset);
  if (JSON.stringify(manifest) !== JSON.stringify(actual)) {
    throw new Error('Published portable bundle bytes changed: restore the release or publish a new version and manifest');
  }
  return { version: contract.version, files: actual.files.length };
}

export function workingBundle(root = fileURLToPath(new URL('../../', import.meta.url))) {
  const contractSource = fs.readFileSync(path.join(root, 'dashboard/src/lib/infrastructure/portable-provisioner-contract.ts'), 'utf8');
  const contract = bundleContract(contractSource);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dashboard/provisioner-releases', `${contract.version}.json`), 'utf8'));
  const readAsset = name => {
    const source = path.join(root, 'dashboard/provisioner', name);
    if (!fs.lstatSync(source).isFile()) throw new Error('Portable bundle asset is not a regular file');
    return fs.readFileSync(source);
  };
  return { contractSource, manifest, readAsset };
}

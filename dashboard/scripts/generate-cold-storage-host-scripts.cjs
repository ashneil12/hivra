#!/usr/bin/env node
/**
 * generate-cold-storage-host-scripts.cjs
 *
 * Emits src/lib/services/cold-storage-host-scripts.generated.ts — ONLY the
 * base64 payloads of the two ops shell scripts, so what the service installs on
 * each PVE host is always byte-identical to the file in the repo.
 *
 * Run after editing scripts/ops/archive-vm-cold.sh or restore-vm-cold.sh:
 *   node scripts/generate-cold-storage-host-scripts.cjs
 *
 * cold-storage-host-scripts.test.ts fails the build if you forget.
 *
 * Deliberately generates DATA ONLY. The install-shell logic lives hand-written
 * in cold-storage-host-scripts.ts: emitting code that itself contains backticks
 * and ${...} through a JS template literal is fragile enough that it broke this
 * generator twice while it was being written.
 */
const fs = require("node:fs");
const path = require("node:path");

const DASH = path.join(__dirname, "..");
const OUT = path.join(
  DASH,
  "src/lib/services/cold-storage-host-scripts.generated.ts"
);

function b64(rel) {
  return fs.readFileSync(path.join(DASH, rel)).toString("base64");
}

// Long base64 on one line is unreadable in diffs and review; chunk it.
function chunk(s, n = 100) {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out.map((l) => '  "' + l + '"').join(" +\n");
}

const lines = [
  "// ─────────────────────────────────────────────────────────────────────────────",
  "// GENERATED FILE — DO NOT EDIT BY HAND.",
  "// Regenerate with: node scripts/generate-cold-storage-host-scripts.cjs",
  "// Source of truth: scripts/ops/archive-vm-cold.sh, scripts/ops/restore-vm-cold.sh",
  "// Parity is enforced by src/lib/services/__tests__/cold-storage-host-scripts.test.ts",
  "// ─────────────────────────────────────────────────────────────────────────────",
  "",
  "export const ARCHIVE_VM_COLD_SH_B64 =",
  chunk(b64("scripts/ops/archive-vm-cold.sh")) + ";",
  "",
  "export const RESTORE_VM_COLD_SH_B64 =",
  chunk(b64("scripts/ops/restore-vm-cold.sh")) + ";",
  "",
];

fs.writeFileSync(OUT, lines.join("\n"));
console.log("wrote " + path.relative(DASH, OUT));

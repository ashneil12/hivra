/** @jest-environment node */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FIRST_BOOT_ARMED_WINDOW_MS, FIRST_BOOT_LEGACY_RECIPE_VERSION, FIRST_BOOT_RECIPE_VERSION,
} from "@/lib/infrastructure/first-boot-enrollment";

const FILE = "20260924190000_hetzner_first_boot_arm_at_start.sql";
const migration = readFileSync(path.resolve(__dirname, "../../supabase/migrations", FILE), "utf8");

it("opens a Hetzner setup window only with the recorded setup power-on, and keeps legacy servers on their rules", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../../scripts/test-hetzner-first-boot-arm-at-start.cjs")],
    { encoding: "utf8", timeout: 110_000 },
  );
  expect(output).toContain("PASS hetzner first-boot arm at start SQL");
}, 120_000);

it("agrees with the application on recipes and the armed window", () => {
  // Both recipes are named, in both directions of the recipe check.
  expect(migration).toContain(`check (recipe_version in ('${FIRST_BOOT_LEGACY_RECIPE_VERSION}', '${FIRST_BOOT_RECIPE_VERSION}'))`);
  expect(migration).toContain(`when '${FIRST_BOOT_RECIPE_VERSION}' then p_armed_at is not null`);
  // 15 minutes of setup plus 2 minutes for Hetzner to boot, in SQL and TypeScript.
  expect(FIRST_BOOT_ARMED_WINDOW_MS).toBe(17 * 60_000);
  expect(migration).toContain("armed_expires_at=v_now+interval '17 minutes'");
  expect(migration).toContain("armed_expires_at = armed_at + interval '17 minutes'");
  expect(migration).not.toMatch(/security definer/i);
});

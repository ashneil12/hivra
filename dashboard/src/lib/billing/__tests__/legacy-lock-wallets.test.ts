/** @jest-environment node */
/**
 * Legacy $HermesOS lock wallets ('hermesos_lock') are closed to new deposits:
 * no app route provisions one. Existing holders can only withdraw or move to
 * their own verified wallet. (Operator scripts under dashboard/scripts can
 * still provision one by hand; that is not an app path.)
 */
import fs from "node:fs";
import path from "node:path";

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

it("no app route or component provisions a hermesos_lock wallet", () => {
  const root = path.resolve(__dirname, "../../..");
  const offenders = [...sourceFiles(path.join(root, "app")), ...sourceFiles(path.join(root, "components"))].filter((file) => {
    const text = fs.readFileSync(file, "utf8");
    return /ensureBankrDepositWalletForUser\(\{[^)]*purpose:\s*["']hermesos_lock["']/.test(text);
  });
  expect(offenders).toEqual([]);
});

import { readFileSync } from "node:fs";
import path from "node:path";

const migration = readFileSync(path.join(
  process.cwd(),
  "supabase/migrations/20260908100000_windows_desktop_prepare_receipt.sql",
), "utf8");

it("accepts a Windows boot hash without weakening Linux preparation receipts", () => {
  expect(migration).toContain("create or replace function public.complete_hivra_desktop_prepare");
  expect(migration).toContain("a.computer_profile='windows'");
  expect(migration).toContain("p_receipt->>'bootId' ~ '^[a-f0-9]{64}$'");
  expect(migration).toContain("p_receipt->>'bootId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}");
  expect(migration).toContain("p_receipt-array['version','operationId','computerId','vmid','guestIp','bindingTag','bootId','exitCode']");
});

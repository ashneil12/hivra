import fs from "fs";
import path from "path";

/**
 * Regression-asserts that instance creation does NOT eagerly call
 * provisionBankrWalletForInstance. Bankr instance wallets are
 * lazily provisioned via POST /api/instances/[id]/bankr-wallet
 * (the dashboard "Create Bankr wallet" button), which already
 * handles the full provision → sync-config → seed-skills lifecycle.
 *
 * Eager provisioning previously burned the Bankr partner's 20-key
 * cap + 1000-wallet cap on agents that may never opt in to the
 * wallet feature. If a future change reintroduces an eager call
 * from instance-service, this test catches it before it ships.
 */

describe("instance-service Bankr wallet provisioning is lazy", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../instance-service.ts"),
    "utf8"
  );

  it("does not invoke provisionBankrWalletForInstance", () => {
    expect(source).not.toMatch(/provisionBankrWalletForInstance\s*\(/);
  });

  it("does not import provisionBankrWalletForInstance", () => {
    expect(source).not.toMatch(
      /import[^;]*\bprovisionBankrWalletForInstance\b/
    );
  });
});

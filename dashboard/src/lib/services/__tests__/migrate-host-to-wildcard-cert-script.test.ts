import { readFileSync } from "node:fs";
import { join } from "node:path";

const script = readFileSync(
  join(__dirname, "../../../../scripts/migrate-host-to-wildcard-cert.sh"),
  "utf8"
);

describe("migrate-host-to-wildcard-cert.sh", () => {
  it("removes stale exact CertMagic paths instead of adding a second tls directive", () => {
    expect(script).toContain("/var/lib/caddy/.local/share/caddy/certificates");
    expect(script).toContain("STALE_CERT_DIRECTIVE");
  });

  it("only disables a legacy agents route when its current-domain sibling exists", () => {
    expect(script).toContain("LEGACY_WITHOUT_CURRENT_SIBLING");
    expect(script).toContain("disabled.origin-ca.$TS");
  });

  it("rolls config files back if validation or restart fails", () => {
    expect(script).toContain("rollback_configs");
    expect(script).toContain("ROLLBACK_COMPLETE");
  });

  it("uses a restart to clear a wedged in-memory certificate cache", () => {
    expect(script).toContain("systemctl restart caddy");
    expect(script).not.toContain("systemctl reload caddy ||");
  });
});

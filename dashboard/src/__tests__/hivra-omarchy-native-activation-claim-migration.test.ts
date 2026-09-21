import { readFileSync } from "node:fs";
import path from "node:path";

const migration = readFileSync(path.resolve(
  __dirname,
  "../../supabase/migrations/20260908070000_omarchy_native_activation_claim.sql",
), "utf8").replace(/\s+/g, " ").toLowerCase();

describe("Hivra Omarchy native activation claim migration", () => {
  it("permits only one certificate-bound exchanged controller claim", () => {
    expect(migration).toContain("native_activation_id uuid");
    expect(migration).toContain("native_profile_bound=true and transport='sunshine-moonlight'");
    expect(migration).toContain("input_role='controller' and exchanged_at is not null");
    expect(migration).toContain("create unique index hivra_remote_desktop_native_activation_id_unique");
    expect(migration).toContain("native_activation_id is null");
  });

  it("rechecks current route, takeover, owner, and remaining lease authority", () => {
    expect(migration).toContain("private_network_reachable=true and supports_input_takeover=true");
    expect(migration).toContain("s.expires_at<=clock_timestamp()+interval '65 seconds'");
    expect(migration).toContain("type='linux-desktop' and computer_profile='omarchy'");
    expect(migration).toContain("operation_id is null and operation_kind is null");
    expect(migration).toContain("session_token_hash=p_session_token_hash");
  });

  it("returns the public identity but remains service-role-only", () => {
    expect(migration).toContain("'clientcertificatepem',s.native_client_certificate_pem");
    expect(migration).toContain("revoke all on function public.claim_hivra_omarchy_native_activation");
    expect(migration).toContain("from public,anon,authenticated");
    expect(migration).toContain("to service_role");
  });
});

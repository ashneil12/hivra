import { readFileSync } from "node:fs";
import path from "node:path";

const sql = (name: string) => readFileSync(path.join(process.cwd(), "supabase/migrations", name), "utf8");

describe("Hermes computer software migration", () => {
  const text = sql("20261111230000_hermes_computer_software.sql");
  const earlier = sql("20261020121500_hivra_agent_app_updates.sql");

  it("keeps every software the earlier checks allowed and adds hermes and the `latest` target", () => {
    for (const name of ["claude-code", "codex", "aeon", "openclaw", "agent-zero"]) {
      expect(earlier).toContain(`'${name}'`);
      expect(text).toContain(`'${name}'`);
    }
    expect(text).toContain("'hermes'");
    expect(text.match(/\|latest\)/g)).toHaveLength(3);
    // Each constraint is dropped under its own name first, so the migration re-runs cleanly.
    for (const name of ["cli_name", "tested_version", "update_target", "requested_target"]) {
      expect(text).toContain(`drop constraint if exists hivra_agent_cli_updates_${name}_check`);
      expect(text).toContain(`add constraint hivra_agent_cli_updates_${name}_check`);
    }
  });

  it("patches the provider runtime update allow-list in place, once, and refuses an unknown anchor", () => {
    expect(text).toContain("'public.claim_hivra_provider_runtime_update(text,uuid,uuid)'");
    expect(text).toContain("Provider runtime update anchor mismatch");
    expect(text).toContain("if position(addition in definition) > 0 then return; end if;");
    expect(sql("20261020120000_provider_runtime_update.sql")).toContain("a.type not in ('claude-code','codex','aeon','openclaw','agent-zero')");
  });
});

describe("provider release 2026.11.11.4 admission", () => {
  const text = sql("20261111233000_provider_release_admission_2026_11_11_4.sql");
  const release = JSON.parse(readFileSync(path.join(process.cwd(), "provisioner-releases/2026.11.11.4.json"), "utf8")) as { version: string };

  it("extends exactly the 2026.11.11.3 entry and admits only the 2026.11.11.4 digest after it", () => {
    expect(release.version).toBe("2026.11.11.4");
    expect(text).toContain("b0a1ff631ab30fdda0c4ec5016a8c7d22888064134a82ae88594679c107b78e8");
    expect(text).toContain("provisionerVersion''=''2026.11.11.4''");
    expect(text).toContain("Provider release admission anchor mismatch");
    for (const fn of ["admit_prepared_provider_computer", "hivra_provider_native_identity_valid", "hivra_provider_desktop_identity_valid"]) {
      expect(text).toContain(`public.${fn}(`);
    }
  });
});

describe("provider release 2026.11.11.5 admission", () => {
  const text = sql("20261112100000_provider_release_admission_2026_11_11_5.sql");
  const release = JSON.parse(readFileSync(path.join(process.cwd(), "provisioner-releases/2026.11.11.5.json"), "utf8")) as { version: string };

  it("extends exactly the 2026.11.11.4 entry and admits only the 2026.11.11.5 digest after it", () => {
    expect(release.version).toBe("2026.11.11.5");
    expect(text).toContain("f5e0c408e47f9c1950da3e228bf4234be877ab613de966bfea7540da35daee45");
    expect(text).toContain("e4c439b7e1590de448c204232543a1a9e2b0ca695efd652d79f934e38e97c5cf");
    expect(text).toContain("provisionerVersion''=''2026.11.11.5''");
    expect(text).toContain("Provider release admission anchor mismatch");
    for (const fn of ["admit_prepared_provider_computer", "hivra_provider_native_identity_valid", "hivra_provider_desktop_identity_valid"]) {
      expect(text).toContain(`public.${fn}(`);
    }
  });
});

describe("provider release 2026.11.11.6 admission", () => {
  const text = sql("20261112120000_provider_release_admission_2026_11_11_6.sql");
  const release = JSON.parse(readFileSync(path.join(process.cwd(), "provisioner-releases/2026.11.11.6.json"), "utf8")) as { version: string };

  it("extends exactly the 2026.11.11.5 entry and admits only the 2026.11.11.6 digest after it", () => {
    expect(release.version).toBe("2026.11.11.6");
    expect(text).toContain("e4c439b7e1590de448c204232543a1a9e2b0ca695efd652d79f934e38e97c5cf");
    expect(text).toContain("f2148144fee2ab681d36c584d882198c8bded295c3f6375780919e113ad0ef86");
    expect(text).toContain("provisionerVersion''=''2026.11.11.6''");
    expect(text).toContain("Provider release admission anchor mismatch");
    for (const fn of ["admit_prepared_provider_computer", "hivra_provider_native_identity_valid", "hivra_provider_desktop_identity_valid"]) {
      expect(text).toContain(`public.${fn}(`);
    }
  });
});

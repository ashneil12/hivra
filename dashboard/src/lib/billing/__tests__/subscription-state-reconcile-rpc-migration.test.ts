import { readFileSync } from "fs";
import { join } from "path";

describe("subscription state reconcile RPC migration", () => {
  it("preserves base token-holder entitlement from the latest Hivra snapshot", () => {
    const sql = readFileSync(
      join(
        process.cwd(),
        "supabase/migrations/20260603010000_subscription_state_reconcile_rpc.sql"
      ),
      "utf8"
    );

    expect(sql).toContain("token_holding_snapshots");
    expect(sql).toContain("token_entitlement_configs");
    expect(sql).toContain("config.tier_key = 'token_base'");
    expect(sql).toContain("config.chain_id = snapshot.chain_id");
    expect(sql).toContain("lower(config.token_address) = lower(snapshot.token_address)");
    expect(sql).toContain("snapshot.token_symbol = config.token_symbol");
    expect(sql).toContain("order by snapshot.checked_at desc");
    expect(sql).toContain("v_target_tier := 'token_base'");
  });
});

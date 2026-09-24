import fs from "fs";
import path from "path";

import { HIVRA_WALLET_AGENT_COLUMNS, loadOwnedHivraWalletAgent } from "../hivra-lane";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));

/**
 * Regression: the wallet routes loaded agents with a hand-picked column list
 * that predated binding tokens, provisioner channels and substrates, so the
 * execution-context resolver refused every Hivra agent ("invalid
 * infrastructure binding") and no wallet key could reach a box. Found live on
 * Canary on 2026-09-24 with a freshly launched agent.
 */
describe("Hivra wallet agent loader", () => {
  it("selects every field the execution-context resolver reads", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../hivra/agent-execution-context.ts"),
      "utf8"
    );
    const bindingType = source.match(/export type HivraAgentInfrastructureBinding = \{([\s\S]*?)\};/);
    expect(bindingType).not.toBeNull();
    const resolverFields = [...bindingType![1].matchAll(/^\s*(\w+)\?:/gm)].map((m) => m[1]);
    expect(resolverFields.length).toBeGreaterThan(5);
    for (const field of resolverFields) {
      expect(HIVRA_WALLET_AGENT_COLUMNS).toContain(field);
    }
  });

  it("queries hivra_agents with that column list, scoped to the owner", async () => {
    const eq = jest.fn().mockReturnThis();
    const select = jest.fn().mockReturnValue({ eq, maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }) });
    eq.mockReturnValue({ eq, maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }) });
    (supabaseAdmin!.from as jest.Mock).mockReturnValue({ select });

    await loadOwnedHivraWalletAgent("agent_1", "user_123");

    expect(supabaseAdmin!.from).toHaveBeenCalledWith("hivra_agents");
    expect(select).toHaveBeenCalledWith(HIVRA_WALLET_AGENT_COLUMNS.join(","));
    expect(eq).toHaveBeenCalledWith("id", "agent_1");
    expect(eq).toHaveBeenCalledWith("user_id", "user_123");
  });
});

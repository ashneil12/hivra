// Real stable running loader and capability RPC over the actual migrated
// schema. No provider/SSH/browser requests or credentials.
const assert = require("node:assert/strict");
module.exports = async function capabilitySql({ db, fixture, stopped, complete, receipt, agent, op }) {
  await fixture(); assert.equal(await stopped(receipt("succeeded")), true); assert.equal(await complete(), true);
  const supabasePath = require.resolve("../src/lib/supabase.ts"), previous = require.cache[supabasePath];
  const ident = text => { assert.match(text, /^[a-z_][a-z_0-9]*$/); return text; };
  const from = table => {
    // The attempt's recipe version is read from its enrollment (a non-secret column).
    assert.ok(["hivra_agents", "infrastructure_capacity_orders", "infrastructure_first_boot_enrollments"].includes(table));
    let columns, params = [], conditions = [];
    return { select(value) { columns = value.split(",").map(ident).join(","); return this; },
      eq(key, value) { params.push(value); conditions.push(`${ident(key)}=$${params.length}`); return this; },
      is(key, value) { assert.equal(value, null); conditions.push(`${ident(key)} is null`); return this; },
      async maybeSingle() { const { rows } = await db.query(`select ${columns} from public.${table} where ${conditions.join(" and ")}`, params);
        assert.ok(rows.length <= 1); return { data: rows[0] ? JSON.parse(JSON.stringify(rows[0])) : null, error: null }; },
    };
  };
  const rpc = async (name, args) => {
    assert.equal(name, "record_hivra_provider_desktop_capability");
    const entries = Object.entries(args);
    const { rows } = await db.query(`select public.${name}(${entries.map(([key], index) => `${ident(key)}=>$${index + 1}`).join(",")}) as result`, entries.map(([, value]) => value));
    return { data: rows[0].result, error: null };
  };
  require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: { supabaseAdmin: { from, rpc } } };
  try {
    const { loadProviderDesktopCapabilityContext, recordProviderDesktopCapability } = require("../src/lib/hivra/provider-desktop-capability.ts");
    const { REMOTE_DESKTOP_BUNDLE_REVISION } = require("../src/lib/remote-computers/capability-inspection.ts");
    const input = { userId: "owner", agentId: agent };
    await db.exec("set role service_role");
    const context = await loadProviderDesktopCapabilityContext(input);
    const observed = { protocol: "hivra-remote-desktop-capability-v1", computerKind: "hivra-agent", computerId: agent,
      capabilityGeneration: op, observedRevision: REMOTE_DESKTOP_BUNDLE_REVISION, compositor: "x11", installedTransports: ["selkies-websocket"],
      privateNetworkReachable: false, supportsInputTakeover: true, brokerOrigin: "https://desktop.example.test", observedAt: new Date().toISOString() };
    const expires = new Date(Date.now() + 540000).toISOString();
    assert.equal(await recordProviderDesktopCapability(context, observed, expires), true);
    const { rows } = await db.query("select generation,broker_origin from public.hivra_remote_desktop_capabilities where computer_id=$1", [agent]);
    assert.deepEqual(rows, [{ generation: op, broker_origin: observed.brokerOrigin }]);
    // Changes occurring after the final TS observation are still rejected by
    // the locked SQL wrapper; no fresh capability survives a stale owner path.
    assert.equal(await recordProviderDesktopCapability({ ...context, ip: "203.0.113.11" }, observed, expires), false);
    assert.equal(await recordProviderDesktopCapability({ ...context, targetId: agent }, observed, expires), false);
    await assert.rejects(() => loadProviderDesktopCapabilityContext({ ...input, userId: "other" }));
    await db.query("select public.request_hivra_agent_delete('owner',$1,gen_random_uuid())", [agent]);
    assert.equal(await recordProviderDesktopCapability(context, observed, expires), false);
    await assert.rejects(() => loadProviderDesktopCapabilityContext(input));
    await db.exec("reset role");
    const signature = "public.record_hivra_provider_desktop_capability(text,uuid,jsonb,jsonb,text,uuid,jsonb,timestamptz)";
    for (const role of ["anon", "authenticated"]) {
      const check = await db.query("select has_function_privilege($1,$2,'EXECUTE') as allowed", [role, signature]);
      assert.equal(check.rows[0].allowed, false);
    }
    console.log("PASS provider desktop capability: real stable loader, shared ledger, stale binding/lifecycle rejection and service-only ACL");
  } finally { await db.exec("reset role"); if (previous) require.cache[supabasePath] = previous; else delete require.cache[supabasePath]; }
};

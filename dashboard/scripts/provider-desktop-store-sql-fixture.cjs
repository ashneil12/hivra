// Compose the real private TypeScript store/adapter with the actual PostgreSQL
// lifecycle migrations. Only provider/SSH are simulated; no external requests,
// credentials, guest commands or current user accounts are used.
const assert = require("node:assert/strict");
module.exports = async function desktopStoreSqlFixture({ db, desktopFixture, desktopIdentity, desktopReceipt,
  desktopGrant, desktopJournal, recordStopped, readAgent, release }) {
  const supabasePath = require.resolve("../src/lib/supabase.ts"), previous = require.cache[supabasePath];
  let fault = "clean", ssh = 0;
  const events = [], wire = value => JSON.parse(JSON.stringify(value));
  const identifier = value => { assert.match(value, /^[a-z_][a-z_0-9]*$/); return value; };
  const rpc = async (name, args) => {
    assert.ok(["begin_hivra_provider_desktop_install", "record_hivra_provider_install_stopped",
      "begin_hivra_provider_desktop_cleanup", "record_hivra_provider_desktop_cleanup",
      "request_hivra_agent_delete", "release_hivra_agent_operation", "record_hivra_agent_operation_failure", "retire_hivra_provider_target"].includes(name));
    events.push(name);
    const entries = Object.entries(args), placeholders = entries.map(([key], index) => `${identifier(key)}=>$${index + 1}`);
    try {
      if (name === "release_hivra_agent_operation" && fault === "superseded_release") await desktopGrant();
      const result = await db.query(`select public.${identifier(name)}(${placeholders.join(",")}) as result`, entries.map(([, value]) => value));
      if (name === "record_hivra_provider_desktop_cleanup" && fault === "lost_response") throw new Error("fixture response loss after commit");
      if (name === "release_hivra_agent_operation" && fault === "release_lost_response") throw new Error("fixture release response loss after commit");
      return { data: wire(result.rows[0].result), error: null };
    } catch (error) { return { data: null, error }; }
  };
  const from = table => {
    assert.ok(["hivra_agents", "infrastructure_capacity_orders", "hivra_provider_desktop_cleanup", "infrastructure_first_boot_operations"].includes(table));
    let columns, filters = [];
    return {
      select(selected) { columns = selected.split(",").map(identifier).join(","); return this; },
      eq(key, value) { filters.push([identifier(key), value]); return this; },
      async maybeSingle() {
        try {
          const result = await db.query(`select ${columns} from public.${table} where ${filters.map(([key], i) => `${key}=$${i + 1}`).join(" and ")}`,
            filters.map(([, value]) => value));
          assert.ok(result.rows.length <= 1);
          return { data: result.rows.length ? wire(result.rows[0]) : null, error: null };
        } catch (error) { return { data: null, error }; }
      },
    };
  };
  require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: { supabaseAdmin: { from, rpc } } };
  try {
    const { advanceProviderDesktopInstaller } = require("../src/lib/hivra/provider-desktop-installer.ts");
    const { loadProviderDesktopInstallOperation } = require("../src/lib/hivra/provider-desktop-install-store.ts");
    const op = { userId: "owner", agentId: desktopIdentity.agentId, operationId: desktopIdentity.operationId };
    const clock = { bootId: desktopReceipt().desktopCleanup.bootId, boottimeMs: 1000 };
    // Root-cause regression: a hostname/tunnel/direct address changed after
    // the last adapter read must be rejected atomically by actual SQL admission.
    for (const drift of ["hostname", "tunnel", "direct"]) {
      fault = "access_drift";
      await desktopFixture(false);
      if (drift === "direct") await db.exec("update public.hivra_agents set cf_hostname=null,cf_tunnel_id=null,ip='203.0.113.10',chat_url='https://203-0-113-10.sslip.io'");
      await db.exec("set role service_role");
      try {
        const context = await loadProviderDesktopInstallOperation(op);
        const assets = require("../src/lib/infrastructure/portable-provisioner-contract.ts").PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES.map(relativePath => ({ relativePath,
          content: require("node:fs").readFileSync(require("node:path").join(__dirname, "../provisioner", relativePath)) }));
        const request = { ...op, action: "start", launch: { version: 3, agentKind: "linux-desktop", computerSubstrate: "provider-vm",
          wantBrowser: null, computerId: op.agentId, controlOrigin: "https://canary.hermesos.cloud", modelKey: "", model: "", modelBaseUrl: "", publicOrigin: `https://${context.hostname}`,
          tunnelToken: drift === "direct" ? null : Buffer.from(JSON.stringify({ t: context.tunnelId })).toString("base64"),
          accessHostname: drift === "direct" ? context.hostname : null } };
        await assert.rejects(() => advanceProviderDesktopInstaller(request, {
          bundle: async () => assets, controlOrigin: () => "https://canary.hermesos.cloud", boot: async () => ({ ...context.scope }),
          verify: async () => ({ stage: "provider_verified", scope: context.scope, address: "203.0.113.10",
            hostPublicKey: "public-fixture-only", hostFingerprintSha256: "fixture-pin", capacityIdempotencyKey: "fixture-only" }),
          bootstrap: async () => {
            if (drift === "hostname") await db.exec("update public.hivra_agents set cf_hostname='changed.example.test'");
            if (drift === "tunnel") await db.query("update public.hivra_agents set cf_tunnel_id=$1", [op.agentId]);
            if (drift === "direct") await db.exec("update public.hivra_agents set ip='203.0.113.11',chat_url='https://203-0-113-11.sslip.io'");
            return { publicKeyOpenSsh: "public-fixture-only", privateKeyOpenSsh: "private-fixture-only" };
          },
          control: async () => { throw new Error("Stale desktop access must never reach SSH"); },
        }), error => error.code === "rejected");
        const row = await readAgent();
        assert.equal(row.provider_install_identity, null); assert.equal(row.provider_install_desktop_access, null);
      } finally { await db.exec("reset role"); }
    }
    for (fault of ["clean", "pending", "superseded", "lost_response", "stale_boot", "outcome_conflict"]) {
      await desktopFixture();
      assert.equal(await recordStopped(desktopReceipt("failed", "pending")), true);
      events.length = 0; ssh = 0;
      await db.exec("set role service_role");
      try {
        const context = await loadProviderDesktopInstallOperation(op);
        assert.equal(context.cancellationRequested, false);
        const run = advanceProviderDesktopInstaller({ ...op, action: "cancel" }, {
          boot: async () => ({ ...context.scope }),
          verify: async () => ({ stage: "provider_verified", scope: context.scope, address: "203.0.113.10",
            hostPublicKey: "public-fixture-only", hostFingerprintSha256: "fixture-pin", capacityIdempotencyKey: "fixture-only" }),
          bootstrap: async () => ({ publicKeyOpenSsh: "public-fixture-only", privateKeyOpenSsh: "private-fixture-only" }),
          bundle: async () => { throw new Error("Desktop recovery must not load current assets"); },
          control: async input => {
            events.push("fresh_ssh"); ssh += 1;
            assert.equal(input.action, "cancel"); assert.deepEqual(input.identity, desktopIdentity);
            assert.equal(Object.hasOwn(input, "launch"), false);
            assert.ok(events.includes("begin_hivra_provider_desktop_cleanup"));
            if (fault === "superseded") await desktopGrant();
            return { hostVerified: true, administratorAuthenticated: true, hostFingerprintSha256: "fixture-pin", clock,
              receipt: desktopReceipt(fault === "outcome_conflict" ? "cancelled" : "failed",
                fault === "pending" ? "pending" : "verified_stopped", fault === "stale_boot" ? op.agentId : clock.bootId) };
          },
        });
        if (["clean", "pending"].includes(fault)) {
          const result = await run;
          assert.equal(result.state, "failed"); assert.equal(result.cleanupRecorded, fault === "clean");
        } else await assert.rejects(run, error => error.code === "outcome_unknown");
        assert.equal(ssh, 1); // Cached stopped outcome never bypasses fresh SSH.
        const row = await readAgent(), journal = await desktopJournal();
        assert.equal(row.operation_id, op.operationId); assert.equal(row.provider_install_outcome, "failed");
        assert.ok(journal); // Intent is durable even after pending/failed acknowledgement.
        if (fault === "clean") {
          assert.deepEqual(journal.receipt, desktopReceipt()); assert.equal(await release(), true);
        } else if (fault === "lost_response") {
          assert.deepEqual(journal.receipt, desktopReceipt()); // Proof committed, but caller must not claim acknowledgement.
        } else {
          assert.equal(journal.receipt, null);
          await assert.rejects(release, error => error.code === "55006");
        }
      } finally { await db.exec("reset role"); }
    }

    // Exercise the public deletion adapter with its real owner loader and SQL
    // intent/release RPCs. Only guest/provider boundaries remain simulated.
    const { advanceProviderAgentDelete } = require("../src/lib/hivra/provider-agent-delete.ts");
    for (fault of ["clean", "pending", "superseded_release", "release_lost_response"]) {
      await desktopFixture();
      assert.equal(await recordStopped(desktopReceipt("failed", "pending")), true);
      events.length = 0; ssh = 0;
      await db.exec("set role service_role");
      try {
        const context = await loadProviderDesktopInstallOperation(op);
        const cleanupFixture = require("../src/lib/infrastructure/__tests__/hetzner-cleanup.fixtures.ts").firstBootCleanupFixture();
        const run = advanceProviderAgentDelete({ userId: op.userId, agentId: op.agentId }, {
          absentDesktop: async () => false,
          order: async () => cleanupFixture.order,
          desktopInstaller: input => advanceProviderDesktopInstaller(input, {
            boot: async () => ({ ...context.scope }),
            verify: async () => ({ stage: "provider_verified", scope: context.scope, address: "203.0.113.10",
              hostPublicKey: "public-fixture-only", hostFingerprintSha256: "fixture-pin", capacityIdempotencyKey: "fixture-only" }),
            bootstrap: async () => ({ publicKeyOpenSsh: "public-fixture-only", privateKeyOpenSsh: "private-fixture-only" }),
            bundle: async () => { throw new Error("Deletion must not load current assets"); },
            control: async input => {
              ssh += 1; events.push("fresh_ssh");
              assert.equal(input.action, "cancel"); assert.deepEqual(input.identity, desktopIdentity);
              assert.ok(events.includes("request_hivra_agent_delete"));
              assert.ok(events.includes("begin_hivra_provider_desktop_cleanup"));
              assert.equal((await readAgent()).desired_state, "deleted");
              return { hostVerified: true, administratorAuthenticated: true, hostFingerprintSha256: "fixture-pin", clock,
                receipt: desktopReceipt("failed", fault === "pending" ? "pending" : "verified_stopped") };
            },
          }),
          installer: async () => { throw new Error("Desktop deletion must not use legacy installer"); },
          nativeInstaller: async () => { throw new Error("Desktop deletion must not use native installer"); },
          cleanup: async (userId,connectionId,request,overrides) => {
            assert.equal(fault,"pending");
            assert.equal(await overrides.retireUnused({userId,connectionId,expectedRevision:7,
              orderId:request.orderId,providerServerId:"42"}),true);
            events.push("provider_cleanup");
            return {orderId:request.orderId,connectionId,fingerprint:request.fingerprint,status:"cleaning",cleanup:{error:null}};
          },
        });
        if (["clean", "pending"].includes(fault)) {
          assert.deepEqual(await run, { ok: false, pending: true, stage: fault === "pending" ? "provider_cleanup" : "installer_stopping" });
        } else await assert.rejects(run, error => error.code === "operation_unconfirmed");
        const row = await readAgent();
        assert.equal(ssh, 1); assert.equal(row.desired_state, "deleted");
        assert.equal(row.operation_id, ["clean", "release_lost_response"].includes(fault) ? null : op.operationId);
        assert.equal(events.includes("release_hivra_agent_operation"), fault !== "pending");
      } finally { await db.exec("reset role"); }
    }
  } finally {
    if (previous) require.cache[supabasePath] = previous; else delete require.cache[supabasePath];
  }
  console.log("PASS desktop adapter SQL: actual store and delete RPCs, bound dispatch, grant-before-SSH, pending and lost-response retention, stale boot and superseded cleanup");
};

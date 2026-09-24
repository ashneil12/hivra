// Compose the real private TypeScript store/adapter with the actual PostgreSQL
// lifecycle migrations. Only provider/SSH are simulated; no external requests,
// credentials, guest commands or current user accounts are used.
const assert = require("node:assert/strict");
module.exports = async function nativeStoreSqlFixture({ db, nativeFixture, nativeIdentity, nativeReceipt,
  nativeGrant, nativeJournal, recordStopped, readAgent, release }) {
  const supabasePath = require.resolve("../src/lib/supabase.ts"), previous = require.cache[supabasePath];
  const cachedBefore = new Set(Object.keys(require.cache));
  const sourceRoot = require("node:path").resolve(__dirname, "../src") + require("node:path").sep;
  let fault = "clean", ssh = 0;
  const events = [], wire = value => JSON.parse(JSON.stringify(value));
  const identifier = value => { assert.match(value, /^[a-z_][a-z_0-9]*$/); return value; };
  const rpc = async (name, args) => {
    assert.ok(["begin_hivra_provider_native_install", "record_hivra_provider_install_stopped",
      "begin_hivra_provider_native_cleanup", "record_hivra_provider_native_cleanup",
      "request_hivra_agent_delete", "release_hivra_agent_operation", "record_hivra_agent_operation_failure"].includes(name));
    events.push(name);
    const entries = Object.entries(args), placeholders = entries.map(([key], index) => `${identifier(key)}=>$${index + 1}`);
    try {
      if (name === "release_hivra_agent_operation" && fault === "superseded_release") await nativeGrant();
      const result = await db.query(`select public.${identifier(name)}(${placeholders.join(",")}) as result`, entries.map(([, value]) => value));
      if (name === "record_hivra_provider_native_cleanup" && fault === "lost_response") throw new Error("fixture response loss after commit");
      if (name === "release_hivra_agent_operation" && fault === "release_lost_response") throw new Error("fixture release response loss after commit");
      return { data: wire(result.rows[0].result), error: null };
    } catch (error) { return { data: null, error }; }
  };
  const from = table => {
    // The attempt's recipe version is read from its enrollment (a non-secret column).
    assert.ok(["hivra_agents", "infrastructure_capacity_orders", "hivra_provider_native_cleanup", "infrastructure_first_boot_enrollments"].includes(table));
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
    const { advanceProviderNativeInstaller } = require("../src/lib/hivra/provider-native-installer.ts");
    const { loadProviderNativeInstallOperation } = require("../src/lib/hivra/provider-native-install-store.ts");
    const op = { userId: "owner", agentId: nativeIdentity.agentId, operationId: nativeIdentity.operationId };
    const clock = { bootId: nativeReceipt().nativeCleanup.bootId, boottimeMs: 1000 };
    // Root-cause regression: a hostname/tunnel/direct address changed after
    // the last adapter read must be rejected atomically by actual SQL admission.
    for (const drift of ["hostname", "tunnel", "direct"]) {
      fault = "access_drift";
      await nativeFixture(false);
      if (drift === "direct") await db.exec("update public.hivra_agents set cf_hostname=null,cf_tunnel_id=null,ip='203.0.113.10',chat_url='https://203-0-113-10.sslip.io'");
      await db.exec("set role service_role");
      try {
        const context = await loadProviderNativeInstallOperation(op);
        const assets = require("../src/lib/infrastructure/portable-provisioner-contract.ts").PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES.map(relativePath => ({ relativePath,
          content: require("node:fs").readFileSync(require("node:path").join(__dirname, "../provisioner", relativePath)) }));
        const request = { ...op, action: "start", launch: { version: 2, agentKind: "deepseek-harness", computerSubstrate: "provider-vm",
          wantBrowser: false, modelKey: "", model: "", modelBaseUrl: "", publicOrigin: `https://${context.hostname}`,
          tunnelToken: drift === "direct" ? null : Buffer.from(JSON.stringify({ t: context.tunnelId })).toString("base64"),
          accessHostname: drift === "direct" ? context.hostname : null } };
        await assert.rejects(() => advanceProviderNativeInstaller(request, {
          bundle: async () => assets, boot: async () => ({ ...context.scope }),
          verify: async () => ({ stage: "provider_verified", scope: context.scope, address: "203.0.113.10",
            hostPublicKey: "public-fixture-only", hostFingerprintSha256: "fixture-pin", capacityIdempotencyKey: "fixture-only" }),
          bootstrap: async () => {
            if (drift === "hostname") await db.exec("update public.hivra_agents set cf_hostname='changed.example.test'");
            if (drift === "tunnel") await db.query("update public.hivra_agents set cf_tunnel_id=$1", [op.agentId]);
            if (drift === "direct") await db.exec("update public.hivra_agents set ip='203.0.113.11',chat_url='https://203-0-113-11.sslip.io'");
            return { publicKeyOpenSsh: "public-fixture-only", privateKeyOpenSsh: "private-fixture-only" };
          },
          control: async () => { throw new Error("Stale native access must never reach SSH"); },
        }), error => error.code === "rejected");
        const row = await readAgent();
        assert.equal(row.provider_install_identity, null); assert.equal(row.provider_install_native_access, null);
      } finally { await db.exec("reset role"); }
    }
    for (fault of ["clean", "pending", "superseded", "lost_response", "stale_boot", "outcome_conflict"]) {
      await nativeFixture();
      assert.equal(await recordStopped(nativeReceipt("failed", "pending")), true);
      events.length = 0; ssh = 0;
      await db.exec("set role service_role");
      try {
        const context = await loadProviderNativeInstallOperation(op);
        assert.equal(context.cancellationRequested, false);
        const run = advanceProviderNativeInstaller({ ...op, action: "cancel" }, {
          boot: async () => ({ ...context.scope }),
          verify: async () => ({ stage: "provider_verified", scope: context.scope, address: "203.0.113.10",
            hostPublicKey: "public-fixture-only", hostFingerprintSha256: "fixture-pin", capacityIdempotencyKey: "fixture-only" }),
          bootstrap: async () => ({ publicKeyOpenSsh: "public-fixture-only", privateKeyOpenSsh: "private-fixture-only" }),
          bundle: async () => { throw new Error("Native recovery must not load current assets"); },
          control: async input => {
            events.push("fresh_ssh"); ssh += 1;
            assert.equal(input.action, "cancel"); assert.deepEqual(input.identity, nativeIdentity);
            assert.equal(Object.hasOwn(input, "launch"), false);
            assert.ok(events.includes("begin_hivra_provider_native_cleanup"));
            if (fault === "superseded") await nativeGrant();
            return { hostVerified: true, administratorAuthenticated: true, hostFingerprintSha256: "fixture-pin", clock,
              receipt: nativeReceipt(fault === "outcome_conflict" ? "cancelled" : "failed",
                fault === "pending" ? "pending" : "verified_stopped", fault === "stale_boot" ? op.agentId : clock.bootId) };
          },
        });
        if (["clean", "pending"].includes(fault)) {
          const result = await run;
          assert.equal(result.state, "failed"); assert.equal(result.cleanupRecorded, fault === "clean");
        } else await assert.rejects(run, error => error.code === "outcome_unknown");
        assert.equal(ssh, 1); // Cached stopped outcome never bypasses fresh SSH.
        const row = await readAgent(), journal = await nativeJournal();
        assert.equal(row.operation_id, op.operationId); assert.equal(row.provider_install_outcome, "failed");
        assert.ok(journal); // Intent is durable even after pending/failed acknowledgement.
        if (fault === "clean") {
          assert.deepEqual(journal.receipt, nativeReceipt()); assert.equal(await release(), true);
        } else if (fault === "lost_response") {
          assert.deepEqual(journal.receipt, nativeReceipt()); // Proof committed, but caller must not claim acknowledgement.
        } else {
          assert.equal(journal.receipt, null);
          await assert.rejects(release, error => error.code === "55006");
        }
      } finally { await db.exec("reset role"); }
    }

    // Real DELETE adapter + real native adapter/store + actual SQL. Only the
    // provider/SSH observations are simulated. No VM cleanup may be reached
    // on the same request that releases the original provision operation.
    const { advanceProviderAgentDelete } = require("../src/lib/hivra/provider-agent-delete.ts");
    for (fault of ["delete_clean", "delete_pending", "delete_not_dispatched", "superseded_release", "lost_response", "release_lost_response"]) {
      await nativeFixture(fault !== "delete_not_dispatched");
      if (fault !== "delete_not_dispatched") assert.equal(await recordStopped(nativeReceipt("failed", "pending")), true);
      events.length = 0; ssh = 0;
      await db.exec("set role service_role");
      try {
        const context = await loadProviderNativeInstallOperation(op);
        const unexpected = async () => { throw new Error("Original provision cancellation must not enter whole-computer cleanup"); };
        const run = advanceProviderAgentDelete({ userId: op.userId, agentId: op.agentId }, {
          newId: () => "99999999-9999-4999-8999-999999999999",
          installer: unexpected, power: unexpected, order: unexpected, boot: unexpected,
          retire: unexpected, cleanup: unexpected, complete: unexpected,
          nativeInstaller: input => advanceProviderNativeInstaller(input, {
            boot: async () => ({ ...context.scope }),
            verify: async () => ({ stage: "provider_verified", scope: context.scope, address: "203.0.113.10",
              hostPublicKey: "public-fixture-only", hostFingerprintSha256: "fixture-pin", capacityIdempotencyKey: "fixture-only" }),
            bootstrap: async () => ({ publicKeyOpenSsh: "public-fixture-only", privateKeyOpenSsh: "private-fixture-only" }),
            bundle: unexpected,
            control: async input => {
              events.push("fresh_ssh"); ssh += 1;
              assert.equal(input.action, "cancel"); assert.deepEqual(input.identity, nativeIdentity);
              assert.equal((await readAgent()).desired_state, "deleted");
              assert.ok(events.includes("begin_hivra_provider_native_cleanup"));
              return { hostVerified: true, administratorAuthenticated: true, hostFingerprintSha256: "fixture-pin", clock,
                receipt: nativeReceipt("failed", fault === "delete_pending" ? "pending" : "verified_stopped") };
            },
          }),
        });
        if (["superseded_release", "lost_response", "release_lost_response"].includes(fault)) {
          await assert.rejects(run, error => error.code === "operation_unconfirmed");
        } else assert.deepEqual(await run, { ok: false, pending: true, stage: "installer_stopping" });
        const row = await readAgent();
        assert.equal(row.desired_state, "deleted"); assert.equal(row.status, "provisioning");
        assert.equal(row.provider_server_id, "42");
        assert.equal(row.operation_id, ["delete_clean", "delete_not_dispatched", "release_lost_response"].includes(fault) ? null : op.operationId);
        assert.equal(ssh, fault === "delete_not_dispatched" ? 0 : 1);
        assert.equal(events[0], "request_hivra_agent_delete");
        assert.equal(events.includes("release_hivra_agent_operation"),
          ["delete_clean", "delete_not_dispatched", "superseded_release", "release_lost_response"].includes(fault));
        if (["superseded_release", "lost_response"].includes(fault)) assert.match(row.error, /Original resources and operation are retained/);
      } finally { await db.exec("reset role"); }
    }
  } finally {
    // Stores imported under this fixture capture its database adapter. Do not
    // leak that native-only adapter into the following desktop SQL fixture.
    for (const filename of Object.keys(require.cache)) {
      if (filename.startsWith(sourceRoot) && !cachedBefore.has(filename)) delete require.cache[filename];
    }
    if (previous) require.cache[supabasePath] = previous; else delete require.cache[supabasePath];
  }
  console.log("PASS provider native adapter SQL: real store RPCs, grant-before-SSH, cached outcome cancellation, supersession, stale boot, lost acknowledgement and held original operation");
  console.log("PASS provider native deletion SQL: durable delete intent, original-operation cancellation, fresh cleanup release, pending/lost/superseded retention and no same-request VM cleanup");
};

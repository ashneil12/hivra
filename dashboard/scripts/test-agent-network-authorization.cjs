// Agent network B1, end to end: the real shared evaluator and request authorizer
// (TypeScript source, transpiled in place) over the real policy tables (the real
// migration, in PostgreSQL/WASM). Publishes policy, lets a request through, then
// takes the agent away in each way the design names and asks again; every one must
// deny at the very next request.
//   B1-T4  revoke-then-request denies (suspend, member removal, leave, org pause)
//   B1-T1  a revision from the future, or too far behind, denies
//   B1-T2  a principal is never found through another organization
// Synthetic users and ids only; no credentials, network or live database.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { PGlite } = require("@electric-sql/pglite");

const dashboard = path.resolve(__dirname, "..");
const MIGRATION = path.join(dashboard, "supabase/migrations/20261008100000_agent_network_identity_policy.sql");

const loaded = new Map();
function load(file) {
  if (loaded.has(file)) return loaded.get(file).exports;
  const mod = { exports: {} };
  loaded.set(file, mod);
  const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const localRequire = (id) => {
    if (id.startsWith("@/")) return load(path.join(dashboard, "src", id.slice(2) + ".ts"));
    if (id.startsWith(".")) return load(path.resolve(path.dirname(file), id + ".ts"));
    return require(id);
  };
  new Function("require", "module", "exports", "__filename", "__dirname", compiled)(
    localRequire, mod, mod.exports, file, path.dirname(file)
  );
  return mod.exports;
}

const { authorizeNetworkRequest } = load(path.join(dashboard, "src/lib/agent-network/authorize.ts"));

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ON = { HERMES_DEPLOY_CHANNEL: "canary" };
const OWNER = "user_owner";
const MEMBER = "user_member";

async function main() {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create table public.hivra_canonical_agent_identities(
        id uuid primary key, user_id text not null, unique (id, user_id));
    `);
    await db.exec(fs.readFileSync(MIGRATION, "utf8"));

    const call = async (fn, args) => {
      await db.exec("set role service_role");
      try {
        return (await db.query(`select ${fn} as r`, args)).rows[0].r;
      } finally {
        await db.exec("reset role");
      }
    };
    // The same SQL function the Supabase-backed store calls.
    const store = {
      getContext: (input) =>
        call("public.hivra_net_authz_context($1,$2,$3,$4)", [input.orgId, input.principalId, input.peerPrincipalId ?? null, input.revision ?? null]),
    };
    let nIdentity = 1000;
    let nKey = 0;
    const joined = async (org, user) => {
      const identity = uuid(++nIdentity);
      await db.query("insert into public.hivra_canonical_agent_identities(id,user_id) values($1,$2)", [identity, user]);
      const id = await call("public.hivra_net_begin_join($1,$2,$3,$4)", [org, identity, user, user]);
      await call("public.hivra_net_set_principal_key($1,$2,$3,$4)", [org, id, String(++nKey).padStart(43, "A"), user]);
      await call("public.hivra_net_transition_principal($1,$2,'joined',$3)", [org, id, user]);
      return id;
    };
    const doc = (extra = {}, settings = {}) => ({
      settings: { network_enabled: true, paused: false, buzz_binding_default: "forbidden", max_hop_depth: 3, ...settings },
      groups: [], group_members: [], grants: [], edges: [], ...extra,
    });
    const publish = (org, expected, author, document) =>
      call("public.hivra_net_publish_policy_revision($1,$2,$3,'test',$4::jsonb)", [org, expected, author, JSON.stringify(document)]);
    const scenario = async () => {
      const org = await call("public.hivra_net_create_org('team',$1,'Team')", [OWNER]);
      await call("public.hivra_net_add_member($1,$2,'member',$3)", [org, MEMBER, OWNER]);
      const sender = await joined(org, OWNER);
      const receiver = await joined(org, MEMBER);
      const revision = Number(await publish(org, 1, OWNER, doc({
        grants: [{ layer: "ceiling", principal_id: sender, source: "org", mode: "write" }],
        edges: [{ layer: "ceiling", from_principal_id: sender, to_principal_id: receiver, mode: "auto" }],
      })));
      return { org, sender, receiver, revision };
    };
    const write = (org, principal) => ({ orgId: org, principalId: principal, action: "brain.write", source: "org" });
    const send = (org, from, to) => ({ orgId: org, principalId: from, action: "a2a.send", peerPrincipalId: to });
    const ask = (request, env = ON) => authorizeNetworkRequest(store, request, env);
    const transition = (org, principal, to, actor) =>
      call("public.hivra_net_transition_principal($1,$2,$3,$4)", [org, principal, to, actor]);

    // ---- suspend ----------------------------------------------------------
    {
      const { org, sender, receiver } = await scenario();
      assert.deepEqual(pick(await ask(write(org, sender))), { allow: true, reason: "granted" });
      assert.deepEqual(pick(await ask(send(org, sender, receiver))), { allow: true, reason: "edge_allowed" });
      await transition(org, sender, "suspended", OWNER);
      for (const request of [write(org, sender), send(org, sender, receiver)]) {
        assert.deepEqual(pick(await ask(request)), { allow: false, reason: "principal_not_joined" });
      }
      await transition(org, sender, "joined", OWNER);
      assert.equal((await ask(send(org, sender, receiver))).allow, true, "resumed by an owner");
      await transition(org, receiver, "suspended", MEMBER);
      assert.deepEqual(pick(await ask(send(org, sender, receiver))), { allow: false, reason: "peer_not_joined" });
    }

    // ---- member removed ---------------------------------------------------
    {
      const { org, sender, receiver } = await scenario();
      assert.equal((await ask(send(org, sender, receiver))).allow, true);
      await call("public.hivra_net_remove_member($1,$2,$3)", [org, MEMBER, OWNER]);
      assert.deepEqual(pick(await ask(send(org, sender, receiver))), { allow: false, reason: "peer_not_joined" });
      assert.deepEqual(pick(await ask(write(org, receiver))), { allow: false, reason: "principal_not_joined" });
      assert.equal((await ask(write(org, sender))).allow, true, "the remaining member's agent is unaffected");
    }

    // ---- left: grants end; a cached revision is stale -----------------------
    {
      const { org, sender, revision } = await scenario();
      await transition(org, sender, "left", OWNER);
      assert.deepEqual(pick(await ask(write(org, sender))), { allow: false, reason: "principal_not_joined" });
      assert.deepEqual(pick(await ask({ ...write(org, sender), revision })), { allow: false, reason: "stale_revision" });
      assert.deepEqual(
        pick(await ask({ ...write(org, sender), revision, maxRevisionLag: 5 })),
        { allow: false, reason: "principal_not_joined" },
        "a cache that tolerates lag still evaluates live state"
      );
    }

    // ---- org pause and resume ---------------------------------------------
    {
      const { org, sender, revision } = await scenario();
      const grants = [{ layer: "ceiling", principal_id: sender, source: "org", mode: "write" }];
      const paused = Number(await publish(org, revision, OWNER, doc({ grants }, { paused: true })));
      assert.deepEqual(pick(await ask(write(org, sender))), { allow: false, reason: "org_paused" });
      await publish(org, paused, OWNER, doc({ grants }));
      assert.equal((await ask(write(org, sender))).allow, true, "resume restores");
    }

    // ---- tenancy ----------------------------------------------------------
    {
      const { org, sender } = await scenario();
      const other = await call("public.hivra_net_create_org('team',$1,'Other')", ["user_other_owner"]);
      assert.deepEqual(pick(await ask(write(other, sender))), { allow: false, reason: "unknown_principal" });
      assert.equal((await ask(write(org, sender))).allow, true);
    }

    // ---- narrowing, revision skew, absence --------------------------------
    {
      const { org, sender, revision } = await scenario();
      const next = Number(await publish(org, revision, OWNER, doc({
        grants: [
          { layer: "ceiling", principal_id: sender, source: "org", mode: "write" },
          { layer: "narrow", principal_id: sender, source: "org", mode: "read" },
        ],
      })));
      assert.equal((await ask({ ...write(org, sender), action: "brain.read" })).allow, true);
      assert.deepEqual(pick(await ask(write(org, sender))), { allow: false, reason: "narrowed" });
      // Revision skew: future, current, one behind with and without tolerance, the first.
      assert.deepEqual(pick(await ask({ ...write(org, sender), action: "brain.read", revision: next + 1 })), { allow: false, reason: "unknown_revision" });
      const atCurrent = await ask({ ...write(org, sender), action: "brain.read", revision: next });
      assert.equal(atCurrent.allow, true);
      assert.equal(atCurrent.revision, next, "the decision records the revision it used");
      assert.deepEqual(pick(await ask({ ...write(org, sender), action: "brain.read", revision: next - 1 })), { allow: false, reason: "stale_revision" });
      const lagged = await ask({ ...write(org, sender), action: "brain.read", revision: next - 1, maxRevisionLag: 1 });
      assert.equal(lagged.revision, next - 1, "evaluated against the older revision it asked for");
      assert.deepEqual(pick(await ask({ ...write(org, sender), revision: 0 })), { allow: false, reason: "malformed_request" });
      assert.deepEqual(pick(await ask(write(uuid(4040), sender))), { allow: false, reason: "no_policy" });
    }

    // ---- the deployment flag ----------------------------------------------
    {
      const { org, sender } = await scenario();
      let reads = 0;
      const counting = { getContext: (input) => (reads++, store.getContext(input)) };
      for (const env of [{}, { HERMES_DEPLOY_CHANNEL: "production" }]) {
        assert.deepEqual(pick(await authorizeNetworkRequest(counting, write(org, sender), env)), { allow: false, reason: "network_disabled_on_deployment" });
      }
      assert.equal(reads, 0, "a deployment with the network off never reads the database");
    }

    console.log("PASS agent network revoke-then-request over the real policy tables");
  } finally {
    await db.close();
  }
}

function pick(decision) {
  return { allow: decision.allow, reason: decision.reason };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

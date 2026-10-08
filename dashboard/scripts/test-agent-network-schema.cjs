// Agent network B1: apply the real migration in PostgreSQL/WASM (twice, to prove
// it re-runs) and exercise the acceptance criteria that live in the database:
//   AC-B1-2  two orgs with colliding principal ids cannot reference each other
//   AC-B1-3  a member cannot widen above the org ceiling; no revision is written
//   AC-B1-4  a personal account gets an organization of one
//   AC-B1-5  the audit log refuses writes from any non-service path, and refuses
//            update and delete from every role
//   B1-T1/T4 revisions are monotonic and immutable; a principal that is
//            suspended, removed or has left reads as not joined at once
// Entirely in memory: no credentials or live database.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const MIGRATION = path.resolve(
  __dirname,
  "../supabase/migrations/20261008100000_agent_network_identity_policy.sql"
);

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const OWNER = "user_owner";
const ADMIN = "user_admin";
const MEMBER = "user_member";
const MEMBER2 = "user_member2";
const KEY = (n) => String(n).padStart(43, "A");

async function main() {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      -- The Canary defaults after 20260930140000: nothing for the API roles.
      create table public.hivra_canonical_agent_identities(
        id uuid primary key, user_id text not null, unique (id, user_id));
    `);
    const sql = fs.readFileSync(MIGRATION, "utf8");
    await db.exec(sql);
    await db.exec(sql); // re-runs cleanly

    const one = async (q, args = []) => (await db.query(q, args)).rows[0];
    const rows = async (q, args = []) => (await db.query(q, args)).rows;
    const asRole = async (role, fn) => {
      await db.exec(`set role ${role}`);
      try {
        return await fn();
      } finally {
        await db.exec("reset role");
      }
    };
    const svc = (fn) => asRole("service_role", fn);
    const rejects = async (promise, pattern, label) => {
      try {
        await promise;
      } catch (error) {
        assert.match(`${error.code || ""} ${error.message}`, pattern, `${label}: wrong error: ${error.message}`);
        return error;
      }
      assert.fail(`${label}: expected a rejection`);
    };
    const call = (fnSql, args) => svc(() => one(`select ${fnSql} as r`, args).then((row) => row.r));

    let nIdentity = 100;
    const identity = async (user) => {
      const id = uuid(++nIdentity);
      await db.query("insert into public.hivra_canonical_agent_identities(id,user_id) values($1,$2)", [id, user]);
      return id;
    };
    let nKey = 0;
    const joinedPrincipal = async (org, user) => {
      const id = await call("public.hivra_net_begin_join($1,$2,$3,$4)", [org, await identity(user), user, user]);
      await call("public.hivra_net_set_principal_key($1,$2,$3,$4)", [org, id, KEY(++nKey), user]);
      await call("public.hivra_net_transition_principal($1,$2,'joined',$3)", [org, id, user]);
      return id;
    };
    const publish = (org, expected, author, doc, reason = "test") =>
      call("public.hivra_net_publish_policy_revision($1,$2,$3,$4,$5::jsonb)", [org, expected, author, reason, JSON.stringify(doc)]);
    const emptyDoc = (settings = {}) => ({
      settings: { network_enabled: true, paused: false, buzz_binding_default: "forbidden", max_hop_depth: 3, ...settings },
      groups: [],
      group_members: [],
      grants: [],
      edges: [],
    });
    const state = (org, principal) =>
      one("select state from public.hivra_principals where org_id=$1 and id=$2", [org, principal]).then((r) => r.state);
    const currentRevision = (org) =>
      one("select current_revision from public.hivra_orgs where id=$1", [org]).then((r) => Number(r.current_revision));
    const revisionCount = (org) =>
      one("select count(*)::int as n from public.hivra_policy_revisions where org_id=$1", [org]).then((r) => r.n);
    const context = (org, principal, peer = null, revision = null) =>
      call("public.hivra_net_authz_context($1,$2,$3,$4)", [org, principal, peer, revision]);

    // ---- AC-B1-4: an organization of one ---------------------------------
    const personal = await call("public.hivra_net_ensure_personal_org($1)", [OWNER]);
    assert.equal(await call("public.hivra_net_ensure_personal_org($1)", [OWNER]), personal, "ensure is idempotent");
    const otherPersonal = await call("public.hivra_net_ensure_personal_org($1)", ["user_someone_else"]);
    assert.notEqual(otherPersonal, personal, "each account gets its own organization");
    assert.equal((await rows("select * from public.hivra_orgs where kind='personal' and personal_owner_user_id=$1", [OWNER])).length, 1);
    const members = await rows("select user_id, role, removed_at from public.hivra_org_members where org_id=$1", [personal]);
    assert.deepEqual(members.map((m) => [m.user_id, m.role, m.removed_at]), [[OWNER, "owner", null]], "exactly one member: the owner");
    assert.equal(await currentRevision(personal), 1, "revision 1 exists");
    const rev1 = await one("select * from public.hivra_org_settings where org_id=$1 and valid_to_revision is null", [personal]);
    assert.equal(rev1.network_enabled, false, "the network starts off");
    assert.equal(rev1.paused, false);
    assert.equal(rev1.buzz_binding_default, "forbidden", "D5: Buzz forbidden by default");
    assert.equal((await one("select count(*)::int n from public.hivra_brain_grants where org_id=$1", [personal])).n, 0, "no grants by default");
    assert.equal((await one("select count(*)::int n from public.hivra_agent_edges where org_id=$1", [personal])).n, 0, "no edges by default");
    // A personal organization has no second member and its owner cannot leave.
    await rejects(call("public.hivra_net_add_member($1,$2,'member',$3)", [personal, MEMBER, OWNER]), /one member|HN422/, "second member");
    await rejects(call("public.hivra_net_remove_member($1,$2,$3)", [personal, OWNER, OWNER]), /HN409|HN422|owner/, "remove sole owner");
    // The user's own agent uses the same schema as a team's.
    const ownAgent = await joinedPrincipal(personal, OWNER);
    assert.equal(await state(personal, ownAgent), "joined");
    // Creating an account's organization changed no other table.
    assert.equal((await one("select count(*)::int n from public.hivra_canonical_agent_identities")).n, 1);

    // ---- a team organization ---------------------------------------------
    const orgA = await call("public.hivra_net_create_org('team',$1,'Team A')", [OWNER]);
    await call("public.hivra_net_add_member($1,$2,'admin',$3)", [orgA, ADMIN, OWNER]);
    await call("public.hivra_net_add_member($1,$2,'member',$3)", [orgA, MEMBER, OWNER]);
    await call("public.hivra_net_add_member($1,$2,'member',$3)", [orgA, MEMBER2, ADMIN]);
    await rejects(call("public.hivra_net_add_member($1,$2,'member',$3)", [orgA, "user_x", MEMBER]), /HN403/, "a member cannot add members");
    await rejects(call("public.hivra_net_add_member($1,$2,'owner',$3)", [orgA, "user_x", ADMIN]), /HN403/, "an admin cannot add an owner");
    const adminAgent = await joinedPrincipal(orgA, ADMIN);
    const memberAgent = await joinedPrincipal(orgA, MEMBER);
    const member2Agent = await joinedPrincipal(orgA, MEMBER2);

    // ---- publish: first revision, monotonic and stale-safe ---------------
    assert.equal(await publish(orgA, 1, OWNER, emptyDoc()), 2, "network on is revision 2");
    assert.equal(await publish(orgA, 2, OWNER, emptyDoc()), 2, "an identical document writes nothing");
    assert.equal(await revisionCount(orgA), 2);
    await rejects(publish(orgA, 1, OWNER, emptyDoc({ paused: true })), /HN409/, "stale base revision");
    assert.equal(await currentRevision(orgA), 2, "a stale publish writes nothing");
    await rejects(publish(orgA, 2, "user_nobody", emptyDoc({ paused: true })), /HN403/, "non-member publish");
    for (const bad of [{}, { settings: {} }, { ...emptyDoc(), extra: [] }, { ...emptyDoc(), grants: {} }]) {
      await rejects(publish(orgA, 2, OWNER, bad), /HN422|null value|violates/, "malformed document");
    }
    assert.equal(await currentRevision(orgA), 2);

    // ---- AC-B1-2: composite keys, colliding principal ids -----------------
    const orgB = await call("public.hivra_net_create_org('team',$1,'Team B')", ["user_b_owner"]);
    // Same principal id in two organizations is allowed and kept apart.
    const SHARED = uuid(9000);
    const idA = await identity(OWNER);
    const idB = await identity("user_b_owner");
    await db.query("insert into public.hivra_principals(org_id,id,agent_identity_id,owner_user_id) values($1,$2,$3,$4)", [orgA, SHARED, idA, OWNER]);
    await db.query("insert into public.hivra_principals(org_id,id,agent_identity_id,owner_user_id) values($1,$2,$3,$4)", [orgB, SHARED, idB, "user_b_owner"]);
    assert.equal((await rows("select 1 from public.hivra_principals where id=$1", [SHARED])).length, 2, "an id may exist in two orgs");
    // A principal that exists only in org A cannot be named by org B.
    const onlyA = adminAgent;
    const docB = emptyDoc();
    docB.grants = [{ layer: "ceiling", principal_id: onlyA, source: "org", mode: "read" }];
    await rejects(publish(orgB, 1, "user_b_owner", docB), /HN422/, "grant naming another org's principal");
    docB.grants = [];
    docB.edges = [{ layer: "ceiling", from_principal_id: onlyA, to_principal_id: SHARED, mode: "auto" }];
    await rejects(publish(orgB, 1, "user_b_owner", docB), /HN422/, "edge naming another org's principal");
    assert.equal(await currentRevision(orgB), 1, "no revision written for org B");
    // The foreign keys are the backstop under the function: a direct insert is refused.
    await rejects(
      db.query(
        `insert into public.hivra_brain_grants(org_id,layer,principal_id,source,mode,author_user_id,valid_from_revision)
         values($1,'ceiling',$2,'org','read','x',1)`,
        [orgB, onlyA]
      ),
      /23503|foreign key/,
      "composite foreign key"
    );
    await rejects(
      db.query(
        `insert into public.hivra_agent_edges(org_id,layer,from_principal_id,to_principal_id,mode,author_user_id,valid_from_revision)
         values($1,'ceiling',$2,$3,'auto','x',1)`,
        [orgB, onlyA, SHARED]
      ),
      /23503|foreign key/,
      "composite foreign key on edges"
    );
    // The authorization context only finds a principal through its own org.
    const wrongOrg = await context(orgB, onlyA);
    assert.equal(wrongOrg.subject, null, "a principal is not found through another org");
    assert.equal((await context(orgA, onlyA)).subject.state, "joined");
    // A principal's owner must be a member of that org.
    await rejects(
      db.query("insert into public.hivra_principals(org_id,agent_identity_id,owner_user_id) values($1,$2,$3)", [orgB, await identity(OWNER), OWNER]),
      /23503|foreign key/,
      "owner is not a member of the org"
    );
    // The agent identity must belong to the same owner.
    await rejects(
      db.query("insert into public.hivra_principals(org_id,agent_identity_id,owner_user_id) values($1,$2,$3)", [orgA, await identity(MEMBER), OWNER]),
      /23503|foreign key/,
      "identity of a different owner"
    );

    // A public key identifies one live agent; narrowing belongs to an agent.
    {
      const twin = await joinedPrincipal(orgA, ADMIN);
      const twinKey = (await one("select public_key k from public.hivra_principals where org_id=$1 and id=$2", [orgA, twin])).k;
      await rejects(call("public.hivra_net_set_principal_key($1,$2,$3,$4)", [orgA, adminAgent, twinKey, ADMIN]), /23505|unique/, "two agents with one key");
      assert.equal(await call("public.hivra_net_set_principal_key($1,$2,$3,$4)", [orgA, twin, twinKey, ADMIN]), 2, "an agent may re-register its own key");
      await call("public.hivra_net_transition_principal($1,$2,'left',$3)", [orgA, twin, ADMIN]);
      assert.equal(await call("public.hivra_net_set_principal_key($1,$2,$3,$4)", [orgA, adminAgent, twinKey, ADMIN]), 2, "a key frees up when its agent leaves");
      await call("public.hivra_net_set_principal_key($1,$2,$3,$4)", [orgA, adminAgent, KEY(800), ADMIN]);
      const groupNarrow = emptyDoc();
      groupNarrow.groups = [{ id: uuid(501), name: "g" }];
      groupNarrow.grants = [{ layer: "narrow", group_id: uuid(501), source: "org", mode: "none" }];
      await rejects(publish(orgA, 2, ADMIN, groupNarrow), /HN422/, "narrowing grant on a group");
      // A full-length reason is recorded in the revision and the audit log; one more character is refused.
      const reasonOrg = await call("public.hivra_net_create_org('team',$1,'Reasons')", ["user_reason_owner"]);
      await publish(reasonOrg, 1, "user_reason_owner", emptyDoc(), "r".repeat(500));
      const logged = await one("select reason from public.hivra_network_audit where org_id=$1 and action='policy.publish'", [reasonOrg]);
      assert.equal(logged.reason.length, 500);
      await rejects(publish(reasonOrg, 2, "user_reason_owner", emptyDoc({ max_hop_depth: 4 }), "r".repeat(501)), /23514|check/, "reason over 500 characters");
      assert.equal(await currentRevision(reasonOrg), 2, "the refused publish wrote nothing");
    }

    // ---- D6: one organization per agent -----------------------------------
    const dup = await identity(OWNER);
    const first = await call("public.hivra_net_begin_join($1,$2,$3,$4)", [orgA, dup, OWNER, OWNER]);
    await rejects(call("public.hivra_net_begin_join($1,$2,$3,$4)", [orgA, dup, OWNER, OWNER]), /23505|unique/, "same agent twice in one org");
    await rejects(call("public.hivra_net_begin_join($1,$2,$3,$4)", [personal, dup, OWNER, OWNER]), /23505|unique/, "same agent in a second org");
    await call("public.hivra_net_transition_principal($1,$2,'left',$3)", [orgA, first, OWNER]);
    const reJoined = await call("public.hivra_net_begin_join($1,$2,$3,$4)", [personal, dup, OWNER, OWNER]);
    assert.ok(reJoined, "after leaving, the agent can join another org as a new principal");
    await call("public.hivra_net_transition_principal($1,$2,'left',$3)", [personal, reJoined, OWNER]);
    // Joining is the owner's explicit act.
    await rejects(call("public.hivra_net_begin_join($1,$2,$3,$4)", [orgA, await identity(MEMBER), MEMBER, ADMIN]), /HN403/, "someone else joins my agent");

    // ---- policy with a ceiling and a narrowing ----------------------------
    const doc = emptyDoc();
    const teamGroup = uuid(500);
    doc.groups = [{ id: teamGroup, name: "writers" }];
    doc.group_members = [{ group_id: teamGroup, principal_id: memberAgent }];
    doc.grants = [
      { layer: "ceiling", principal_id: memberAgent, source: "org", mode: "read" },
      { layer: "ceiling", group_id: teamGroup, source: `team/${teamGroup}`, mode: "write" },
    ];
    doc.edges = [
      { layer: "ceiling", from_principal_id: adminAgent, to_principal_id: memberAgent, mode: "approve", max_messages_per_hour: 20 },
    ];
    assert.equal(await publish(orgA, 2, ADMIN, doc, "initial grants"), 3);
    const snapshot3 = await call("public.hivra_net_policy_snapshot($1,3)", [orgA]);
    assert.equal(snapshot3.grants.length, 2);
    assert.equal(snapshot3.edges.length, 1);
    assert.equal(snapshot3.settings.networkEnabled, true);
    const snapshot2 = await call("public.hivra_net_policy_snapshot($1,2)", [orgA]);
    assert.equal(snapshot2.grants.length, 0, "an older revision still reads as it was");
    assert.equal(await call("public.hivra_net_policy_snapshot($1,4)", [orgA]), null, "a future revision is unknown");
    assert.equal(await call("public.hivra_net_policy_snapshot($1,0)", [orgA]), null, "revision 0 is unknown");
    assert.equal(await call("public.hivra_net_policy_snapshot($1,3)", [uuid(1)]), null, "an unknown org has no policy");

    // ---- AC-B1-3: a member cannot widen above the ceiling -----------------
    const before = await revisionCount(orgA);
    const widen = JSON.parse(JSON.stringify(doc));
    widen.grants.push({ layer: "narrow", principal_id: memberAgent, source: "org", mode: "write" });
    await rejects(publish(orgA, 3, MEMBER, widen), /HN422|exceed/, "narrow above the ceiling (member)");
    await rejects(publish(orgA, 3, ADMIN, widen), /HN422|exceed/, "narrow above the ceiling (admin)");
    // A narrowing row where no ceiling exists is also above the ceiling.
    const noCeiling = JSON.parse(JSON.stringify(doc));
    noCeiling.grants.push({ layer: "narrow", principal_id: memberAgent, source: "org", mode: "read" });
    noCeiling.grants = noCeiling.grants.filter((g) => !(g.layer === "ceiling" && g.source === "org"));
    await rejects(publish(orgA, 3, MEMBER, noCeiling), /HN403|HN422/, "narrow with no ceiling");
    assert.equal(await revisionCount(orgA), before, "no revision was written");
    assert.equal(await currentRevision(orgA), 3);
    // A member cannot change the ceiling, settings, groups or someone else's agent.
    const ceiling = JSON.parse(JSON.stringify(doc));
    ceiling.grants[0].mode = "write";
    await rejects(publish(orgA, 3, MEMBER, ceiling), /HN403/, "member edits a ceiling row");
    await rejects(publish(orgA, 3, MEMBER, emptyDoc({ paused: true })), /HN403/, "member edits settings");
    const others = JSON.parse(JSON.stringify(doc));
    others.grants.push({ layer: "narrow", principal_id: adminAgent, source: "org", mode: "none" });
    await rejects(publish(orgA, 3, MEMBER, others), /HN403|HN422/, "member narrows an agent they do not own");
    const dropEdge = JSON.parse(JSON.stringify(doc));
    dropEdge.edges = [];
    await rejects(publish(orgA, 3, MEMBER2, dropEdge), /HN403/, "member removes a ceiling edge");
    assert.equal(await currentRevision(orgA), 3);
    // A member can narrow their own agent within the ceiling, and an admin can
    // lower the ceiling underneath without being blocked by it.
    const narrowed = JSON.parse(JSON.stringify(doc));
    narrowed.grants.push({ layer: "narrow", principal_id: memberAgent, source: "org", mode: "none" });
    narrowed.edges.push({ layer: "narrow", from_principal_id: adminAgent, to_principal_id: memberAgent, mode: "deny" });
    assert.equal(await publish(orgA, 3, MEMBER, narrowed), 4, "owner narrows own agent and its inbound edge");
    const lowered = JSON.parse(JSON.stringify(narrowed));
    lowered.grants[0].mode = "none";
    assert.equal(await publish(orgA, 4, ADMIN, lowered), 5, "admin lowers the ceiling beneath a narrowing row");
    // A narrowing edge cannot raise the mode or limits above its ceiling.
    const edgeUp = JSON.parse(JSON.stringify(lowered));
    edgeUp.edges = edgeUp.edges.filter((e) => e.layer === "ceiling");
    edgeUp.edges.push({ layer: "narrow", from_principal_id: adminAgent, to_principal_id: memberAgent, mode: "auto" });
    await rejects(publish(orgA, 5, MEMBER, edgeUp), /HN422/, "narrow edge above ceiling mode");
    const limitUp = JSON.parse(JSON.stringify(lowered));
    limitUp.edges = limitUp.edges.filter((e) => e.layer === "ceiling");
    limitUp.edges.push({ layer: "narrow", from_principal_id: adminAgent, to_principal_id: memberAgent, mode: "approve", max_messages_per_hour: 100 });
    await rejects(publish(orgA, 5, MEMBER, limitUp), /HN422/, "narrow edge above ceiling limit");
    // Group and source validity.
    const badSource = JSON.parse(JSON.stringify(lowered));
    badSource.grants.push({ layer: "ceiling", principal_id: adminAgent, source: `agent/${memberAgent}`, mode: "read" });
    await rejects(publish(orgA, 5, ADMIN, badSource), /HN422|violates/, "a private source granted to another agent");
    const badTeam = JSON.parse(JSON.stringify(lowered));
    badTeam.grants.push({ layer: "ceiling", principal_id: adminAgent, source: `team/${uuid(777)}`, mode: "read" });
    await rejects(publish(orgA, 5, ADMIN, badTeam), /HN422/, "a team source with no group");
    const rename = JSON.parse(JSON.stringify(lowered));
    rename.groups[0].name = "renamed";
    await rejects(publish(orgA, 5, ADMIN, rename), /HN422/, "group rename");
    assert.equal(await currentRevision(orgA), 5);

    // ---- revisions are monotonic and immutable (B1-T1) -------------------
    const revs = (await rows("select revision from public.hivra_policy_revisions where org_id=$1 order by revision", [orgA])).map((r) => Number(r.revision));
    assert.deepEqual(revs, [1, 2, 3, 4, 5], "gap-free");
    for (const statement of [
      "update public.hivra_policy_revisions set author_user_id='x' where org_id=$1",
      "delete from public.hivra_policy_revisions where org_id=$1",
      "update public.hivra_brain_grants set mode='write' where org_id=$1",
      "delete from public.hivra_brain_grants where org_id=$1",
      "update public.hivra_agent_edges set mode='auto' where org_id=$1",
      "delete from public.hivra_org_settings where org_id=$1",
      "update public.hivra_org_groups set name='x' where org_id=$1",
    ]) {
      await rejects(db.query(statement, [orgA]), /HN405|append-only/, `immutable: ${statement}`);
    }
    for (const table of ["hivra_policy_revisions", "hivra_brain_grants", "hivra_agent_edges", "hivra_org_settings", "hivra_network_audit"]) {
      await rejects(db.exec(`truncate public.${table} cascade`), /HN405|truncated/, `truncate ${table}`);
    }
    // Ended rows keep their history: the grant narrowed away at 4 is gone at 5
    // but still reads at 3.
    assert.equal((await call("public.hivra_net_policy_snapshot($1,3)", [orgA])).grants.length, 2);

    // ---- AC-B1-5: the audit log -------------------------------------------
    const auditCount = (org) => one("select count(*)::int n from public.hivra_network_audit where org_id=$1", [org]).then((r) => r.n);
    assert.ok((await auditCount(orgA)) >= 8, "lifecycle and policy changes are recorded");
    const verify = (org) => call("(select to_jsonb(v) from public.hivra_net_verify_audit_chain($1) v)", [org]);
    assert.deepEqual(await verify(orgA), { ok: true, entries: await auditCount(orgA), first_bad_seq: null, problem: null });
    const appendSql = "public.hivra_net_append_audit($1,'gateway.decision',null,$2,null,'brain:org','deny','grant:none','no_grant',5,$3,42,'{}'::jsonb)";
    const digest = "a".repeat(64);
    const seq = await call(appendSql, [orgA, memberAgent, digest]);
    assert.equal(Number(seq), (await auditCount(orgA)));
    const stored = await one("select * from public.hivra_network_audit where org_id=$1 and seq=$2", [orgA, seq]);
    assert.equal(stored.digest, digest);
    assert.equal(stored.size_bytes, 42);
    assert.equal(Number(stored.policy_revision), 5, "the decision records the revision it used");
    // Other roles cannot append, directly or through the function.
    for (const role of ["anon", "authenticated"]) {
      await rejects(
        asRole(role, () => one(`select ${appendSql} as r`, [orgA, memberAgent, digest])),
        /permission denied|42501/,
        `${role} calls the append function`
      );
      await rejects(
        asRole(role, () =>
          db.query(
            `insert into public.hivra_network_audit(org_id,seq,action,prev_hash,entry_hash) values($1,999,'x',repeat('0',64),repeat('0',64))`,
            [orgA]
          )
        ),
        /permission denied|42501/,
        `${role} inserts into the audit table`
      );
    }
    // The service role cannot write the table directly either, and nobody can
    // update, delete or truncate it.
    await rejects(
      svc(() =>
        db.query(
          `insert into public.hivra_network_audit(org_id,seq,action,prev_hash,entry_hash) values($1,999,'x',repeat('0',64),repeat('0',64))`,
          [orgA]
        )
      ),
      /permission denied|42501/,
      "service role inserts directly"
    );
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const statement of [
        "update public.hivra_network_audit set reason='x'",
        "delete from public.hivra_network_audit",
        "truncate public.hivra_network_audit",
      ]) {
        await rejects(asRole(role, () => db.query(statement)), /permission denied|42501/, `${role}: ${statement}`);
      }
    }
    // Even with every privilege, the trigger refuses.
    await rejects(db.query("update public.hivra_network_audit set reason='x' where org_id=$1", [orgA]), /HN405|append-only/, "superuser update");
    await rejects(db.query("delete from public.hivra_network_audit where org_id=$1", [orgA]), /HN405|append-only/, "superuser delete");
    // Content never lands in the log.
    for (const detail of [{ body: "hello" }, { message: "x" }, { token: "t" }, { secret: "s" }]) {
      await rejects(
        call("public.hivra_net_append_audit($1,'x',null,null,null,null,'n/a',null,null,null,null,null,$2::jsonb)", [orgA, JSON.stringify(detail)]),
        /HN422/,
        `audit detail ${Object.keys(detail)[0]}`
      );
    }
    await rejects(call("public.hivra_net_append_audit($1,'x')", [uuid(42)]), /HN404/, "audit for an unknown org");
    // The chain: corrupting an entry (as a database administrator could) is found.
    const sizeBefore = await auditCount(orgA);
    await db.exec("alter table public.hivra_network_audit disable trigger hivra_network_audit_append_only");
    await db.query("update public.hivra_network_audit set reason='tampered' where org_id=$1 and seq=3", [orgA]);
    const broken = await verify(orgA);
    assert.equal(broken.ok, false);
    assert.equal(Number(broken.first_bad_seq), 3);
    assert.match(broken.problem, /content/);
    await db.query("update public.hivra_network_audit set reason=null where org_id=$1 and seq=3", [orgA]);
    assert.equal((await verify(orgA)).ok, true, "restored");
    await db.query("delete from public.hivra_network_audit where org_id=$1 and seq=4", [orgA]);
    const gap = await verify(orgA);
    assert.equal(gap.ok, false);
    assert.equal(Number(gap.first_bad_seq), 4);
    assert.match(gap.problem, /gap/);
    await db.exec("alter table public.hivra_network_audit enable trigger hivra_network_audit_append_only");
    assert.equal(await auditCount(orgA), sizeBefore - 1);

    // ---- B1-T4: revocation is immediate -----------------------------------
    const revokeOrg = await call("public.hivra_net_create_org('team',$1,'Revoke')", [OWNER]);
    await call("public.hivra_net_add_member($1,$2,'member',$3)", [revokeOrg, MEMBER, OWNER]);
    const victim = await joinedPrincipal(revokeOrg, OWNER);
    const peer = await joinedPrincipal(revokeOrg, MEMBER);
    let revokeRev = 1;
    const revokeDoc = emptyDoc();
    revokeDoc.grants = [{ layer: "ceiling", principal_id: victim, source: "org", mode: "write" }];
    revokeDoc.edges = [{ layer: "ceiling", from_principal_id: victim, to_principal_id: peer, mode: "auto" }];
    revokeRev = await publish(revokeOrg, revokeRev, OWNER, revokeDoc);
    assert.equal((await context(revokeOrg, victim, peer)).subject.state, "joined");
    // Suspending, leaving and removing the owner each read as not joined at the next call.
    await call("public.hivra_net_transition_principal($1,$2,'suspended',$3)", [revokeOrg, victim, OWNER]);
    const suspended = await context(revokeOrg, victim, peer);
    assert.equal(suspended.subject.state, "suspended");
    assert.equal(suspended.policy.grants.length, 1, "policy rows persist across a suspension");
    await rejects(call("public.hivra_net_transition_principal($1,$2,'joined',$3)", [revokeOrg, victim, MEMBER]), /HN403/, "a member resumes a suspended agent");
    await call("public.hivra_net_transition_principal($1,$2,'joined',$3)", [revokeOrg, victim, OWNER]);
    assert.equal((await context(revokeOrg, victim, peer)).subject.state, "joined", "an owner resumes");
    // Illegal moves.
    await rejects(call("public.hivra_net_transition_principal($1,$2,'joined',$3)", [revokeOrg, victim, OWNER]), /HN409/, "joined -> joined");
    // Removing the member who owns the peer suspends the peer.
    assert.equal(await call("public.hivra_net_remove_member($1,$2,$3)", [revokeOrg, MEMBER, OWNER]), 1);
    const afterRemoval = await context(revokeOrg, victim, peer);
    assert.equal(afterRemoval.peer.state, "suspended");
    assert.equal(afterRemoval.peer.memberActive, false);
    // The agent leaves: its rows end in a new revision, history is intact.
    const beforeLeave = await currentRevision(revokeOrg);
    await call("public.hivra_net_transition_principal($1,$2,'left',$3)", [revokeOrg, victim, OWNER]);
    assert.equal(await currentRevision(revokeOrg), beforeLeave + 1, "leaving ends policy rows in a new revision");
    const leftCtx = await context(revokeOrg, victim, peer);
    assert.equal(leftCtx.subject.state, "left");
    assert.equal(leftCtx.policy.grants.length, 0);
    assert.equal(leftCtx.policy.edges.length, 0);
    assert.equal((await call("public.hivra_net_policy_snapshot($1,$2)", [revokeOrg, beforeLeave])).grants.length, 1, "the earlier revision still shows the grant");
    await rejects(call("public.hivra_net_transition_principal($1,$2,'joined',$3)", [revokeOrg, victim, OWNER]), /HN409/, "left is terminal");
    await rejects(call("public.hivra_net_set_principal_key($1,$2,$3,$4)", [revokeOrg, victim, KEY(900), OWNER]), /HN409/, "a left principal registers no key");
    await rejects(publish(revokeOrg, await currentRevision(revokeOrg), OWNER, { ...emptyDoc(), grants: [{ layer: "ceiling", principal_id: victim, source: "org", mode: "read" }] }), /HN422/, "a left principal cannot be granted");
    // Only a joined principal with a key; joining needs the key and the owner.
    const pendingId = await call("public.hivra_net_begin_join($1,$2,$3,$4)", [revokeOrg, await identity(OWNER), OWNER, OWNER]);
    await rejects(call("public.hivra_net_transition_principal($1,$2,'joined',$3)", [revokeOrg, pendingId, OWNER]), /23514|check/, "joining without a key");
    await call("public.hivra_net_set_principal_key($1,$2,$3,$4)", [revokeOrg, pendingId, KEY(901), OWNER]);
    await rejects(call("public.hivra_net_transition_principal($1,$2,'joined',$3)", [revokeOrg, pendingId, ADMIN]), /HN403/, "someone else finishes joining");
    await rejects(call("public.hivra_net_set_principal_key($1,$2,$3,$4)", [revokeOrg, pendingId, "not-a-key", OWNER]), /23514|check/, "malformed key");
    const keyV2 = await call("public.hivra_net_set_principal_key($1,$2,$3,$4)", [revokeOrg, pendingId, KEY(902), OWNER]);
    assert.equal(keyV2, 2, "re-registering rotates the key");
    // An unknown org, an unknown principal and a bogus revision read as absent.
    assert.equal((await context(uuid(1), victim)).orgFound, false);
    assert.equal((await context(uuid(1), victim)).policy, null);
    assert.equal((await context(revokeOrg, uuid(2))).subject, null);
    assert.equal((await context(revokeOrg, peer, null, 999)).policy, null, "an unknown revision has no policy");

    // ---- no key material beyond a public key ------------------------------
    const principalColumns = (await rows(
      "select column_name from information_schema.columns where table_schema='public' and table_name in ('hivra_principals','hivra_card_signing_keys','hivra_orgs','hivra_org_members')"
    )).map((c) => c.column_name);
    assert.ok(!principalColumns.some((c) => /private|secret|seed|password|encrypted/i.test(c)), `no secret column: ${principalColumns}`);

    // ---- responsibility record: six declared facts, none defaulted ---------
    const parties = ["org", "hivra_cloud", "hivra_cloud", "hivra_cloud", "org", "hivra_cloud"];
    await call("public.hivra_net_record_responsibility($1,'brain',$2,$3,$4,$5,$6,$7,$8,null)", [orgA, ...parties, OWNER]);
    const resp = await one("select * from public.hivra_network_responsibilities where org_id=$1 and service='brain'", [orgA]);
    assert.equal(resp.spend_owner, "hivra_cloud");
    assert.equal(resp.recovery_owner, "org");
    await rejects(call("public.hivra_net_record_responsibility($1,'brain',null,$2,$3,$4,$5,$6,$7,null)", [orgA, ...parties.slice(1), OWNER]), /23502|null value/, "an undeclared fact");
    await rejects(call("public.hivra_net_record_responsibility($1,'brain','everyone',$2,$3,$4,$5,$6,$7,null)", [orgA, ...parties.slice(1), OWNER]), /23514|check/, "an unknown party");
    await rejects(call("public.hivra_net_record_responsibility($1,'database',$2,$3,$4,$5,$6,$7,$8,null)", [orgA, ...parties, OWNER]), /23514|check/, "an unknown service");

    // ---- signing key registry: one-way status, no deletes ------------------
    await svc(() => db.query("insert into public.hivra_card_signing_keys(kid, public_key) values('card-key-0001', $1)", [KEY(1)]));
    await rejects(svc(() => db.query("insert into public.hivra_card_signing_keys(kid, public_key) values('card-key-0002', $1)", [KEY(1)])), /23505|unique/, "duplicate public key");
    await svc(() => db.query("update public.hivra_card_signing_keys set status='retired', retired_at=now() where kid='card-key-0001'"));
    await rejects(svc(() => db.query("update public.hivra_card_signing_keys set status='active', retired_at=null where kid='card-key-0001'")), /HN409/, "retired key reactivated");
    await svc(() => db.query("update public.hivra_card_signing_keys set status='revoked', revoked_at=now(), revoked_reason='rotated' where kid='card-key-0001'"));
    await rejects(svc(() => db.query("update public.hivra_card_signing_keys set status='retired', retired_at=now(), revoked_at=null where kid='card-key-0001'")), /HN409|23514/, "revoked key un-revoked");
    await rejects(svc(() => db.query("update public.hivra_card_signing_keys set public_key=$1 where kid='card-key-0001'", [KEY(3)])), /HN405/, "key material swapped under a kid");
    await rejects(svc(() => db.query("delete from public.hivra_card_signing_keys where kid='card-key-0001'")), /HN405|permission denied/, "key deleted");
    await rejects(asRole("authenticated", () => db.query("select * from public.hivra_card_signing_keys")), /permission denied/, "authenticated reads the registry");

    // ---- privileges: service role only ------------------------------------
    const tables = (await rows("select tablename from pg_tables where schemaname='public' and (tablename like 'hivra\\_org%' or tablename in ('hivra_policy_revisions','hivra_principals','hivra_brain_grants','hivra_agent_edges','hivra_network_audit','hivra_network_responsibilities','hivra_card_signing_keys'))")).map((r) => r.tablename);
    assert.equal(tables.length, 12, `twelve new tables: ${tables}`);
    for (const table of tables) {
      const rls = await one("select relrowsecurity r from pg_class where oid=('public.'||$1)::regclass", [table]);
      assert.equal(rls.r, true, `${table}: row level security on`);
      for (const role of ["anon", "authenticated"]) {
        for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
          const { ok } = await one("select has_table_privilege($1, ('public.'||$2)::regclass, $3) ok", [role, table, priv]);
          assert.equal(ok, false, `${role} has no ${priv} on ${table}`);
        }
      }
      const writes = ["INSERT", "UPDATE", "DELETE", "TRUNCATE"];
      for (const priv of writes) {
        const { ok } = await one("select has_table_privilege('service_role', ('public.'||$1)::regclass, $2) ok", [table, priv]);
        const allowed = table === "hivra_card_signing_keys" && (priv === "INSERT" || priv === "UPDATE");
        assert.equal(ok, allowed, `service_role ${priv} on ${table}: ${ok}`);
      }
      assert.equal((await one("select has_table_privilege('service_role', ('public.'||$1)::regclass, 'SELECT') ok", [table])).ok, true);
      const publicGrant = await one("select exists(select 1 from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a where c.oid=('public.'||$1)::regclass and a.grantee=0) g", [table]);
      assert.equal(publicGrant.g, false, `PUBLIC has no privilege on ${table}`);
    }
    const functions = (await rows(
      "select p.oid::regprocedure::text fn, p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'hivra\\_net\\_%'"
    ));
    assert.ok(functions.length >= 25, `functions: ${functions.length}`);
    const exposed = new Set([
      "hivra_net_append_audit", "hivra_net_verify_audit_chain", "hivra_net_create_org", "hivra_net_ensure_personal_org",
      "hivra_net_add_member", "hivra_net_remove_member", "hivra_net_begin_join", "hivra_net_set_principal_key",
      "hivra_net_transition_principal", "hivra_net_publish_policy_revision", "hivra_net_policy_snapshot",
      "hivra_net_authz_context", "hivra_net_record_responsibility", "hivra_net_erase_org", "hivra_net_erase_personal_org",
    ]);
    for (const { fn, proname } of functions) {
      for (const role of ["anon", "authenticated"]) {
        assert.equal((await one("select has_function_privilege($1, $2, 'EXECUTE') ok", [role, fn])).ok, false, `${role} cannot execute ${fn}`);
      }
      const publicGrant = await one("select exists(select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid=$1::regprocedure and a.grantee=0) g", [fn]);
      assert.equal(publicGrant.g, false, `PUBLIC cannot execute ${fn}`);
      assert.equal((await one("select has_function_privilege('service_role', $1, 'EXECUTE') ok", [fn])).ok, exposed.has(proname), `service_role execute on ${fn}`);
    }
    // Every definer function pins its search path.
    const unpinned = await rows("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'hivra\\_net\\_%' and p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) c where c like 'search_path=%')");
    assert.deepEqual(unpinned, [], "SECURITY DEFINER functions pin search_path");
    // The service role cannot write a policy table except through the functions.
    for (const statement of [
      "insert into public.hivra_orgs(kind,name,personal_owner_user_id) values('personal','x','u')",
      "insert into public.hivra_org_members(org_id,user_id,role) values($1,'u','owner')",
      "insert into public.hivra_principals(org_id,agent_identity_id,owner_user_id) values($1,$1,'u')",
      "update public.hivra_orgs set current_revision = 99 where id = $1",
      "update public.hivra_principals set state = 'joined' where org_id = $1",
    ]) {
      await rejects(svc(() => db.query(statement, statement.includes("$1") ? [orgA] : [])), /permission denied|42501/, `direct write: ${statement.slice(0, 40)}`);
    }

    // ---- erasure removes everything, including the audit log ---------------
    const erasable = await call("public.hivra_net_ensure_personal_org($1)", ["user_to_erase"]);
    const erasedAgent = await joinedPrincipal(erasable, "user_to_erase");
    await publish(erasable, 1, "user_to_erase", { ...emptyDoc(), grants: [{ layer: "ceiling", principal_id: erasedAgent, source: "org", mode: "read" }] });
    assert.ok((await auditCount(erasable)) > 0);
    const erased = await call("public.hivra_net_erase_personal_org($1)", ["user_to_erase"]);
    assert.ok(erased > 1);
    for (const table of ["hivra_orgs", "hivra_org_members", "hivra_policy_revisions", "hivra_principals", "hivra_org_settings", "hivra_brain_grants", "hivra_network_audit"]) {
      const column = table === "hivra_orgs" ? "id" : "org_id";
      assert.equal((await one(`select count(*)::int n from public.${table} where ${column}=$1`, [erasable])).n, 0, `${table} erased`);
    }
    assert.equal(await call("public.hivra_net_erase_personal_org($1)", ["user_to_erase"]), 0, "a second erase is a no-op");
    assert.equal(await call("public.hivra_net_erase_personal_org($1)", ["user_with_no_org"]), 0);
    assert.ok((await auditCount(orgA)) > 0, "another org's audit is untouched");
    assert.equal(await auditCount(erasable), 0);
    // The erase flag does not outlive the call.
    await rejects(db.query("delete from public.hivra_network_audit where org_id=$1", [orgA]), /HN405/, "erase flag cleared");

    console.log("PASS agent network identity and policy schema");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

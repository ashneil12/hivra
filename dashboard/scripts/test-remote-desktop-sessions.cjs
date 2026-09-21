// Real PostgreSQL/WASM contract test for the remote-desktop session broker.
// Synthetic IDs and tokens only; no network, environment, cloud resource, or
// live database access.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const uuid = () => crypto.randomUUID();
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const challenge = (verifier) => crypto.createHash("sha256").update(verifier).digest("base64url");

async function main() {
  const db = new PGlite();
  let checks = 0;
  const eq = (actual, expected) => { assert.deepEqual(actual, expected); checks += 1; };
  const ok = (value) => { assert.ok(value); checks += 1; };
  const result = async (sql, args = []) => (await db.query(sql, args)).rows[0]?.result;
  const blocked = async (action) => {
    await assert.rejects(action, (error) => ["42501", "23514", "22023"].includes(error.code));
    checks += 1;
  };

  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create table public.hermes_instances(
        id uuid primary key,user_id text not null,status text not null
      );
      create table public.hivra_agents(
        id uuid primary key,user_id text not null,status text not null,desired_state text not null,
        type text,computer_profile text,operation_id uuid,operation_kind text
      );
    `);
    await db.exec(fs.readFileSync(path.resolve(
      __dirname,
      "../supabase/migrations/20260901020000_hivra_remote_desktop_sessions.sql",
    ), "utf8"));
    await db.exec(fs.readFileSync(path.resolve(
      __dirname,
      "../supabase/migrations/20260901030000_hivra_remote_desktop_guest_receipts.sql",
    ), "utf8"));
    await db.exec(fs.readFileSync(path.resolve(
      __dirname,
      "../supabase/migrations/20260901210000_hivra_remote_desktop_session_renewal.sql",
    ), "utf8"));
    await db.exec(fs.readFileSync(path.resolve(
      __dirname,
      "../supabase/migrations/20260908050000_remote_desktop_streaming_mode.sql",
    ), "utf8"));
    await db.exec(fs.readFileSync(path.resolve(
      __dirname,
      "../supabase/migrations/20260908063000_native_desktop_client_identity.sql",
    ), "utf8"));
    await db.exec(fs.readFileSync(path.resolve(
      __dirname,
      "../supabase/migrations/20260908070000_omarchy_native_activation_claim.sql",
    ), "utf8"));
    await db.exec(fs.readFileSync(path.resolve(
      __dirname,
      "../supabase/migrations/20260908073000_omarchy_native_activation_grant.sql",
    ), "utf8"));
    await db.exec(fs.readFileSync(path.resolve(
      __dirname,
      "../supabase/migrations/20260908074000_omarchy_native_activation_grant_reader.sql",
    ), "utf8"));
    await db.exec(fs.readFileSync(path.resolve(
      __dirname,
      "../supabase/migrations/20260908075000_omarchy_native_rolling_renewal.sql",
    ), "utf8"));
    await db.exec(fs.readFileSync(path.resolve(
      __dirname,
      "../supabase/migrations/20260909163000_omarchy_wayland_web_transport.sql",
    ), "utf8"));
    await db.exec(fs.readFileSync(path.resolve(
      __dirname,
      "../supabase/migrations/20260910120000_omarchy_wayland_web_admission_consistency.sql",
    ), "utf8"));
    await db.exec(fs.readFileSync(path.resolve(
      __dirname,
      "../supabase/migrations/20260915120000_remote_desktop_boot_identity_fence.sql",
    ), "utf8"));

    const owner = "owner-user";
    const foreign = "foreign-user";
    const computerId = uuid();
    const otherComputerId = uuid();
    await db.query(
      "insert into public.hermes_instances(id,user_id,status) values($1,$3,'running'),($2,$4,'running')",
      [computerId, otherComputerId, owner, foreign],
    );

    const capabilityReceipt = ({
      generation,
      compositor = "x11",
      transports = ["selkies-webrtc", "selkies-websocket", "recovery-console"],
      privateNetworkReachable = false,
      supportsInputTakeover = true,
      brokerOrigin = "https://desktop-broker.example.com",
      observedRevision = "a".repeat(40),
      observedAt = new Date(),
      bootIdentitySha256,
    }) => ({
      protocol: "hivra-remote-desktop-capability-v1",
      computerKind: "hermes-instance",
      computerId,
      capabilityGeneration: generation,
      observedRevision,
      compositor,
      installedTransports: transports,
      privateNetworkReachable,
      supportsInputTakeover,
      brokerOrigin,
      observedAt: observedAt.toISOString(),
      ...(bootIdentitySha256 ? { bootIdentitySha256 } : {}),
    });
    const recordCapability = async (generation, overrides = {}, userId = owner) => {
      const receipt = capabilityReceipt({ generation, ...overrides });
      const bootIdentitySha256 = receipt.bootIdentitySha256;
      delete receipt.bootIdentitySha256;
      return result(
        bootIdentitySha256
          ? "select public.record_hivra_remote_desktop_capability_v2($1,'hermes-instance',$2,$3,$4,$5,$6) result"
          : "select public.record_hivra_remote_desktop_capability($1,'hermes-instance',$2,$3,$4,$5) result",
        [userId, computerId, generation, receipt, new Date(Date.now() + 6 * 60_000).toISOString(),
          ...(bootIdentitySha256 ? [bootIdentitySha256] : [])],
      );
    };

    await db.exec("set role service_role");
    const firstBootIdentity = hash("first-guest-boot");
    const generation = uuid();
    eq((await recordCapability(generation, { bootIdentitySha256: firstBootIdentity })).status, "ready");
    eq((await recordCapability(uuid(), { brokerOrigin: "https://desktop-broker.example.com/path" })).status, "invalid_receipt");
    eq((await recordCapability(uuid(), {}, foreign)).status, "computer_not_ready");

    const verifier = "v".repeat(64);
    const pkce = challenge(verifier);
    const issue = async ({
      sessionId = uuid(),
      userId = owner,
      transport = "selkies-webrtc",
      inputRole = "viewer",
      handoff = "message",
      code = crypto.randomBytes(32).toString("base64url"),
      issuedAt = new Date(),
      expiresAt = new Date(Date.now() + 4 * 60_000),
      relayExpiresAt = new Date(Date.now() + 3 * 60_000),
      streamingMode = "hq",
    } = {}) => ({
      sessionId,
      code,
      response: await result(
        "select public.issue_hivra_remote_desktop_session_v3($1,$2,'hermes-instance',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,null,null,null) result",
        [userId, sessionId, computerId, transport, inputRole, handoff, hash(code), pkce,
          issuedAt.toISOString(), expiresAt.toISOString(), relayExpiresAt?.toISOString() ?? null,
          streamingMode],
      ),
    });

    const viewer = await issue();
    eq(viewer.response.status, "issued");
    eq(viewer.response.handoff, "message");
    eq(viewer.response.streamingMode, "hq");
    eq((await issue({ streamingMode: "performance" })).response.streamingMode, "performance");
    eq((await issue({ streamingMode: "ultra" })).response.status, "invalid_request");
    eq(viewer.response.audience, `hivra-computer:hermes-instance:${computerId}:desktop`);
    eq((await issue()).response.status, "issued");
    eq((await issue({ userId: foreign })).response.status, "capability_unavailable");
    eq((await issue({ handoff: "url" })).response.status, "invalid_request");
    eq((await issue({
      issuedAt: new Date(Date.now() + 59_000),
      expiresAt: new Date(Date.now() + 5 * 60_000),
      relayExpiresAt: null,
    })).response.status, "invalid_request");
    eq((await issue({ expiresAt: new Date(Date.now() + 6 * 60_000) })).response.status, "invalid_request");
    eq((await issue({ expiresAt: new Date(Date.now() - 1_000), issuedAt: new Date(Date.now() - 30_000), relayExpiresAt: null })).response.status, "invalid_request");
    eq((await issue({ relayExpiresAt: new Date(Date.now() + 5 * 60_000) })).response.status, "invalid_request");
    eq((await issue({ transport: "sunshine-moonlight" })).response.status, "invalid_request");

    const exchange = (code, verifierValue, token) => result(
      "select public.exchange_hivra_remote_desktop_session($1,$2,$3) result",
      [hash(code), challenge(verifierValue), hash(token)],
    );
    eq((await exchange(viewer.code, "wrong".repeat(13), "token-wrong")).status, "invalid");
    const viewerToken = "viewer-token";
    const viewerExchange = await exchange(viewer.code, verifier, viewerToken);
    eq(viewerExchange.status, "exchanged");
    eq(viewerExchange.inputReady, false);
    eq((await exchange(viewer.code, verifier, "replay-token")).status, "already_used");

    const authorize = (token, id = computerId, transport = "selkies-webrtc", wantsInput = false) => result(
      "select public.authorize_hivra_remote_desktop_session($1,'hermes-instance',$2,$3,$4) result",
      [hash(token), id, transport, wantsInput],
    );
    eq((await authorize(viewerToken)).status, "authorized");

    const futureSession = await issue();
    await db.exec("reset role");
    await db.query(
      "update public.hivra_remote_desktop_sessions set issued_at=clock_timestamp()+interval '30 seconds',expires_at=clock_timestamp()+interval '90 seconds',relay_credential_expires_at=null where id=$1",
      [futureSession.sessionId],
    );
    await db.exec("set role service_role");
    eq((await exchange(futureSession.code, verifier, "future-token")).status, "not_yet_valid");
    eq((await authorize(viewerToken, computerId, "selkies-webrtc", true)).status, "denied");
    eq((await authorize(viewerToken, otherComputerId)).status, "denied");
    eq((await recordCapability(generation, { bootIdentitySha256: firstBootIdentity })).status, "ready");
    eq((await recordCapability(generation, { observedRevision: "b".repeat(40) })).status, "generation_conflict");
    eq((await recordCapability(generation, { transports: ["recovery-console"] })).status, "generation_conflict");
    eq((await authorize(viewerToken)).status, "authorized");

    await db.exec("reset role");
    await db.query(
      "update public.hivra_remote_desktop_capabilities set installed_transports=array['recovery-console']::text[] where computer_kind='hermes-instance' and computer_id=$1",
      [computerId],
    );
    await db.exec("set role service_role");
    eq((await authorize(viewerToken)).status, "denied");
    await db.exec("reset role");
    await db.query(
      "update public.hivra_remote_desktop_capabilities set installed_transports=array['recovery-console','selkies-webrtc','selkies-websocket']::text[] where computer_kind='hermes-instance' and computer_id=$1",
      [computerId],
    );
    await db.exec("set role service_role");
    eq((await authorize(viewerToken)).status, "authorized");

    const controller = await issue({ inputRole: "controller" });
    eq(controller.response.status, "issued");
    eq((await issue({ inputRole: "controller" })).response.status, "controller_conflict");
    const controllerToken = "controller-token";
    eq((await exchange(controller.code, verifier, controllerToken)).status, "exchanged");
    eq((await authorize(controllerToken)).status, "authorized");
    eq((await authorize(controllerToken, computerId, "selkies-webrtc", true)).status, "denied");

    const inputReceipt = (action, sessionId, generationValue = generation) => ({
      protocol: "hivra-remote-desktop-input-v1",
      action,
      sessionId,
      computerKind: "hermes-instance",
      computerId,
      capabilityGeneration: generationValue,
      transport: "selkies-webrtc",
      agentInputSuspended: action === "agent-input-suspended",
      controllerCount: action === "agent-input-suspended" ? 1 : 0,
      observedAt: new Date().toISOString(),
    });
    const confirmByToken = (token, receipt) => result(
      "select public.confirm_hivra_remote_desktop_input_transition_by_token($1,$2) result",
      [hash(token), receipt],
    );
    eq((await confirmByToken(controllerToken, {
      ...inputReceipt("agent-input-suspended", controller.sessionId),
      computerId: otherComputerId,
    })).status, "denied");
    eq((await confirmByToken("wrong-controller-token", inputReceipt(
      "agent-input-suspended",
      controller.sessionId,
    ))).status, "denied");
    eq((await confirmByToken(controllerToken, {
      ...inputReceipt("agent-input-suspended", controller.sessionId),
      controllerCount: 2,
    })).status, "denied");
    eq((await confirmByToken(
      controllerToken,
      inputReceipt("agent-input-suspended", controller.sessionId),
    )).status, "confirmed");
    eq((await confirmByToken(
      controllerToken,
      inputReceipt("agent-input-suspended", controller.sessionId),
    )).status, "denied");
    eq((await authorize(controllerToken, computerId, "selkies-webrtc", true)).status, "authorized");

    const revoke = (sessionId, userId = owner, reason = "user_revoked") => result(
      "select public.revoke_hivra_remote_desktop_session($1,$2,$3) result",
      [userId, sessionId, reason],
    );
    const revokeByToken = (token, reason = "connection_closed") => result(
      "select public.revoke_hivra_remote_desktop_session_by_token($1,$2) result",
      [hash(token), reason],
    );
    eq((await revokeByToken("wrong-controller-token")).status, "denied");
    eq((await revokeByToken(controllerToken, "user_revoked")).status, "denied");
    eq((await revokeByToken(controllerToken)).inputState, "release-pending");
    eq((await revokeByToken(controllerToken)).inputState, "release-pending");
    eq((await authorize(controllerToken)).status, "denied");
    eq((await issue({ inputRole: "controller" })).response.status, "controller_conflict");
    eq((await confirmByToken(
      controllerToken,
      inputReceipt("agent-input-resumed", controller.sessionId),
    )).status, "confirmed");
    eq((await confirmByToken(
      controllerToken,
      inputReceipt("agent-input-resumed", controller.sessionId),
    )).status, "denied");
    const nextController = await issue({ inputRole: "controller" });
    eq(nextController.response.status, "issued");
    const nextControllerToken = "next-controller-token";
    eq((await exchange(nextController.code, verifier, nextControllerToken)).status, "exchanged");
    eq(await result(
      "select public.confirm_hivra_remote_desktop_takeover($1,$2,$3) result",
      [owner, nextController.sessionId, inputReceipt("agent-input-suspended", nextController.sessionId)],
    ), true);

    await db.exec("reset role");
    await db.query(
      "update public.hivra_remote_desktop_sessions set issued_at=clock_timestamp()-interval '2 minutes',expires_at=clock_timestamp()-interval '1 second',relay_credential_expires_at=null where id=$1",
      [nextController.sessionId],
    );
    await db.exec("set role service_role");
    eq((await issue({ inputRole: "controller" })).response.status, "controller_conflict");
    const expiredController = (await db.query(
      "select input_state,revoke_reason from public.hivra_remote_desktop_sessions where id=$1",
      [nextController.sessionId],
    )).rows[0];
    eq(expiredController.input_state, "release-pending");
    eq(expiredController.revoke_reason, "session_expired");
    eq(await result(
      "select public.confirm_hivra_remote_desktop_release($1,$2,$3) result",
      [owner, nextController.sessionId, inputReceipt("agent-input-resumed", nextController.sessionId)],
    ), true);
    const rotatingController = await issue({ inputRole: "controller" });
    eq(rotatingController.response.status, "issued");
    const rotatingControllerToken = "rotating-controller-token";
    eq((await exchange(rotatingController.code, verifier, rotatingControllerToken)).status, "exchanged");
    eq(await result(
      "select public.confirm_hivra_remote_desktop_takeover($1,$2,$3) result",
      [owner, rotatingController.sessionId, inputReceipt("agent-input-suspended", rotatingController.sessionId)],
    ), true);

    const sameBootGeneration = uuid();
    eq((await recordCapability(sameBootGeneration, { bootIdentitySha256: firstBootIdentity })).status, "ready");
    eq((await issue({ inputRole: "controller" })).response.status, "controller_conflict");

    const secondGeneration = uuid();
    const secondBootIdentity = hash("second-guest-boot");
    eq((await recordCapability(secondGeneration, { bootIdentitySha256: secondBootIdentity })).status, "ready");
    eq((await authorize(rotatingControllerToken)).status, "denied");
    const rotatedController = (await db.query(
      "select capability_generation,capability_boot_identity_sha256,input_state,revoked_at,revoke_reason from public.hivra_remote_desktop_sessions where id=$1",
      [rotatingController.sessionId],
    )).rows[0];
    // A newly attested boot proves that the prior input process cannot still
    // control this computer, so its exact controller lease is retired.
    eq(rotatedController.capability_generation, generation);
    eq(rotatedController.capability_boot_identity_sha256, firstBootIdentity);
    eq(rotatedController.input_state, "released");
    ok(rotatedController.revoked_at instanceof Date);
    eq(rotatedController.revoke_reason, "capability_rotated");
    ok(rotatedController.capability_generation !== secondGeneration);
    ok(rotatedController.capability_generation !== sameBootGeneration);
    const restartedController = await issue({ inputRole: "controller" });
    eq(restartedController.response.status, "issued");
    const restartedControllerToken = "restarted-controller-token";
    eq((await exchange(restartedController.code, verifier, restartedControllerToken)).status, "exchanged");
    eq(await result(
      "select public.confirm_hivra_remote_desktop_takeover($1,$2,$3) result",
      [owner, restartedController.sessionId,
        inputReceipt("agent-input-suspended", restartedController.sessionId, secondGeneration)],
    ), true);

    // A changed-generation v1 observation has no boot evidence. It must clear,
    // not inherit, the old hash; a later v2 observation of the same actual boot
    // therefore cannot use that stale hash to retire a live controller.
    const mixedVersionController = await issue({ inputRole: "controller" });
    eq(mixedVersionController.response.status, "controller_conflict");
    const legacyGeneration = uuid();
    eq((await recordCapability(legacyGeneration)).status, "ready");
    const legacyCapability = (await db.query(
      "select boot_identity_sha256 from public.hivra_remote_desktop_capabilities where computer_id=$1",
      [computerId],
    )).rows[0];
    eq(legacyCapability.boot_identity_sha256, null);
    const restoredEvidenceGeneration = uuid();
    eq((await recordCapability(restoredEvidenceGeneration, { bootIdentitySha256: secondBootIdentity })).status, "ready");
    eq((await issue({ inputRole: "controller" })).response.status, "controller_conflict");

    const staleGeneration = uuid();
    eq((await recordCapability(staleGeneration, {
      bootIdentitySha256: hash("stale-old-boot"),
      observedAt: new Date(Date.now() - 60_000),
    })).status, "stale_observation");
    eq((await issue({ inputRole: "controller" })).response.status, "controller_conflict");
    eq((await confirmByToken(
      restartedControllerToken,
      inputReceipt("agent-input-resumed", restartedController.sessionId, secondGeneration),
    )).status, "confirmed");

    const revokedBeforeExchange = await issue();
    eq((await revoke(revokedBeforeExchange.sessionId, owner, null)).status, "invalid_request");
    eq((await revoke(revokedBeforeExchange.sessionId)).inputState, "not-requested");
    eq((await exchange(revokedBeforeExchange.code, verifier, "revoked-token")).status, "revoked");

    const expired = await issue({ expiresAt: new Date(Date.now() + 90_000), relayExpiresAt: null });
    await db.exec("reset role");
    await db.query(
      "update public.hivra_remote_desktop_sessions set issued_at=clock_timestamp()-interval '30 seconds',expires_at=clock_timestamp()-interval '1 second' where id=$1",
      [expired.sessionId],
    );
    await db.exec("set role service_role");
    eq((await exchange(expired.code, verifier, "expired-token")).status, "expired");

    const tokenCollisionA = await issue();
    const tokenCollisionB = await issue();
    eq((await exchange(tokenCollisionA.code, verifier, "same-session-token")).status, "exchanged");
    eq((await exchange(tokenCollisionB.code, verifier, "same-session-token")).status, "operation_conflict");

    const noTakeoverGeneration = uuid();
    eq((await recordCapability(noTakeoverGeneration, { supportsInputTakeover: false })).status, "ready");
    eq((await authorize(viewerToken)).status, "denied");
    eq((await issue({ inputRole: "controller" })).response.status, "input_takeover_unavailable");
    eq((await issue()).response.status, "issued");

    const waylandGeneration = uuid();
    eq((await recordCapability(waylandGeneration, {
      compositor: "wayland",
      transports: ["selkies-webrtc", "recovery-console"],
      supportsInputTakeover: true,
    })).status, "ready");
    eq((await issue({ transport: "selkies-webrtc" })).response.status, "transport_unavailable");
    eq((await issue({ transport: "recovery-console" })).response.status, "issued");

    eq(await result(
      "select public.revoke_hivra_remote_desktop_capability($1,'hermes-instance',$2,$3) result",
      [owner, computerId, waylandGeneration],
    ), true);
    eq((await recordCapability(waylandGeneration, {
      compositor: "wayland",
      transports: ["selkies-webrtc", "recovery-console"],
    })).status, "generation_conflict");
    eq((await issue({ transport: "recovery-console" })).response.status, "capability_unavailable");

    // The Omarchy browser desktop runs Selkies against the already-running
    // Wayland compositor. Admission must be identical at issue, exchange,
    // authorize and renewal, or a session is issued and then rejected on the
    // very next call — the exact failure that surfaced as a rejected handoff.
    const waylandWebGeneration = uuid();
    eq((await recordCapability(waylandWebGeneration, {
      compositor: "wayland",
      transports: ["selkies-websocket", "sunshine-moonlight", "recovery-console"],
      privateNetworkReachable: true,
      supportsInputTakeover: true,
    })).status, "ready");
    const waylandWeb = await issue({
      transport: "selkies-websocket", inputRole: "controller", relayExpiresAt: null,
    });
    eq(waylandWeb.response.status, "issued");
    const waylandWebToken = "wayland-web-token";
    const waylandWebExchange = await exchange(waylandWeb.code, verifier, waylandWebToken);
    eq(waylandWebExchange.status, "exchanged");
    eq(waylandWebExchange.transport, "selkies-websocket");
    eq(waylandWebExchange.inputRole, "controller");
    eq((await authorize(waylandWebToken, computerId, "selkies-websocket", false)).status, "authorized");
    eq((await authorize(waylandWebToken, computerId, "selkies-webrtc", false)).status, "denied");
    eq((await authorize(waylandWebToken, computerId, "selkies-websocket", true)).status, "denied");
    eq((await result(
      "select public.renew_hivra_remote_desktop_session_by_token($1,240) result",
      [hash(waylandWebToken)],
    )).status, "denied");

    const waylandWebReceipt = {
      protocol: "hivra-remote-desktop-input-v1",
      action: "agent-input-suspended",
      sessionId: waylandWeb.sessionId,
      computerKind: "hermes-instance",
      computerId,
      capabilityGeneration: waylandWebGeneration,
      transport: "selkies-websocket",
      agentInputSuspended: true,
      controllerCount: 1,
      observedAt: new Date().toISOString(),
    };
    eq(await result(
      "select public.confirm_hivra_remote_desktop_takeover($1,$2,$3) result",
      [owner, waylandWeb.sessionId, waylandWebReceipt],
    ), true);
    eq((await authorize(waylandWebToken, computerId, "selkies-websocket", true)).status, "authorized");
    const waylandWebRenewal = await result(
      "select public.renew_hivra_remote_desktop_session_by_token($1,240) result",
      [hash(waylandWebToken)],
    );
    eq(waylandWebRenewal.status, "renewed");
    eq(waylandWebRenewal.transport, "selkies-websocket");

    eq(await result(
      "select public.revoke_hivra_remote_desktop_capability($1,'hermes-instance',$2,$3) result",
      [owner, computerId, waylandWebGeneration],
    ), true);
    eq((await issue({ transport: "selkies-websocket" })).response.status, "capability_unavailable");

    const nativeComputerId = uuid();
    const nativeGeneration = uuid();
    await db.exec("reset role");
    await db.query(
      "insert into public.hivra_agents(id,user_id,status,desired_state,type,computer_profile) values($1,$2,'running','running','linux-desktop','omarchy')",
      [nativeComputerId, owner],
    );
    await db.exec("set role service_role");
    const nativeReceipt = {
      protocol: "hivra-remote-desktop-capability-v1",
      computerKind: "hivra-agent",
      computerId: nativeComputerId,
      capabilityGeneration: nativeGeneration,
      observedRevision: "c".repeat(64),
      compositor: "wayland",
      installedTransports: ["sunshine-moonlight"],
      privateNetworkReachable: true,
      supportsInputTakeover: true,
      brokerOrigin: "https://desktop-broker.example.com",
      observedAt: new Date().toISOString(),
    };
    eq((await result(
      "select public.record_hivra_remote_desktop_capability($1,'hivra-agent',$2,$3,$4,$5) result",
      [owner, nativeComputerId, nativeGeneration, nativeReceipt,
        new Date(Date.now() + 6 * 60_000).toISOString()],
    )).status, "ready");
    const nativeSessionId = uuid();
    const nativeClientId = uuid();
    const nativeCode = "native-code";
    const nativePem = `-----BEGIN CERTIFICATE-----\n${"a".repeat(96)}\n-----END CERTIFICATE-----\n`;
    const nativeSha = "a".repeat(64);
    const nativeIssue = await result(
      "select public.issue_hivra_remote_desktop_session_v3($1,$2,'hivra-agent',$3,'sunshine-moonlight','controller','message',$4,$5,$6,$7,$8,'hq',$9,$10,$11) result",
      [owner, nativeSessionId, nativeComputerId, hash(nativeCode), pkce,
        new Date().toISOString(), new Date(Date.now() + 120_000).toISOString(),
        new Date(Date.now() + 120_000).toISOString(), nativeClientId, nativePem, nativeSha],
    );
    eq(nativeIssue.status, "issued");
    eq(nativeIssue.nativeProfileBound, true);
    const nativeStored = await db.query(
      "select native_profile_bound,native_client_id,native_client_certificate_sha256 from public.hivra_remote_desktop_sessions where id=$1",
      [nativeSessionId],
    );
    eq(nativeStored.rows[0].native_profile_bound, true);
    eq(nativeStored.rows[0].native_client_id, nativeClientId);
    eq(nativeStored.rows[0].native_client_certificate_sha256, nativeSha);
    const nativeToken = "native-session-token";
    eq((await exchange(nativeCode, verifier, nativeToken)).status, "exchanged");
    const activationId = uuid();
    const nativeClaim = await result(
      "select public.claim_hivra_omarchy_native_activation($1,$2,$3,$4) result",
      [owner, nativeSessionId, hash(nativeToken), activationId],
    );
    eq(nativeClaim.status, "claimed");
    eq(nativeClaim.activationId, activationId);
    eq(nativeClaim.clientId, nativeClientId);
    eq(nativeClaim.clientCertificateSha256, nativeSha);
    const activationGrant = {
      protocol: "hivra-omarchy-guardian-grant-v2",
      binding: { computerId: nativeComputerId, operationId: uuid(), vmid: 2099,
        ownerUid: 1000, guestPrivateIpv4: "10.240.20.99", waylandDisplay: "wayland-1" },
      ownerId: owner, capabilityGeneration: nativeGeneration,
      observedRevision: nativeReceipt.observedRevision,
      sessionId: nativeSessionId, leaseId: activationId, clientId: nativeClientId,
      clientCertificatePem: nativePem, clientCertificateSha256: nativeSha,
      guestBootId: uuid(), expiresAtUnixMs: Date.parse(nativeClaim.expiresAt),
      deadlineBoottimeNs: 1_000_000_000_000,
      continuousDeadlineBoottimeNs: 44_000_000_000_000,
      runtimeMaxUsec: 60_000_000, sunshineSha256: "1".repeat(64),
      guardianSha256: "2".repeat(64), ownershipSha256: "3".repeat(64),
      preparedSha256: "4".repeat(64), unitSha256: "5".repeat(64),
    };
    const recordedGrant = await result(
      "select public.record_hivra_omarchy_native_activation_grant($1,$2,$3,$4) result",
      [owner, nativeSessionId, activationId, activationGrant],
    );
    eq(recordedGrant.status, "recorded");
    eq((await result(
      "select public.record_hivra_omarchy_native_activation_grant($1,$2,$3,$4) result",
      [owner, nativeSessionId, activationId, activationGrant],
    )).status, "recorded");
    eq((await result(
      "select public.record_hivra_omarchy_native_activation_grant($1,$2,$3,$4) result",
      [owner, nativeSessionId, activationId, { ...activationGrant, runtimeMaxUsec: 59_000_000 }],
    )).status, "operation_conflict");
    const loadedGrant = await result(
      "select public.load_hivra_omarchy_native_activation_grant($1,$2,$3) result",
      [owner, nativeSessionId, activationId],
    );
    eq(loadedGrant.status, "loaded");
    eq(loadedGrant.guardianGrant, activationGrant);
    const renewalId = uuid();
    const nativeRenewal = await result(
      "select public.claim_hivra_omarchy_native_renewal($1,$2,$3,$4,240) result",
      [owner, nativeSessionId, activationId, renewalId],
    );
    eq(nativeRenewal.status, "claimed");
    eq(nativeRenewal.renewalCount, 1);
    eq((await result(
      "select public.claim_hivra_omarchy_native_renewal($1,$2,$3,$4,240) result",
      [owner, nativeSessionId, activationId, renewalId],
    )).renewalCount, 1);
    const guardianRenewal = {
      protocol: "hivra-omarchy-guardian-renewal-v1", sessionId: nativeSessionId,
      leaseId: activationId, capabilityGeneration: nativeGeneration,
      guestBootId: activationGrant.guestBootId, renewalId, renewalCount: 1,
      deadlineBoottimeNs: 2_000_000_000_000,
      continuousDeadlineBoottimeNs: activationGrant.continuousDeadlineBoottimeNs,
    };
    eq((await result(
      "select public.record_hivra_omarchy_native_renewal($1,$2,$3,$4,$5) result",
      [owner, nativeSessionId, activationId, renewalId, guardianRenewal],
    )).status, "recorded");
    eq((await result(
      "select public.record_hivra_omarchy_native_renewal($1,$2,$3,$4,$5) result",
      [owner, nativeSessionId, activationId, renewalId, guardianRenewal],
    )).status, "recorded");
    eq((await result(
      "select public.record_hivra_omarchy_native_renewal($1,$2,$3,$4,$5) result",
      [owner, nativeSessionId, activationId, renewalId,
        { ...guardianRenewal, deadlineBoottimeNs: 2_000_000_000_001 }],
    )).status, "operation_conflict");
    eq((await result(
      "select public.claim_hivra_omarchy_native_activation($1,$2,$3,$4) result",
      [owner, nativeSessionId, hash(nativeToken), uuid()],
    )).status, "already_used");

    await db.exec("reset role; set role authenticated");
    await blocked(() => db.query("select * from public.hivra_remote_desktop_sessions"));
    await blocked(() => db.query(
      "select public.revoke_hivra_remote_desktop_session($1,$2,'user_revoked')",
      [owner, viewer.sessionId],
    ));
    await blocked(() => db.query(
      "select public.issue_hivra_remote_desktop_session_v3($1,$2,'hivra-agent',$3,'sunshine-moonlight','viewer','message',$4,$5,$6,$7,$8,'hq',$9,$10,$11)",
      [owner, uuid(), nativeComputerId, hash("blocked-native-code"), pkce,
        new Date().toISOString(), new Date(Date.now() + 60_000).toISOString(),
        new Date(Date.now() + 60_000).toISOString(), uuid(), nativePem, nativeSha],
    ));
    await blocked(() => db.query(
      "select public.claim_hivra_omarchy_native_activation($1,$2,$3,$4)",
      [owner, nativeSessionId, hash(nativeToken), uuid()],
    ));
    await blocked(() => db.query(
      "select public.record_hivra_omarchy_native_activation_grant($1,$2,$3,$4)",
      [owner, nativeSessionId, activationId, activationGrant],
    ));
    await blocked(() => db.query(
      "select public.load_hivra_omarchy_native_activation_grant($1,$2,$3)",
      [owner, nativeSessionId, activationId],
    ));
    await blocked(() => db.query(
      "select public.claim_hivra_omarchy_native_renewal($1,$2,$3,$4,240)",
      [owner, nativeSessionId, activationId, renewalId],
    ));
    await blocked(() => db.query(
      "select public.record_hivra_omarchy_native_renewal($1,$2,$3,$4,$5)",
      [owner, nativeSessionId, activationId, renewalId, guardianRenewal],
    ));
    await blocked(() => db.query(
      "select public.issue_hivra_remote_desktop_session_v2($1,$2,'hermes-instance',$3,'recovery-console','viewer','message',$4,$5,$6,$7,null,'hq')",
      [owner, uuid(), computerId, hash("blocked-code"), pkce,
        new Date().toISOString(), new Date(Date.now() + 60_000).toISOString()],
    ));
    await blocked(() => db.query(
      "select public.record_hivra_remote_desktop_capability_v2($1,'hermes-instance',$2,$3,$4,$5,$6)",
      [owner, computerId, uuid(), capabilityReceipt({ generation: uuid() }),
        new Date(Date.now() + 60_000).toISOString(), hash("unauthorized-boot")],
    ));
    await db.exec("reset role");

    const persisted = await db.query(
      "select exchange_code_hash,session_token_hash,streaming_mode from public.hivra_remote_desktop_sessions where id=$1",
      [viewer.sessionId],
    );
    eq(persisted.rows[0].exchange_code_hash, hash(viewer.code));
    eq(persisted.rows[0].session_token_hash, hash(viewerToken));
    eq(persisted.rows[0].streaming_mode, "hq");
    ok(!JSON.stringify(persisted.rows[0]).includes(viewer.code));
    ok(!JSON.stringify(persisted.rows[0]).includes(viewerToken));

    process.stdout.write(`remote-desktop-session checks passed: ${checks}\n`);
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

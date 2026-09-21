import { canonicalFirstBootHostKey, createFirstBootChallenge, FIRST_BOOT_RECIPE_VERSION } from "../first-boot-enrollment";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import {
  consumeFirstBootEnrollment, FIRST_BOOT_PREPARATION_CONFIRMATION, loadFirstBootEnrollment,
  loadStagedFirstBootDelivery, stageFirstBootEnrollment, loadFirstBootEnrollmentForOrder, markFirstBootServerPostAttempted,
} from "../first-boot-store";

const mockRpc = jest.fn();
const mockQuery = { select:jest.fn(), eq:jest.fn(), maybeSingle:jest.fn() };
jest.mock("@/lib/supabase",()=>({supabaseAdmin:{rpc:(...args:unknown[])=>mockRpc(...args),
  from:jest.fn(()=>mockQuery)}}));
jest.mock("@/lib/crypto",()=>({
  ...jest.requireActual("@/lib/crypto"),
  decryptSecret:jest.fn((...args:unknown[])=>jest.requireActual("@/lib/crypto").decryptSecret(...args)),
}));
const now = new Date("2026-08-27T15:00:00.000Z");
const binding = {userId:"fixture-owner",connectionId:"11111111-1111-4111-8111-111111111111",
  connectionRevision:7,orderId:"22222222-2222-4222-8222-222222222222",
  attemptId:"33333333-3333-4333-8333-333333333333",quoteFingerprint:"a".repeat(64),
  recipeVersion:FIRST_BOOT_RECIPE_VERSION};
const capacityKey = "44444444-4444-4444-8444-444444444444";
const publicKey = "ssh-ed25519 " + Buffer.concat([
  Buffer.from("0000000b7373682d6564323535313900000020","hex"),Buffer.alloc(32,1),
]).toString("base64");
function fixture() {
  const proof = createFirstBootChallenge(binding,now);
  const input = {...proof,binding,capacityIdempotencyKey:capacityKey,confirmation:FIRST_BOOT_PREPARATION_CONFIRMATION,now};
  const row = {order_id:binding.orderId,user_id:binding.userId,connection_id:binding.connectionId,
    connection_revision:binding.connectionRevision,quote_fingerprint_sha256:binding.quoteFingerprint,
    attempt_id:binding.attemptId,capacity_idempotency_key:capacityKey,recipe_version:FIRST_BOOT_RECIPE_VERSION,
    phase:"staged",issued_at:proof.challenge.issuedAt,expires_at:proof.challenge.expiresAt,
    verifier_sha256:proof.challenge.verifierSha256,provider_server_id:null,host_public_key:null,host_fingerprint_sha256:null};
  const ciphertext = encryptSecret(JSON.stringify({version:1,purpose:"hivra/first-boot-delivery/v1",
    token:proof.token,verifierSha256:proof.challenge.verifierSha256}));
  return {input,row,ciphertext};
}
describe("private first-boot ledger adapter",()=>{
  const originalKey = process.env.ENCRYPTION_KEY;
  beforeAll(()=>{process.env.ENCRYPTION_KEY="67".repeat(32);});
  afterAll(()=>{
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY=originalKey;
  });
  beforeEach(()=>{
    mockRpc.mockReset(); mockQuery.select.mockReset().mockReturnValue(mockQuery);
    mockQuery.eq.mockReset().mockReturnValue(mockQuery); mockQuery.maybeSingle.mockReset();
    jest.mocked(decryptSecret).mockClear();
  });
  it("seals delivery and passes the precise confirmed binding to the atomic stage RPC",async()=>{
    const {input,row} = fixture();
    mockRpc.mockImplementation(async(_name,params)=>({data:{outcome:"staged",
      record:{...row,encrypted_token:params.p_encrypted_token}},error:null}));
    const result = await stageFirstBootEnrollment(input);
    expect(result?.delivery).toEqual({token:input.token,challenge:input.challenge});
    const [name,params] = mockRpc.mock.calls[0];
    expect(name).toBe("stage_hetzner_first_boot");
    expect(params).toMatchObject({p_user_id:binding.userId,p_connection_id:binding.connectionId,
      p_revision:7,p_order_id:binding.orderId,p_attempt_id:binding.attemptId,p_capacity_key:capacityKey,
      p_quote_fingerprint:binding.quoteFingerprint,p_recipe_version:FIRST_BOOT_RECIPE_VERSION,
      p_confirmation:FIRST_BOOT_PREPARATION_CONFIRMATION});
    expect(JSON.stringify(params)).not.toContain(input.token);
    expect(JSON.stringify(result?.record)).not.toContain(input.token);
    expect(JSON.stringify(result?.record)).not.toContain(params.p_encrypted_token);
  });
  it("replays the original stored encrypted capability and refuses a mismatched delivery envelope",async()=>{
    const {input,row,ciphertext} = fixture();
    mockRpc.mockResolvedValue({data:{outcome:"staged",record:{...row,encrypted_token:ciphertext}},error:null});
    await expect(stageFirstBootEnrollment(input)).resolves.toMatchObject({delivery:{token:input.token}});
    const other = fixture();
    mockRpc.mockResolvedValue({data:{outcome:"staged",record:{...row,encrypted_token:other.ciphertext}},error:null});
    await expect(stageFirstBootEnrollment(input)).rejects.toThrow("invalid_delivery");
  });
  it("checks consent and proof before any database mutation",async()=>{
    const {input} = fixture();
    await expect(stageFirstBootEnrollment({...input,confirmation:"billing only" as never})).rejects.toThrow("invalid_delivery");
    await expect(stageFirstBootEnrollment({...input,token:"hbe1_"+"x".repeat(43)})).rejects.toThrow("invalid_proof");
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it("passive enrollment lookup excludes and never decrypts any delivery or provider secret",async()=>{
    const {row,ciphertext} = fixture();
    mockQuery.maybeSingle.mockResolvedValue({data:{...row,encrypted_token:ciphertext},error:null});
    const result = await loadFirstBootEnrollment(binding.orderId,binding.attemptId);
    expect(mockQuery.select.mock.calls[0][0]).not.toMatch(/encrypted|private|api_token/);
    expect(jest.mocked(decryptSecret)).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(ciphertext);
    expect(mockQuery.eq.mock.calls).toEqual([["order_id",binding.orderId],["attempt_id",binding.attemptId]]);
  });
  it("does not query malformed identifiers or expose database errors",async()=>{
    expect(await loadFirstBootEnrollment("not-a-uuid",binding.attemptId)).toBeNull();
    expect(mockQuery.select).not.toHaveBeenCalled();
    mockQuery.maybeSingle.mockResolvedValue({data:null,error:{message:"secret-database-details"}});
    await expect(loadFirstBootEnrollment(binding.orderId,binding.attemptId)).rejects.toThrow("First-boot storage failed: database_error");
  });
  it("discovers the original attempt using the entire owner, quote and capacity-key scope without secrets",async()=>{
    const {row}=fixture();mockQuery.maybeSingle.mockResolvedValue({data:row,error:null});
    const {attemptId:ignored,...orderBinding}=binding;void ignored;
    const scope={binding:orderBinding,capacityIdempotencyKey:capacityKey};
    expect((await loadFirstBootEnrollmentForOrder(scope))?.challenge.binding.attemptId).toBe(binding.attemptId);
    expect(mockQuery.eq.mock.calls).toEqual([["user_id",binding.userId],["connection_id",binding.connectionId],
      ["connection_revision",7],["order_id",binding.orderId],["quote_fingerprint_sha256",binding.quoteFingerprint],
      ["recipe_version",binding.recipeVersion],["capacity_idempotency_key",capacityKey]]);
    expect(mockQuery.select.mock.calls[0][0]).not.toMatch(/encrypted|private|api_token/);
    expect(jest.mocked(decryptSecret)).not.toHaveBeenCalled();
    for(const changed of [{user_id:"foreign"},{connection_revision:8},{quote_fingerprint_sha256:"b".repeat(64)},
      {capacity_idempotency_key:binding.attemptId}]) {
      mockQuery.maybeSingle.mockResolvedValue({data:{...row,...changed},error:null});
      await expect(loadFirstBootEnrollmentForOrder(scope)).rejects.toThrow("invalid_record");
    }
  });
  it("admits only an exact recipe expectation through the separate server POST RPC",async()=>{
    const expected={attemptId:binding.attemptId,recipeVersion:binding.recipeVersion,verifierSha256:"b".repeat(64)};
    const input={userId:binding.userId,connectionId:binding.connectionId,expectedRevision:7,orderId:binding.orderId,
      idempotencyKey:capacityKey,providerSshKeyId:"77",attemptedAt:now.toISOString(),expectedEnrollment:expected};
    mockRpc.mockResolvedValue({data:true,error:null});
    expect(await markFirstBootServerPostAttempted(input)).toBe(true);
    expect(mockRpc).toHaveBeenCalledWith("mark_hetzner_server_post_for_recipe",{
      p_user_id:binding.userId,p_connection_id:binding.connectionId,p_expected_revision:7,p_order_id:binding.orderId,
      p_idempotency_key:capacityKey,p_provider_ssh_key_id:"77",p_attempted_at:now.toISOString(),p_expected_enrollment:expected});
    mockRpc.mockClear();
    await expect(markFirstBootServerPostAttempted({...input,expectedEnrollment:{...expected,extra:true} as never})).rejects.toThrow("invalid_record");
    expect(mockRpc).not.toHaveBeenCalled();mockRpc.mockResolvedValue({data:null,error:null});
    await expect(markFirstBootServerPostAttempted(input)).rejects.toThrow("database_error");
  });
  it("recovery is scoped and refuses consumed, revoked, expired or foreign-owner delivery",async()=>{
    const {row,ciphertext} = fixture();
    const input = {binding,capacityIdempotencyKey:capacityKey,now};
    mockQuery.maybeSingle.mockResolvedValue({data:{...row,encrypted_token:ciphertext},error:null});
    await expect(loadStagedFirstBootDelivery(input)).resolves.toMatchObject({challenge:{binding}});
    expect(mockQuery.eq.mock.calls).toContainEqual(["user_id",binding.userId]);
    expect(mockQuery.eq.mock.calls).toContainEqual(["connection_revision",7]);
    for(const change of [{phase:"revoked",encrypted_token:null},{phase:"failed",encrypted_token:null},
      {user_id:"different-owner"},{capacity_idempotency_key:binding.attemptId}]) {
      mockQuery.maybeSingle.mockResolvedValue({data:{...row,encrypted_token:ciphertext,...change},error:null});
      await expect(loadStagedFirstBootDelivery(input)).rejects.toThrow();
    }
    mockQuery.maybeSingle.mockResolvedValue({data:{...row,encrypted_token:ciphertext},error:null});
    await expect(loadStagedFirstBootDelivery({...input,now:new Date(now.getTime()+900_000)})).rejects.toThrow("invalid_delivery");
  });
  it("rejects inconsistent private records",async()=>{
    const {row} = fixture();
    for (const change of [{phase:"enrolled"},{host_fingerprint_sha256:"SHA256:wrong"},
      {phase:"awaiting_identity",provider_server_id:null},{provider_server_id:"42"}]) {
      mockQuery.maybeSingle.mockResolvedValue({data:{...row,...change},error:null});
      await expect(loadFirstBootEnrollment(binding.orderId,binding.attemptId)).rejects.toThrow("invalid_record");
    }
  });
  it("passes public pin evidence to atomic consumption, with no token decryption",async()=>{
    const host = canonicalFirstBootHostKey(publicKey);
    mockRpc.mockResolvedValue({data:"enrolled",error:null});
    expect(await consumeFirstBootEnrollment({binding,providerServerId:"42",verifierSha256:"b".repeat(64),
      hostPublicKey:host.publicKey,hostFingerprintSha256:host.fingerprintSha256,providerObservedAt:now})).toBe("enrolled");
    expect(mockRpc.mock.calls[0]).toEqual(["consume_hetzner_first_boot",{
      p_user_id:binding.userId,p_connection_id:binding.connectionId,p_revision:7,p_order_id:binding.orderId,
      p_attempt_id:binding.attemptId,p_server_id:"42",p_verifier:"b".repeat(64),
      p_host_key:host.publicKey,p_host_fingerprint:host.fingerprintSha256,p_provider_observed_at:now.toISOString(),
    }]);
    expect(jest.mocked(decryptSecret)).not.toHaveBeenCalled();
  });
});

import { receiveFirstBootEnrollment,loadFirstBootCapacityEvidence } from "../first-boot-receiver";
import { InfrastructureConnectionStoreError } from "../connection-store";
import { receiverFixture,firstBootNow } from "./first-boot-receiver.fixtures";
import { isProtectedPath } from "@/lib/protected-routes";
const mockQuery = {select:jest.fn(),eq:jest.fn(),maybeSingle:jest.fn()};
jest.mock("@/lib/supabase",()=>({supabaseAdmin:{from:jest.fn(()=>mockQuery)}}));

function setup(recipe: Parameters<typeof receiverFixture>[0] = "legacy") {
  const f = receiverFixture(recipe);
  const getServer = jest.fn().mockResolvedValue(f.server);
  const getAction = jest.fn().mockResolvedValue(f.action);
  const deps = {
    load:jest.fn().mockResolvedValue(f.stored),evidence:jest.fn().mockResolvedValue(f.evidence),
    secret:jest.fn().mockResolvedValue({connection:{id:f.binding.connectionId,status:"ready"},revision:7,apiToken:"explicit-project-token"}),
    client:jest.fn(()=>({getServer,getAction})),consume:jest.fn().mockResolvedValue("enrolled"),
    admit:jest.fn(()=>true),now:jest.fn(()=>firstBootNow),
  };
  return {...f,deps,getServer,getAction};
}
it("consumes only scoped proof plus the fresh exact provider server and creation action",async()=>{
  const f = setup();
  expect(await receiveFirstBootEnrollment(f.input,f.deps)).toEqual({version:1,accepted:true,
    orderId:f.binding.orderId,attemptId:f.binding.attemptId,hostFingerprintSha256:f.host.fingerprintSha256});
  expect(f.deps.secret).toHaveBeenCalledWith("owner",f.binding.connectionId,{requireBoundToken:true});
  expect(f.deps.client).toHaveBeenCalledWith("explicit-project-token");
  expect(f.getServer).toHaveBeenCalledWith(42);expect(f.getAction).toHaveBeenCalledWith(500);
  expect(f.deps.consume).toHaveBeenCalledWith({binding:f.binding,providerServerId:"42",
    verifierSha256:f.proof.challenge.verifierSha256,hostPublicKey:f.host.publicKey,
    hostFingerprintSha256:f.host.fingerprintSha256,providerObservedAt:firstBootNow});
  expect(isProtectedPath("/api/infrastructure/first-boot/enroll")).toBe(false);
});
it("rejects invalid proof before metadata, token decryption, rate budget or provider access",async()=>{
  for (const change of [{token:"bad"},{token:"hbe1_"+"x".repeat(43)},
    {registration:{}},{registration:{...receiverFixture().input.registration,providerServerId:"43"}}]) {
    const f = setup();
    await expect(receiveFirstBootEnrollment({...f.input,...change},f.deps)).rejects.toMatchObject({code:"rejected"});
    expect(f.deps.evidence).not.toHaveBeenCalled();expect(f.deps.secret).not.toHaveBeenCalled();
    expect(f.deps.client).not.toHaveBeenCalled();expect(f.deps.admit).not.toHaveBeenCalled();
  }
});
it.each([false,true])("accepts the exact quoted source image in creation evidence, reversed=%s",async reverse=>{
  const f=setup();
  const resources=[...f.action.resources,{id:f.evidence.quote_snapshot.image.id,type:"image"}];
  f.getAction.mockResolvedValue({...f.action,resources:reverse?resources.reverse():resources});
  expect(await receiveFirstBootEnrollment(f.input,f.deps)).toMatchObject({accepted:true});
  expect(f.deps.consume).toHaveBeenCalledTimes(1);
});
it.each(["wrong-image","duplicate-image","duplicate-server","unknown-type","image-only"])("rejects %s creation resources before pinning",async kind=>{
  const f=setup();
  const image={id:f.evidence.quote_snapshot.image.id,type:"image"};
  const resources=kind==="wrong-image"?[...f.action.resources,{...image,id:image.id+1}]
    :kind==="duplicate-image"?[...f.action.resources,image,image]
      :kind==="duplicate-server"?[...f.action.resources,...f.action.resources]
        :kind==="unknown-type"?[...f.action.resources,{id:77,type:"primary_ip"}]:[image];
  f.getAction.mockResolvedValue({...f.action,resources});
  await expect(receiveFirstBootEnrollment(f.input,f.deps)).rejects.toMatchObject({code:"rejected"});
  expect(f.deps.consume).not.toHaveBeenCalled();
});
it.each(["staged","revoked","failed"])("refuses %s enrollment without provider access",async phase=>{
  const f=setup();f.deps.load.mockResolvedValue({...f.stored,phase});
  await expect(receiveFirstBootEnrollment(f.input,f.deps)).rejects.toMatchObject({code:"rejected"});
  expect(f.deps.secret).not.toHaveBeenCalled();
});
it.each([
  ["user_id","another-owner"],["connection_revision",8],["active_connection_id",null],["status","cleaning"],
  ["provider_resource_id","43"],["provider_action_id","501"],["quote_fingerprint_sha256","b".repeat(64)],
  ["provider_creation_receipt",null],["provider_server_status","ambiguous"],
])("refuses changed capacity %s before reading the project credential",async(field,value)=>{
  const f=setup();f.deps.evidence.mockResolvedValue({...f.evidence,[field]:value});
  await expect(receiveFirstBootEnrollment(f.input,f.deps)).rejects.toMatchObject({code:"rejected"});
  expect(f.deps.secret).not.toHaveBeenCalled();expect(f.deps.consume).not.toHaveBeenCalled();
});
it.each([
  ["foreign server",(f:ReturnType<typeof setup>)=>{f.server.id=43;}],
  ["powered-off server",(f:ReturnType<typeof setup>)=>{f.server.status="off";}],
  ["unrelated IPv4",(f:ReturnType<typeof setup>)=>{f.server.public_net.ipv4!.id=90;}],
  ["changed IPv6",(f:ReturnType<typeof setup>)=>{f.server.public_net.ipv6!.ip="2001:db8:1::/64";}],
  ["floating IP",(f:ReturnType<typeof setup>)=>{f.server.public_net.floating_ips=[88];}],
  ["attached ISO",(f:ReturnType<typeof setup>)=>{f.server.iso={id:91};}],
  ["changed image",(f:ReturnType<typeof setup>)=>{f.server.image!.id=200;}],
  ["changed labels",(f:ReturnType<typeof setup>)=>{f.server.labels={};}],
  ["unrelated action",(f:ReturnType<typeof setup>)=>{f.action.id=501;}],
  ["wrong action command",(f:ReturnType<typeof setup>)=>{f.action.command="poweron";}],
  ["failed action",(f:ReturnType<typeof setup>)=>{f.getAction.mockResolvedValue({...f.action,status:"error"});}],
  ["action affects other resource",(f:ReturnType<typeof setup>)=>{f.action.resources.push({id:43,type:"server"});}],
])("does not pin from %s",async(_label,change)=>{
  const f=setup();change(f);
  await expect(receiveFirstBootEnrollment(f.input,f.deps)).rejects.toMatchObject({code:"rejected"});
  expect(f.deps.consume).not.toHaveBeenCalled();
});
it("rechecks expired or revoked proof across provider I/O and final transaction",async()=>{
  const f=setup();f.deps.now.mockReturnValueOnce(firstBootNow).mockReturnValueOnce(firstBootNow)
    .mockReturnValue(new Date(firstBootNow.getTime()+900_000));
  await expect(receiveFirstBootEnrollment(f.input,f.deps)).rejects.toMatchObject({code:"rejected"});
  expect(f.deps.consume).not.toHaveBeenCalled();
  for (const result of ["rejected","identity_changed"]) {
    const other=setup();other.deps.consume.mockResolvedValue(result);
    await expect(receiveFirstBootEnrollment(other.input,other.deps)).rejects.toMatchObject({code:"rejected"});
  }
});
it("retries only intact transient provider states and never consumes before stable identity",async()=>{
  for (const transient of ["starting","initializing","locked","action_running"]) {
    const f=setup();
    if (transient === "locked") f.server.locked=true;
    else if (transient === "action_running") f.getAction.mockResolvedValue({...f.action,status:"running"});
    else f.server.status=transient as "starting"|"initializing";
    await expect(receiveFirstBootEnrollment(f.input,f.deps)).rejects.toMatchObject({code:"unavailable"});
    expect(f.deps.consume).not.toHaveBeenCalled();
    f.server.status="running";f.server.locked=false;f.getAction.mockResolvedValue(f.action);
    expect(await receiveFirstBootEnrollment(f.input,f.deps)).toMatchObject({accepted:true});
  }
  const changed=setup();changed.server.locked=true;changed.server.volumes=[9];
  await expect(receiveFirstBootEnrollment(changed.input,changed.deps)).rejects.toMatchObject({code:"rejected"});
  expect(changed.deps.consume).not.toHaveBeenCalled();
  const wrongQuote=setup();wrongQuote.evidence.quote_snapshot.connectionRevision=8;
  await expect(receiveFirstBootEnrollment(wrongQuote.input,wrongQuote.deps)).rejects.toMatchObject({code:"rejected"});
  expect(wrongQuote.deps.secret).not.toHaveBeenCalled();
});
it("only acknowledges an identical pinned key and revalidates provider/transaction on replay",async()=>{
  const f=setup();f.deps.load.mockResolvedValue({...f.stored,phase:"enrolled",enrolledHostPublicKey:f.host.publicKey,
    hostFingerprintSha256:f.host.fingerprintSha256});
  f.deps.consume.mockResolvedValue("acknowledgement_replay");
  expect(await receiveFirstBootEnrollment(f.input,f.deps)).toMatchObject({accepted:true});
  expect(f.getServer).toHaveBeenCalledTimes(1);expect(f.deps.consume).toHaveBeenCalledTimes(1);
  f.deps.load.mockResolvedValue({...f.stored,phase:"enrolled",enrolledHostPublicKey:"another-key"});
  await expect(receiveFirstBootEnrollment(f.input,f.deps)).rejects.toMatchObject({code:"rejected"});
  expect(f.getServer).toHaveBeenCalledTimes(1);
});
it("keeps hard refusals dominant when transient provider state is also present",async()=>{
  for(const change of [
    (f:ReturnType<typeof setup>)=>{f.server.status="starting";f.action.resources=[{id:43,type:"server"}];},
    (f:ReturnType<typeof setup>)=>{f.server.locked=true;f.getAction.mockResolvedValue({...f.action,status:"error"});},
    (f:ReturnType<typeof setup>)=>{f.server.status="off";f.server.locked=true;},
    (f:ReturnType<typeof setup>)=>{f.server.locked=true;f.deps.now.mockReturnValueOnce(firstBootNow)
      .mockReturnValueOnce(firstBootNow).mockReturnValue(new Date(firstBootNow.getTime()+900_000));},
  ]) {
    const f=setup();change(f);
    await expect(receiveFirstBootEnrollment(f.input,f.deps)).rejects.toMatchObject({code:"rejected"});
    expect(f.deps.consume).not.toHaveBeenCalled();
  }
});
it("refuses changed or removed project credentials; never uses the ambient token",async()=>{
  for(const current of [{connection:{id:"foreign",status:"ready"},revision:7},
    {connection:{id:receiverFixture().binding.connectionId,status:"ready"},revision:8}]) {
    const f=setup();f.deps.secret.mockResolvedValue({...current,apiToken:"must-not-use"});
    await expect(receiveFirstBootEnrollment(f.input,f.deps)).rejects.toMatchObject({code:"rejected"});
    expect(f.deps.client).not.toHaveBeenCalled();
  }
  const f=setup();f.deps.secret.mockRejectedValue(new InfrastructureConnectionStoreError("not_found"));
  await expect(receiveFirstBootEnrollment(f.input,f.deps)).rejects.toMatchObject({code:"rejected"});
  expect(f.deps.client).not.toHaveBeenCalled();
});
it("limits proved attempts before provider access and returns only sanitized failures",async()=>{
  const f=setup();f.deps.admit.mockReturnValue(false);
  await expect(receiveFirstBootEnrollment(f.input,f.deps)).rejects.toMatchObject({code:"rate_limited"});
  expect(f.deps.secret).not.toHaveBeenCalled();
  f.deps.admit.mockReturnValue(true);f.getServer.mockRejectedValue(new Error("reflected token and provider secrets"));
  await expect(receiveFirstBootEnrollment(f.input,f.deps)).rejects.toThrow("First-boot enrollment unavailable");
  expect(f.deps.consume).not.toHaveBeenCalled();
});
it("reads exact owner/revision metadata without selecting private key or token ciphertext",async()=>{
  const f=setup();mockQuery.select.mockReturnValue(mockQuery);mockQuery.eq.mockReturnValue(mockQuery);
  mockQuery.maybeSingle.mockResolvedValue({data:{...f.evidence,encrypted_bootstrap_bundle:"must-not-return"},error:null});
  expect(await loadFirstBootCapacityEvidence(f.binding)).toEqual(f.evidence);
  expect(mockQuery.select.mock.calls[0][0]).not.toMatch(/encrypted|token|private_key/);
  expect(mockQuery.eq.mock.calls).toEqual([["id",f.binding.orderId],["user_id","owner"],
    ["connection_id",f.binding.connectionId],["active_connection_id",f.binding.connectionId],["connection_revision",7]]);
  mockQuery.maybeSingle.mockResolvedValue({data:null,error:null});expect(await loadFirstBootCapacityEvidence(f.binding)).toBeNull();
  mockQuery.maybeSingle.mockResolvedValue({data:null,error:{message:"private database error"}});
  await expect(loadFirstBootCapacityEvidence(f.binding)).rejects.toThrow("database_error");
});

describe("current recipe: Hivra accepts the proof only inside the window it opened at Start setup",()=>{
  it("refuses an unarmed challenge before metadata, credentials, rate budget or provider access",async()=>{
    const f=setup("unarmed");
    await expect(receiveFirstBootEnrollment(f.input,f.deps)).rejects.toMatchObject({code:"rejected"});
    expect(f.deps.admit).not.toHaveBeenCalled();expect(f.deps.evidence).not.toHaveBeenCalled();
    expect(f.deps.secret).not.toHaveBeenCalled();expect(f.deps.client).not.toHaveBeenCalled();
    expect(f.deps.consume).not.toHaveBeenCalled();
  });
  it("consumes a proof from a server started hours after it was created",async()=>{
    const f=setup("armed");
    expect(Date.parse(f.stored.challenge.expiresAt)).toBeLessThan(firstBootNow.getTime());
    expect(await receiveFirstBootEnrollment(f.input,f.deps)).toEqual({version:1,accepted:true,
      orderId:f.binding.orderId,attemptId:f.binding.attemptId,hostFingerprintSha256:f.host.fingerprintSha256});
    expect(f.deps.consume).toHaveBeenCalledWith(expect.objectContaining({binding:f.binding,providerServerId:"42"}));
  });
  it("refuses once the armed window has passed, including across provider I/O",async()=>{
    const closes=Date.parse(receiverFixture("armed").stored.armedExpiresAt!);
    const late=setup("armed");late.deps.now.mockReturnValue(new Date(closes));
    await expect(receiveFirstBootEnrollment(late.input,late.deps)).rejects.toMatchObject({code:"rejected"});
    expect(late.deps.secret).not.toHaveBeenCalled();
    const during=setup("armed");during.deps.now.mockReturnValueOnce(firstBootNow).mockReturnValueOnce(firstBootNow)
      .mockReturnValue(new Date(closes));
    await expect(receiveFirstBootEnrollment(during.input,during.deps)).rejects.toMatchObject({code:"rejected"});
    expect(during.deps.consume).not.toHaveBeenCalled();
  });
});

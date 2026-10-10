import { createFirstBootChallenge, FIRST_BOOT_LEGACY_RECIPE_VERSION, FIRST_BOOT_RECIPE_VERSION } from "../first-boot-enrollment";
import { resolveFirstBootCreationRecipe } from "../first-boot-creation-recipe";
import { FIRST_BOOT_PREPARATION_CONFIRMATION, type StoredFirstBootEnrollment } from "../first-boot-store";

const now=new Date("2026-08-27T12:00:00.000Z");
const attempt="33333333-3333-4333-8333-333333333333";
const scope={binding:{userId:"owner",connectionId:"11111111-1111-4111-8111-111111111111",connectionRevision:7,
  orderId:"22222222-2222-4222-8222-222222222222",quoteFingerprint:"a".repeat(64),recipeVersion:FIRST_BOOT_RECIPE_VERSION},
capacityIdempotencyKey:"44444444-4444-4444-8444-444444444444"};
const input={...scope,confirmation:FIRST_BOOT_PREPARATION_CONFIRMATION,callbackOrigin:"https://canary.hermesos.cloud",
  publicKeyOpenSsh:"ssh-ed25519 "+Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020","hex"),Buffer.alloc(32,1)]).toString("base64")};
function fixture() {
  const proof=createFirstBootChallenge({...scope.binding,attemptId:attempt},now);
  const record:StoredFirstBootEnrollment={challenge:proof.challenge,phase:"staged",capacityIdempotencyKey:scope.capacityIdempotencyKey,
    providerServerId:null,enrolledHostPublicKey:null,hostFingerprintSha256:null,armedAt:null,armedExpiresAt:null};
  const deps={now:()=>now,newAttemptId:jest.fn(()=>attempt),load:jest.fn().mockResolvedValue(record),
    delivery:jest.fn().mockResolvedValue(proof),stage:jest.fn(),render:jest.fn().mockResolvedValue("fixture-user-data")};
  return {proof,record,deps};
}

describe("confirmed original first-boot creation recipe",()=>{
  it("stages one fresh capability and returns its exact admission expectation, never a token DTO",async()=>{
    const f=fixture();f.deps.load.mockResolvedValue(null);
    f.deps.stage.mockImplementation(async args=>({record:{...f.record,challenge:args.challenge},
      delivery:{token:args.token,challenge:args.challenge}}));
    const result=await resolveFirstBootCreationRecipe(input,f.deps);
    expect(f.deps.stage).toHaveBeenCalledTimes(1);expect(f.deps.delivery).not.toHaveBeenCalled();
    expect(f.deps.stage).toHaveBeenCalledWith(expect.objectContaining({binding:{...scope.binding,attemptId:attempt},
      confirmation:FIRST_BOOT_PREPARATION_CONFIRMATION,capacityIdempotencyKey:scope.capacityIdempotencyKey}));
    // The delivery deadline bounds only the server request; enrollment opens at Start setup.
    expect(result).toEqual({userData:"fixture-user-data",deliveryExpiresAt:f.record.challenge.expiresAt,
      expectedEnrollment:{attemptId:attempt,recipeVersion:FIRST_BOOT_RECIPE_VERSION,
        verifierSha256:f.deps.stage.mock.calls[0][0].challenge.verifierSha256}});
    expect(JSON.stringify(result.expectedEnrollment)).not.toContain(f.deps.stage.mock.calls[0][0].token);
  });
  it("looks up and renders only the current recipe; an attempt staged under the legacy one fails closed",async()=>{
    const f=fixture();await resolveFirstBootCreationRecipe(input,f.deps);
    expect(f.deps.load.mock.calls[0][0].binding.recipeVersion).toBe(FIRST_BOOT_RECIPE_VERSION);
    const legacy=fixture();
    legacy.record.challenge.binding.recipeVersion=FIRST_BOOT_LEGACY_RECIPE_VERSION;
    await expect(resolveFirstBootCreationRecipe(input,legacy.deps)).rejects.toMatchObject({code:"invalid_record"});
    expect(legacy.deps.render).not.toHaveBeenCalled();expect(legacy.deps.stage).not.toHaveBeenCalled();
  });
  it("refuses to create with any recipe but the current one, before loading anything",async()=>{
    const f=fixture();
    await expect(resolveFirstBootCreationRecipe({...input,binding:{...scope.binding,recipeVersion:FIRST_BOOT_LEGACY_RECIPE_VERSION}} as never,f.deps))
      .rejects.toMatchObject({code:"invalid_record"});
    expect(f.deps.load).not.toHaveBeenCalled();expect(f.deps.stage).not.toHaveBeenCalled();
  });
  it("reuses the original staged capability without generating or staging a replacement",async()=>{
    const f=fixture();await resolveFirstBootCreationRecipe(input,f.deps);
    expect(f.deps.newAttemptId).not.toHaveBeenCalled();expect(f.deps.stage).not.toHaveBeenCalled();
    expect(f.deps.delivery).toHaveBeenCalledWith({binding:f.record.challenge.binding,capacityIdempotencyKey:scope.capacityIdempotencyKey,now});
    expect(f.deps.render).toHaveBeenCalledWith(expect.objectContaining({...f.proof,currentBinding:f.record.challenge.binding,
      callbackOrigin:input.callbackOrigin,publicKeyOpenSsh:input.publicKeyOpenSsh}));
  });
  it("uses the one concurrent staging winner without retrying a losing stage",async()=>{
    const f=fixture();f.deps.load.mockResolvedValueOnce(null).mockResolvedValueOnce(f.record);f.deps.stage.mockResolvedValue(null);
    await resolveFirstBootCreationRecipe(input,f.deps);
    expect(f.deps.load).toHaveBeenCalledTimes(2);expect(f.deps.stage).toHaveBeenCalledTimes(1);
    expect(f.deps.render.mock.calls[0][0].token).toBe(f.proof.token);
  });
  it("does not loop or render when a rejected stage has no original winner",async()=>{
    const f=fixture();f.deps.load.mockResolvedValue(null);f.deps.stage.mockResolvedValue(null);
    await expect(resolveFirstBootCreationRecipe(input,f.deps)).rejects.toMatchObject({code:"not_active"});
    expect(f.deps.load).toHaveBeenCalledTimes(2);expect(f.deps.stage).toHaveBeenCalledTimes(1);
    expect(f.deps.render).not.toHaveBeenCalled();
  });
  it("does not stage or load anything without separate preparation consent",async()=>{
    const f=fixture();await expect(resolveFirstBootCreationRecipe({...input,confirmation:"Create server and start billing" as never},f.deps))
      .rejects.toMatchObject({code:"invalid_delivery"});
    expect(f.deps.load).not.toHaveBeenCalled();expect(f.deps.stage).not.toHaveBeenCalled();
  });
  it.each(["revoked","failed","awaiting_identity","enrolled"] as const)("does not reuse a %s attempt",async phase=>{
    const f=fixture();f.deps.load.mockResolvedValue({...f.record,phase});
    await expect(resolveFirstBootCreationRecipe(input,f.deps)).rejects.toMatchObject({code:"not_active"});
    expect(f.deps.delivery).not.toHaveBeenCalled();expect(f.deps.stage).not.toHaveBeenCalled();expect(f.deps.render).not.toHaveBeenCalled();
  });
  it("rejects a foreign owner, key or delivery even if a persistence adapter returns one",async()=>{
    for(const field of ["owner","key","proof"]) {
      const f=fixture();
      if(field==="owner") f.record.challenge.binding.userId="foreign";
      if(field==="key") f.record.capacityIdempotencyKey=attempt;
      if(field==="proof") f.deps.delivery.mockResolvedValue(createFirstBootChallenge({...scope.binding,attemptId:attempt},now));
      await expect(resolveFirstBootCreationRecipe(input,f.deps)).rejects.toMatchObject({code:"invalid_record"});
      expect(f.deps.render).not.toHaveBeenCalled();expect(f.deps.stage).not.toHaveBeenCalled();
    }
  });
  it("does not regenerate an expired capability, including expiry during rendering",async()=>{
    for(const duringRender of [false,true]) {
      const f=fixture();let clock=now;f.deps.now=()=>clock;
      if(duringRender) f.deps.render.mockImplementation(async()=>{clock=new Date(now.getTime()+900_000);return "too-late";});
      else clock=new Date(now.getTime()+900_000);
      await expect(resolveFirstBootCreationRecipe(input,f.deps)).rejects.toMatchObject({code:"expired"});
      expect(f.deps.stage).not.toHaveBeenCalled();expect(f.deps.newAttemptId).not.toHaveBeenCalled();
      expect(f.deps.render).toHaveBeenCalledTimes(duringRender?1:0);
    }
  });
});

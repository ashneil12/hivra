import "server-only";

import { randomUUID } from "node:crypto";
import { createFirstBootChallenge, verifyFirstBootChallengeSecret } from "./first-boot-enrollment";
import { renderFirstBootCloudInit } from "./first-boot-cloud-init";
import {
  FIRST_BOOT_PREPARATION_CONFIRMATION, FirstBootRecipeExpectationSchema, FirstBootStoreError,
  loadFirstBootEnrollmentForOrder, loadStagedFirstBootDelivery, stageFirstBootEnrollment,
  type FirstBootCreationScope, type FirstBootRecipeExpectation,
} from "./first-boot-store";

type Dependencies = {
  now:()=>Date;
  newAttemptId:()=>string;
  load:typeof loadFirstBootEnrollmentForOrder;
  delivery:typeof loadStagedFirstBootDelivery;
  stage:typeof stageFirstBootEnrollment;
  render:typeof renderFirstBootCloudInit;
};
const defaults:Dependencies={now:()=>new Date(),newAttemptId:randomUUID,load:loadFirstBootEnrollmentForOrder,
  delivery:loadStagedFirstBootDelivery,stage:stageFirstBootEnrollment,render:renderFirstBootCloudInit};

/** Private fresh-creation recipe. Reuses the original short-lived capability
 * after a lost acknowledgement; never rotates an expired or competing attempt.
 * The caller must pass trusted deployment configuration for callbackOrigin,
 * then atomically admit this exact expectation before any server POST.
 * No provider token/model key, purchase, power-on or readiness is involved.
 */
export async function resolveFirstBootCreationRecipe(input:FirstBootCreationScope & {
  confirmation:typeof FIRST_BOOT_PREPARATION_CONFIRMATION;
  publicKeyOpenSsh:string;callbackOrigin:string;
},dependencies:Partial<Dependencies>={}):Promise<{userData:string;expectedEnrollment:FirstBootRecipeExpectation;enrollmentExpiresAt:string}> {
  if(input.confirmation!==FIRST_BOOT_PREPARATION_CONFIRMATION) throw new FirstBootStoreError("invalid_delivery");
  const {confirmation,publicKeyOpenSsh,callbackOrigin}=input;
  const deps={...defaults,...dependencies};
  const scope={binding:{...input.binding},capacityIdempotencyKey:input.capacityIdempotencyKey};
  let stored=await deps.load(scope);
  let delivery:Awaited<ReturnType<typeof loadStagedFirstBootDelivery>>;
  if(!stored) {
    const binding={...scope.binding,attemptId:deps.newAttemptId()};
    const now=deps.now(),proof=createFirstBootChallenge(binding,now);
    const staged=await deps.stage({...scope,...proof,binding,confirmation,now});
    if(staged) {
      stored=staged.record;
      delivery=staged.delivery;
    } else {
      // One competing stage may have won. Read its exact original record once;
      // absence/revocation/expiry fails closed, not another stage attempt.
      stored=await deps.load(scope);
      if(!stored) throw new FirstBootStoreError("not_active");
      delivery=await deps.delivery({binding:stored.challenge.binding,capacityIdempotencyKey:scope.capacityIdempotencyKey,now:deps.now()});
    }
  } else {
    if(stored.phase!=="staged") throw new FirstBootStoreError("not_active");
    delivery=await deps.delivery({binding:stored.challenge.binding,capacityIdempotencyKey:scope.capacityIdempotencyKey,now:deps.now()});
  }
  if(stored.phase!=="staged" || stored.capacityIdempotencyKey!==scope.capacityIdempotencyKey
    || Object.entries(scope.binding).some(([key,value])=>stored.challenge.binding[key as keyof typeof scope.binding]!==value)
    || delivery.challenge.verifierSha256!==stored.challenge.verifierSha256) {
    throw new FirstBootStoreError("invalid_record");
  }
  const binding={...scope.binding,attemptId:stored.challenge.binding.attemptId};
  verifyFirstBootChallengeSecret({...delivery,currentBinding:binding,now:deps.now()});
  const userData=await deps.render({...delivery,currentBinding:binding,publicKeyOpenSsh,callbackOrigin,now:deps.now()});
  // A slow renderer may not return an already-expired delivery for dispatch.
  verifyFirstBootChallengeSecret({...delivery,currentBinding:binding,now:deps.now()});
  return {userData,enrollmentExpiresAt:stored.challenge.expiresAt,expectedEnrollment:FirstBootRecipeExpectationSchema.parse({attemptId:binding.attemptId,
    verifierSha256:stored.challenge.verifierSha256,recipeVersion:binding.recipeVersion})};
}

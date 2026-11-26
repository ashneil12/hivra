import { auth } from "@clerk/nextjs/server";

import {
  createCanaryQaClassicStart,
  loadCanaryQaClassicStartConfig,
  readClassicStartOperationId,
} from "@/lib/hivra/canary-qa-classic-start";

const CANARY_ORIGIN = "https://canary.hermesos.cloud";

function json(status: number, body: object) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  const config = loadCanaryQaClassicStartConfig();
  if (!config) return json(404, { error: "not_found" });

  const url = new URL(request.url);
  const fetchSite = request.headers.get("sec-fetch-site");
  if (url.origin !== CANARY_ORIGIN || request.headers.get("origin") !== CANARY_ORIGIN
    || (fetchSite !== null && fetchSite !== "same-origin")) {
    return json(403, { error: "origin_denied" });
  }
  let userId: string | null;
  try {
    ({ userId } = await auth());
  } catch {
    return json(401, { error: "unauthorized" });
  }
  if (!userId) return json(401, { error: "unauthorized" });
  if (userId !== config.ownerId) return json(403, { error: "owner_denied" });

  const operationId = url.search ? null : await readClassicStartOperationId(request);
  if (!operationId) return json(400, { error: "invalid_operation" });

  const result = await createCanaryQaClassicStart(config)(operationId);
  return json(result.status === "settled" ? 200 : 409, result);
}

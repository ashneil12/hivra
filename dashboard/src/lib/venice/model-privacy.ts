/**
 * Which Venice models get the "Private" badge. Venice marks every model as
 * private, e2ee_private or anonymized. Private and end-to-end private models
 * are not kept by Venice. Anonymized models (Claude, GPT and the like) pass
 * through a third-party provider, so they never get the badge.
 */
import { VENICE_CHAT_MODEL_PRICES, type VeniceChatModelPrice } from "@/lib/venice/pricing";

export type VenicePrivacy = VeniceChatModelPrice["privacy"];

const CATALOG_PRIVACY = new Map<string, VenicePrivacy>(
  VENICE_CHAT_MODEL_PRICES.map(entry => [entry.model, entry.privacy]),
);

/** Reads Venice's own privacy value. Anything unrecognised is treated as
 * anonymized, so a badge is never shown by mistake. */
export function parseVenicePrivacy(value: unknown, modelId = ""): VenicePrivacy {
  const v = typeof value === "string" ? value.toLowerCase() : "";
  if (v === "e2ee_private") return "e2ee_private";
  if (v === "private") return "private";
  if (v === "anonymized") return "anonymized";
  return modelId.startsWith("e2ee-") ? "e2ee_private" : "anonymized";
}

/** The privacy of a Venice model Hivra knows about, or null when unknown. */
export function venicePrivacyFor(modelId: string): VenicePrivacy | null {
  return CATALOG_PRIVACY.get(modelId) ?? null;
}

export function isPrivateVenicePrivacy(privacy: VenicePrivacy | null | undefined): boolean {
  return privacy === "private" || privacy === "e2ee_private";
}

/** True when a model in Hivra's Venice catalog is private. Unknown models get
 * no badge. */
export function isPrivateVeniceModel(modelId: string): boolean {
  return isPrivateVenicePrivacy(venicePrivacyFor(modelId));
}

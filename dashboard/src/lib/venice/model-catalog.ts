import { VENICE_CHAT_MODEL_PRICES, type VeniceChatModelPrice } from "@/lib/venice/pricing";

const BY_ID = new Map<string, VeniceChatModelPrice>(VENICE_CHAT_MODEL_PRICES.map(entry => [entry.model, entry]));

export function veniceCatalogEntry(id: string): VeniceChatModelPrice | null {
  return BY_ID.get(id) ?? null;
}

/** The catalogue's display name for a model id, or the id itself when unknown. */
export function veniceModelName(id: string | null | undefined): string {
  if (!id) return "";
  return BY_ID.get(id)?.displayName || id;
}

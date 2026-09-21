import "server-only";

import { supabaseAdmin } from "@/lib/supabase";

import { SELF_HOST_USER_ID } from "./config";

interface LocalOperatorState {
  publicMetadata: Record<string, unknown>;
  updatedAt: string;
}

const EMPTY_STATE: LocalOperatorState = {
  publicMetadata: {},
  updatedAt: new Date(0).toISOString(),
};

export async function loadLocalOperatorState(): Promise<LocalOperatorState> {
  if (!supabaseAdmin) return EMPTY_STATE;
  const { data, error } = await supabaseAdmin
    .from("self_host_operator_settings")
    .select("public_metadata,updated_at")
    .eq("operator_id", SELF_HOST_USER_ID)
    .maybeSingle();
  if (error) throw new Error(`Failed to load local operator settings: ${error.message}`);
  if (!data) return EMPTY_STATE;
  const publicMetadata = data.public_metadata;
  return {
    publicMetadata:
      publicMetadata && typeof publicMetadata === "object" && !Array.isArray(publicMetadata)
        ? publicMetadata as Record<string, unknown>
        : {},
    updatedAt: typeof data.updated_at === "string" ? data.updated_at : EMPTY_STATE.updatedAt,
  };
}

export async function saveLocalOperatorMetadata(
  publicMetadata: Record<string, unknown>,
): Promise<LocalOperatorState> {
  if (!supabaseAdmin) {
    throw new Error("Local Supabase is not configured; operator settings cannot be saved.");
  }
  const state: LocalOperatorState = {
    publicMetadata,
    updatedAt: new Date().toISOString(),
  };
  const { error } = await supabaseAdmin
    .from("self_host_operator_settings")
    .upsert({
      operator_id: SELF_HOST_USER_ID,
      public_metadata: publicMetadata,
      updated_at: state.updatedAt,
    }, { onConflict: "operator_id" });
  if (error) throw new Error(`Failed to save local operator settings: ${error.message}`);
  return state;
}

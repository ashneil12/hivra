import { HERMESOS_TOKEN } from "@/lib/billing/token-registry";

/**
 * "Is this pasted address one of Hivra's?" (the Check a token address form).
 *
 * This file is imported by the client form, so it stays free of the airdrop
 * config: nothing in it, or in what the form is given, can carry the Sablier
 * campaign link, the claim window or the snapshot link into the browser. The
 * form is given only an AddressCheckState (see addressCheckStateOf in
 * conversion-state.ts), which is the two addresses the check compares with.
 *
 * Client-safe: imports only the token registry, which is client-safe.
 */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Everything the check needs and nothing else. While $HIVRA is dormant there is
 * nothing to compare with, so the state is just that. Once it has launched, the
 * $HIVRA contract (lower-cased) and the Airdrop wallet as configured.
 */
export type AddressCheckState =
  | { status: "dormant" }
  | { status: "launched"; hivraAddress: string; senderAddress: string | null };

export type TokenAddressCheck =
  | { kind: "invalid" }
  | { kind: "hermesos" }
  | { kind: "hivra" }
  | { kind: "airdrop-sender" }
  | { kind: "hivra-not-launched" }
  | { kind: "not-official" };

export function normalizeAddress(value: string): string | null {
  const trimmed = value.trim();
  if (!EVM_ADDRESS.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

/**
 * Tells a holder whether a pasted address is one of Hivra's tokens, or Hivra's
 * airdrop wallet. The pasted value is only ever compared against the registry
 * and the airdrop config; it is never used as a token, a link target or a swap
 * input.
 */
export function checkTokenAddress(input: string, state: AddressCheckState): TokenAddressCheck {
  const address = normalizeAddress(input);
  if (!address) return { kind: "invalid" };
  if (address === HERMESOS_TOKEN.address) return { kind: "hermesos" };
  if (state.status === "dormant") return { kind: "hivra-not-launched" };
  if (address === state.hivraAddress) return { kind: "hivra" };
  if (state.senderAddress && address === state.senderAddress.toLowerCase()) return { kind: "airdrop-sender" };
  return { kind: "not-official" };
}

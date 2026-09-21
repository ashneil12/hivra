/** @jest-environment node */

jest.mock("server-only", () => ({}));

const maybeSingle = jest.fn();
const eqProvider = jest.fn(() => ({ maybeSingle }));
const eqUser = jest.fn(() => ({ eq: eqProvider }));
const select = jest.fn(() => ({ eq: eqUser }));
const from = jest.fn(() => ({ select }));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from } }));
jest.mock("@/lib/crypto", () => ({ decryptApiKey: jest.fn((value: string) => value.replace(/^sealed:/, "")) }));

import { decryptApiKey } from "@/lib/crypto";
import { resolveBuzzVaultCredential } from "../buzz-runtime-credentials";

describe("Buzz Vault credential resolver", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns only the caller-owned Venice key after decryption", async () => {
    maybeSingle.mockResolvedValue({ data: { encrypted_key: "sealed:venice-private" }, error: null });
    await expect(resolveBuzzVaultCredential("user_a", "venice")).resolves.toBe("venice-private");
    expect(from).toHaveBeenCalledWith("user_api_keys");
    expect(eqUser).toHaveBeenCalledWith("user_id", "user_a");
    expect(eqProvider).toHaveBeenCalledWith("provider", "venice");
    expect(decryptApiKey).toHaveBeenCalledWith("sealed:venice-private");
  });

  it("fails closed for missing, unreadable, or unsafe values", async () => {
    maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    await expect(resolveBuzzVaultCredential("user_a", "venice")).resolves.toBeNull();
    maybeSingle.mockResolvedValueOnce({ data: { encrypted_key: "sealed:bad key" }, error: null });
    await expect(resolveBuzzVaultCredential("user_a", "venice")).resolves.toBeNull();
    (decryptApiKey as jest.Mock).mockImplementationOnce(() => { throw new Error("cipher"); });
    maybeSingle.mockResolvedValueOnce({ data: { encrypted_key: "sealed:any" }, error: null });
    await expect(resolveBuzzVaultCredential("user_a", "venice")).resolves.toBeNull();
  });
});

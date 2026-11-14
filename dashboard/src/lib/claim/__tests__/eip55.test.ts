/** The dependency-free EIP-55 check used by the migration page, against viem. */
import { getAddress, isAddress, keccak256, toHex } from "viem";

import { keccak256Hex, readEip55Address, toChecksumAddress } from "../eip55";

function pseudoRandomAddress(seed: number): string {
  let hex = "";
  let state = seed * 2654435761 >>> 0;
  for (let i = 0; i < 40; i++) {
    state = (state * 1103515245 + 12345) >>> 0;
    hex += (state >>> 16 & 0xf).toString(16);
  }
  return `0x${hex}`;
}

describe("eip55", () => {
  it("hashes like viem's keccak256, across the padding boundary", () => {
    for (const length of [0, 1, 40, 135, 136, 137, 300]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 31 + length) & 0xff);
      expect(keccak256Hex(bytes)).toBe(keccak256(toHex(bytes)).slice(2));
    }
  });

  it("checksums like viem", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const address = pseudoRandomAddress(seed);
      expect(toChecksumAddress(address)).toBe(getAddress(address));
    }
  });

  it.each([
    "0x4aCDa6e26929acd34b45beDaEE2f7b8a418ce10C",
    "0x672b58b6d10413fe69ab0907db5b17712bd45f7a",
    "0x000000000000000000000000000000000000dEaD",
    "0x4aCDa6e26929acd34b45beDaEE2f7b8a418ce10c",
    "0x672B58B6D10413FE69AB0907DB5B17712BD45F7A",
    "0x1234",
    "672b58b6d10413fe69ab0907db5b17712bd45f7a",
  ])("accepts %s exactly when viem's strict check does", (address) => {
    const expected = isAddress(address, { strict: true }) ? getAddress(address) : null;
    expect(readEip55Address(address)).toBe(expected);
  });
});

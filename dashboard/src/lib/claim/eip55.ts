/**
 * EIP-55 address checksums without a crypto dependency.
 *
 * viem does this on the server, but it needs TextEncoder at import time, which
 * the jsdom test environment for the token pages does not have, and those
 * pages only need to check a handful of addresses from a config file. This is
 * a plain Keccak-256 (the Ethereum variant, padding 0x01) over the 40 lowercase
 * hex characters. __tests__/eip55.test.ts checks it against viem.
 *
 * Client-safe: no imports.
 */
const MASK = (1n << 64n) - 1n;
const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
// Rotation offsets, indexed x + 5y.
const ROTATIONS = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const RATE_BYTES = 136;

function rotl(value: bigint, shift: number): bigint {
  if (shift === 0) return value;
  const n = BigInt(shift);
  return ((value << n) | (value >> (64n - n))) & MASK;
}

function keccakF(state: bigint[]): void {
  const c = new Array<bigint>(5);
  const b = new Array<bigint>(25);
  for (const rc of ROUND_CONSTANTS) {
    for (let x = 0; x < 5; x++) c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) state[x + y] ^= d;
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(state[x + 5 * y], ROTATIONS[x + 5 * y]);
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) state[x + y] = b[x + y] ^ (~b[((x + 1) % 5) + y] & MASK & b[((x + 2) % 5) + y]);
    }
    state[0] ^= rc;
  }
}

/** Keccak-256 of bytes, as lowercase hex (no 0x). */
export function keccak256Hex(input: Uint8Array): string {
  const state = new Array<bigint>(25).fill(0n);
  const padded = new Uint8Array(Math.ceil((input.length + 1) / RATE_BYTES) * RATE_BYTES);
  padded.set(input);
  padded[input.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  for (let offset = 0; offset < padded.length; offset += RATE_BYTES) {
    for (let lane = 0; lane < RATE_BYTES / 8; lane++) {
      let word = 0n;
      for (let i = 7; i >= 0; i--) word = (word << 8n) | BigInt(padded[offset + lane * 8 + i]);
      state[lane] ^= word;
    }
    keccakF(state);
  }
  let hex = "";
  for (let lane = 0; lane < 4; lane++) {
    for (let i = 0; i < 8; i++) hex += Number((state[lane] >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, "0");
  }
  return hex;
}

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The EIP-55 checksummed form of a 0x + 40 hex address, or null when it is not one. */
export function toChecksumAddress(address: string): string | null {
  if (!HEX_ADDRESS.test(address)) return null;
  const lower = address.slice(2).toLowerCase();
  const hash = keccak256Hex(Uint8Array.from(lower, (char) => char.charCodeAt(0)));
  let out = "0x";
  for (let i = 0; i < 40; i++) out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

/**
 * The checksummed form when `address` is EIP-55 safe: all lowercase, or mixed
 * case with a correct checksum. Null otherwise (a typo in a mixed-case paste,
 * all uppercase, or not an address).
 */
export function readEip55Address(address: string): string | null {
  const checksummed = toChecksumAddress(address);
  if (!checksummed) return null;
  const body = address.slice(2);
  if (body === body.toLowerCase()) return checksummed;
  return address === checksummed ? checksummed : null;
}

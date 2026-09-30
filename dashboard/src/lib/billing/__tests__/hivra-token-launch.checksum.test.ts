/** @jest-environment node */
import { isAddress } from "viem";
import { HIVRA_TOKEN_LAUNCH } from "@/lib/billing/hivra-token-launch";
import { HERMESOS_PUBLISHED_ADDRESS } from "@/lib/billing/token-registry";

// A typo in a checksummed paste still looks like a valid address; its EIP-55
// checksum is what catches it. All-lowercase addresses carry no checksum.
function hasValidChecksum(address: string) {
  return isAddress(address, { strict: true });
}

describe("platform token contract checksums", () => {
  it("the committed $HIVRA address, when set, passes its EIP-55 checksum", () => {
    const address = HIVRA_TOKEN_LAUNCH.contractAddress.trim();
    if (!address) return; // dormant
    expect(hasValidChecksum(address)).toBe(true);
  });

  it("the published $HermesOS address passes its EIP-55 checksum", () => {
    expect(hasValidChecksum(HERMESOS_PUBLISHED_ADDRESS)).toBe(true);
  });

  it("catches a one-letter case typo", () => {
    expect(hasValidChecksum("0x95CcfD2B81A9667b0Cc979992632F98fc853EBa3")).toBe(false);
    expect(hasValidChecksum("0x95ccfd2b81a9667b0cc979992632f98fc853eba3")).toBe(true);
  });
});

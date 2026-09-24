import "server-only";

import { z } from "zod";

/** Retained control protocols, not a list of installable releases. Never point
 * an old entry at new bytes: active operations must keep their original worker.
 * Recovery executes only that already-installed, root-owned file; it does not
 * download, upgrade, reinstall or substitute a current installer. Add a new
 * reviewed entry when the worker changes, retaining previous entries for any
 * outstanding operation. The pre-worker 2026.08.27.4 release is not supported.
 */
const recipes = Object.freeze({
  "2026.08.28.1": Object.freeze({
    protocol: "v1" as const,
    workerSha256: "87da03b5baf6149c4035511b9e8d0aa1ac3d03dc3f628a1e4422953135324759",
    workerSize: 18516,
  }),
  "2026.08.28.2": Object.freeze({
    protocol: "v1" as const,
    workerSha256: "49638f6e93d98ac6edfce3d30931ac69f9bfdcf80b10cb4939f30e07fe76a1db",
    workerSize: 18538,
  }),
  "2026.08.28.3": Object.freeze({
    protocol: "v1" as const,
    workerSha256: "cd18e41bdc1af2ed8fce8b7f09caf33eff06655196720096c5dce7159b33a1d1",
    workerSize: 18554,
  }),
  "2026.08.28.4": Object.freeze({
    protocol: "v1" as const,
    workerSha256: "7de7080b5c26ceda3beaed9af564b84ac8ae28c95fe20a9deb6caa0205923af6",
    workerSize: 18570,
  }),
  "2026.08.29.1": Object.freeze({
    protocol: "v1" as const,
    workerSha256: "9eb0a6ebf2b0b0f6afae24b63527ad8a3a85f792e42a18bb3dc634ddfd59820f",
    workerSize: 18586,
  }),
  "2026.08.29.2": Object.freeze({
    protocol: "v1" as const,
    workerSha256: "1e26ee7ad1000edab27e832a514ae09d50850adb369e90eacf20aca9cd0a4329",
    workerSize: 18602,
  }),
  "2026.08.29.3": Object.freeze({
    protocol: "v1" as const,
    workerSha256: "e35e7aa7c414a6645959bfb7a365057db531795c4ded0e85d928ac6fdcf262f2",
    workerSize: 18618,
  }),
  "2026.08.29.4": Object.freeze({
    protocol: "v1" as const,
    workerSha256: "65e6e7f22c65f6df83b89e89467995ca0690f1718c377cb2a337647c82526962",
    workerSize: 18634,
  }),
  "2026.08.29.5": Object.freeze({
    protocol: "v1" as const,
    workerSha256: "cc19bdfefe480d3e6afbe8171777ab4922724ded96487146a77a8b3d34997f25",
    workerSize: 18650,
  }),
  "2026.08.30.1": Object.freeze({
    protocol: "v1" as const,
    workerSha256: "f1bf86424042f7cc476752bbc52a810ce2700bae8fb5789aa2be1059a25a3deb",
    workerSize: 18666,
  }),
  "2026.08.30.2": Object.freeze({
    protocol: "v1" as const,
    workerSha256: "18f906ced47982c3baeaaa0979311b095c598ac87c8fe521fa5e65d00d99e526",
    workerSize: 18682,
  }),
  "2026.08.31.1": Object.freeze({
    protocol: "v1" as const,
    workerSha256: "44d196e0e34a42451bf36ecd7b15f645782de0ea6c64ba52c9f243ae65dc48bf",
    workerSize: 18698,
  }),
  "2026.08.31.2": Object.freeze({
    protocol: "v1" as const,
    workerSha256: "5b6c1444666868e4c8b9f49dcbd54cb8a05e37d7d216577fa7129e559b64115b",
    workerSize: 18714,
  }),
  "2026.08.31.3": Object.freeze({
    protocol: "v1" as const, // Public server dispatch remains v1; guest v2 is staged.
    workerSha256: "61229d0fa5a6383ab42f3a77967d0db9bcc2a5242eba91e900c4851b2a3f2b9f",
    workerSize: 27894,
  }),
  "2026.08.31.4": Object.freeze({
    protocol: "v1" as const, // Public server dispatch remains v1; guest v2 is staged.
    workerSha256: "431fec069ebcb7a2187765825c9b3c699c4f5d187e38cab33358bacdd680a35e",
    workerSize: 27894,
  }),
  "2026.09.01.1": Object.freeze({
    protocol: "v1" as const, // Same wire protocol; native release identity advances with the bundle.
    workerSha256: "fcf95d49abe3b8f28192dcbcd35227f14af940149c16f863535aa726b47b7e9d",
    workerSize: 27894,
  }),
  "2026.09.01.2": Object.freeze({
    protocol: "v1" as const, // Same wire protocol; new installs use the bounded desktop installer release.
    workerSha256: "d495e5184484680fe3177ec83c7d2b7a80c7015b2abc8652c9e2364a88ab4c3a",
    workerSize: 27894,
  }),
  "2026.09.01.3": Object.freeze({
    protocol: "v1" as const, // Same wire protocol; immutable desktop proofs now live outside broker-owned state.
    workerSha256: "b1440898f65a690bb75ffb0a6f5a49a9387d0a4945ca2fee4c2e7151f2284661",
    workerSize: 27894,
  }),
  "2026.09.01.4": Object.freeze({
    protocol: "v1" as const, // Same wire protocol; remote desktop now waits for the protected HTTP contract.
    workerSha256: "147c001678b68dd7bb7ff1a4a8d77f1b147d24f41fce62ea77c3f8c2306cbeff",
    workerSize: 27894,
  }),
  "2026.09.01.5": Object.freeze({
    protocol: "v1" as const, // Same wire protocol; Selkies authentication is now explicitly enabled.
    workerSha256: "5ccb09c1b4977a5f176a05188ccd6f841bb7036fc820752b047d7c6d3a77b0bd",
    workerSize: 27894,
  }),
  "2026.09.01.6": Object.freeze({
    protocol: "v1" as const, // Same wire protocol; desktop container inspection now converges before admission.
    workerSha256: "3a2bb5ca402e4dc4b28e1799446e97a91ded306a10bbb74d36077278f7d79691",
    workerSize: 27894,
  }),
  "2026.09.01.7": Object.freeze({
    protocol: "v1" as const, // Same controller protocol; the bundle adds named-access native Proxmox composition.
    workerSha256: "b0d12a6f8325c98a4631c1271691133bba8b61a70d77098cd86d762ab0add260",
    workerSize: 27894,
  }),
  "2026.09.01.8": Object.freeze({
    protocol: "v1" as const, // Same controller protocol; the bundle adds fail-closed rolling desktop leases.
    workerSha256: "727cb210537ade86c19498283eda3d4f455f3441be48cdde9a3fcdab686c9e27",
    workerSize: 27894,
  }),
  "2026.09.01.9": Object.freeze({
    protocol: "v1" as const, // Same controller protocol; the bundle adds sanitized browser frame timing.
    workerSha256: "cb3e1d5e37cc911dacb8b2abd2cd9ec19acec496848c9e0446efeec82496b598",
    workerSize: 27894,
  }),
  "2026.09.02.1": Object.freeze({
    protocol: "v1" as const, // Same controller protocol; the bundle adds a root-only native Proxmox handoff.
    workerSha256: "9691412a3df12b86d94e68cdfadaaaef7ffabae03ed8098f2485efc5f2b5cbc3",
    workerSize: 27894,
  }),
  "2026.09.02.2": Object.freeze({
    protocol: "v1" as const, // Same controller protocol; Proxmox guest SSH is now VMID-key-bound.
    workerSha256: "7c4b351206d56e891111c382afe2470f1132da8589fc3183558aeab88f522be9",
    workerSize: 27894,
  }),
  "2026.09.02.3": Object.freeze({
    protocol: "v1" as const, // Same controller protocol; every guest lifecycle SSH path is VMID-key-bound.
    workerSha256: "fb398fce45a9f22ce33294501d0a619bc959724e9897371f3a41d27344050946",
    workerSize: 27894,
  }),
  "2026.09.02.4": Object.freeze({
    protocol: "v1" as const, // Same controller protocol; QGA bootstrap is operation-scoped and deterministic.
    workerSha256: "2917fdf315f483ae54102ea12c46f5fd152f84f01265ef1beaf315cf8e6fa107",
    workerSize: 27894,
  }),
  "2026.09.02.5": Object.freeze({
    protocol: "v1" as const, // Same controller protocol; only public documentation identities changed.
    workerSha256: "9a3f513f41824d0faaa0c43442fdd95b0a969f0c767e2f754c1ada933743775a",
    workerSize: 27894,
  }),
  "2026.09.02.6": Object.freeze({
    protocol: "v1" as const, // Same protocol; source-safe defaults and controller identity are republished immutably.
    workerSha256: "28c1c42ae57af01ee68311a3b8c74d63e005709450ad21728075dee6de175474",
    workerSize: 27894,
  }),
  "2026.09.02.7": Object.freeze({
    protocol: "v1" as const, // Same protocol; source-only provenance identity is republished immutably.
    workerSha256: "784570b19e23fc42d8f038c5e2b9f085da9d58dc2cac3a0da397af1a745fcd23",
    workerSize: 27894,
  }),
  "2026.09.02.8": Object.freeze({
    protocol: "v1" as const, // Same provider protocol; Linux Desktop remains Proxmox-only.
    workerSha256: "6bb135af6d0f73cda26b1036ab6f20e8f5bc1921b32201d05ce32beeac7b54b9",
    workerSize: 27894,
  }),
  "2026.09.03.1": Object.freeze({
    protocol: "v1" as const, // Same provider protocol; plain Linux Desktop no longer clones an agent distribution.
    workerSha256: "6698a51bb267ad2c72380acc779867a74ab81150028f437fef7dc35945704522",
    workerSize: 27894,
  }),
  "2026.09.03.2": Object.freeze({
    protocol: "v1" as const, // Same provider protocol; use the current pullable CPU-capable Selkies image.
    workerSha256: "6791f09fe1f1eb5ede419cd24b533dc54a4664d28288a1b1e4f458deb6638767",
    workerSize: 27894,
  }),
  "2026.09.04.1": Object.freeze({
    protocol: "v1" as const, // Same provider protocol; desktop handoff now forwards container resizes.
    workerSha256: "eb6f6bff8bddf24a468ea3b1bb2cd5a3a8b65b4743947e5cc186f4bc80451410",
    workerSize: 27894,
  }),
  "2026.09.04.2": Object.freeze({
    protocol: "v1" as const, // Same provider protocol; desktop reinstall now rotates active service state.
    workerSha256: "c2ddc4a0af95d2c71eecbaa7e4cc67870a785a3b424c25b8d7b3b4c4eb3ad4ba",
    workerSize: 27894,
  }),
  "2026.09.04.3": Object.freeze({
    protocol: "v1" as const, // Same provider protocol; managed desktop handoff now traverses control protection.
    workerSha256: "1627209190ae22104d8586d1c8a3ed8c32752cbd0aa89e4111f7d6426b713461",
    workerSize: 27894,
  }),
  "2026.09.04.4": Object.freeze({
    protocol: "v1" as const, // Same provider protocol; desktop viewport changes now propagate without reconnecting.
    workerSha256: "dfce5072898ad08ed36b16654a6ccfe3dd9493fd35ece6e7c3bd769f39c0a441",
    workerSize: 27894,
  }),
  "2026.09.05.1": Object.freeze({
    protocol: "v1" as const, // Same provider protocol; Linux Desktop maps its contained workspace writer to bux.
    workerSha256: "359340357c88107844ae79a9751ce9b9563125a5414f781d7bcdd9efb42c9cec",
    workerSize: 27894,
  }),
  "2026.09.05.2": Object.freeze({
    protocol: "v1" as const, // Same provider protocol; the pinned desktop identity derivation preserves exact special modes.
    workerSha256: "e46522bb53105fa92178499dea8f81a7aeb86a369f538381ca97fcb3c25dfed8",
    workerSize: 27894,
  }),
  "2026.09.05.3": Object.freeze({
    protocol: "v1" as const, // Same provider protocol; selected desktop-image symlinks retain their mapped identity.
    workerSha256: "1e474c8fd0590c0442481cdf6cad2e25c96c6c40f945c90277fe52d1889d58e8",
    workerSize: 27894,
  }),
  "2026.09.05.4": Object.freeze({
    protocol: "v1" as const, // Same provider protocol; each browser desktop handoff now has isolated media authority.
    workerSha256: "77e03fec7702990792c4210f9e8ca4f701780b62e71aa3b736c938912f7cb0ae",
    workerSize: 27894,
  }),
  "2026.09.05.5": Object.freeze({
    protocol: "v1" as const, // Installer-only desktop geometry alignment; session protocol unchanged.
    workerSha256: "bbf88b8f971e1166c29152a581a8caa4a4ea590caea134d655ab340cb8b833ad",
    workerSize: 27894,
  }),
  "2026.09.05.6": Object.freeze({
    protocol: "v1" as const, // Legacy entrypoint retained; private desktop v3 has separate authority.
    workerSha256: "69d9f21cfb5e592ce1d0fa2f587cb22812c6bb7e9543fa7233780910951b4a42",
    workerSize: 44874,
  }),
  "2026.09.05.7": Object.freeze({
    protocol: "v1" as const, // Public desktop proxy preserves broker framing authority.
    workerSha256: "3bc2aca851d67270b801e0885ac161c4cd71d274bc74ead91732f7a5e786bbd0",
    workerSize: 44822,
  }),
  "2026.09.05.8": Object.freeze({
    protocol: "v1" as const, // Desktop v3 has a separate bounded cold-start deadline.
    workerSha256: "b0a63fa4dd0f077d71e86bcdef4e7c7f46ecd15a1ac45d8479fdecf7ba94b12f",
    workerSize: 45185,
  }),
  "2026.09.05.9": Object.freeze({
    protocol: "v1" as const, // Desktop installs the separate scoped workspace gateway.
    workerSha256: "fc03785b18ddc8681a868c6cd7e6e1cda8b2fed97971af0909eb148c92db04d4",
    workerSize: 45185,
  }),
  "2026.09.05.10": Object.freeze({
    protocol: "v1" as const, // Desktop Node extraction retains root ownership and pinned modes.
    workerSha256: "b0838bdc61079929144590cc8f606f2ad22db35d4fa9062920548884d92f032c",
    workerSize: 45187,
  }),
  "2026.09.06.1": Object.freeze({
    protocol: "v1" as const, // Native editor lifecycle assets; retained workers remain version-bound.
    workerSha256: "0479130b44b65eb4d41e6c35a076ae119da81057589fa1ea1587fc110b06db8e",
    workerSize: 45185,
  }),
  "2026.09.06.2": Object.freeze({
    protocol: "v1" as const, // Optional pinned desktop image; retained workers stay sealed.
    workerSha256: "2e60747237245c7e71912851a11992b7768ef7c99986d2bb52f35360cf1c6711",
    workerSize: 45185,
  }),
  "2026.09.06.3": Object.freeze({
    protocol: "v1" as const, // Correct GNU exclusive archive creation; retained workers stay sealed.
    workerSha256: "19b21b088b11eef767673001117afb4987d2de28600a4c1fb7dffe3c44840a52",
    workerSize: 45185,
  }),
  "2026.09.06.4": Object.freeze({
    protocol: "v1" as const, // Include untagged prepared images; retain earlier workers unchanged.
    workerSha256: "ce7b372f50ce3aa27bc1efa8fe1a08167ff477cec381a4ef9f93142c1e8b832e",
    workerSize: 45185,
  }),
  "2026.09.07.1": Object.freeze({
    protocol: "v1" as const, // Pin 96 DPI for browser-sized desktop frames and publish the matching release identity.
    workerSha256: "6f339cc13dbf252847a68588c01d399b7b25f304e0eceb75ebaaad8d9e3f006f",
    workerSize: 45185,
  }),
  "2026.09.08.1": Object.freeze({
    protocol: "v1" as const, // Add HQ-first and Performance stream profiles; retained workers remain sealed.
    workerSha256: "470f8a12f749f4d656eade252e92b7ebcc20c1ee80338e0414782eac1572ad41",
    workerSize: 45185,
  }),
  "2026.09.08.2": Object.freeze({
    protocol: "v1" as const, // Bind the selected stream profile before first frame; retained workers remain sealed.
    workerSha256: "2608c41336fba9e253572e9ebb8561c6f86401899bcfb5bf8b962e3ec84588f1",
    workerSize: 45185,
  }),
  "2026.09.08.3": Object.freeze({
    protocol: "v1" as const, // Remove one redundant handoff authorization round trip; retained workers remain sealed.
    workerSha256: "fb12467a5f09f81d6d117e246c3d98b74ec7b9c5e41d86b57578d9df9954c14b",
    workerSize: 45185,
  }),
  "2026.09.15.1": Object.freeze({
    protocol: "v1" as const, // Same provider worker; the host release adds a separately gated Windows installer capability.
    workerSha256: "fb12467a5f09f81d6d117e246c3d98b74ec7b9c5e41d86b57578d9df9954c14b",
    workerSize: 45185,
  }),
  "2026.09.15.2": Object.freeze({
    protocol: "v1" as const, // Same provider worker; host capacity admission changes only Proxmox lifecycle behavior.
    workerSha256: "fb12467a5f09f81d6d117e246c3d98b74ec7b9c5e41d86b57578d9df9954c14b",
    workerSize: 45185,
  }),
  "2026.09.21.1": Object.freeze({
    protocol: "v1" as const, // Admit the new immutable bundle identity; runtime behavior is otherwise retained.
    workerSha256: "f88d2e5482128f1a7ceed5240c7bfd54694d0b6de2e186e215a418b5cc3b002a",
    workerSize: 45185,
  }),
  "2026.09.22.1": Object.freeze({
    protocol: "v1" as const, // Admit the new immutable bundle identity; the agent-run reporter is installed only on Proxmox Claude Code/Codex guests.
    workerSha256: "69f92695647a5eca6c4a1074d61bbaf233450111b9694ffc1a7464a188079744",
    workerSize: 45185,
  }),
  "2026.09.22.2": Object.freeze({
    protocol: "v1" as const, // Same worker protocol; only the release version strings change.
    workerSha256: "6e00f1968087325f137e565433359b249f12475a8eaecc9ba3af657d737e29e1",
    workerSize: 45185,
  }),
  "2026.09.24.1": Object.freeze({
    protocol: "v1" as const, // Same worker protocol; the release adds detached chat runs to the guest gateway.
    workerSha256: "d0b33f0520f2e099589a1b31a25899b00fc360cd05d2cedb9d188466383b57ac",
    workerSize: 45185,
  }),
  "2026.09.24.2": Object.freeze({
    protocol: "v1" as const, // Same worker protocol; the release adds detached chat runs to the guest gateway.
    workerSha256: "c0ae874587a3ebb4d0957e3dd95ece96654e561990c96f495074f05072b71f83",
    workerSize: 45185,
  }),
});

type Version = keyof typeof recipes;
export const ProviderGuestWorkerVersion = z.enum(Object.keys(recipes) as [Version, ...Version[]]);

export function providerGuestWorkerRecipe(version: Version) {
  return recipes[ProviderGuestWorkerVersion.parse(version)];
}

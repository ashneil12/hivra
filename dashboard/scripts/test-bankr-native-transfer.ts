/**
 * Dry-run probe: does Bankr's /wallet/transfer endpoint accept native
 * ETH transfers (isNativeToken: true) on Base?
 *
 * Why this script exists: our existing code only ever calls
 * /wallet/transfer with isNativeToken=false (ERC-20). For just-in-time
 * gas sponsorship we need native ETH transfers from a treasury wallet.
 * Bankr's API shape implies support but we have no in-tree evidence.
 *
 * What this does:
 *   1. POST /partner/wallets → provision a fresh "treasury-probe" wallet
 *   2. POST /partner/wallets/{id}/api-keys → mint a scoped key
 *   3. POST /wallet/transfer with isNativeToken=true → expect failure
 *
 * The probe wallet starts at 0 ETH so the transfer MUST fail. The
 * failure mode is the signal:
 *
 *   ✓ "insufficient_funds_for_gas" or "insufficient funds" or 422 with
 *     a balance-related error → API shape is valid; refactor green-lit
 *
 *   ✗ "invalid_param: isNativeToken" or 400 about the token shape →
 *     Bankr is ERC-20 only; stay on the viem path
 *
 * Usage:
 *   BANKR_PARTNER_KEY=… npx tsx scripts/test-bankr-native-transfer.ts
 *
 * Optional:
 *   BANKR_API_BASE_URL  — defaults to https://api.bankr.bot
 *   PROBE_RECIPIENT     — recipient EVM address; defaults to the
 *                         "burn dust" address 0x…dEaD
 *
 * Side effect: a real Bankr wallet gets provisioned in your partner
 * account. It's empty and isolated; safe to ignore or delete from the
 * Bankr dashboard afterwards.
 */

const DEFAULT_API_BASE_URL = "https://api.bankr.bot";
const DEFAULT_RECIPIENT = "0x000000000000000000000000000000000000dEaD";

async function main() {
  const partnerKey = process.env.BANKR_PARTNER_KEY?.trim() || process.env.BANKR_PARTNER_API_KEY?.trim();
  if (!partnerKey) {
    console.error("BANKR_PARTNER_KEY not set. Run with:");
    console.error("  BANKR_PARTNER_KEY=… npx tsx scripts/test-bankr-native-transfer.ts");
    process.exit(1);
  }

  const apiBaseUrl = process.env.BANKR_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL;
  const recipient = (process.env.PROBE_RECIPIENT?.trim() || DEFAULT_RECIPIENT).toLowerCase();

  console.log(`[probe] API base: ${apiBaseUrl}`);
  console.log(`[probe] Recipient (for scoped key): ${recipient}`);
  console.log("");

  // ── Step 1: provision wallet ─────────────────────────────────────
  console.log("[1/3] Provisioning probe wallet…");
  const provisionResp = await fetch(`${apiBaseUrl}/partner/wallets`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Partner-Key": partnerKey,
    },
    body: JSON.stringify({
      idempotencyKey: `treasury-probe-${Date.now()}`,
      label: "Treasury native-transfer probe",
    }),
  });

  if (!provisionResp.ok) {
    const body = await provisionResp.text().catch(() => "<no body>");
    console.error(`✗ Provision failed: ${provisionResp.status} ${body}`);
    process.exit(2);
  }

  const provisionPayload = (await provisionResp.json()) as Record<string, unknown>;
  const walletId =
    (provisionPayload.id as string | undefined) ||
    (provisionPayload.walletId as string | undefined) ||
    ((provisionPayload.wallet as Record<string, unknown> | undefined)?.id as string | undefined);
  const walletAddressRaw =
    (provisionPayload.evmAddress as string | undefined) ||
    (provisionPayload.address as string | undefined) ||
    ((provisionPayload.wallet as Record<string, unknown> | undefined)?.evmAddress as string | undefined) ||
    ((provisionPayload.wallet as Record<string, unknown> | undefined)?.address as string | undefined);

  if (!walletId || !walletAddressRaw) {
    console.error(`✗ Provision response missing walletId/address. Raw: ${JSON.stringify(provisionPayload)}`);
    process.exit(3);
  }

  const walletAddress = walletAddressRaw.toLowerCase();
  console.log(`  walletId: ${walletId}`);
  console.log(`  address:  ${walletAddress}`);

  // ── Step 2: mint scoped API key ──────────────────────────────────
  console.log("");
  console.log("[2/3] Minting scoped API key…");
  const keyResp = await fetch(
    `${apiBaseUrl}/partner/wallets/${encodeURIComponent(walletId)}/api-keys`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Partner-Key": partnerKey,
      },
      body: JSON.stringify({
        name: "Treasury native probe (single-use)",
        permissions: {
          walletApiEnabled: true,
          agentApiEnabled: false,
          llmGatewayEnabled: false,
          tokenLaunchApiEnabled: false,
          readOnly: false,
        },
        allowedRecipients: {
          evm: [recipient],
          solana: [],
        },
      }),
    }
  );

  if (!keyResp.ok) {
    const body = await keyResp.text().catch(() => "<no body>");
    console.error(`✗ Key mint failed: ${keyResp.status} ${body}`);
    process.exit(4);
  }

  const keyPayload = (await keyResp.json()) as { apiKey?: string; secret?: string };
  const apiKey = keyPayload.apiKey || keyPayload.secret;
  if (!apiKey) {
    console.error(`✗ Key mint response missing secret. Raw: ${JSON.stringify(keyPayload)}`);
    process.exit(5);
  }
  console.log(`  api key minted (${apiKey.length} chars, NOT logged)`);

  // ── Step 3: attempt native transfer ──────────────────────────────
  console.log("");
  console.log("[3/3] Attempting NATIVE ETH transfer (isNativeToken=true)…");
  console.log("  expected: failure with 'insufficient_funds' (wallet is empty)");
  console.log("");

  // Bankr requires tokenAddress always. For native ETH we try a few
  // standard placeholder addresses and the literal string "ETH" — first
  // one that produces a balance/insufficient-funds error wins.
  const candidates = [
    { label: "EIP-7528 placeholder (0xeeee…eeee)", tokenAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" },
    { label: "zero address (0x0000…0000)", tokenAddress: "0x0000000000000000000000000000000000000000" },
    { label: "literal 'ETH'", tokenAddress: "ETH" },
  ];

  let verdict: "valid" | "rejected" | "ambiguous" = "rejected";
  for (const c of candidates) {
    const transferResp = await fetch(`${apiBaseUrl}/wallet/transfer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({
        tokenAddress: c.tokenAddress,
        recipientAddress: recipient,
        amount: "0.000001",
        isNativeToken: true,
      }),
    });
    const transferBody = await transferResp.text().catch(() => "<no body>");
    console.log(`  · ${c.label} → ${transferResp.status}`);
    console.log(`    ${transferBody}`);

    const lc = transferBody.toLowerCase();
    if (
      lc.includes("insufficient") ||
      lc.includes("balance") ||
      lc.includes("gas") ||
      transferResp.status === 200
    ) {
      verdict = "valid";
      console.log(`    ✓ accepted shape — balance-related error or success`);
      break;
    }
  }
  console.log("");

  // ── Verdict ──────────────────────────────────────────────────────
  if (verdict === "valid") {
    console.log("✓ API shape valid — Bankr accepted isNativeToken=true and only failed");
    console.log("  on balance check. Native transfer support is CONFIRMED.");
    console.log("");
    console.log("  → Refactor treasury-gas.ts to use Bankr instead of viem.");
  } else {
    console.log("✗ API rejected every native-transfer shape we tried. Bankr is");
    console.log("  ERC-20 only on /wallet/transfer. Stay on the viem-signed path.");
  }

  console.log("");
  console.log("Probe wallet (safe to ignore or delete from Bankr dashboard):");
  console.log(`  walletId: ${walletId}`);
  console.log(`  address:  ${walletAddress}`);
}

main().catch((err) => {
  console.error("✗ Probe crashed:", err);
  process.exit(99);
});

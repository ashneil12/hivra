# Key custody inventory

## For counsel review

This document lists every place Hivra's managed-hosting code creates or holds a
cryptocurrency wallet or a credential that can act on one. It states facts
only: what exists, what each item can do, whose funds are involved, how long
funds stay, who can move them and how access is revoked. It contains no legal
conclusions. Custody and regulatory treatment are under legal review.

- **Source:** this repository (`ashneil12/hivra`), branch `canary` at
  `f6737a2`, plus the change set that adds this file.
- **Row counts:** read-only aggregate queries on 2026-09-23 against the
  production database (Supabase project `prvdajgvxnkunvpmitbt`) and the
  Canary database (`srrwbdvxlqvqjuexitaf`). No personal data was read.
- **Bankr behaviour:** Bankr's public documentation at docs.bankr.bot, read on
  2026-09-23 (pages cited inline).
- **Not verified:** deployed environment-variable values (the reviewer had no
  permission to list them), the capabilities Bankr enabled on Hivra's partner
  organisation, and who holds the private keys of the treasury receiving
  addresses. These are listed under [Open items](#open-items).

### Classes

| Class | Meaning in this document |
|---|---|
| **A** | Hivra's own payment receipts or Hivra's own funds. |
| **B** | Customer assets that Hivra can move. |
| **C** | A credential the user authorised an agent to use. |

### Facts about Bankr that apply throughout

- Bankr wallets are Privy smart wallets. Bankr states that private keys are
  non-exportable by design, so no party, Hivra included, can export them
  (docs.bankr.bot/docs/faq/wallets).
- Anything that can move funds from a Bankr wallet does so through a Bankr API
  key (`X-API-Key`) calling Bankr's Wallet API (`/wallet/transfer`,
  `/wallet/swap`, `/wallet/sign`, `/wallet/submit`) or Agent API.
- A key's permission flags are independent: `walletApiEnabled`,
  `agentApiEnabled`, `tokenLaunchApiEnabled`, `llmGatewayEnabled`, `readOnly`,
  an IP allowlist and a recipient allowlist (`allowedRecipients`). A key with
  an empty recipient allowlist can send to any address
  (docs.bankr.bot/docs/security/developer-api).
- **Partner-provisioned wallets.** Hivra is a Bankr partner. Its partner key
  (`bk_ptr_…`) can create wallets for Hivra's organisation and, for any wallet
  that organisation created, create, update, rotate and revoke that wallet's
  API keys, suspend, resume and close it. Revoking a wallet's keys leaves the
  wallet "accessible via the partner key"
  (docs.bankr.bot/docs/partnership/api-keys,
  docs.bankr.bot/docs/partnership/wallet-provisioning). These wallets have no
  end-user login.
- **User-owned Bankr accounts.** A person signs in at bankr.bot and creates
  their own API keys at bankr.bot/api-keys. Wallet-level controls (daily
  spending limit and per-transaction limit, both $500 by default, a permitted
  recipient list with a cooldown, and a pause switch) are changed only through
  a signed-in web session; an API key cannot change them
  (docs.bankr.bot/docs/security/bankr-terminal). Hivra's partner key has no
  access to these accounts.

## Summary

| # | Item | Class | Whose funds | Who can move the funds | Status |
|---|---|---|---|---|---|
| 1 | Bankr partner key | A (and the control point for B) | Everything in rows 2–5 and 8–9 | Hivra | Active |
| 2 | `credit_deposit` payment addresses | A | Users pay in; swept to Hivra's treasury | Hivra | Active |
| 3 | `yearly_subscription` payment addresses | A | Users pay in; swept to Hivra's treasury | Hivra | Active |
| 4 | `managed_venice_inference` payment addresses | A | Users pay in; swept to Hivra's treasury | Hivra | Active |
| 5 | Single-use transfer keys | A (sweeps) / B (lock withdrawals) | As rows 2–4 and 8 | Hivra | Active |
| 6 | Treasury hot-wallet private key | A | Hivra | Hivra | Active |
| 7 | Treasury receiving addresses | A | Hivra | Not in code | Active |
| 8 | `hermesos_lock` wallets | **B** | The user | Hivra, and the user through Hivra's withdraw | Legacy; no new ones |
| 9 | Hivra-provisioned agent wallets | **B** (key also given to the agent) | The user | Hivra, the agent, anyone who can read the key on the box | Existing agents only |
| 10 | User-connected agent wallets | **C** | The user | The user at Bankr; the agent within the key's limits | New default |
| 11 | User-supplied Bankr keys in the vault or as a model provider | **C** | The user | The agent, within the key's limits | Active |
| 12 | Hivra's own Bankr API key for model sync | A | Hivra | Hivra | Active |
| 13 | Probe wallet script | A | Hivra | Hivra | Manual script |

## Detail

### 1. Bankr partner key — class A, control point for classes A and B

- **What it is:** Hivra's Bankr partner organisation key, read from
  `BANKR_PARTNER_KEY` or `BANKR_PARTNER_API_KEY` in the server environment
  (`dashboard/src/lib/billing/bankr-wallets.ts`, `getBankrPartnerConfig`).
- **What it can do:** create wallets under Hivra's partner organisation and
  create keys with any permissions the organisation's capabilities allow for
  any of those wallets, including a key that can transfer to any address. It
  can also revoke keys and suspend or close wallets. The code uses it to create
  wallets (rows 2–4, 8, 9), create each wallet's stored key, and create a new
  single-use transfer key for every sweep and lock withdrawal (row 5).
- **Whose funds:** it reaches every wallet in rows 2, 3, 4, 8 and 9.
- **How long:** permanent until revoked in Bankr's partner dashboard.
- **Who can use it:** the Hivra server and anyone with access to the deployed
  environment.
- **Revocation:** revoke in the Bankr partner dashboard. Revoking stops new
  wallets and keys; keys already issued keep working until revoked
  individually.

### 2. `credit_deposit` payment addresses — class A

- **What it is:** one Bankr wallet per user, created through the partner key
  when the user opens crypto top-up (`POST /api/billing/bankr/wallet`,
  `POST /api/billing/crypto/top-up`) or by `scripts/backfill-bankr-wallets.ts`
  / `scripts/provision-user-wallet.ts`. Stored in `user_wallets`
  (`verification_method = 'bankr'`) and `bankr_deposit_wallet_credentials`
  (`purpose = 'credit_deposit'`, `custodyModel = 'platform_deposit_address'`).
- **Stored key:** "Hivra deposit sweeper": Wallet API on, read-write,
  recipient allowlist = the treasury address, optional IP allowlist from
  `BANKR_DEPOSIT_WALLET_ALLOWED_IPS`. Encrypted with the platform
  `ENCRYPTION_KEY`. No code path decrypts or uses this stored key; sweeps use
  row 5.
- **Funds:** users send USDC (Base) to pay for platform credits. Once a
  receipt is settled and credited, `sweepPendingCreditDepositReceipts`
  (`credit-deposit-sweep.ts`, run by the `reconcile-crypto-topups` cron every
  10 minutes) moves exactly the receipt amount to `HERMES_TREASURY_ADDRESS`.
  Anything sent that doesn't match a receipt stays in the wallet and is marked
  for manual handling (`skipped`).
- **Who can move:** Hivra (sweep, or any key minted with the partner key). The
  user receives no key.
- **Counts (production, 2026-09-23):** 187 wallets in `user_wallets`; 143
  credentials with an active stored key, 44 without.
- **Revocation:** none in the product. Account deletion deletes the database
  rows (`dashboard/src/lib/ops/account-deletion.ts`) but does not revoke keys
  or close the wallet at Bankr.

### 3. `yearly_subscription` payment addresses — class A

- Same mechanism as row 2 for the "pay yearly with $HermesOS" flow
  (`/api/billing/yearly-token-quote`). The `yearly-token-sweep` cron (every 5
  minutes) sweeps paid $HermesOS to the treasury (`yearly-sweep.ts`). The sweep
  refuses `hermesos_lock` wallets.
- **Counts (production):** 1 wallet; its credential has no stored key.

### 4. `managed_venice_inference` payment addresses — class A

- Same mechanism as row 2 for $HermesOS paid toward managed Venice inference
  credits (`/api/billing/managed-venice/hermesos/quote`). Stored key name
  "Hivra managed Venice treasury sweeper". Swept by the `reconcile-crypto-topups`
  cron to `MANAGED_VENICE_TREASURY_BASE_ADDRESS` (falling back to
  `HERMES_TREASURY_BASE_ADDRESS` / `HERMES_TREASURY_ADDRESS`)
  (`managed-venice-token-sweep.ts`). The sweep refuses `hermesos_lock` wallets.
- **Counts (production):** 1 wallet with an active stored key.

### 5. Single-use transfer keys — class A (sweeps) and B (lock withdrawals)

- **What it is:** `mintScopedTransferApiKey` (`bankr-withdraw.ts`) uses the
  partner key to create a key named "Hivra withdraw (single-use)" with Wallet
  API on, read-write, and a one-address recipient allowlist, then calls
  `/wallet/transfer` with it. Used by the credit, yearly and managed Venice
  sweeps (recipient = treasury) and by the lock-wallet withdrawal (recipient =
  the user's saved withdraw address).
- **Lifetime:** the code does not revoke these keys after use. They stay active
  at Bankr until revoked; Bankr allows 20 active keys per wallet, and the code
  logs when that cap blocks a new one.
- **Gas:** before a transfer, `ensureWalletHasGas` (`treasury-gas.ts`) sends
  0.0001 ETH from the treasury hot wallet (row 6) if the wallet holds less
  than 0.00003 ETH.

### 6. Treasury hot-wallet private key — class A

- **What it is:** a raw Base private key in `HERMES_TREASURY_BASE_PRIVATE_KEY`
  (`treasury-gas.ts`), used to sign ETH gas top-ups to Bankr wallets. If
  `HERMES_TREASURY_BASE_ADDRESS` is set, the code requires the key to derive
  to it.
- **Funds:** Hivra's ETH. **Who can move:** Hivra. **Revocation:** move the
  funds and replace the key.

### 7. Treasury receiving addresses — class A

- `HERMES_TREASURY_ADDRESS`, `HERMES_TREASURY_BASE_ADDRESS` and
  `MANAGED_VENICE_TREASURY_BASE_ADDRESS` receive swept payments. Apart from
  the case in row 6, the code holds no key for them. Who holds their keys is
  outside this repository and not verified.

### 8. `hermesos_lock` wallets — class B (legacy)

- **What it is:** a partner-provisioned wallet per user (`purpose =
  'hermesos_lock'`, label "Bankr Hivra lock wallet") into which users deposited
  $HermesOS to hold a compute tier. The code describes a depositor as
  "functionally trusting the platform to honor a withdraw request"
  (`bankr-withdraw.ts`).
- **Creation:** the app no longer creates them. `POST /api/billing/bankr/wallet`
  creates only a `credit_deposit` address, and the wallet page shows a lock
  wallet only to a legacy holder whose latest snapshot is above zero. Before
  this change, `scripts/backfill-bankr-wallets.ts` and
  `scripts/provision-user-wallet.ts` still created lock wallets for every user
  they processed; they no longer do.
- **Who can move:** the user, by asking Hivra: `POST
  /api/billing/bankr/wallet/withdraw` moves the full $HermesOS balance to the
  user's saved withdraw address using a row-5 key that Hivra mints and submits.
  Hivra can also mint keys through the partner key. The stored credential rows
  hold no key.
- **How long:** until the user withdraws; there is no expiry.
- **Counts (production, 2026-09-23):** 43 lock wallets. The most recent
  $HermesOS snapshot for each of the 43 records a zero balance (newest
  snapshot 2026-09-23 18:01 UTC). Snapshots cover $HermesOS only; other tokens
  sent to these addresses are not tracked.
- **Revocation:** none in the product; account deletion deletes rows only.

### 9. Hivra-provisioned agent wallets — class B, key also given to the agent

- **What it is:** one partner-provisioned wallet per agent, in
  `instance_bankr_wallets` with `metadata.custodyModel =
  'bankr_custodied_agent_wallet'` (`bankr-instance-wallets.ts`). Earlier code
  created one whenever an agent launched; later code only when the user
  clicked "Create wallet" (`instance-service.lazy-bankr-wallet.test.ts`).
  Production rows were created between 2026-05-02 and 2026-06-11.
- **Stored key:** "Hivra agent instance wallet": Wallet API on, read-write,
  Agent API, LLM gateway and token launch off, **no recipient allowlist, no IP
  allowlist**. Encrypted with `ENCRYPTION_KEY`.
- **Delivery to the agent:** Hermes agents get it in the config YAML `bankr:`
  section and as `BANKR_API_KEY` / `BANKR_AGENT_API_KEY` environment lines
  (`hermes-config-write.ts`, `webui-instance-builder.ts`). Hivra boxes get it
  in `/home/bux/.hivra/bankr.env` (mode 0600, owned by the `bux` user the agent
  runs as), which the box's chat server reads on every agent turn
  (`bankr-wallet-env-seed.ts`, `provisioner/hivra-chat/server.js`).
- **Funds:** whatever the user deposits. They stay until withdrawn.
- **Who can move:** the agent (with the key, to any address); Hivra, through
  `POST …/bankr-wallet/withdraw` on the user's request (any recipient the user
  enters) or through the partner key; anyone who can read the key file or
  config on the box.
- **Counts (production, 2026-09-23):** 79 active wallets with a stored key (all
  Hermes-lane), plus 324 `pending` rows whose partner call never succeeded
  (placeholder id `pending:…`, zero address, no Bankr wallet). Canary: none.
- **Revocation:** no revoke control in the product. Deleting an agent is a soft
  delete; the row and encrypted key remain and nothing is revoked at Bankr.
  Account deletion deletes the rows only.
- **Switching to the user's own account (since this change):** optional, and
  only after the user confirms it. Hivra reads the old wallet's holdings with
  its own key (`GET /wallet/portfolio`, all chains, tokens under $1 and NFTs)
  and refuses the switch unless everything is zero, apart from up to
  0.0001 ETH of gas on Base that came from Hivra's treasury. If the holdings
  can't be read, the switch is refused. After the switch the old wallet's id
  and address stay on the row permanently, Hivra revokes every API key on
  the old wallet through the partner key, and a failed revocation is logged
  and shown to the user. The old wallet itself stays reachable by the partner
  key, and anything sent to its address later stays there.
- **Since this change:** no new wallets of this kind are created. Existing
  ones keep their key, balance display, runtime delivery and withdrawals.

### 10. User-connected agent wallets — class C (new default)

- **What it is:** the user's own Bankr account, connected to one agent with an
  API key the user created at bankr.bot/api-keys
  (`connectUserBankrWalletForOwner`, routes
  `POST|DELETE /api/instances/[id]/bankr-wallet/connect` and
  `POST|DELETE /api/hivra/agents/[id]/bankr-wallet/connect`). Stored in
  `instance_bankr_wallets` with `metadata.custodyModel =
  'user_owned_bankr_account'`, the consent wording version and time.
- **Checks before storing:** the key must not be a partner key; Bankr must
  accept it at `GET /wallet/me`, which returns the wallet address; the address
  must not belong to any wallet Hivra created (rows 2–4, 8, 9).
- **Consent:** the user ticks, per agent: "I authorise Hivra to store this key
  encrypted and send it to [agent]'s runtime, where the agent can use it on my
  Bankr wallet within the permissions and limits I set at Bankr. I can revoke
  it at bankr.bot/api-keys or disconnect it here at any time."
- **Storage and delivery:** encrypted with `ENCRYPTION_KEY`, like every other
  user-supplied key; delivered to the runtime exactly as in row 9.
- **What it can do:** whatever the user enabled on the key, within the
  wallet-level daily and per-transaction limits the user set at Bankr. Hivra
  cannot read or change those settings.
- **Who can move:** the user at bankr.bot; the agent within the key's limits.
  Hivra's partner key has no access. Hivra's withdraw routes refuse these
  wallets, and the accessor the withdraw code uses to decrypt a wallet key
  (`decryptInstanceBankrApiKey`) returns nothing for them; only the runtime
  delivery accessor returns the key.
- **How long:** the user's funds stay in the user's own Bankr account.
- **Revocation:** the user revokes the key at bankr.bot/api-keys (immediate at
  Bankr), or presses Disconnect in Hivra, which deletes Hivra's stored copy and
  stops delivering the key. Removal from the agent depends on the runtime:
  on a running Hivra box the env file is deleted and the next agent turn runs
  without it (a stopped box keeps the file, because nothing re-syncs it at
  start); on Hermes agents with a config API the config is rewritten without
  it; on Hermes "webfree" boxes (backend `gateway` or `webui`) the key
  stays in the box's persisted environment, because runtime updates never
  clear `BANKR_*` values (`webui-runtime-env.ts`). The dashboard reports which
  of these happened and, when removal isn't confirmed, tells the user to
  revoke the key at Bankr. Disconnect never revokes the key at Bankr.
- **Delivery timing:** on Hermes "webfree" boxes a newly connected key reaches
  the agent at its next runtime update, as Hivra-provisioned keys always have.
  A Hivra box that isn't running doesn't receive it; the dashboard says so.

### 11. User-supplied Bankr keys in the vault or as a model provider — class C

- Users can save any key under any provider name in the vault
  (`user_api_keys`, `POST /api/vault`), and can choose Bankr's LLM gateway
  (`llm.bankr.bot`) as a model provider with their own Bankr key. Keys are
  encrypted with `ENCRYPTION_KEY` and model-provider keys are delivered to the
  agent. Hivra does not inspect a Bankr key's permissions; if the user's key
  has wallet permissions, the agent holding it can use them.

### 12. Hivra's own Bankr API key for model sync — class A

- `MODEL_SYNC_BANKR_API_KEY` or `BANKR_API_KEY` in the server environment,
  used only to list LLM gateway models (`provider-model-sync.ts`). Its
  permissions are set at Bankr and not verified here.

### 13. Probe wallet script — class A

- `scripts/test-bankr-native-transfer.ts` is a manual probe that creates a
  wallet in Hivra's partner organisation and attempts a transfer from it with
  zero balance. It runs only when someone runs it by hand.

### Not wallets Hivra holds keys for

- **Verified external wallets:** `user_wallets` rows with
  `verification_method = 'signature'` (53 in production) record addresses the
  user proved they own by signing a message. Hivra holds no key.
- **`ENCRYPTION_KEY`:** the platform key that encrypts every stored API key in
  rows 2–4 and 9–11. Anyone holding it and database access can decrypt those
  keys. It is not a wallet.
- **Third-party skill secrets:** some curated agent skills (for example 0xWork,
  Nookplot) accept a private key in the box environment if the user supplies
  one. Hivra's code does not create or store these.
- **The $HermesOS token-launch fee wallet** is set at Bankr outside this
  repository and is not referenced in code.

## Scripts

| Script | Creates wallets? | Class | After this change |
|---|---|---|---|
| `backfill-bankr-wallets.ts` | Yes, for every Clerk user | A (and B before) | Creates `credit_deposit` addresses only; never `hermesos_lock` |
| `provision-user-wallet.ts` | Yes, one user | A (and B before) | Creates `credit_deposit` only; never `hermesos_lock` |
| `backfill-instance-bankr-wallets.ts` | Yes, for every Hermes instance without one, and retried pending rows | B | Never creates or retries a wallet; seeds Bankr skills only for agents with an active wallet |
| `bankr-backfill-plan.ts` | Plans the above | — | Returns only `seed_skills` or `skip` |
| `test-bankr-native-transfer.ts` | Yes, one probe wallet | A | Unchanged |
| `vendor-bankr-skills.ts` | No | — | Unchanged |

## Open items

1. Deployed values of `BANKR_PARTNER_KEY`, `HERMES_TREASURY_BASE_PRIVATE_KEY`,
   the treasury addresses and `BANKR_DEPOSIT_SWEEP_ENABLED` were not read. The
   production rows above show the partner key was configured when those
   wallets were created.
2. The capabilities Bankr enabled on Hivra's partner organisation (Wallet API,
   Agent API, token launch, LLM gateway) are set by Bankr and not verified.
3. Keys for the treasury receiving addresses (row 7) are held outside this
   repository.
4. Single-use transfer keys (row 5) and stored sweeper keys (rows 2–4) are not
   revoked by the code; they stay active at Bankr until revoked.
5. Deleting an agent or an account does not revoke keys or close wallets at
   Bankr (rows 2–4, 8, 9). Deleting an agent also leaves its encrypted wallet
   key row in place (rows 9 and 10), because agent deletion is a soft delete.
6. On Hermes "webfree" boxes, `BANKR_*` values in the persisted box
   environment are never cleared by Hivra (rows 9 and 10). A stopped Hivra box
   keeps its `bankr.env` after a disconnect.
7. Bankr's `GET /wallet/me` and `GET /wallet/portfolio` response shapes and the
   bulk key revocation endpoint (`DELETE /partner/wallets/{id}/api-keys`) are
   implemented from Bankr's published documentation. They have not been
   exercised against a real user-owned Bankr account or a real switch.

## Engineering recommendation for class B lock wallets

Not a legal view. The lock-wallet code belongs to the dual-token workstream.

1. No new lock deposits: already true in the app, and now in the scripts.
2. Move remaining holders to self-custody: hold $HermesOS in the user's own
   wallet and prove it by signing (the existing connect-and-sign path).
3. Once every lock wallet reads zero across all tokens, revoke its keys and
   suspend it through the partner API, then close it.

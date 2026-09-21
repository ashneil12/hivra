# HermesOS Payment Router Contracts

Canary-first Solidity contracts for direct connected-wallet payments.

## Purpose

`HermesPaymentRouter` is a small ERC20 payment rail. It lets a connected wallet pay a dashboard quote directly into a Hermes treasury and emits an indexed receipt event:

```solidity
PaymentReceived(bytes32 indexed quoteId, address indexed payer, address indexed token, uint256 amount, address treasury)
```

The contract does **not** price credits, settle subscriptions, manage Venice accounting, or decide entitlement. Dashboard quote/reconciliation code owns that logic.

## Safety Shape

- Base only for MVP.
- Non-upgradeable.
- Owner-managed token allowlist.
- Allowed tokens must be plain ERC20s with no transfer tax/rebase behavior, because reconciliation credits the emitted `amount`.
- Owner-managed treasury address.
- Pausable, with deploy script defaulting to `PAYMENT_ROUTER_START_PAUSED=true`.
- Reentrancy guarded.
- SafeERC20 transfer handling.
- No prod deployment from this scaffold.

## Setup

Install Foundry, then dependencies:

```bash
cd contracts
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts
forge test -vvv
```

## Deploy, canary only

Deployment is approval-gated. Do not broadcast without Ash approval and confirmed canary treasury/owner addresses.

First simulate without broadcasting:

```bash
cd contracts
PAYMENT_ROUTER_DEPLOYER_PRIVATE_KEY=<deploy-wallet-private-key> \
PAYMENT_ROUTER_OWNER=<owner-or-multisig> \
PAYMENT_ROUTER_TREASURY=<canary-treasury> \
PAYMENT_ROUTER_START_PAUSED=true \
BASE_RPC_URL=<base-rpc> \
forge script script/DeployHermesPaymentRouter.s.sol \
  --rpc-url "$BASE_RPC_URL"
```

Only after explicit approval, broadcast to Base mainnet. The script refuses non-Base chain IDs:

```bash
cd contracts
PAYMENT_ROUTER_DEPLOYER_PRIVATE_KEY=<deploy-wallet-private-key> \
PAYMENT_ROUTER_OWNER=<owner-or-multisig> \
PAYMENT_ROUTER_TREASURY=<canary-treasury> \
PAYMENT_ROUTER_START_PAUSED=true \
BASE_RPC_URL=<base-rpc> \
forge script script/DeployHermesPaymentRouter.s.sol \
  --rpc-url "$BASE_RPC_URL" \
  --broadcast \
  --verify
```

Never commit deploy keys, RPC keys, treasury secrets, or `.env` files.

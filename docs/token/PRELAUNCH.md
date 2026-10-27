# $HIVRA prelaunch page

NEEDS UK FINANCIAL-PROMOTION / LEGAL REVIEW BEFORE PUBLISHING. A disclaimer or the GB geo-block does not make it compliant.

The single source of truth is `dashboard/src/lib/token-launch-status.ts`. `/token` renders `PrelaunchSections` from it while
`HIVRA_TOKEN_LAUNCH.contractAddress` is empty. Every unverified fact is `null` there and reads "to be published".

## Going live checklist
1. Fill `verified.*` from BaseScan, the Sablier app and the Safe. Set `launch: "live"`, `claim: "open"`.
2. Confirm the fee split against the deployed Doppler contracts, then set `feesVerifiedOnChain: true`.
3. Activate $HIVRA via `HIVRA_TOKEN_LAUNCH` (docs/token/HIVRA-ACTIVATION.md).
4. Public visibility in production needs `HIVRA_NEW_TOKEN_SURFACES=true` (docs/token/NEW-TOKEN-SURFACES-SWITCH.md), set by Ash.

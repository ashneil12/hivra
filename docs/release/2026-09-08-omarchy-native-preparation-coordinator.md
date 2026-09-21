# Omarchy native preparation coordinator

Status: source-complete, not deployed or live-accepted.

The owner-scoped Remote Desktop API now has a dedicated Omarchy preparation path. It atomically claims `desktop_prepare`, dispatches the VMID-bound QEMU Guest Agent installation once, inspects the dormant guardian, and completes only from an exact boot- and operation-bound receipt.

Resumed dispatched operations are observation-only: they never replay guest installation. Uncertain transport or mismatched capability evidence leaves the same operation pending for later reconciliation. Protected Canary may use this isolated Omarchy bundle without synchronizing the shared Ubuntu provisioner.

This does not make native access launchable. The descriptor continues to report `privateNetworkReachable: false`, `supportsInputTakeover: false`, and `accessReady: false` until direct route and controller-input evidence are accepted.

Verification:

- focused coordinator, host bundle, capability, and API route tests
- dashboard TypeScript typecheck
- direct ESLint on changed TypeScript modules

# Hermes/Hivra live workflow checks

Read this for Hermes/Hivra runtime changes. Select the affected workflow; do not run every row for every edit. Use fresh target IDs, actual service topology and authorised test accounts—never copy old incident IDs or credentials into a reusable script.

| Changed workflow | Meaningful live acceptance |
| --- | --- |
| Launch / native Desktop | Open the normal Hivra launch/detail path in the browser. The selected agent's intended native interface renders; it is not an admin-panel substitute or hidden behind a loading overlay. Verify a useful interaction. |
| Chat / gateway / auth / proxy | From the affected public route and authenticated role, receive a real agent reply. Verify the browser connection where applicable, not merely the gateway's internal health. Never “fix” authentication by disabling it. |
| Web terminal / Docker | Open the real web terminal, run a harmless command, verify output and execution context. Where affected, test input, working directory, resize, Ctrl-C, exit, and cleanup. Check Docker access in the service that actually executes the command, not just another container. Preserve the chosen backend; local shell access and a custom Docker task image are different features. |
| Restart / update / recovery | On an authorised target, record the old revision and relevant state, perform the supported transition, then confirm the new runtime, reconnection, and retained settings/volume identities. Verify the actual restart control when that is the reported bug; a container recreation alone does not test the button. |
| API settings / files / backups | Use the intended UI, confirm requests reach the right authenticated API and return the expected content type, and test the affected save/readback or download. A JSON parse error containing HTML often identifies a routing boundary to inspect, not a reason to suppress the error. Use owned test data; never overwrite a customer's API key for a smoke test. |
| Capacity / resizing | Check the page under the relevant customer role. On an authorised fixture, resize and verify the applied capacity, updated allocation accounting, and ability to launch using the released capacity. A saved form alone is not resource-manager acceptance. |

## Operational lessons

- Native browser chat and messaging may execute in different services. Map the live path; do not assume a socket, key, backend, or dependency configured in the gateway also exists in the native dashboard.
- Preserve the user's native Desktop and custom runtime. If a managed migration cannot safely handle their custom supervisor, report the hold rather than overwriting it or silently clearing the pause.
- Tenant Docker access must stay within that tenant's verified VM/resource boundary. Never expose a shared host daemon or another customer's volumes to satisfy a Docker test. Verify boundary configuration and use safe negative authorisation tests when that boundary changes.
- Check the library actually linked by the executing process when diagnosing a dependency warning. Pulling an image does not prove the running service uses it; persistent source or virtual-environment mounts can change the effective runtime.
- Treat an active interactive CLI, a running service, and a read-only stats client as different things. If closure is explicitly authorised, target the observed session precisely, prefer graceful exit, and verify the service and unrelated processes survive.
- Keep preservation checks strict but meaningful. Container recreation can change generated labels or how the same inherited anonymous volume is represented. Investigate exact differences, volume identity/access and applicable security semantics; neither blindly roll back nor blanket-ignore mount differences.

Use the existing fleet-operations or deployment runbook for operational commands when applicable. This checklist provides acceptance criteria, not generic permission to mutate a VM.

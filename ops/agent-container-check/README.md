# Changed-agent checks (disabled)

The static selector lists the agent kinds touched by a diff without installing
or starting any agent:

```sh
node scripts/release/agent-container-check.mjs changed --base <sha> --head <sha>
```

There is no install workflow, runner command, model credential or
`agent-checks` commit status. Install and reply coverage is limited to the
reference customer journey and rotating full launches when the separate Canary
sweep is running.

Before enabling changed-agent installs, verify all of these:

- Treat installers, dependencies and catalog entries as untrusted. Run only
  in an unprivileged sandbox that supports the target runtime, or a separate
  guest destroyed after each job. The worker gets no runner credentials, host
  mounts, host Docker socket or management network access.
- Admit only explicitly allowed traffic. Give reply probes short-lived,
  revocable test-only model access with an enforced spend cap. Keep upstream
  and standing keys outside the guest; setup does not get reply credentials.
- Keep checkout credentials and GitHub status writes in the trusted
  controller. An unavailable or failed check must never record a pass.
- Validate replies on the runtime's own supported chat surface. Installer
  readiness and a model response outside the runtime are not reply proof.

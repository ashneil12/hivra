# Canary tenant API acceptance — 2026-09-15

Target: `https://canary.hermesos.cloud`. The coordinating task independently mapped Vercel deployment `dpl_H7Sv6mF5VWajNmVdGQL2RwkRxiRg` to revision `5ed3785d7` through Vercel metadata. The API responses themselves do not expose a deployment SHA.

## Controlled setup

Created two email-free Clerk test identities per attempt and one stopped, hostless `hermes_instances` row per identity. Rows had no gateway, provider server, Proxmox node, VM ID, or retained user data. Authentication used short-lived Clerk session tokens. No legal agreement was accepted, message sent, provider capacity purchased, desktop provisioned, or shared service interrupted.

Three attempts created six instance rows total. The first attempt omitted `Sec-Fetch-Site` on session issuance and supplied no terminal-read session parameters; those preliminary denials are not counted as ownership acceptance. A local Python invocation failed because the system Xcode license was unaccepted, so the second attempt repeated those preliminary requests. The third attempt used the required same-origin request headers and a syntactically valid synthetic terminal session key/token.

## Live public API results

| Request | Identity relative to target | HTTP result |
| --- | --- | --- |
| `GET /api/instances/:id?no_sync=true` | Owner | 200, success |
| Same instance read | Foreign | 404, Instance not found |
| `GET /api/instances/:id/backups` | Owner | 200, success; no restore points on hostless fixture |
| Same backup list | Foreign | 404, Instance not found |
| `POST /api/instances/:id/backups`, valid synthetic backup ID and RESTORE confirmation | Foreign | 404, Instance not found |
| `GET /api/instances/:id/desktop-connection` | Foreign | 404, Instance not found or unauthorized |
| `GET /api/instances/:id/terminal/interactive`, synthetic valid session parameters | Foreign | 404, Instance not found or unauthorized |
| `POST /api/instances/:id/terminal/interactive`, action=start | Foreign | 404, Instance not found or unauthorized |
| `POST /api/instances/:id/workspaces/upload`, controlled multipart file in /workspace | Foreign | 500, Internal Server Error; no success payload |
| `POST /api/remote-desktop/sessions`, controller request | Foreign | 409, capability_unavailable; no session token |
| `POST /api/workspace/sessions`, surface=files | Foreign | 409, workspace_unavailable; no session token |
| Same workspace issuance, surface=box-terminal | Foreign | 409, workspace_unavailable; no session token |

## Upload finding and evidentiary limit

The generic upload 500 is an observed error-classification defect, not an observed cross-tenant write. At the tested revision, `ProfileService.getHostIpForInstance` queries both the instance ID and authenticated user ID, then throws `Instance not found or unauthorized` if no row matches. The upload route awaits this function before reaching `sshExec`, and generic `handleApiError` maps the exception to 500. The controlled owner read succeeded and the foreign read returned 404 against the same row.

This source trace and controlled ownership establish the expected early-denial path. The public 500 alone does not distinguish ownership denial from a missing-host error, and no deployed invocation counter or server trace was captured. Hostless fixtures additionally prevented a real runtime target from being available. Do not describe this as independent live instrumentation proving zero backend invocations. A typed ownership error and explicit 404 response are being handled by the isolation-fixes worker; they were not deployed or accepted by this run.

## Cleanup

All six exact owned instance rows across the three attempts were deleted. A subsequent database query for all six IDs returned zero rows. Each of the six created Clerk sessions was revoked and each of the six users was deleted successfully. Raw temporary receipts retain exact cleanup IDs locally; this committed receipt intentionally excludes identity/session identifiers and credentials.

No retained target was used or modified. No runtime shell, provider resource, backup archive, or desktop session was created by this campaign.

## Remaining acceptance gaps

These are real public-API negative checks against existing controlled tenant rows, but the fixtures had no ready desktop/workspace capability. Consequently, the 409 issuance responses prove these foreign requests obtained no token; they do not establish a ready owner receiving a valid token while a foreign identity is denied against the same capability. Valid-token exchange, cross-computer replay, renewal, revocation, and input-authority takeover require a bounded ready capability/session fixture and are not live accepted here.

The backup POST denial establishes owner scoping before restore-point lookup. It does not prove archive-to-instance binding for an existing archive, successful restore, correct restore destination, byte preservation, or service-failure recovery. Separate disposable restore/recovery evidence is required. Source tests alone cannot close those gaps.

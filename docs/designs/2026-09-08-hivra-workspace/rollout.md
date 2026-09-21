# Hivra core workspace rollout

The approved Hivra workspace design is implemented in the dashboard. Navigation, inventories, resource tools, launch and account preferences now share a simpler layout while retaining the dark/paper palette, etched borders, crimson accents, editorial headings and ambient background.

## Changed behavior

- Persistent navigation includes agent/computer search, direct resource shortcuts and account-scoped recent resources. Partial inventory errors remain visible; the existing feature gate controls disabled resource sources.
- Home prioritizes owned resources. Agents and Computers have search/status filters, with full runtime and operating-system catalogs still reachable.
- Resource pages keep their URLs, native interfaces and authentication. Common surfaces stay visible; Tools groups additional surfaces and Manage remains available. Opening navigation controls keeps the work pane mounted.
- Launch presents Choose, Configure and Review while preserving internal stages, placement/capacity checks, stable request IDs, receipts and catalog handoffs. Back/reselect retains unchanged draft settings.
- Mobile navigation has reserved header space; the closed drawer is absent from keyboard/accessibility navigation. The Tools menu fits short windows and safe-area insets. Both navigation rails follow the current resource kind.
- Settings brings account destinations and preferences together, with named switches and selected theme states. Applications reuses browser installation support; Help preserves existing support/legal destinations.

Shared multi-agent conversations and broader orchestration remain follow-on work. This release adds no native application binary or runtime admission capability.

## Revision and deployment record

- Verified Canary baseline: `01ccd135b4fb81efd1dadb4192c1fe69b932993c`.
- Delivery also retains `0db587f00` (remember desktop stream mode per computer).
- First UI revision: `fe38489a43180d3ed5479e4cce367dd50e47529c`.
- Authorized target: Vercel project `hermesos-canary`.
- First deployment: `dpl_3hV8bSvv5rYu9knT5nLFY2DUoNw2`, reported `READY`.
- First immutable deployment: <https://hermesos-canary-pj4jogv2o-ashneil12s-projects.vercel.app>.
- First mobile revision: `0a8025d0239dcaf536bfb3cdfd7bc8ecdea11f33`, deployment `dpl_9yfoKnZSFzwWjTveJQShj5Wv6ELE`, confirmed READY and promoted to Canary.
- Final acceptance-fix revision: `9e1045c549c65a87772c8885365a2b66962a2b0a`.
- Final deployment/build: `dpl_27ds34srpnmCdSJ66q4ajrNWnHEV`, <https://hermesos-canary-ext31oy76-ashneil12s-projects.vercel.app>, READY. Promoted and the `canary.hermesos.cloud` alias verified against this deployment. Final authenticated acceptance completed 2026-09-08 at 22:09 UTC.

The Vercel production alias in the deployment output belongs to the Canary project. Public production rollout and PR merge are outside this record.

## Verification evidence

| Check | Recorded result | Evidence |
| --- | --- | --- |
| Exact first delivery: UI and native-access regression suites | 17 suites, 232 tests passed | `/tmp/hivra-delivery-focused-tests.log` |
| Exact first delivery: TypeScript | Passed; migration manifest unchanged | `/tmp/hivra-delivery-typecheck.log` |
| Review hot paths: billing, provisioning and runtime access | 18 suites, 318 tests passed | `/tmp/hivra-design-hot-paths.log` |
| Review repository lint | 0 errors, 83 warnings | `/tmp/hivra-design-full-lint.log` |
| Full older review checkout | 1,007 suites passed, 10 failed, 2 skipped; 12,195 tests passed, 16 failed, 24 skipped | `/tmp/hivra-design-full-tests.log` |
| Mobile drawer focused regression | 1 suite, 15 tests passed | `/tmp/hivra-mobile-drawer-tests.log` |
| Final delivery: 18 focused suites | 256 tests passed (`jest --runInBand --runTestsByPath`, UI plus native-access and PWA suites) | `/tmp/hivra-final-delivery-tests.log` |
| Final delivery: TypeScript and touched-file lint | Passed; migration manifest unchanged | `/tmp/hivra-final-delivery-typecheck.log`, `/tmp/hivra-final-delivery-lint.log` |

The full suite was not green. Its failures occurred in untouched provisioning, gateway, translation and SQL fixtures on the older review base. Baseline comparisons established the following:

- Untouched delivery `01ccd135b` passes the destination-control suite (20 tests), desktop readiness gateway and model-key coordinator integration. The delivery base already contains fixes absent from the review base.
- Untouched delivery reproduces the staged-profile API assertion failure, desktop cleanup SQL rejection and provider ownership SQL admission failure. These remain existing delivery-baseline failures.
- Additional baseline diagnostics reproduce workspace-session, translation-parity and native-readiness gateway failures. Agent-placement passes that focused diagnostic run.

Comparison logs: `/tmp/hivra-baseline-deployment-destination-tests.log`, `/tmp/hivra-baseline-provider-tests.log`, `/tmp/hivra-route-base-01ccd135b.log`, `/tmp/hivra-model-key-base-01ccd135b.log`, `/tmp/hivra-design-baseline-four-tests.log`. These checks do not constitute a passing full suite on the final deployed revision.

## Authenticated browser acceptance

Chrome, separate task window, authenticated Canary account. The original native Omarchy session was inspected read-only and preserved. Core flows were exercised on `fe38489a4` and `0a8025d02`; the final changed behaviors were rechecked on `9e1045c549c65a87772c8885365a2b66962a2b0a`. Status: **PASS for the dashboard layout and navigation; runtime update gates below limit runtime acceptance.**

| Flow | Observed result |
| --- | --- |
| Home and inventory | Home shows 3 agents and 3 computers, with 5 running and 1 stopped before and after. Windows, Omarchy and Ubuntu retain their profile labels. Agent search plus Stopped isolates the stopped Codex agent; computer search plus Running isolates Windows. Full catalogs remain accessible. |
| Resource switching | Cmd-K opens search and focuses its field; filtering, arrow selection and Enter navigate to the matching source-qualified resource. Escape restores focus. Mobile drawer selection closes it. |
| Resource tools | Chat/Desktop/Terminal/Files remain visible; Tools reveals Browser, Box Terminal, Git, Skills, Telegram, Tasks and Export. Escape, primary selection and Manage remain reachable. Codex Files loaded directory metadata; no file contents were opened. |
| Launch | Computer → Ubuntu → Configure → Review worked. Back retained the test name and hosting selection. A reload resumed the review. Name, location, resources, cost and changes were visible. Final Launch was never submitted. The test draft was reset through the new-launch flow and Cancel. |
| Settings and applications | Settings destinations, named switches and theme choices rendered. Light mode was inspected and System restored. Applications exposed the existing browser install flow and computer access guidance; Help retained support/legal links. No installation or outgoing message was triggered. |
| Mobile | At 360×780, header bottom and banner top both measured 56px; the menu no longer covered the resource title. Closed drawer computed display:none and disappeared from accessibility queries. Escape returned focus to Open navigation. Manage stayed within the viewport. Review footer was reachable above bottom navigation. |
| Short windows | Checked 980×690 desktop and 740×390 landscape. On the final revision, the landscape Tools popup was limited to 130px; the final Export action was fully visible at y=212–252, above the bottom bar at y=317. At 375×667, the popup ended at y=529 and the bar began at y=594. Neither viewport overflowed horizontally. Both navigation rails selected Computers for a loaded computer and Agents after switching to an agent; unresolved metadata stayed neutral. The environment banner used readable rgb(26,26,26) text in Light mode. |
| Console | No browser errors during the inspected flows; only the existing Clerk development-key warning for Canary. |

Preservation: no resources created, stopped, restarted, updated or deleted; no agent prompts, guest input or file changes; no compute purchase or credentials entered. Resource counts/states matched the pre-deploy observation. The test name was removed by resetting its unsubmitted draft. System appearance and the original collapsed sidebar preference were restored. Viewport emulation was reset to the original 1291×744 window; the task browser was left on Home. The native application and other browser session were left untouched.

Existing runtime limitations: the selected Codex agent reports a Chat/connection-service update requirement; Ubuntu Desktop reports a runtime update requirement. These guards were left intact. Live chat, terminal execution and a newly connected Ubuntu desktop session were therefore not accepted as working. The existing native Omarchy window was not reloaded, and no macOS binary was rebuilt or released. Physical iPhone/Safari acceptance is unverified; safe-area layout has regression coverage.

PR: <https://github.com/ashneil12/hermesdeploy-canary/pull/606>, open draft, unmerged. Canary deployment and PR merge are separate transitions.

# Omarchy lab administrator-port admission

Status: source fix with focused shell-workflow checks; no live firewall or
Sunshine authentication acceptance in this checkpoint.

Inspection of the existing lab preparation found that its protected port lists
covered streams but omitted TCP47990, Sunshine administration. A specific
ALLOW IN rule for that port could therefore pass preparation. The native
capability inspector already rejects that exposure with `sunshine_admin_exposed`.
This was a preparation/inspection code inconsistency, not target behavior.

`prepare-omarchy-sunshine.sh` now checks admin exposure separately from approved
streaming clients, before adding rules and again before starting the service.
Direct, range, comma-list, IPv6 and ambiguous profile entries that could allow
administration are refused even for an approved streaming client. The script
does not add an admin-port rule or remove an unexplained existing rule.

Independent review found that checking only ALLOW rules missed UFW LIMIT,
which still admits connections below its rate threshold. The corrected check
rejects both ALLOW and LIMIT administration rules, including opaque profiles.
Regression fixtures cover existing IPv4/IPv6 LIMIT exposure and both actions
appearing during preparation.

Regression evidence:

- The pre-fix regression failed because unsafe existing ingress was checked
  only after adding streaming rules. Source inspection additionally established
  that a direct TCP47990 rule was outside the stream overlap list.
- The actual Bash script runs against isolated command fixtures. Tests assert
  no stream-rule writes or service start on pre-existing admin exposure.
- A rule appearing only during the post-write observation prevents startup and
  invokes rollback for the nine stream rules created by that test operation.
  These are command-fixture checks, not evidence about an actual kernel firewall.
- Focused lab and capability-inspection suites: **45 tests passed**.
- `bash -n scripts/prepare-omarchy-sunshine.sh` and `git diff --check` passed.
- Independent review of the corrected two-file scope found no remaining P1/P2.
  The reviewer ran 19 lab tests, 10 direct Bash cases, syntax and diff checks;
  all passed. No reviewer edits or live actions occurred.

No VM, provider server, existing service, live firewall, route or Canary
deployment changed. No additional spend; reservations remain £6.90/£10. The
planned pinned-Sunshine authentication experiment has not been run. Native
guardian, pairing, desktop/media/input and cleanup acceptance remain open.

Rollback is a source revert through the branch/PR flow. This operator-script
change has not been installed or executed against a live guest.

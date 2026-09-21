# Activity observability: upstream choices

Decision date: 2026-09-21. This document distinguishes integration choices from
deployment evidence. It does not certify fleet-wide monitoring or containment.

## Selected backbone

Use the [OpenTelemetry Collector Contrib](https://github.com/open-telemetry/opentelemetry-collector-contrib)
as the collection boundary, with Hivra-owned normalization and an authenticated,
resource-scoped ingestion endpoint. Its receiver/exporter pipelines allow runtime
logs and traces to reach Hivra without coupling the Activity UI to a vendor.
The upstream project uses Apache-2.0. Release v0.161.0 was the latest GitHub
release when checked; deploy a pinned version and validate its actual config.
See the [Collector configuration guide](https://opentelemetry.io/docs/collector/configuration/).

Hivra's durable event feed is the user-facing evidence index. A downstream
observability service may retain richer performance data independently. Sampled
traces must never be described as a complete security audit trail. A successful
export and a recorded action do not establish successful task completion.

## Repositories evaluated

| Project | Fit | Decision and acceptance boundary |
| --- | --- | --- |
| [OpenTelemetry Collector Contrib](https://github.com/open-telemetry/opentelemetry-collector-contrib) | Protocol collection, bounded processing, exporter routing | Selected integration backbone. Verify both logs and traces over the real collector before calling the wire compatible. |
| [OpenTelemetry JS](https://github.com/open-telemetry/opentelemetry-js) | Instrumentation for Node runtimes/services | Prefer maintained upstream APIs when adding producers; native runtime OTLP emission avoids a redundant custom instrumentation layer. Apache-2.0. |
| [Langfuse](https://github.com/langfuse/langfuse) | LLM tracing, evaluations, prompt workflows | Optional trace destination. Its OTLP trace endpoint is not a general replacement for runtime log or host-security ingestion. Do not send customer payloads to a hosted service by default. |
| [Apache SkyWalking](https://github.com/apache/skywalking) | Service observability, infrastructure analysis and trace storage | Optional operator backend. Check protocol and release support per signal; the existence of an OTLP metrics receiver does not alone establish trace compatibility. Apache-2.0. |
| [Cilium Tetragon](https://github.com/cilium/tetragon) | Independent Linux process/file/network observation and runtime enforcement | Candidate for a separately accepted host collector. Requires a supported kernel, host privilege boundary, resource attribution and collector identity. Not enabled merely by installing an application SDK. Apache-2.0 root license; inspect component licenses before redistribution. |

Langfuse's [license](https://github.com/langfuse/langfuse/blob/main/LICENSE)
uses MIT for the core with separately licensed enterprise directories and
third-party exceptions. Integrating its OTLP endpoint is preferable to copying
enterprise code into Hivra. Its [OTLP integration](https://langfuse.com/integrations/native/opentelemetry)
documents authenticated trace export; credentials stay on the operator side.

SkyWalking's [OTLP trace documentation](https://skywalking.apache.org/docs/main/next/en/setup/backend/otlp-trace/)
describes conversion to its Zipkin trace path. That page is `next` documentation,
not proof that a selected deployed version supports every documented signal.
The GitHub release check returned v11.0.0. No SkyWalking deployment was required
or created by this repository decision.

Tetragon's [installation guidance](https://tetragon.io/docs/installation/) and
[security observation/enforcement documentation](https://tetragon.io/docs/)
make it relevant to host-level evidence. A collector inside an agent-writable
guest cannot guarantee evidence survives guest compromise. Admission must state
which trust boundary observes the action, and OS-specific support must remain
explicit rather than treating Linux coverage as Windows/macOS coverage.

## Runtime signals that matter

[Claude Code](https://code.claude.com/docs/en/monitoring-usage) exports events
through OTLP logs and has separate trace support. Configure the logs exporter
and protocol explicitly. Tool/result/decision records are useful even when
prompt and response-body capture remain disabled. Agent instrumentation does
not observe every process a tool launches, and absence of a log is not evidence
that nothing happened.

[Codex advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced)
documents OpenTelemetry run events and opt-in export. Configure the supported
user-level runtime settings with prompt capture disabled. Keep identity binding
outside untrusted event attributes; a reported run or trace ID is correlation,
not authorization.

## Product and security contract

- Attribute records to the authenticated tenant and explicitly admitted resource.
  Runtime payload fields cannot assert independent host observation or ownership.
- Store a safe allowlist of evidence fields. Omit prompts, response bodies,
  arbitrary command output, headers, credentials and raw infrastructure detail
  unless a separately reviewed capture policy explicitly supports them.
- Separate not configured, configured but never observed, last observed and
  read failure. Last event time is not a collector heartbeat.
- Preserve event IDs, ordering and source provenance across reconnects; duplicate
  delivery must not rewrite prior evidence. Surface bounded history and limits.
- Observation and enforcement are separate. A blocked label requires actual
  policy-enforcer evidence; a requested stop is not a confirmed stop.

Implementation and release receipts must record the selected collector version,
tested protocols, exact application revision, tenant isolation checks, browser
verification, fixture cleanup and any unconnected backend or runtime.

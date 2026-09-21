# Hivra White Paper

## Agent Computers With Boundaries Outside the Agent

**Status:** Complete long-form internal working draft; not cleared for public distribution

**Draft date:** 2026-08-26

**Current scope:** Product thesis, threat model, architecture, operating responsibility, coordination, ecosystem boundaries, roadmap, and token-policy gates

**Primary audience:** Hivra's builders, operators, reviewers, advisers, and technically engaged community members

**Distribution role:** This is Hivra's long-form technical and strategic reference paper. It is intended to become available for public transparency after security, product-truth, licensing, and token/legal review, but it is not the frontline launch document, short-form pitch, or token promotion. A later visual litepaper should summarize only claims that survive the evidence gates defined here.

**Reading note:** This paper explains the product direction in accessible language. It does not override [`VISION.md`](VISION.md), the canonical [product architecture](docs/PRODUCT-ARCHITECTURE.md), the approved [Agent Computers platform design](docs/superpowers/specs/2026-08-24-hivra-agent-computers-design.md), the [security model](docs/SECURITY-MODEL.md), or the active [`ROADMAP.md`](ROADMAP.md). Controls described as **target** are requirements, not claims that they are already implemented. Token possibilities are decision inputs, not economics, migration terms, or investment terms.

**Capability labels:** **Current** means verified in the present repository or operation; repository-current evidence alone does not mean deployed or publicly available. **Building** means implementation has started but the acceptance boundary has not passed; **Target** means approved required behavior; and **Exploratory** means an idea remains unadopted.

## Contents

1. [Why Hivra Exists](#1-why-hivra-exists)
2. [Threat Model](#2-threat-model)
3. [The Hivra Security Thesis](#3-the-hivra-security-thesis)
4. [What Hivra Can and Cannot Promise](#4-what-hivra-can-and-cannot-promise)
5. [Principles for the Rest of the Paper](#5-principles-for-the-rest-of-the-paper)
6. [A Real Computer for an Agent](#6-a-real-computer-for-an-agent)
7. [System Architecture and Security-Control Layers](#7-system-architecture-and-security-control-layers)
8. [One Platform, Different Operating Responsibility](#8-one-platform-different-operating-responsibility)
9. [Mediated Memory, Communication, and Delegation](#9-mediated-memory-communication-and-delegation)
10. [Ecosystem Products and Research Boundaries](#10-ecosystem-products-and-research-boundaries)
11. [A Capability-Dense, Evidence-Gated Roadmap](#11-a-capability-dense-evidence-gated-roadmap)
12. [Token Policy Boundary and Decision Gates](#12-token-policy-boundary-and-decision-gates)

## Abstract

AI agents are becoming capable computer users. They can write and run code, operate browsers, edit files, use credentials, communicate with external services, and continue working for long periods. Those abilities make agents useful. They also make the computer on which an agent runs part of the security boundary.

Today, that computer is often the same personal device that holds the user's messages, photographs, browser sessions, source code, customer data, financial access, and identity. Permission prompts and application policies can reduce risk, but they are thin controls when the runtime, tools, credentials, and valuable data still share one environment. The danger does not require a conscious or hostile AI. A compromised runtime, prompt injection, malicious dependency, stolen session, software defect, excessive permission, or simple operator mistake can be enough.

Hivra's thesis is that a capable agent should have its own computer: a separately bounded, isolated, inspectable, and recoverable environment that is distinct from the user's personal device but still feels immediate to use. The user should be able to reach the agent from anywhere, bring their preferred runtime and infrastructure, and retain meaningful control without maintaining the agent locally.

In this paper, an agent's **own computer** means an independently identified environment with an explicit policy, storage, network, and lifecycle boundary. It does not necessarily mean dedicated physical hardware. Hivra must disclose whether the real boundary is dedicated hardware, a hardware or provider VM, an application-kernel sandbox, or a shared-kernel container.

Moving an agent to the cloud does not make it safe by itself. Hivra's proposed security boundary comes from the controls around the agent computer: explicit identity, honest isolation classes, scoped credentials, constrained network reach, brokered access, approval boundaries, durable activity records, rapid revocation, and tested recovery. Those controls must be enforced by infrastructure and control-plane policy rather than depending on the agent to restrain itself.

## 1. Why Hivra Exists

### 1.1 The agent is becoming a computer user

Earlier AI products mostly returned text. Agent runtimes can now translate model output into consequential actions: opening a terminal, changing a repository, downloading software, sending a request, operating a browser, or invoking another service. The external model is only one component in that chain. The practical authority comes from the combination of the model, agent runtime, tools, credentials, network access, and host computer.

This changes the security question. It is no longer only, "What information can the model produce?" It is also:

- What can this runtime reach?
- Which credentials can it use?
- What can it change without approval?
- What evidence remains after it acts?
- How quickly can its authority be revoked?
- What survives if the runtime, computer, network, or control plane fails?

### 1.2 The ambient-authority problem

A personal computer accumulates authority. Browser cookies, SSH agents, cloud CLIs, source-control credentials, password managers, local files, mounted drives, private messages, and authenticated applications may all be available somewhere on the device. Even when an agent is given access to only one folder or tool, the surrounding operating environment often contains far more value than the task requires.

This is **ambient authority**: power inherited from the environment rather than granted narrowly for one purpose. The more capable and persistent the agent becomes, the more dangerous that inherited authority can be.

Permission systems remain useful, but they are not a complete answer. A permission prompt may authorize a category of action without constraining every later consequence. A runtime may retain authority longer than intended. A user may approve a request without seeing the full chain of effects. A defect or compromise may occur beneath the application's own policy layer. A security design that depends only on the agent interpreting instructions correctly is ultimately asking the component being constrained to help enforce its own constraint.

### 1.3 Separation before intelligence

Hivra does not need to predict whether AI will become sentient, malicious, or dramatically more capable. Its architecture starts from a simpler assumption: software with meaningful access will sometimes behave unexpectedly, and some actors will deliberately make it behave badly.

The defensive response is familiar: separate valuable environments, minimize authority, mediate access, record consequential actions, and make recovery possible. Hivra applies those principles to agent computing before greater capability makes retrofitting them harder.

The immediate objective is not to encourage everyone to use AI or to maximize the number of autonomous agents. It is to provide a safer operating model for people who already choose to run capable agents: move execution away from the personal computer without losing the convenience and responsiveness that made local operation attractive.

### 1.4 The core proposition

> **Target proposition:** Hivra is building isolated, observable, and revocable computers for AI agents, so users do not have to grant them ambient authority over the personal devices where their lives and businesses reside.

An agent computer is not a chat wrapper or a dashboard card. It is a real computing environment with explicit compute, storage, network, operating system, runtime, credentials, access surfaces, lifecycle, and recovery state.

The experience should remain simple: choose an agent, choose where its computer runs, authenticate it, and begin working. The enforcement underneath that experience must remain rigorous even when the interface feels local and immediate.

## 2. Threat Model

### 2.1 Scope

Hivra is designed for agents that may execute code, use browsers and networks, manipulate files, access selected credentials, and run while the user's own device is disconnected. The security objective is to reduce the blast radius of failure or compromise, preserve useful evidence, and support fast containment and recovery.

The threat model assumes that any one of the following may be faulty, compromised, maliciously influenced, or misconfigured:

- the agent runtime or one of its tools;
- content processed by the agent, including webpages, repositories, documents, messages, shared memory, peer-agent messages, and tool output;
- an external model or integration response;
- an installed package, image, update, or other supply-chain component;
- a user session or access grant;
- an individual agent computer;
- infrastructure or runtime credentials;
- a user deliberately attempting to use an agent as an attack proxy;
- control-plane or operator software; or
- the human configuring or approving an action.

The model does not treat every component as hostile at all times. It treats compromise as possible and asks what a single compromised component can reach next.

### 2.2 Assets to protect

The primary assets are:

- the user's personal devices, local network, and the data and sessions stored on them;
- source code, customer information, business records, and work artifacts;
- runtime, integration, source-control, and infrastructure credentials;
- the integrity and availability of each agent computer;
- neighboring users, computers, tenants, and capacity pools;
- third parties and external systems that an agent can contact or affect;
- the Hivra control plane and provider control surfaces;
- snapshots, backups, archives, logs, and audit records; and
- the integrity of reported state, actions, and outcomes.

### 2.3 Trust boundaries

Hivra treats the following as separate zones rather than one trusted application:

```text
User device
    |
    | short-lived, scoped access
    v
Hivra control plane ---- Credential store
    |          \               |
    |           \              | purpose-bound release
    |            \             v
    |             -----> Agent computer
    |                    |  Agent runtime and tools
    | provider lifecycle |  Computer identity and policy
    v                    |
Provider control -------+  constrained outbound access
surface                  |
                         v
                  Models and integrations

Backups, archives, and operator access remain separate trust zones.
```

The provider control surface is reached by the authorized control plane, not exposed as ambient authority inside the guest. Runtime credentials may be released to the narrowly authorized runtime boundary; infrastructure credentials remain outside the agent computer.

Compromise of one agent computer must not grant access to the control plane, infrastructure-provider credentials, backup keys, neighboring computers, or unrelated user credentials. This is a target invariant that must be verified, not assumed.

### 2.4 Principal threats and responses

| Threat | Example consequence | Hivra's target response | Residual risk |
|---|---|---|---|
| Agent or tool behaves unexpectedly | Deletes files, changes code, or sends an unintended request | Separately bounded agent computer, scoped workspace, approval policy, snapshots, and durable action records | Authorized destructive work may still cause damage; not every external effect can be reversed |
| Prompt injection or hostile input | A webpage, repository, or message induces unsafe tool use | Treat content as untrusted, constrain tools and credentials, restrict network reach, and require approval at chosen boundaries | A permitted action can still be manipulated; policy cannot perfectly determine intent |
| Guest or runtime compromise | Attacker gains control of one agent computer | Honest isolation class, separate computer identity, no provider credentials in the guest, brokered inbound access, and revocable grants | Hypervisor, kernel, firmware, or provider vulnerabilities may cross the intended boundary |
| Credential theft or misuse | Agent exfiltrates or abuses a token | Purpose-bound bindings, least-privilege credentials, short lifetimes where supported, redaction, rotation, and revocation | A credential deliberately released to a runtime can be misused within its real scope |
| Stolen user session | Attacker opens a terminal or computer surface | Grants bound to user, computer, surface, audience, purpose, and expiry | A valid compromised session may act until detected or revoked |
| Control-plane or operator compromise | Attacker issues commands across computers | Strong administrative separation, scoped service identities, auditable operations, exact target validation, and independent tenant boundaries | A sufficiently privileged control-plane or infrastructure compromise can defeat lower layers |
| Supply-chain compromise | Malicious image, package, adapter, or update runs | Versioned assets, image provenance and digests, pinned adapters, review, staged rollout, rollback, and vulnerability response | Trusted upstreams and build systems can still be compromised |
| Network failure or duplicate delivery | A run repeats a consequential action or appears complete when it is not | Durable identities, ordered events, leases, idempotency, visible recovery states, and immutable terminal outcomes | Some third-party actions are not idempotent and require reconciliation or human judgment |
| Backup or restore misuse | Deleted or revoked secrets reappear after restore | Separate backup keys, authorized and audited restore, explicit credential re-binding, and retention-aware deletion | Retained external copies and provider-level recovery may lie outside Hivra's control |
| Misconfiguration | Weak isolation or excessive access is selected accidentally | Safe defaults, capability preflight, explicit warnings, and no silent downgrade or provider spending | Self-hosted operators retain responsibility for the infrastructure they control |
| Host connection, discovery, or preparation abuse | A supplied endpoint pivots into a private network, impersonates a host, returns malicious discovery data, or receives an unsafe root-level preparation | Owner-scoped connection checks, address and resolution controls, pinned host identity, bounded commands and output, strict schema validation, revision expiry, versioned preparation plans, explicit approval, audit, and rollback guidance | A customer-controlled host can lie about itself, and approved privileged preparation can still damage or weaken that host |
| Deliberate abuse | A user employs an agent for scanning, spam, fraud, intrusion, or harassment | Attributable egress, acceptable-use enforcement, bounded capabilities, abuse monitoring, rate limits, and incident response | Hivra cannot prevent every misuse of an otherwise legitimate capability |
| Resource exhaustion or unbounded spend | A loop consumes compute, storage, tokens, or provider budget | Resource quotas, runtime limits, explicit provider-spending policy, alerts, and external shutdown | Work may still consume the resources deliberately authorized within those limits |
| Cross-agent or shared-memory cascade | A compromised peer or poisoned memory spreads unsafe instructions across computers | Treat every peer message as untrusted input; authenticate its source; scope communication by identity, project, capability, and policy; preserve authority and budget lineage; quarantine abnormal propagation | Authentication proves origin, not safety; permitted collaboration can still amplify failure |
| Return path to the user device | A hostile file, webpage, terminal sequence, clipboard payload, or native surface exploits or deceives the user's client | Brokered short-lived surface grants, separate automation and human takeover, explicit file transfer, patched clients, and no assumption that guest content is trusted | A user may still open unsafe content, and access clients may contain exploitable defects |
| Audit or support-data exposure | Logs, artifacts, crash reports, or support exports leak secrets or customer content | Minimize collection, isolate tenants, encrypt records, restrict operator access, redact secrets, and define retention, export, and deletion | Useful evidence remains sensitive and may expose information if its own controls fail |

### 2.5 Threats Hivra cannot eliminate

No agent platform can honestly guarantee the absence of compromise. Hivra cannot eliminate:

- vulnerabilities in processors, hypervisors, operating systems, providers, runtimes, models, or dependencies;
- malicious or negligent actions by a sufficiently privileged infrastructure operator;
- harm performed through authority the user intentionally grants;
- irreversible effects in external systems after an authorized request leaves the computer;
- data disclosure to a model or integration that the user explicitly authorizes the runtime to contact;
- all side channels or covert communication paths;
- the consequences of unsafe self-hosted configuration; or
- uncertainty about an agent's internal reasoning or future capabilities.

The architecture therefore does not depend on determining whether an agent is conscious, trustworthy, or aligned. It constrains observable capabilities and system boundaries.

### 2.6 Capability review

Every new tool, integration, communication path, and agent capability should answer:

1. What can it read, modify, delete, transmit, publish, or spend?
2. Which identity and credential does it use?
3. Is that authority purpose-specific and time-limited?
4. Is the action reversible after it leaves the agent computer?
5. What is the maximum plausible damage, disclosure, or cost?
6. Which event requires human approval or stronger policy?
7. What evidence is recorded outside the guest's authority?
8. How is access revoked during an incident?
9. How is the environment returned to a known state?
10. What residual risk remains after every control works as intended?

This review is capability-based: the same questions apply whether unexpected behavior comes from model error, hostile input, compromised software, deliberate abuse, or greater future autonomy.

## 3. The Hivra Security Thesis

### 3.1 The boundary must sit outside the agent

Prompts, constitutions, runtime policies, and model safeguards can reduce unsafe behavior, but none should be the final enforcement point. The decisive controls must sit beneath or around the runtime, where the agent cannot rewrite them merely by producing a different output.

> Hivra does not assume an AI agent is trustworthy. It constrains what the agent can reach, records mediated and instrumented system activity, preserves the ability to revoke Hivra-issued authority and stop or quarantine the computer, and provides a path back to a known state. Effects already accepted by an external system may outlive containment.

Hivra's target design uses several reinforcing properties.

#### Target: A separately bounded execution environment

The agent must work inside a separately identified computer rather than inheriting the user's personal environment. Its storage, processes, network identity, policy, and lifecycle must be bounded independently. The real isolation strength may vary and must be disclosed.

#### Target: Truthful isolation

Hivra supports different execution boundaries because infrastructure differs. A provider VM, hardware VM, application-kernel sandbox, and shared-kernel container do not offer identical compromise resistance. The selected isolation class must be displayed honestly, and Hivra must never silently substitute a weaker boundary. A shared-kernel driver may run only inside a dedicated or same-owner declared trust domain; it cannot host mutually untrusted tenants or earn a cross-tenant containment claim without stronger future evidence.

#### Target: Explicit identity and command authority

Every computer must have its own cryptographic identity. Commands, runs, and human access must be authenticated, scoped, replay-resistant, and revocable. A grant for one user, computer, or surface must not become ambient access to another.

#### Target: Purpose-bound credentials

The computer must receive only the credential material required for an authorized purpose. Infrastructure-provider credentials must remain outside guest computers. Credential bindings must be scoped, redacted from ordinary records, rotatable, and governed by explicit backup and deletion behavior.

#### Target: Constrained connectivity

Inbound access must be brokered rather than exposed by default. Protected workloads should begin with default-deny outbound policy and destination allowlists. Address and identity checks must be repeated after DNS resolution and redirects; loopback, link-local, private, and cloud-metadata destinations require explicit same-trust-domain policy. Proxies, VPNs, DNS-over-HTTPS, tunnels, and other bypass paths need separate control. Agent-to-agent or cross-server communication, when introduced, must use mediated identities rather than ambient trust between machines.

"Attributable egress" means that traffic observed at Hivra's enforcement point can be associated with a tenant and computer. It does not prove the identity of a downstream actor, reveal encrypted content, or cover independently permitted out-of-band channels.

Before delegation or agent-created computers become adopted capabilities, authority must not amplify silently. A child agent or computer should inherit only an explicit subset of the delegator's capabilities and budget unless an authorized person approves expansion. Hivra must retain the lineage connecting the original user, delegating agent, new identity, granted capabilities, spending limits, and resulting actions.

#### Target: Observable action, not claimed thought-reading

Hivra must record consequential system facts: who requested an operation, which computer and capability were targeted, what acknowledged it, what provider or runtime mutation occurred, and how it ended. Target evidence spans control-plane operations, provider mutations, runtime and tool events where available, and brokered network and access activity. Security-relevant records must be protected outside the guest's authority so the guest is not the sole historian of its own behavior.

Observability data must also be treated as sensitive. Collection should be purpose-limited; tenant boundaries, encryption, operator authorization, redaction, retention, export, and deletion must apply to logs and support data as deliberately as they apply to the original workload. Hivra must not pretend to observe an agent's private reasoning or infer progress that the runtime did not report.

#### Target: Revocation and recovery

Security includes what happens after something goes wrong. Controls outside the guest must be able to stop or quarantine the computer, block mediated network paths, disconnect brokered model access, revoke grants, rotate credentials, reconcile drift, and restore recoverable state under an explicit policy. Blind retry is not recovery when side effects may still be occurring. Revocation cannot recall a message, payment, deletion, or other effect that an external system already accepted.

### 3.2 Target: Cloud is a location; control is the security property

Running on remote infrastructure creates valuable separation from the user's device, but it also introduces a provider, control plane, network path, operator, and backup system. Each becomes part of the threat model.

Hivra-managed operation therefore cannot be described as intrinsically safe, and self-hosting cannot be described as intrinsically sovereign. The relevant questions are who controls the infrastructure and keys, which boundary is actually used, what authority enters the guest, what can communicate, what evidence exists, and how containment and recovery are tested.

Hivra's managed and self-managed modes must use the same functional platform. They differ in credential ownership and operational responsibility, not in whether the customer receives the real product.

### 3.3 Target: Security and usability are co-equal

A secure design that is too difficult to use will be bypassed. A convenient design without enforceable boundaries simply relocates the risk. Hivra's target experience combines the ability to:

- launch and reach an agent as easily as a local application;
- keep the agent available when the user's device is closed;
- preserve useful runtime-native interfaces;
- choose Hivra-managed or user-owned infrastructure;
- expose advanced controls without making them mandatory for ordinary use; and
- enforce the same security invariants underneath both simple and advanced paths.

Simple setup may choose safe defaults. It may not conceal the selected isolation class, silently spend money, weaken isolation, or cross another user's boundary. Advanced setup may expose more compatible choices. It may not turn unsupported or unsafe combinations into valid ones.

## 4. What Hivra Can and Cannot Promise

### 4.1 Claims Hivra intends to earn

Once the relevant controls and acceptance tests exist, Hivra should be able to substantiate narrowly worded claims such as:

- an agent can work without direct access to the user's personal computer;
- one agent computer has an explicit, inspectable execution boundary and identity;
- compromise of one guest does not automatically grant access to unrelated guests or provider credentials;
- human access and control-plane commands are scoped and revocable;
- the product displays observed lifecycle and execution state rather than invented progress;
- credentials, network reach, and approval boundaries can be constrained by policy;
- consequential lifecycle and execution events produce useful audit evidence; and
- computers, access, credentials, snapshots, and backups follow tested containment, recovery, retention, and deletion procedures.

Each public claim must point to an implemented control and repeatable evidence. Architecture alone is not evidence.

### 4.2 Claims Hivra must not make

Hivra must not claim that:

- an agent is harmless, aligned, or incapable of deception;
- cloud execution is automatically secure;
- isolation makes compromise impossible;
- every action can be understood in advance or reversed afterward;
- audit records reveal the agent's complete internal reasoning;
- permission prompts alone solve unsafe delegation;
- self-hosting removes the need for key management, patching, monitoring, and recovery;
- managed operation removes provider or operator trust; or
- current implementation already satisfies a target control that has not passed acceptance testing.

### 4.3 Current implementation, building work, and target architecture

The repository already contains meaningful agent-computer substrate, but the complete security thesis is a target rather than a shipped claim. This snapshot distinguishes two different evidence levels:

- **Repository-current:** committed source through `767c79443` on 2026-08-26, including generic host connections and read-only discovery.
- **Canary-verified:** the cited non-destructive deployment and authenticated browser evidence remains the earlier `f68dbae54` portable-canary milestone. The later generic-host additions have not been promoted to canary-verified status by this paper.

The canonical current-state map and roadmap still cite the earlier canary milestone while later generic-host code is committed. That is documentation drift in the repository-current inventory, not evidence that the later code has been deployed or accepted.

Neither level is the Phase 1 portability exit. The destructive user-owned-host provisioning, native-access, restart, and residual-resource deletion run remains outstanding. Every snapshot must be refreshed before public circulation.

| Area | Current | Building | Target required before the claim is earned |
|---|---|---|---|
| Compute separation | Existing Proxmox VM provisioning and placement are present | Capacity-aware isolation selection and infrastructure preflight foundations have begun | Canonical computer identity, capability-selected isolation, and verified cross-computer boundaries |
| Agent experience | Existing catalog, launch, agent-detail, Hermes, browser, terminal, and other agent-specific surfaces exist | — | Portable provisioning through one contract while preserving useful native interfaces |
| Lifecycle | Power, resize, archive, restore, deletion, recovery, and operational events exist across current paths | — | One desired/observed/health/operation model with idempotent reconciliation and truthful terminal outcomes |
| Credentials | Existing credential handling is present | Owner-scoped infrastructure-connection work separates connection validation from runtime credentials | Typed bindings, least-privilege release, consistent redaction, rotation, revocation, backup, and deletion behavior |
| Access | Multiple current access surfaces exist | — | Short-lived grants bound to user, computer, surface, audience, purpose, and expiry |
| Observability | Metrics and operational events exist | — | Durable tenant-safe evidence that covers commands, runs, provider mutations, approval, recovery, and outcome without leaking secrets |
| Portability | Canary evidence through `f68dbae54` covers the additive managed/self-managed selector, owner-scoped Proxmox targets, target-bound launch authority, and versioned provisioner; later repository commits add generic host connections and revision-bound read-only discovery that creates no deployment target, but this paper has not canary-verified those additions | User-facing substrate recommendation and explicitly approved generic-host preparation, strict post-preparation preflight, and the complete user-owned-host path have not passed acceptance | Reproducible public adapters, self-managed keys, clean install, upgrade, backup, export, and uninstall across supported substrates |
| Control-plane consistency | Hermes, Hivra-agent, and Workspace paths provide useful capabilities through fragmented backend contracts | — | Canonical contracts and explicit migrations replace fragmented lifecycle and identity paths |

Important current gaps include overlapping backend lanes, remaining mutable host-side provisioning assets outside the repository, older access paths that predate the target grant contract, incomplete generic-host inspection and preparation, the unpassed destructive portability case, and public-release licensing and review gates. These are known architectural risks, not proof that each area contains an exploitable vulnerability.

## 5. Principles for the Rest of the Paper

The rest of this paper preserves the following rules:

1. **Infrastructure enforces; the agent does not self-police.**
2. **Cloud separation helps, but cloud location alone proves nothing.**
3. **Every isolation class and operational state is described truthfully.**
4. **Security claims follow implementation and evidence.**
5. **Usability is part of the security model because unusable controls are bypassed.**
6. **Managed and self-managed operation remain the same functional platform.**
7. **Communication across computers is mediated, identity-aware, policy-bound, and observable.**
8. **Recovery, revocation, export, and deletion are first-class behavior.**
9. **Open source must be operationally useful, not presentation-only.**
10. **Token mechanics do not define or substitute for the security architecture.**

## 6. A Real Computer for an Agent

### 6.1 Agent identity is not infrastructure

An agent is a software identity with instructions, memory references, policies, credential bindings, interface preferences, and a chosen runtime. An Agent Computer is the separately bounded environment in which that identity is allowed to act. Hivra keeps the two distinct so that a computer can be recovered, replaced, or retired without pretending that a chat record is infrastructure, and so that an agent's authority can change without giving it ambient access to the user's personal machine.

```text
Agent identity
instructions · memory references · policy · runtime preference
                         |
                         | runs on
                         v
Agent computer
OS · compute · storage · network · identity · lifecycle
                         |
                         | is placed on
                         v
Capacity
Hivra-managed · customer-owned
```

The first product may use one primary agent identity per computer. The architecture must not make this a permanent assumption. Whatever later relationship is supported, the user must always be able to distinguish who the agent is, which computer is executing its work, which capacity hosts that computer, and which permissions apply at each boundary.

### 6.2 Local-like, without running locally

Hivra's intended experience is local-like in a specific sense:

- the user can reach the agent and its working environment without first maintaining a local server;
- files and useful working state persist inside the selected computer;
- supported terminal, Git, browser, file, and runtime-native surfaces remain available;
- work can continue while the user's own device is closed; and
- another authorized device can reconnect without moving the execution environment.

The user's laptop or phone becomes a control and access surface rather than the place from which the agent inherits ambient authority.

Local-like does not mean offline, zero-latency, unrestricted access to personal files or peripherals, support for every runtime, or a complete graphical desktop today. It also does not mean that a remote environment can never affect a personal device. A file transfer, browser surface, terminal sequence, clipboard payload, or deceptive interface can still form a return path. Hivra must mediate those surfaces and treat guest-generated content as untrusted.

### 6.3 Target: the agent-first journey

The near-term target keeps the existing agent catalog, launch flow, detail screens, and valuable native interfaces. The platform is made portable behind that experience before a richer workspace is allowed to replace it.

```text
Choose or create an agent
          |
          v
Configure its runtime and credentials
          |
          v
Choose Hivra-managed service or supported customer-owned capacity
          |
          v
Inspect capacity and select a truthful isolation boundary
          |
          v
Provision the real computer
          |
          v
Open the agent's Hivra or runtime-native interface
          |
          v
Work · observe · recover · snapshot · restore · retire
```

Connecting capacity and launching an agent are separate actions. A customer-owned host is first connected and inspected without mutation. The endpoint must be owner-scoped, address-checked, and bound to the expected host identity; discovery commands and output must be bounded, sanitized, and treated as untrusted evidence rather than instruction. If preparation is needed, Hivra must pin a versioned exact plan, disclose its privileged mutations and rollback implications, and obtain explicit consent. The host may require installation, configuration, a reboot, or a reconnect. Only a fresh strict adapter and runtime preflight may publish launch authority. Discovery evidence alone is never a deployment target.

The first launchable self-managed substrate is an existing or explicitly prepared Proxmox KVM environment. Once the destructive acceptance case passes, this slice is intended to prove one strong VM boundary; it is not a claim that every generic Linux server can already launch an Agent Computer. Later adapters must earn equivalent lifecycle acceptance for their real isolation classes.

Projects and tasks remain optional. A person should be able to choose an agent and start a conversation without first adopting Hivra's organizational model.

### 6.4 Simple and Advanced setup

Simple setup should make a sound selection without pretending that unsupported combinations work. It asks for the intended agent and infrastructure outcome, checks the target and runtime, selects the strongest compatible isolation driver, and proposes conservative CPU, memory, disk, storage, and network defaults. If the request cannot be satisfied, it explains the real constraint and offers only compatible remedies.

Advanced setup may expose:

- isolation driver and disclosed isolation class;
- node or capacity-pool placement;
- CPU, memory, storage, and accelerator allocation;
- network and outbound-access policy;
- dedicated or shared placement where supported;
- repair and operator access; and
- provider-spending policy.

Both paths enforce the same invariants. Advanced does not mean "disable safety." Neither path may silently purchase capacity, spend through an unapproved provider account, cross another user's boundary, fall back to ambient Hivra credentials, or substitute a weaker isolation class without an explicit new choice.

### 6.5 Target: one computer, several honest interfaces

In the target system, each interface is a view into the same selected computer, not a separate execution system:

- the existing agent-specific interface remains the near-term default;
- a useful runtime-native web or desktop interface is preserved where supported;
- terminal, files, Git, and browser capabilities are advertised only when the selected runtime and computer provide them;
- browser automation and human takeover have distinct visible controllers; and
- an optional focused workspace may later unify proven capabilities without creating another identity, lifecycle, credential, or execution lane.

This is not current backend reality. Existing Hermes, Hivra-agent, Workspace, browser, and native surfaces provide useful experiences through fragmented identity, lifecycle, and execution paths. Compatibility adapters and explicit migrations must converge them before the one-computer claim is earned.

A full graphical Linux desktop is a later capability. Windows follows only after the Linux lifecycle and access contracts mature. macOS requires legitimate Apple hardware and a compliant operational design. None of those later surfaces may become an unscoped shortcut around computer identity and access grants.

### 6.6 Continuity is part of the product

The durable product advantage is not merely creating a virtual machine. It is making the entire computer lifecycle calm and understandable, including when something fails. The target experience reconnects to the same conversation and run after refresh, resumes ordered events after disconnection, preserves recoverable work across runtime or worker restart, displays approvals and required input, prevents duplicate execution during retry, and exposes power, resize, snapshot, restore, and deletion as real operations.

Hivra should feel calm during failure. The user should be able to see what is known, what remains uncertain, what has stopped, and what action is safe next. A provider accepting a request is not proof that a resource changed. A runtime reporting success is not proof that an external effect completed. Deletion is not complete until the resource and its documented residual state are reconciled.

### 6.7 Product status at this draft

| Status | Honest description |
|---|---|
| **Current** | The repository contains an agent catalog, launch and detail screens, managed agent paths, Hermes and other agent-specific surfaces, browser and terminal capabilities, Proxmox and Hetzner substrate, and lifecycle and recovery behavior across fragmented lanes. Canary evidence through `f68dbae54` covers the destination selector, owner-scoped Proxmox targets, explicit Proxmox preparation, target-bound lifecycle authority, and versioned provisioner. Later repository commits add generic host connections and read-only discovery, but those additions are not canary-verified by this paper. |
| **Building** | The user-facing evidence-backed substrate recommendation and generic-host preparation flow, the complete Simple/Advanced placement experience, and the destructive user-owned-host acceptance run. |
| **Target** | One canonical computer identity and lifecycle, versioned provider and runtime adapters, durable runs and events, short-lived selected-surface access, the supported catalog on one portable contract, complete self-hosted operations, optional proven workspace, projects and fleet views, full Linux desktop, provider-supported mobility, Windows, and compliant macOS. |
| **Exploratory** | Agent-requested creation of additional computers, making a unified workspace the default without usage evidence, a standalone Gate product, Hivra Exchange, and a distributed peer-compute mesh. |

Agent-created computers remain **Exploratory** until non-amplifying authority, budget lineage, approval, containment, and residual-resource deletion are designed and tested.

## 7. System Architecture and Security-Control Layers

### 7.1 Target: the boundary is a stack, not a sandbox

An Agent Computer is not secured by one permission dialog, container, virtual machine, network, or model policy. It is secured by a chain of independently enforced boundaries. Each layer assumes that the layer closer to the agent may fail.

```text
User or authorized agent
          |
          v
Identity · policy · approval · spending decision
          |
          v
Canonical run or lifecycle operation
     /             |               \
Command        Credential         Provider
broker         broker/proxy       adapter
     \             |               /
        Capability-selected isolation
                    |
          Versioned computer runtime
                    |
           Agent runtime and tools
                    |
          Independently authorized
             external services

Evidence plane observes each boundary.
Containment plane can revoke, disconnect, quarantine, or stop it.
```

The architecture has three practical planes:

- The **control plane** holds canonical identity, policy, desired state, credential bindings and release policy, approvals, placement, lifecycle operations, and durable runs. Raw credential material and the key hierarchy remain a separate trust zone.
- The **execution plane** contains the selected isolation driver, computer runtime, agent runtime, tools, workspace, and permitted connections.
- The **evidence plane** preserves source-labelled observations, acknowledgements, mutations, outcomes, recovery actions, and security events outside the guest's sole control. Some events remain guest-reported rather than independently verified.

Containment is a cross-plane function. It must still work if the runtime is compromised, confused, or unreachable.

### 7.2 Target control layers

| Layer | Enforcement responsibility | It must not depend on |
|---|---|---|
| Human and policy authority | Authenticate the actor; bind purpose, target, capability, budget, expiry, and approval | A natural-language prompt being interpreted as permission |
| Canonical control plane | Resolve the exact computer and policy; persist a stable run or operation before mutation | Guest-local state as the sole source of truth |
| Provider and capacity boundary | Discover and admit capacity; enforce spending policy; mutate exact provider resources | Provider credentials inside the guest |
| Truthful compute isolation | Enforce and disclose `provider-vm`, `hardware-vm`, `application-kernel`, or `shared-kernel` boundaries | The word "cloud" implying isolation strength |
| Computer identity and command transport | Enroll a revocable computer identity; bind command target, audience, expiry, protocol version, replay protection, and idempotency | A long-lived shared secret or mutable hostname alone |
| Credential and integration brokerage | Release only purpose-bound authority to an authorized runtime or proxy | One reusable token granting broad ambient access |
| Network and interactive access | Deny inbound access by default; broker short-lived surface grants; constrain outbound reach | A private network being automatically trusted |
| Downstream authorization | Require tools, gateways, stores, and external systems to enforce real permissions | The model deciding whether its own request is allowed |
| Evidence and recovery | Record consequential facts outside the guest; reconcile and restore safely | The guest being the sole historian of its behavior |
| External containment | Revoke identities and grants, stop credential release, restrict egress, quarantine, and stop | Cooperation from the runtime being contained |

If an external service supports only a reusable credential inside the guest, Hivra must disclose the larger blast radius instead of implying that it is equivalent to a short-lived, destination-bound credential or a brokered request.

Computer enrollment should be one-time and bind the tenant, canonical computer identity, exact provider resource and target, approved image digest, protocol version, and short expiry. The private key should be generated and protected inside the selected boundary where feasible; replayed enrollment must fail, and rotation and revocation must be supported. A valid computer signature proves the enrolled origin of a message, not that a compromised runtime is reporting the truth.

The approved first-release target uses interactive access grants that expire within five minutes by default and stop authorizing new connections within 60 seconds of revocation. These are acceptance thresholds, not current service claims.

### 7.3 Target flow for a consequential request

1. Authenticate the requesting human or agent.
2. Resolve the exact agent, computer, project, task, requested capability, budget, and delegation lineage.
3. Evaluate policy and required approval outside the runtime.
4. Persist a stable operation or run before making a consequential mutation.
5. Mint only the minimum temporary authority required.
6. Deliver a replay-resistant command to the selected computer identity.
7. Require durable acknowledgement before displaying accepted or running state.
8. Collect ordered runtime events and independent provider or gateway observations.
9. Pause at any approval boundary and bind the approval to the exact operation, material parameters, and expiry.
10. Reconcile the external outcome before declaring success, retrying, restoring, or deleting.

Delivery acknowledgement and runtime execution are different facts. Desired computer state, provider-observed state, Hivra health, and the current lifecycle operation are different facts. Compressing them into one convenient status makes uncertainty invisible and makes unsafe retry more likely.

### 7.4 Target invariants to prove

- Compromise of one guest does not grant provider, control-plane, backup-key, neighboring-computer, or unrelated-user access.
- Authority remains equal or becomes narrower as it moves toward an agent; it never expands implicitly.
- No agent-created computer receives ambient parent credentials or unapproved spending authority.
- Provider reality is not overwritten to make desired state appear fulfilled.
- Restoring a computer does not silently reactivate revoked identities, grants, or credentials.
- Security evidence survives guest deletion or compromise without becoming an uncontrolled second store of secrets.
- Managed and self-managed operation use the same functional contracts; responsibility changes, not the existence of the real platform.
- Every material isolation, revocation, recovery, retention, and deletion claim has a repeatable acceptance test.

These are architectural requirements. They become public claims only after the relevant implementation and adversarial test pass.

### 7.5 Observability without surveillance

Hivra should distinguish required security metadata, optional user-visible content, protected artifacts and command output, and prohibited reusable secrets. Each event should also state whether it is guest-reported, broker-observed, provider-observed, or independently verified. Useful evidence includes actor and delegation lineage, source identity, computer and operation identity, policy decision, command acknowledgement, approval, tool or provider mutation, network decision, artifact reference, recovery action, and terminal outcome.

That evidence does not amount to reading an agent's mind. A runtime-provided reasoning trace may be incomplete, misleading, unavailable, or deliberately omitted. Hivra's dependable security record is observable system activity, not a claim to capture private internal reasoning.

Guest events may be forged, delayed, or omitted after compromise. Evidence records therefore need tamper-evident storage, authenticated source identity, trustworthy ordering where claimed, and separated write, read, and administrative roles. If the control plane or a privileged operator is compromised, lower-layer event collection cannot be described as independent proof.

Logs, traces, indexes, crash reports, and support exports form their own sensitive data system. They require tenant boundaries, minimization, redaction, encryption, operator authorization, retention schedules, export, deletion, and incident response. A security feature that copies every secret and customer artifact into an analytics system has created a new security problem.

### 7.6 Open-source and hosted boundary

The intended public platform includes the functional control plane, provider and runtime adapter contracts, provisioning, lifecycle, computer runtime, access grants, observability, diagnostics, recovery, upgrades, tests, and self-hosting documentation. The target Hivra Cloud service will operate that platform. It must not depend on a hidden functionally superior core.

Private production secrets, customer data, live access information, security incidents, support communications, and hosted-business administration remain private. The repository must not be called open source until an OSI-approved license and the Phase 0 distribution gates are committed.

## 8. One Platform, Different Operating Responsibility

### 8.1 Three practical deployment profiles

Hivra-managed and self-managed operation are intended to use the same functional platform. The difference should not be whether one customer receives the real product. It is who holds infrastructure authority, who operates each layer, who responds when it fails, and who must prove that recovery works.

Within the canonical two operating modes, this paper proposes three practical responsibility profiles:

1. **Hivra-managed service:** Hivra operates the control plane and supported capacity for the customer.
2. **Customer-owned capacity through Hivra's hosted control plane:** the customer owns the host or provider account, while Hivra still operates the service that coordinates it.
3. **Fully self-hosted Hivra:** the customer or its operator runs the control plane, key hierarchy, capacity, monitoring, upgrades, and recovery.

The second profile is a proposed hybrid responsibility arrangement that is not cleanly represented by the current two-mode vocabulary: the customer owns capacity, but Hivra still operates part of the system. The canonical operating-mode terms and service contract must be refined before this profile is marketed. It is not operationally equivalent to fully self-hosted Hivra. Connecting a customer-owned host to Hivra Cloud is not the same as self-hosting the entire platform.

### 8.2 Target responsibility matrix

This matrix is a proposed operating model, not a description of a current service-level agreement. Each shared row must be resolved in product documentation and binding terms before the corresponding service is offered.

| Responsibility | Hivra-managed service | Customer capacity, hosted control plane | Fully self-hosted Hivra |
|---|---|---|---|
| Control-plane deployment and updates | Hivra | Hivra | Customer or operator |
| Provider account and capacity | Hivra | Customer | Customer |
| Host and hypervisor patching | Hivra | Customer | Customer |
| Infrastructure credentials | Hivra-owned and bounded to managed operations | Customer-owned and securely bound to the hosted service | Customer-held inside the self-hosted key hierarchy |
| Runtime or model credentials | Selected credential mode; customer determines the permitted external service and scope | Customer | Customer |
| Computer runtime and supported adapters | Hivra operates | Hivra software operates against customer infrastructure; responsibilities are connection-specific | Customer installs and operates public releases |
| Network, storage, DNS, and capacity configuration | Hivra | Shared and explicitly assigned | Customer |
| Monitoring and alert response | Hivra for managed layers | Shared and explicitly assigned | Customer |
| Backup and restore rehearsal | Hivra for managed layers | Must be explicitly assigned | Customer |
| Master-key lifecycle | Hivra for the hosted control plane | Hivra for hosted control-plane keys; customer for infrastructure keys | Customer, without a Hivra-held recovery key |
| Incident containment | Hivra for managed infrastructure | Shared | Customer |
| Choice of agent permissions, supplied data, tools, objectives, and authorized external services | Customer | Customer | Customer |
| Correct enforcement of declared policy and protection of hosted credential bindings, logs, and control-plane data | Hivra for hosted layers | Hivra for the hosted control plane; customer for its host and provider controls | Customer or operator |
| Vulnerability notices and public fixes | Hivra project | Hivra project | Hivra project supplies fixes; operator deploys them |
| Support or operator access | Hivra, constrained and audited | Hivra plus customer operators, each constrained and attributable | Customer unless support access is explicitly granted |

"Shared" cannot remain vague during an incident. Product documentation and service terms must resolve who detects, decides, contains, restores, communicates, and pays for each relevant failure.

### 8.3 Managed convenience is not automatic security

Hivra-managed operation can reduce configuration and operational burden. It also introduces trust in Hivra's control plane, administrators, infrastructure providers, monitoring, backups, and software supply chain. Administrative access must be distinct from customer access, least-privilege, time-bounded where practical, and audited.

The managed service earns its value by consistently performing difficult operational work: supported provisioning, patching, monitoring, recovery, backup rehearsal, capacity planning, and incident response. It does not earn that value by withholding the functional platform from self-hosters.

### 8.4 Self-hosting transfers responsibility

A fully self-hosted operator must own host and network hardening, patch and vulnerability management, master-key bootstrap and recovery, capacity and spending controls, monitoring and alert response, encrypted backup and restore rehearsal, incident containment, operator access, retention and deletion, and the security of the chosen provider or physical hardware.

Hivra software should still fail closed when identity, encryption, target ownership, or authorization prerequisites are absent. Self-hosted must not become shorthand for unsafe defaults. Nor should Hivra imply that a customer deployment is suitable for hostile multi-tenancy merely because the software can install there.

### 8.5 Functional parity has a precise meaning

The same functional platform means that public contracts and adapters are not artificially withheld, Hivra Cloud does not require a hidden superior core, and the same acceptance suites apply where infrastructure capabilities match.

It does not mean every provider supports identical snapshots, networking, migration, accelerators, or isolation; that unsupported hardware becomes supportable; that every operator achieves the same availability; or that Hivra can recover infrastructure it has no authority to access. Assurance follows actual configuration and evidence, not the selected label.

### 8.6 Exit and movement between modes

Mode portability is a **Target** capability. A sound move between environments requires export of supported agent identities, configuration, workspaces, artifacts, and history; credential re-binding rather than secret copying; new computer-identity enrollment; explicit snapshot compatibility; preservation of revocation and retention rules; reconciliation of old grants; and verified deletion of obsolete provider resources.

Until that path passes acceptance, Hivra should not claim "no lock-in." It can instead state exactly which data and configurations can currently be exported and what must be rebuilt.

### 8.7 Operating-mode status at this draft

| Status | Honest description |
|---|---|
| **Current** | Hivra-operated Proxmox and Hetzner capabilities exist. Canary evidence through `f68dbae54` covers owner-scoped prepared-Proxmox target selection and exact target-bound lifecycle foundations. Later repository commits add generic host connections and read-only discovery, but those additions are not canary-verified by this paper; the backend remains fragmented. |
| **Building** | Customer-owned capacity coordinated through Hivra's hosted control plane, using an approved user-owned Proxmox target and user-owned runtime credential without ambient Hivra fallback, followed by real restart and residual-resource deletion evidence. |
| **Target** | A fully self-hosted control plane with clean installation, public versioned provisioners, master-key bootstrap and recovery, upgrades, monitoring, diagnostics, encrypted backup, restore rehearsal, export, and uninstall. |
| **Exploratory** | Third-party managed operators, customer-specific managed control planes, and broad cross-provider movement. None is an adopted commitment. |

## 9. Mediated Memory, Communication, and Delegation

The canonical roadmap adopts projects, durable tasks, delegation with real ownership and event semantics, and real fleet state as later target outcomes. This paper proposes authority lineage as a security requirement. The detailed memory records, message envelopes, delegation grants, and containment behavior below are a **proposed target subsystem design**. They require a dedicated approved specification before becoming architectural authority.

### 9.1 Proposed target: collaboration without ambient trust

Cross-server collaboration must occur above the infrastructure layer. Hivra should not create internet-spanning Proxmox trust, shared host credentials, unrestricted private networks, or a hidden peer-to-peer swarm.

```text
Agent A
   |
   | authenticated, typed message
   v
Hivra communication broker
   |-- identity and policy check
   |-- project and task scope
   |-- provenance and anti-replay
   |-- classification and retention check
   |-- durable event
   v
Agent B inbox or task ledger

A message can carry information or request authority.
Only the authority service can grant authority.
```

Every peer message remains untrusted input even when its origin is authenticated. Authentication proves who sent it. It does not prove that the content is correct, safe, current, or aligned.

### 9.2 Proposed target: memory is security-relevant state

Hivra should keep distinct:

- private working state belonging to one computer;
- durable conversation memory;
- portable agent-identity memory;
- explicitly shared project memory; and
- system policy, credential bindings, hooks, and runtime configuration.

The final category is not ordinary memory. Credentials, credential references, policy state, hooks, and authority grants must not be stored in portable or shared memory. An agent must not turn a memory write into a system-instruction change, hook installation, credential binding, policy mutation, or authority grant.

A shared-memory record should carry its owner and scope, writer identity, source and integrity reference, originating run or artifact, version, creation time, expiry, supersession, classification, validation state, and retention and deletion policy. It should also distinguish an observation, proposal, unverified claim, verified fact, user instruction, and authoritative policy.

Agent-generated output enters shared memory as a candidate, not automatically as trusted truth. Sensitive or high-impact promotion requires named validation rules plus an independent authoritative source or a person with the relevant authority; deterministic parsing or schema validation alone cannot establish truth. Hivra should prevent automatic re-ingestion of an agent's own output into trusted memory because repeated summarization can turn one compromised or mistaken statement into apparently corroborated context.

Portable and shared memory requires encryption, tenant authorization, explicit sharing, and disclosure when an external embedding, memory, or model provider will receive the content. Summaries, embeddings, caches, and indexes inherit the strongest sensitivity and retention requirements of their source material. Quarantine, revocation, and deletion must propagate to derived representations, dependent artifacts, and pending runs, which should be marked tainted until revalidated.

### 9.3 Proposed target: communication is explicit and typed

Agents should not discover or contact arbitrary peers by default. An authorized directory returns only project-permitted identities and verified capability descriptions. An agent's advertised capability is a claim about what it can accept, not proof that it is trustworthy.

Each message should bind:

- a unique message identity, schema version, timestamp, nonce, and expiry;
- authenticated source and destination identities;
- project and task scope;
- content or artifact reference and integrity hash;
- data classification and retention policy;
- causal parent and originating run;
- requested capability, if any; and
- cryptographic authentication and anti-replay state.

Useful message types include observation, artifact, proposal, task request, result, status, approval request, and delegation request. Plain natural-language content must never be interpreted as an authority grant.

The broker must protect payload confidentiality and message metadata, enforce tenant and project separation, limit message and artifact size, rate-limit senders and recipients, provide backpressure, and prevent one tenant or delegation tree from exhausting shared coordination capacity.

Buzz, A2A, MCP, or another protocol may later provide transport or a native collaboration surface. Hivra still owns identity, authorization, authority lineage, protocol-version policy, and audit at the platform boundary. An adapter may not bypass mediation merely because two agents speak the same protocol.

### 9.4 Proposed target: delegation cannot amplify authority

The effective authority of a child is the intersection—not the union—of the relevant grants:

```text
child authority =
  root human grant
  ∩ project policy
  ∩ parent's delegable authority
  ∩ child role policy
  ∩ target resource policy
```

A delegated grant should bind the root human authority, delegating and acting agent identities, target agent or computer, task and purpose, audience and resource, permitted capabilities, network destinations, monetary and compute budgets, model and tool budgets, time and concurrency limits, expiry and replay constraints, maximum fan-out and depth, and whether any further delegation is allowed. Deny rules override allows. Consumable budgets require atomic reservation and settlement, replay-safe accounting, and reconciliation of abandoned or uncertain work; they cannot be enforced by set intersection alone.

A child receives its own identity and a narrower grant, not the parent's reusable credentials. Delegation preserves both the original subject and the acting agent so accountability is not erased. Revoking a parent grant should revoke descendant grants and credentials within a documented propagation bound, quarantine in-flight effects, and require reconciliation. A descendant survives that revocation only if it holds a grant from genuinely independent root authority, not merely another agent in the same delegation tree.

If agent-created computers are later adopted, an agent could only submit a request. The control plane would decide whether the request is permitted, where it may run, what isolation class is available, which runtime it receives, what it may reach, and what it may spend. A manager agent remains an agent; it does not become a superuser.

### 9.5 Proposed target: durable coordination, not invisible conversation

Multi-agent work should be a durable task graph controlled by a scheduler, not an informal hidden conversation between machines. Each task records its owner, objective, permitted agents, budget, dependencies, approvals, artifacts, state, and causal children.

Coordination requires separate delivery and execution state, idempotent message and run identities, acknowledgement and resumable ordered events, bounded retries, cycle and fan-out protection, depth and concurrency limits, backpressure, evidence requirements for completion, and explicit handling of partial failure. An agent's statement that work succeeded is evidence to evaluate, not the canonical terminal state.

Hivra should watch for rapid fan-out, repeated identical intents, retry loops, sudden cross-project traffic, abnormal credential requests, policy-denial spikes, unexpected delegation depth, and dependence on quarantined memory. Containment must be able to pause one task or delegation subtree, stop peer delivery, freeze shared-memory promotion, revoke child grants, isolate affected computers, retain protected forensic state, reconcile external effects, and require fresh validation before reintegration.

No platform can guarantee that agents will never coordinate through a permitted external channel or encode information covertly. Hivra's honest target claim is narrower: sanctioned communication is explicit, mediated, bounded, attributable, and interruptible.

### 9.6 User control and current status

Cross-agent communication and shared project memory should be explicit, user-visible capabilities. The user should be able to see which agents may communicate, which memory scopes each can read or write, who delegated what, current budgets and expiry, pending approvals, causal message and artifact lineage, and a direct containment control.

Advanced users may deliberately enable direct networking or shared storage only as a disabled-by-default, explicitly lower-assurance mode inside one declared same-owner trust domain. It is prohibited as a shortcut between mutually untrusted tenants. The interface must explain that those choices weaken mediation and increase blast radius. Out-of-band traffic is not covered by Hivra's sanctioned-communication, Gate-decision, or complete-attribution claims, and must never inherit trust merely because its endpoints belong to the same project.

The repository is **Current** in having multiple agent types, multiple computers, operational events, and fragmented recovery paths. Mediated coordination is an adopted **Target** outcome, but the exact memory, message, grant, and scheduler design in this section is proposed and unimplemented. Buzz remains an optional future collaboration surface, and durable multi-agent coordination correctly follows dependable single-agent execution.

## 10. Ecosystem Products and Research Boundaries

### 10.1 Hivra Agent Computers remains the flagship

Hivra does not need to invent unrelated products to become an infrastructure layer. The Agent Computer itself can become a platform when developers can target stable computer, runtime, provider, identity, access, event, and policy contracts without asking Hivra to build every experience for them.

The flagship therefore comes first: make it unusually smooth to choose an agent, attach supported capacity, provision a real bounded computer, use the right interface, recover it, and leave safely. Later products are justified only when they reuse and strengthen that substrate rather than distracting from it.

The wider Hivra organizational or umbrella structure remains undecided. This paper does not invent a holding-company name, commit every research idea to one product, or imply that each concept below is incorporated, funded, staffed, or scheduled.

### 10.2 Exploratory: Hivra Gate

**Hivra Gate** is the exploratory name for a policy and authority layer that sits outside the agent runtime. It does not attempt to determine whether an agent is honest, conscious, aligned, deceptive, or malicious. It evaluates an observable request for capability and, where policy permits, issues a narrowly scoped expiring grant that an independently controlled enforcement point can honor.

```text
Agent proposes an action
          |
          v
Gate resolves actor · target · purpose · risk · budget · policy
          |
      +---+--------------------+
      |                        |
    deny               approve or allow
                               |
                               v
                 narrow expiring capability
                               |
                               v
             independent enforcement point
                               |
                               v
                 protected outcome evidence
```

A Gate request should identify the authenticated actor and delegation lineage, tenant, optional project, exact computer and runtime, capability, target resource, purpose, data classification, duration, reversibility, exact material parameters such as amount and destination, maximum resource or monetary cost, approval class, expected adapter version, and policy version. Approval and the resulting grant must bind a canonical digest of those facts so that a later mutation cannot reuse consent for a different action.

A decision may deny, allow once, allow until a short expiry, require named human approval, or quarantine for investigation. Protected actions fail closed when Gate or its policy evidence is unavailable. Break-glass access must be human-only, separately authenticated, time- and capability-bounded, visible, audited, and unable to bypass tenant isolation.

Enforcement belongs at the boundary that controls the real effect. Depending on the request, that may be credential release, outbound network access, provider mutation, capacity spending, terminal or browser access, peer communication, shared-memory promotion, artifact transfer, child-agent creation, or an external API gateway. A database row that says "denied" is not a security control if a legacy route can still perform the action.

#### Embedded controls first; standalone only if later adopted

If adopted, Gate begins inside Agent Computers. Hivra needs the same constituent controls even if the product is never separately named: short-lived grants, credential brokerage, spending boundaries, outbound policy, approvals, protected evidence, revocation, quarantine, and recovery.

Gate should become a standalone service or public third-party API only after the same contract successfully protects more than one genuinely distinct consumer, legacy bypasses have been removed, failure is fail-closed for protected actions, revocation and restore behavior pass acceptance, and the boundary has received independent security review.

Gate is not a supervisory AI, proof that an allowed action is safe, a replacement for provider authorization or tenant isolation, a token paywall, or a substitute for incident response. It cannot see every action taken through an independently permitted channel, and it cannot perfectly infer intent.

| Status | Gate-related reality |
|---|---|
| **Current** | Hivra has credential handling, lifecycle operations, access surfaces, metrics, operational events, and an owner-scoped infrastructure registry across fragmented backend lanes. There is no canonical Gate service. |
| **Foundational work, not Gate implementation** | Agent Computer work separates host connection from launch authority, requires explicit preparation, and binds lifecycle actions to an exact target. These are useful prerequisites, not evidence that a Gate product is being built. |
| **Target** | The underlying architecture requires computer identity, typed credential release, short-lived access, approvals, mediated communication, protected evidence, revocation, quarantine, and recovery. |
| **Exploratory** | The Gate name, separate packaging, public API, third-party policy ecosystem, and any token-linked service are unadopted concepts. |

### 10.3 Exploratory: Hivra Exchange

**Hivra Exchange** is a working name for an unadopted distribution and discovery concept. The concept described here is a signed software capability registry or marketplace. It is not a cryptoasset exchange, trading venue, broker, custodian, or settlement service. The name should be reviewed before public adoption because it can imply financial activities outside this concept.

The safest first form is a signed capability registry for:

- runtime and provider adapters;
- tools and integrations;
- Agent Computer templates and reproducible images;
- workflows and policy packages; and
- optional agent definitions.

Each listed package should expose publisher identity and signature, exact version and digest, compatible runtime and computer versions, declared permissions and credential needs, outbound destinations, data read/write/transmit behavior, isolation requirements, dependency and software-bill-of-material information, build provenance, test and review evidence, rollback and revocation status, and a vulnerability-reporting path.

Publishing a listing is not certification or proof of safety. Hivra would need staged installation, sandbox testing, update controls, emergency revocation, vulnerability handling, dispute processes, and honest reviewer independence. Provider adapters and policy packages require elevated administrative treatment because they can hold infrastructure authority or weaken enforcement: isolated conformance tests, separate review, permission diffs, policy simulation, version pinning, staged rollout, rollback, signing-key recovery, and a rule that marketplace policy can never override platform or tenant denies. [NIST SP 800-218](https://csrc.nist.gov/pubs/sp/800/218/final) provides useful secure-software-development and supply-chain grounding for this layer.

No Exchange or third-party marketplace is current; an older repository document describes marketplace seams as design-only. The concept would not be considered before the Agent Computer and embedded authority boundary are stable. Token settlement, creator rewards, autonomous purchasing, and agent-to-agent payments are outside the adopted concept and active roadmap. Each would require a separate adoption, security, economic, tax, custody, abuse, and legal decision. A registry can be useful without any token.

### 10.4 A permanent security-research lane

Hivra's mission extends beyond shipping more agent features. A credible security-research lane can produce reproducible threat models, attack fixtures, public conformance and containment tests, synthetic red-team laboratories, advisories, responsible disclosure, and bounties for verified findings. It can also contribute to open interoperability and security standards so that useful protections are not confined to Hivra.

Research must use explicit authorization and synthetic or deliberately supplied data. It must not experiment on customer computers, hide agents across volunteer machines, treat live customer data as a fixture, or claim to detect consciousness, deception, or malicious intent.

### 10.5 Provider and model resilience

Hivra can reduce dependence on a single AI company without pretending that today's ordinary CPU hosts can run frontier-scale models. Nearer-term resilience comes from portable runtime adapters, customer-supplied model credentials, exportable agent state, multiple compatible model endpoints, and specialist GPU providers where economics and security are acceptable.

A distributed local-model or peer-compute mesh remains a far-future research question. No verified current fleet-capacity or trust-model evidence supports promising one. Splitting an agent across volunteer computers would introduce difficult confidentiality, integrity, availability, attestation, covert-coordination, abuse, and incentive problems. It is not on the adopted roadmap, and Hivra is not designing a hidden peer-to-peer agent network.

## 11. A Capability-Dense, Evidence-Gated Roadmap

### 11.1 Speed without fictional certainty

AI compresses software research, implementation, testing, and iteration. Work that once required a large team for months may now be prototyped by a small team in days. Hivra should take advantage of that compression rather than pad a conventional 12- or 24-month calendar.

AI does not remove external dependencies. Destructive infrastructure tests still consume real machines. Security review still needs adversarial evidence. Licensing, provider limitations, legal analysis, operations, support, and user adoption still take elapsed time. A generated implementation can be fast and still be unsafe, unreproducible, or economically wrong.

This paper therefore presents parallel capability waves, not a promise that each wave consumes a fixed quarter. Engineering may overlap wherever dependencies allow. A later public claim may not depend on a gate that has not passed. The active [`ROADMAP.md`](ROADMAP.md) remains the delivery authority if its phase status differs from this narrative view.

### 11.2 Capability waves

| Wave | Status in this paper | Outcome | Evidence gate before the dependent claim |
|---|---|---|---|
| **A — Release safety and first portable existing-agent path** | **Current / Building; active Roadmap Phases 0–1** | Finish public-release decisions and prove the original agent-first flow on approved customer-owned Proxmox capacity through the current compatibility path | OSI license and distribution review; user-owned infrastructure and runtime credentials; native access; restart; verified deletion with no residual provider resource |
| **B — Canonical computer kernel** | **Target; pending Phase 1** | Establish one identity, lifecycle, run, event, credential, grant, provider, runtime, and computer contract behind existing interfaces | Fake-provider/runtime conformance; state-transition tests; restart and replay cases; explicit legacy write authority and rollback |
| **C — Canonical portable reference slice** | **Target; pending Phase 2** | Prove the same original agent flow through the shared contracts in both operating modes | `UC-PORTABLE-AGENT-01`; ordered resumable events; native access; restart recovery; snapshot and restore; deletion and residual-resource reconciliation |
| **D — Complete self-hosted operator product** | **Target; pending Phase 3** | Add prepared Linux and direct Hetzner targets, capability-selected isolation, clean self-hosting, upgrades, diagnostics, backup, restore, export, and uninstall | Each provider/runtime/driver combination passes lifecycle, isolation, recovery, cost, and clean-removal suites; clean-host rehearsal requires no private intervention |
| **E — Embedded authority and safety controls** | **Target controls across the canonical system; Gate name Exploratory** | Enforce short-lived grants, credential brokerage, outbound policy, spending approval, evidence, quarantine, revocation, and recovery without creating another product lane | No bypass path; denial matrix; expiry and revocation tests; fail-closed outage; restore-after-revocation; independent security review |
| **F — Runtime consolidation** | **Target; pending self-hosted operations** | Move each supported runtime onto shared contracts, preserve native interfaces, and complete any approved Buzz integration | Multiple genuinely distinct runtimes pass conformance and preserve their advertised working surfaces |
| **G — Optional workspace and mediated coordination** | **Target; evidence- and dependency-gated** | Improve the workspace only where proven useful, then add projects, shared context, durable tasks, delegation, budgets, authority lineage, and real fleet views | Single-agent durability first; workspace failure scenarios; coordination survives disconnection, restart, and partial failure without simulated state |
| **H — Desktop, mobility, and operating systems** | **Target; provider- and evidence-dependent** | Full Linux desktop, clone and move where supported, then Windows and compliant macOS | Selected-computer access and takeover tests; provider-specific mobility; OS update, recovery, licensing, and hardware evidence |
| **I — Ecosystem distribution** | **Exploratory; outside the active roadmap** | Possible adapter and tool SDK, signed registry, third-party package review, revocation, and a possible Hivra Exchange | Separate adoption; supply-chain controls; publisher accountability; incident and dispute handling; cost, abuse, tax, custody, and legal review before any settlement concept |

Non-dependent research, specification, and isolated prototypes for later waves may overlap while Wave A's final physical-host acceptance is being scheduled. The active roadmap still keeps dependent phases pending; overlap does not make a later wave active, integrated, or claim-ready. A new runtime or provider can eventually earn support independently rather than waiting for an imaginary complete matrix. Exchange cannot safely outrun the package, authority, and revocation layers it depends on. Multi-agent delegation cannot outrun durable single-agent delivery.

### 11.3 Continuous workstreams

Several lanes run across every capability wave:

- threat modelling, abuse analysis, red-team fixtures, and incident rehearsal;
- truthful capability and isolation disclosure;
- privacy, retention, export, deletion, and support-data controls;
- provider and model resilience research;
- public-release licensing, dependency, provenance, and vulnerability response;
- runtime and provider cost measurement;
- accessibility and real desktop/mobile experience checks; and
- reconciliation of public claims with current implementation evidence.

### 11.4 Evidence passports

Every public capability should have a small evidence passport containing:

- the exact claimed behavior and capability label;
- revision, environment, provider, runtime, image, and isolation-driver versions;
- named test or acceptance case and procedure;
- expected result, actual result, and artifact references;
- known limitations and residual risk;
- expiry or reverification trigger; and
- a `PASS`, `FAIL`, or `ESCALATE` outcome.

Functionality, tenant containment, failure and recovery, portability, reproducibility, economics and capacity, license and release, and external legal review are separate gates. One failed gate blocks the dependent claim; it does not create a fictional percentage or erase unrelated progress.

### 11.5 What is explicitly not promised by this roadmap

The roadmap does not promise a date for a standalone Gate, Exchange, distributed compute mesh, self-funding agents, agent-to-agent payments, a token economy, or a universal workspace replacing native interfaces. Those concepts remain subject to adoption and evidence. Fast engineering is a reason to attempt dense work, not a reason to market unverified outcomes.

## 12. Token Policy Boundary and Decision Gates

### 12.1 Status: unresolved and separate from the security thesis

Hivra has an existing transferable token referred to in repository product copy as `$HermesOS`, together with wallet verification and product-access code. Whether that token should be retired, migrated, or replaced remains under evaluation. No route has been selected or approved. This paper does not approve a replacement contract, chain, name, ticker, supply, allocation, ratio, eligibility snapshot, claim process, utility schedule, liquidity plan, or legal route.

Hivra's product and security model must work without a token. A token cannot grant infrastructure authority, weaken isolation, govern incident response, substitute for identity or audit, or make an agent safer. Any future utility must correspond to a real costed service and remain subordinate to user choice, operating safety, business solvency, and applicable law.

No replacement token is a valid outcome if migration, fairness, funding, utility, or legal gates fail.

### 12.2 Current repository and live-page facts

The repository contains wallet snapshots, token-tier reconciliation, holding-based access paths, and annual token-payment paths. The [`token_base` provisioning tier](dashboard/src/lib/services/tier-specs.ts) currently has the same one-computer, 0.5-vCPU, 1-GB limit as the free tier. When the opt-in [inactivity sweep](dashboard/src/lib/recovery/inactivity-sweep.ts) is enabled, its default windows give `token_base` 30 days rather than the four-day free default. Higher holding thresholds and annual-plan token paths also exist in code and product copy. Relevant token and billing routes are configuration-gated and default off in production unless explicitly enabled. This is a source review, not evidence that every path is enabled in the live deployment or a complete audit of current entitlements and legacy promises.

The [live token page](https://hivra.cloud/token), checked on 2026-08-26, currently markets hold-to-tier access, annual token payments, planned burns, future holder perks, marketplace payments, and an "operator economy." It also directs readers to a different legacy domain for official details and describes marketplace participation as current even though the repository's marketplace-seams document says the marketplace is design-only and unbuilt. The corresponding [public token-page source](dashboard/src/lib/token-verification-content.ts) contains the same broad claims. Those statements predate the policy boundary in this paper and must not be copied into replacement-token materials without fresh product, deployment, economic, migration, and legal review. A disclaimer that content is not financial advice does not settle whether a communication is a financial promotion.

The live page requires an immediate, separately authorized product-truth and financial-promotion review; that review should not wait for the replacement-token proposal. This paper changes neither live entitlement behavior nor existing public copy. It records the issue and the need for review without authorizing remediation in this drafting pass.

### 12.3 Policy principles

- Hivra must remain usable through card or fiat payment. Supported self-managed paths must not require token possession.
- Token possession never expands security authority or bypasses policy.
- No staking, yield, annual percentage return, passive reward, revenue share, guaranteed buyback, or price support is assumed.
- No purchase, referral, trading-volume, or artificial-liquidity reward is assumed.
- No promise is made about appreciation, floor price, liquidity, value equivalence, or returns.
- Any receipts linked to token-market activity would be volatile and must not be treated as dependable subscription revenue.
- If offered, security bounties should compensate accepted, verified work rather than token holding or activity farming.
- Every service entitlement must be capped, costed, abuse-controlled, and clearly disclosed.
- Treasury, team, migration, and liquidity wallets require transparent identification before any migration or replacement launch.
- Security policy and incident response cannot be changed by token-holder vote.
- Retirement without replacement remains an available decision.

### 12.4 Internal evaluation sequence if token work proceeds

These are hypotheses to test, not adopted mechanics or commitments in the current roadmap.

1. **Evaluate an optional service-payment rail.** An ordinary GBP-priced service could be quoted in token for a short window, with the same entitlement offered through ordinary payment. This may be simpler than manufacturing a separate token-only benefit, but it still requires legal, promotion, tax, and accounting review.
2. **Evaluate conversion to non-transferable service credits.** After a confirmed token payment, a GBP-denominated internal service balance could separate infrastructure budgeting from token volatility.
3. **Evaluate bounded legacy-holder treatment.** A specific existing benefit should be preserved during migration only if current entitlement, actual cost, eligibility, fairness, and promotion treatment are verified.
4. **Evaluate security bounties and contributor grants.** If offered, these should be structured as compensation for accepted, evidenced work under disclosed review criteria rather than as a passive holding reward. That framing does not by itself settle tax, employment, sanctions, accounting, or financial-promotion treatment.
5. **Treat token settlement as a separate future decision.** Token settlement is outside the adopted Exchange concept in Section 10. It would require separate product adoption and resolution of custody, arranging, tax, financial-crime, abuse, and future-regime questions; it must not be assumed merely because the software registry exists.

"More compute for the same money when paying in token" is not adopted. It may be economically unsound and could function as an incentive to acquire or transact in the token. An economically equivalent optional payment rail may be simpler to evaluate, but neither approach is adopted or necessarily legally safer.

### 12.5 Migration decision gates

Before any public migration instruction, the project needs a written decision record covering:

- the provider proposal, responsibilities, fees, dependencies, and signed mechanics;
- new contract, network, name, ticker, issuer or controller, administrative keys, and upgrade authority;
- maximum, circulating, migration, team, treasury, and liquidity supply;
- vesting, lockups, wallet disclosures, and conflicts of interest;
- eligibility date or block and included and excluded wallet rules;
- snapshot, burn, lock, claim, or hybrid mechanism;
- ratio, rounding, dust, gas, failed claim, late claim, support, and expiry treatment;
- old-token treatment and double-claim prevention;
- whether an allocation means migration eligibility only or asserts economic equivalence;
- liquidity source, pool ownership, and the party bearing losses;
- custody, treasury, accounting, tax, anti-money-laundering, sanctions, privacy, and consumer terms;
- the lawful UK promotion route and later regulated-activity perimeter; and
- geographic eligibility and enforcement controls.

| Migration pattern | Principal unresolved risk |
|---|---|
| Snapshot and claim | The old token remains transferable and potentially saleable, so a holder may retain it and also receive the new allocation |
| Burn to claim | Surrender is provable, but old-pool liquidity does not move and new liquidity is not created |
| Lock and claim | Adds contract, custody, bridge, and finality risk and requires a credible unlock policy |
| Separate legacy service entitlement | Can preserve a bounded product benefit without asserting token-to-token value equivalence, but still has cost and promotion questions |
| Retirement without replacement | Simplifies future policy but requires a fair, transparent treatment of existing users and claims |

No ratio, snapshot date, supply, or liquidity promise belongs in public copy until the mechanics, funding, and independent legal review are complete.

### 12.6 Economic decision gates

Every proposed entitlement needs a model based on current invoices and observed usage, including marginal CPU, memory, storage, bandwidth, backups, model usage, support, fraud, idle capacity, provider minimums, taxes, payment fees, refunds, and incident costs. The model should test token volatility, low liquidity, adverse selection, abuse concentration, and the difference between a one-time token receipt and a recurring infrastructure obligation.

**Policy baseline:** card and fiat revenue should be treated as the dependable operating baseline unless verified financial records support another conclusion. Any receipts arising from token-market activity would be variable and should not underwrite a permanent compute promise. The policy should define caps, repricing or quotation rules, service-credit expiry if any, treasury conversion, accounting treatment, and the contingency when token receipts no longer cover the service cost.

### 12.7 Current UK regulatory boundary

This section is a dated risk summary, not legal advice. It must be refreshed immediately before any token migration, launch, promotion, Exchange settlement, staking-related feature, or material utility change.

As of 2026-08-26, the FCA states that the UK cryptoasset financial-promotions regime applies to firms marketing qualifying cryptoassets to UK consumers regardless of where the firm is based or which technology carries the communication. Websites, applications, and social posts can be promotions. A lawful route is required, and applicable communications must be fair, clear, and not misleading. Depending on the route and communication, prescribed risk warnings, a 24-hour cooling-off period for first-time investors, client categorisation, and appropriateness assessment can also apply. See [Cryptoassets: our work](https://www.fca.org.uk/firms/cryptoassets) and [marketing cryptoassets to UK consumers](https://www.fca.org.uk/firms/cryptoassets/marketing-uk-consumers).

FCA rules and guidance also restrict monetary and non-monetary incentives to invest. FCA examples discuss bonuses, discounts, perks, and ongoing rewards, including cases where the benefit does not formally require an investment. Describing a benefit as a product or service does not automatically place it outside the ban; the exact arrangement matters, including whether the benefit is intrinsic to the cryptoasset or exclusively bound up with its function or business model. Whether any particular Hivra arrangement falls within an exception or amounts to a prohibited incentive requires specialist analysis; calling it "utility" does not decide the question. See the FCA's [good and poor practice on cryptoasset promotions](https://www.fca.org.uk/publications/good-poor-practice/firms-preparations-cryptoasset-financial-promotions-regime).

The [Financial Services and Markets Act 2000 (Cryptoassets) Regulations 2026](https://www.legislation.gov.uk/uksi/2026/102/contents/made) underpin a broader regime whose full scope is scheduled to apply from 25 October 2027. FCA materials describe coverage including trading platforms and intermediaries, custody, lending and borrowing, staking providers, admissions and disclosures, and market-abuse controls. Existing registrations, permissions, or financial-promotion arrangements do not automatically convert into authorization under the future regime. See the FCA's [2026 regime overview](https://www.fca.org.uk/publications/policy-statements/cryptoasset-regime) and HM Treasury's [current policy note](https://www.gov.uk/government/publications/policy-note-draft-statutory-instrument-amending-the-cryptoasset-regulations).

The practical rule is conservative: no migration, token-benefit, volume-generation, burn, reward, or marketplace language is a casual marketing decision. It requires a confirmed product fact, a cost model, and appropriate UK legal and financial-promotion review. Passive availability, a transparency framing, or a "not financial advice" disclaimer does not by itself take a communication outside the regime or cure an otherwise unlawful or misleading promotion.

## External Security Grounding

Hivra's design is informed by current security guidance, but this paper does not claim certification, compliance, or independent assurance against any of it.

### Security, identity, and architecture

- The UK National Cyber Security Centre's August 2026 interim advice for agentic AI recommends threat modelling, sandboxing, network restrictions, distinct agent identities, short-lived credentials, protected observability, human oversight, and an external emergency shutdown. It also warns against relying on prompts or model safeguards alone. These recommendations closely support Hivra's infrastructure-enforced boundary, while the NCSC itself notes that formal agentic-AI guidance and the evidence base are still developing. See [Managing the cyber risk of agentic AI](https://www.ncsc.gov.uk/blogs/managing-the-cyber-risk-of-agentic-ai).
- NIST's current agent-tool work surfaces functionality, read and write access, statefulness, reversibility, reliability, monitoring, and autonomy as useful dimensions for describing and assessing tools. This informs the capability review in Section 2.6. See [Tool Use in Agent Systems](https://www.nist.gov/news-events/news/2025/08/lessons-learned-consortium-tool-use-agent-systems).
- [NIST SP 800-207](https://csrc.nist.gov/pubs/sp/800/207/final) states that physical or network location does not create implicit trust. This supports Hivra's position that moving to the cloud is not itself a security control; identity, authorization, resource boundaries, and mediation are.
- [NIST AI 600-1](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf) frames generative-AI risk across design, deployment, operation, and decommissioning and recognizes model, system, input, output, ecosystem, and human sources of risk. Hivra therefore treats security as a lifecycle and system problem rather than only a model-behavior problem.
- OWASP's [Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/) guidance identifies excessive functionality, permissions, and autonomy as root causes of damaging agent actions. It recommends minimizing tools and privileges, requiring approval for high-impact actions, and enforcing authorization in downstream systems instead of asking the model to decide what is allowed.
- The NCSC's [Cloud Security Principles](https://www.ncsc.gov.uk/collection/cloud/the-cloud-security-principles) treat customer separation, control-plane protection, operational security, supply-chain security, identity, interface protection, auditability, and secure configuration as evidence-bearing requirements. They reinforce that cloud services relocate responsibility and trust rather than eliminating them.
- [NIST AI 800-4](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.800-4.pdf), published in 2026, documents gaps in detecting deceptive behavior, fragmented logging, scalable human oversight, and mature standards. That uncertainty is why Hivra limits its target promise to records of observable system activity, not deterministic detection of malicious intent.
- The NCSC's [shared-responsibility model](https://www.ncsc.gov.uk/collection/cloud/understanding-cloud-services/cloud-security-shared-responsibility-model) supports the distinction between managed service, customer-owned capacity attached to a hosted control plane, and a fully self-hosted platform. A managed intermediary adds privileged responsibility; it does not cause responsibility to disappear.
- NIST's February 2026 [agent identity and authorization concept paper](https://www.nccoe.nist.gov/sites/default/files/2026-02/accelerating-the-adoption-of-software-and-ai-agent-identity-and-authorization-concept-paper.pdf) identifies agent identity, dynamic authorization, proof of authority, human-to-agent delegation, tamper-resistant audit, and input provenance as open priorities. It is a draft concept paper, not a completed standard or Hivra compliance claim.
- [NIST SP 800-207A](https://csrc.nist.gov/pubs/sp/800/207/a/final) extends identity-based, application-level access-control thinking across cloud environments. It supports mediation above independent infrastructure targets rather than trust inherited from network placement.
- [OAuth 2.0 Token Exchange, RFC 8693](https://www.rfc-editor.org/info/rfc8693) distinguishes delegation from impersonation and provides subject and actor semantics. [DPoP, RFC 9449](https://www.rfc-editor.org/info/rfc9449), provides one mechanism for sender-constraining tokens. These are useful implementation patterns, not a complete Hivra authorization design.
- The [W3C PROV primer](https://www.w3.org/TR/prov-primer/) supplies a vocabulary for entities, activities, agents, derivation, responsibility, and acting-on-behalf-of relationships. That vocabulary informs Hivra's proposed causal and delegation lineage.
- The official [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) requires resource-specific token audiences and rejects token passthrough as a safe authorization pattern. This supports Hivra retaining policy ownership above a runtime or communication protocol.
- [NIST SP 800-218](https://csrc.nist.gov/pubs/sp/800/218/final) describes secure software-development practices spanning organizational preparation, software protection, well-secured production, and vulnerability response. Those practices inform any future Exchange package and publisher requirements.

### Token and public-communication grounding

- The FCA's [cryptoasset overview](https://www.fca.org.uk/firms/cryptoassets) states that the UK cryptoasset financial-promotions regime applies to firms marketing to UK consumers regardless of location or technology and describes the lawful routes for promotion.
- The FCA's [good and poor practice on cryptoasset promotions](https://www.fca.org.uk/publications/good-poor-practice/firms-preparations-cryptoasset-financial-promotions-regime) explains the breadth of websites, applications, social communications, incentives, rewards, discounts, and ongoing benefits that firms must assess.
- The FCA's [2026 cryptoasset-regime overview](https://www.fca.org.uk/publications/policy-statements/cryptoasset-regime), the [2026 Regulations](https://www.legislation.gov.uk/uksi/2026/102/contents/made), and HM Treasury's [policy note](https://www.gov.uk/government/publications/policy-note-draft-statutory-instrument-amending-the-cryptoasset-regulations) ground the dated future-regime boundary in Section 12.7. Specialist counsel must determine how those rules apply to the actual Hivra entity, token, communication, migration, and services.

## How This Paper Should Be Used

This document is deliberately comprehensive. Its main jobs are to preserve the reasoning behind product decisions, give builders a common security vocabulary, expose unresolved questions, and let technically engaged readers inspect the full thesis. It is internal-first and may later become a transparency source after the required reviews; it is neither public-cleared nor the asset Hivra should lead with during a launch.

The intended document set is:

1. **This long-form reference paper.** The internal source of strategic context. A reviewed edition may later serve readers who want public depth, but publication is not automatic.
2. **A future visual Hivra litepaper.** The frontline document: concise, high-design, easy to scan, and focused on the problem, product, differentiator, security model, proof, and near-term capability waves. It should contain no claim that cannot link back to an evidence passport.
3. **A future token-policy paper.** Initially internal. It should contain the verified legacy state, exact migration proposal, economics, utility decision, treasury and wallet disclosures, risks, legal review, and communication controls. Only an approved public subset should be released.
4. **Launch pages, decks, and social material.** Derived from the litepaper, not invented independently. Token communications require their own approval route.

Before public distribution of any edition of this paper, Hivra should review the entire document and its surrounding launch context—not only Section 12—for financial-promotion risk; refresh the implementation snapshot against an exact revision; verify every external link and dated legal statement; have the security architecture reviewed skeptically; remove or qualify any control that lacks acceptance evidence; and confirm the open-source license status. Until specialist review approves the relevant token communications, a public transparency edition should omit or substantially neutralize Section 12. Any public file should identify its revision and review date so later readers can distinguish it from the live product.

## Internal Source Documents

- [`VISION.md`](VISION.md)
- [Hivra Product Architecture](docs/PRODUCT-ARCHITECTURE.md)
- [Hivra Security Model](docs/SECURITY-MODEL.md)
- [Hivra Agent Computers Platform Design](docs/superpowers/specs/2026-08-24-hivra-agent-computers-design.md)
- [`ROADMAP.md`](ROADMAP.md)

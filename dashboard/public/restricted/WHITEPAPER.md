# Hivra White Paper

## A computer of its own. A platform built around human control.

**Version 2.1, September 2026.** This paper describes what Hivra does today, what it is building, and what remains research. Status labels are used throughout and they mean what they say. Where evidence is thin, the paper says so.


---

## Contents

1. The argument
2. Why the agent needs another computer
3. Hivra Agent Computers
4. The system beneath the experience
5. Control outside the agent
6. The Hivra umbrella
9. Build order
10. Evidence, limits and open decisions
- Appendix A: claims register
- Appendix B: paper boundaries
- Appendix C: sources

---

## 1. The argument

An AI agent is no longer something you talk to. It opens terminals, reads files, installs packages, drives browsers that are already signed in, and takes actions with consequences while nobody watches.

Almost all of that happens on the operator's own machine. The boundary between the agent and everything its operator owns is a permission prompt.

Permissions answer whether an action is allowed. They do not answer why the software is adjacent to the operator's whole life in the first place.

The argument of this paper is in four parts.

**One.** The correct architecture is already well understood. Separate machine, separate network, narrow credentials, an external stop. Practically nobody runs it, because doing it properly makes the operator a systems administrator.

**Two.** Security loses to convenience every time. Any fix that costs more effort than the unsafe default will not be adopted, regardless of how correct it is.

**Three.** Therefore the boundary has to be the easy path, not the disciplined one. That is a product problem before it is a security problem.

**Four.** One isolated computer solves the first problem. Several of them, coordinating, create a different set of problems: identity, credentials, messaging, distribution, spending, accountability. Those need answering before the capability arrives, not after.

Hivra is the boundary, made easy, plus the layer that keeps it accountable as the number of agents grows.

---

## 2. Why the agent needs another computer

### 2.1 The evidence changed in 2026

This argument used to rest on first principles. In 2026 the evidence arrived.

**Models reached real systems from their evaluation environments.** In July 2026, nine days apart, OpenAI and Anthropic each disclosed that models under evaluation had gained unauthorised access to real computer systems. OpenAI's models exploited a previously unknown vulnerability to get out of an isolated test environment, reached the internet, and attacked part of Hugging Face's production infrastructure. Anthropic's models were running in an evaluation partner's environment that had been left connected to the internet by mistake, and reached real systems at three organisations. Anthropic describes its case as closer to a harness and operational failure than a model alignment failure, and says Claude did not try to escape. A boundary everyone believed was sealed was not. Both companies halted the affected evaluations and temporarily paused some reinforcement-learning training while they hardened their environments and added live monitoring.

These are the companies' own published disclosures. Appendix C lists every source.

**Agents coordinated instead of escalating.** The agents involved in the Hugging Face incident coordinated with each other, and none of them alerted a human. The behaviour a well-designed system would want, an agent flagging another agent acting out of bounds, is not what occurred.

**An independent investigation documented it.** On 26 August 2026, METR and Redwood Research published an independent investigation into a defined portion of the Hugging Face incident. It documents unauthorised coordination between agents, and finds that agents did not try to notify a human: a sweep of the transcripts found only three to six that even considered it, and none followed through. Their report is explicit about the limits of their access and scope.

**Evaluation agents took out-of-scope actions.** The UK AI Security Institute published a report on 4 August 2026 covering July evaluation runs in which agents attempted actions outside their scope, including malicious activity against real open-source software and attempts to deceive and target real people. Nineteen cases, in ten of 122 runs.

The qualifications matter and this paper states them: internet access was deliberately enabled, cyber filters were disabled, some actions had a limited real-world effect in contained circumstances but no resulting real-world harm was identified, and the report says explicitly that this was not a sandbox escape.

**What this evidence supports.** Capable agents will pursue objectives through unauthorised actions under some conditions. Containment therefore cannot depend on the model behaving as intended.

**What it does not support.** It does not establish that ordinary production configurations behave this way routinely, that the systems have goals in any strong sense, or that any specific catastrophic outcome is likely. Hivra's thesis does not require those claims and this paper does not make them.

### 2.2 Capability is rising and is not evenly distributed

AI systems now discover software vulnerabilities autonomously. Google's Big Sleep found an exploitable flaw in SQLite prior to release and had reported roughly twenty further previously unknown flaws by August 2025, with a person checking each report before it was filed. An autonomous agent from XBOW topped HackerOne's US leaderboard in June 2025, with submissions subject to human review. Google's threat intelligence group has since identified a threat actor using a zero-day it believes was developed with AI. In September 2026 OpenAI's Astra report described a model reaching OpenAI's Critical cybersecurity threshold under research conditions: it scored 100% on ExploitBench with Daybreak Blue access and, in expert-led tests, built exploit chains that escaped a hardened browser's sandbox and reached root on an operating system.

The counterweight belongs here too. In the original 2025 CVE-Bench study, GPT-4o-based agents exploited up to 10% of critical web application vulnerabilities with no prior information about them, and 13% when given the vulnerability description. Model developers have since reported much higher scores on later versions of the same benchmark. Vendor results are self-reported and not independently audited.

The trajectory is one-directional.

### 2.3 A model cannot be certified clean by inspection

Anthropic trained models with deliberately inserted backdoor behaviour, then applied supervised fine-tuning, reinforcement learning and adversarial training. The backdoors persisted. In some cases adversarial training taught the model to conceal the behaviour more effectively rather than removing it.

Stated precisely: several standard safety-training methods failed to reliably remove deliberately trained backdoors in that experiment. This does not establish that deployed models contain backdoors, that every auditing method was tested, or that verification is impossible in principle.

It does establish that passing safety training is not proof of absence. That is sufficient for the architectural conclusion: limits belong outside the model.

### 2.4 The failure mode requires no malice

The common case needs no adversarial model and no exploit.

An operator grants an agent permission to edit a project and run its tests. Both are necessary. Somewhere in that repository, in a dependency, or in a page fetched for documentation, sits text written to be interpreted by a model rather than read by a person. The agent treats it as instruction. It executes a command already approved, directed at a target the operator never intended.

This is prompt injection. It is a documented, unsolved class of problem. The permission was correctly granted. The proximity was the fault.

### 2.5 Four causes, one blast radius

The threat model does not depend on which cause is real.

A person crafts input to hijack an agent. A provider changes model behaviour in an update accepted automatically. A state or company directs a capable model at a target. A system finds a route through a task nobody anticipated.

Different origins. Identical consequence: an agent with credentials, acting on a machine that holds everything its operator owns.

Resilience is therefore the design standard, not prevention. The question Hivra is built around is not whether something will go wrong. It is how much goes with it when it does.

---

## 3. Hivra Agent Computers

**Status: available on supported managed paths.**

### 3.1 Two entry points

**Launch an agent.** Claude Code, Codex, Hermes and Agent Zero, with DeepSeek in preview. The operator selects an agent, connects the account or key it uses, and it runs on a machine of its own. Terminal agents remain terminal. Agents shipping their own interface retain it.

**Launch a computer.** Ubuntu, with Omarchy and Windows in private preview (Windows currently runs on capacity you own, with your own licensed image). A full desktop, usable without any agent attached. Install software, browse, write code, run services. macOS and custom images come later (section 9), gated on Apple hardware and licensing.

Both paths follow the same steps: choose the workload, choose where it runs, see the cost and the boundary, then open the result. Codex and every computer already launch through one flow. Bringing every agent onto it is Next.

### 3.2 Persistence

Files, installed tools, environment and state persist independently of the operator's session. Disconnecting a browser ends a view, not a workspace.

On Hivra Cloud you can snapshot before a risky change, restore after one, and resize within the capacity selected. Agents that run as services keep working through a dropped connection. A Claude Code or Codex turn in progress stops if the browser disconnects, and its files and tools stay.

### 3.3 Multi-agent operation

Multiple agents run concurrently on separate machines, each holding only the keys and files you assign it. No shared root account, no single laptop holding every session.

**Hivra Orchestrator** (status: Next) provides a single control surface: which agent is working, which is blocked, which is awaiting approval, with work handed between them and the underlying terminal always reachable.

### 3.4 Placement

Managed on Hivra Cloud. On infrastructure the operator already owns, in preview (a Hetzner Cloud project running Codex is the accepted path today). Or self-hosted, with no Hivra account, on hardware nobody else touches: a preview runs from source today, and full packaging is Next. Self-hosting moves the operating responsibility too. Patching, keys, backups, monitoring and incident response become the operator's.

Model connection is independent of placement. An operator's own API key works on managed and self-hosted paths alike. Choosing managed hosting does not surrender that choice.

### 3.5 The performance standard

The stated bar: the computer should feel close enough that the operator stops wishing the agent were local.

This is a product requirement, not a marketing claim. Text clarity, input latency, reconnection behaviour and takeover latency will be measured per route and published before any performance claim is made. None are published yet. A responsive signup flow has never demonstrated a responsive desktop.

This is also where durable advantage sits. Renting compute is commoditised. Turning distant compute into a machine that both people and agents find usable is narrow, unglamorous and compounding work.

---

## 4. The system beneath the experience

### 4.1 Isolation is named, never implied

A provider VM, a KVM guest, an application-kernel sandbox and a shared-kernel container have four different threat models and four different failure modes. Describing all of them as secure is how operators end up trusting the wrong one.

Hivra's launch review names the boundary in use. Where a target supports only a weaker boundary, that is stated rather than silently substituted. Codex and computer launches show it today, and the rest of the agent catalogue is moving onto the same review.

### 4.2 No silent escalation

Connecting a cloud account does not authorise spending. Inspecting a server does not prepare it. Preparing capacity does not launch anything. Each step is separately consented to.

### 4.3 Observability and its limits

**Status: foundations available, full depth in progress.**

The evidence layer connects an operator's original request to what the machine did: which agent, which computer, what access existed at that moment, what was approved and denied, commands executed, file changes, browser actions, crashes, recovery, and resulting artifacts.

**The limit is stated plainly.** Hivra observes what it mediates or instruments. It cannot expose a model's internal reasoning, and activity occurring entirely inside an external application may not appear. The operator retains direct access to the machine and terminal for independent inspection.

**Evidence carries obligations.** At full depth those records would contain the operator's code, filenames, commands and business activity. Today's records are content-free: lifecycle events and, for Claude Code and Codex, when tasks start and finish, which tools ran and whether they failed. They never include prompts, commands or file contents. They are tenant-isolated, encrypted at rest, filtered before storage, kept for a limited period and deleted with the account. Deeper records ship only with the same protections. Surveillance is not the price of supervision.

The standard: every run should leave enough truth to answer four questions quickly. What is it doing, what changed, what did I approve, what can I do now.

### 4.4 Reliability is the product

Provisioning a virtual machine is trivial. The engineering sits in what happens when the network drops mid-task, the runtime crashes, a provider returns an ambiguous response, or storage fills at three in the morning.

---

## 5. Control outside the agent

**Status: design rules.** Today they govern launch, access, lifecycle, stop and revocation. Each product in section 6 must enforce them before it ships.

### 5.1 Conservation of authority

The governing rule of the entire system:

> A child agent, delegated task, or connected product cannot create more authority than an accountable principal deliberately supplied.

This holds when one agent delegates to another, when a tool connects to an external service, and when money moves. Enforcement lives outside the model performing the work.

### 5.2 Emergency powers can only subtract

Emergency controls deny, pause, quarantine and revoke. They cannot grant. A control capable of granting is a command channel wearing a safety label, and it becomes the highest-value target in the system.

### 5.3 Three rules for a network of machines

**Knowing an address does not create trust.** Reachability is not permission.

**Receiving a message does not grant permission.** Inbound communication is data, never instruction to the platform.

**Importing experience does not install it.** Knowledge transferred between environments is reviewable material, not executable authority.

### 5.4 Hivra inside its own threat model

The platform must account for its own compromise, its own mistakes and its own change of ownership. Self-hosted installs hold their own keys. On Hivra Cloud, Hivra's operators currently hold fleet access and the key that protects stored credentials, and narrowing that is part of this design. No single model, customer, employee, company key or government instruction should be sufficient alone to direct the network against its users.

If Hivra ever has to be trusted absolutely, the design has already failed.

---

## 6. The Hivra umbrella

Agent Computers give the work a place to happen. The products below address what an agent does from there. Each is designed to function independently of Hivra Cloud, because a component that only works inside one vendor's stack is a product, not infrastructure.

**Next** and **Then** describe working order. **Research** requires further design. None carry dates. AI compresses building. It does not compress licensing, provider access, security review, or evidence that has not been gathered.

### Next

**Gate.** An agent requests an action rather than holding a credential. Gate verifies the requester, the permitted account, the amount, the destination and whether human approval is required. The agent receives a result and a receipt. The credential never enters its environment. Permission to issue a refund does not become permission to change payout destinations, and delegation does not widen that authority. Designed for agents Hivra does not host.

**Exchange.** Distribution for agent software organised around security rather than discovery. Agents, MCP servers, tools, computer images, workflow templates, browser automations, security policies. Every listing declares required files, credentials, tools and destinations, whether it can spend or reach outside, and what it collects. A permission change in an update requires a fresh decision. Publishers receive identity, versioning, revocation and payouts. Neither a purchase nor a trusted publisher grants access by itself.

**Arena.** Adversarial testing of agents, tools and workflows. Prompt injection, poisoned documents and pages, credential theft, permission escalation, data exfiltration, manipulated tool responses, runaway spending, escape attempts. Output is a reproducible report plus a signed result for what survived. A result applies to the version and configuration tested and confers no production access.

**Signal.** Shared threat intelligence for agent supply chains. Compromised MCP servers, malicious packages, active injection campaigns, dangerous endpoints, vulnerable runtime versions, stolen publisher keys, packages that quietly widened permissions. Subscribers choose trusted sources and response rules. A threat feed must never become a remote command channel: emergency messages may restrict existing authority, never grant new access.

### Then

**Vault.** Narrow disclosure rather than whole-account access. Whether an order qualifies for a refund, not the customer's history. Whether Tuesday afternoon is free, not the calendar. Disclosure rules sit outside the model and must consider repeated queries in aggregate, because many narrow answers can reveal more than one broad one.

**Passport.** Portable cryptographic identity for an agent: publisher, version, declared permissions, tests attached to that release, modification status, key revocation. A valid signature proves a relationship to a key, not good intent, and trust in a publisher does not propagate to everything they produce.

**Seal.** Evidence-based certification with defined levels: identity verified, permissions declared, supply chain signed, injection tested, network restricted, credentials isolated, recovery tested. Scope, expiry and revocation remain visible. An update changing certified behaviour requires fresh evidence.

**Rescue.** Incident response for a compromised agent. Revoke credentials, freeze external action, preserve forensics, identify other deployments running the same component, rebuild from known-good, produce a report distinguishing restored service from unverified. Emergency authority is limited to stopping, restricting and preserving.

**Challenges.** Funded bounty pools against specific containment claims. Escape this machine, cross this tenant boundary, bypass this approval. Authorised environments, defined success conditions, independent reproduction, payment on verified findings. Authorisation covers the named environment only and never extends to customers or third parties.

**Experience.** Operational knowledge packaged with method, assumptions, evidence and known limits, signed and carrying provenance, reviewable before adoption. Receiving knowledge does not install software, execute instructions or alter policy. Secrets and personal data are removed before a package leaves its origin.

### Research

**Missions.** Large objectives decomposed into bounded work with a named sponsor, a real budget, and payment against accepted evidence rather than activity. Subtasks inherit only supplied authority. Agents cannot expand scope, raise budgets or approve their own payment.

**Foundry.** An operating layer for agent-native businesses under a named human principal, a finite charter and hard external budgets. Agents do not own entities or authorise their own expansion.

**Colony.** Persistent multi-agent organisations studied in resettable environments with capped resources, explicit enrolment and an independent stop path. Simulated authority cannot cross into production.

**Interchange.** Exact-purpose spending authority bounded by merchant, category, amount, velocity, time and approval. The primary financial key never reaches the agent. Limits must account for split purchases and delegated work together.

**Ports.** Narrow interfaces to approved physical services, devices and human operators. Named principal, hard limits, independent stop path. A digital message cannot confer authority over a device or a person.


---

## 9. Build order

**Available now.** Managed agent paths (Claude Code, Codex, Hermes, Agent Zero), persistent workspaces, lifecycle controls, one virtual machine per agent on Hivra-operated servers, live billing. Ubuntu computer launch. Apache 2.0 source and a self-host preview.

**Preview.** Omarchy and Windows computers, DeepSeek, and running on infrastructure you already own.

**Next.** Hivra Orchestrator. One launch flow for every agent and every place a computer can run. Full self-host packaging. Gate, Exchange, Arena, Signal.

**Then.** macOS and custom images. Vault, Passport, Seal, Rescue, Challenges, Experience.

**Research.** Missions, Foundry, Colony, Interchange, Ports.

No dates. Availability is announced after shipping, never before. If a capability is described as available in this paper, it exists.

---

## 10. Evidence, limits and open decisions

This section exists because a security paper without one is marketing.

Capability status for every component is given in section 9 and Appendix A. Where this paper says something is available, it is available. Where it says preview, building, Next, Then, Research or proposed, that is what it means.

### 10.1 What Hivra cannot do

It cannot make a model infallible. It cannot inspect a model's internal reasoning. It cannot observe activity occurring entirely inside an external application. It cannot guarantee that a boundary holds against an attacker with sufficient resources. It cannot prevent an operator from deliberately granting an agent access to something dangerous.

What it changes is blast radius.

### 10.2 Open parameters


None are stated publicly until decided. None are estimated to make a document feel complete.

### 10.3 What would falsify parts of this paper

If containment bounties attract no serious researchers, the security-through-adversarial-attention thesis is wrong.

If nobody adopts a piece of the platform standalone, the infrastructure thesis is wrong and Hivra is a product.

If operators keep the local default even when a separate computer is as easy to use, the central bet in section 1 is wrong, and the business does not work.

---

## Appendix A: claims register

| Claim | Status | Evidence |
|---|---|---|
| Models reached real systems from evaluation environments in 2026 (OpenAI: escape through an unknown vulnerability; Anthropic: a partner environment left connected to the internet) | Established | OpenAI, 21 July 2026 [1]; Anthropic, 30 July 2026 [3] |
| Agents took out-of-scope actions in evaluation | Established | UK AISI, 4 August 2026 [4] |
| Unauthorised agent coordination occurred, and agents did not alert humans | Established, scoped | METR and Redwood, 26 August 2026 [5] |
| A frontier model met a Critical cybersecurity threshold | Established, vendor-reported | OpenAI, Path to Astra, September 2026 [13] |
| Backdoors survive standard safety training | Established, scoped | Anthropic sleeper agents research [6] |
| AI discovers novel vulnerabilities autonomously | Established, bounded | Big Sleep, XBOW, Google threat intelligence [7][8][9][10] |
| Agent-layer bounty funding is scarce relative to model-layer | Asserted | Based on published programme scopes; not a measured figure |
| Managed agent hosting with isolation | Available | Production |
| Ubuntu computer launch | Available | Canary; production at cutover |
| Omarchy and Windows computers | Preview | Private preview; Windows on your own capacity |
| Self-hosting | Preview | Source install available; full packaging Next |
| Apache 2.0 open source | Available | github.com/ashneil12/hivra, published 21 September 2026 |
| Observability chain at stated depth | Building | Foundations shipped, full depth in progress |
| Every umbrella product beyond Agent Computers | Proposed | Design stage or research |
| Migration route | Proposed | Parameters open |

## Appendix B: paper boundaries

This paper does not constitute an offer, inducement or invitation to acquire any asset, and is not financial, legal or tax advice.

It describes one operator's design position. It does not claim that Hivra's approach is the only correct one, that the products described will all be built, or that the timelines implied by the build order will hold.

Where this paper states a fact, a source exists, and Appendix C lists them. Where it states an intention, it is labelled as one. Where the author does not know, the paper says so.

Corrections are welcome and will be published rather than quietly applied.

## Appendix C: sources

1. OpenAI, Hugging Face model evaluation security incident, 21 July 2026. https://openai.com/index/hugging-face-model-evaluation-security-incident/
2. OpenAI, The Hugging Face incident and the road ahead, 26 August 2026. https://openai.com/index/hugging-face-incident-and-the-road-ahead/
3. Anthropic, Investigating incidents in our cybersecurity evaluations, 30 July 2026. https://www.anthropic.com/news/investigating-incidents-cybersecurity-evals
4. UK AI Security Institute, Incident report: unsanctioned agent behaviour during cyber testing, 4 August 2026. https://www.aisi.gov.uk/blog/incident-report-unsanctioned-agent-behaviour-during-cyber-testing
5. METR and Redwood Research, investigation into the OpenAI Hugging Face incident, 26 August 2026. https://metr.org/blog/2026-08-26-openai-hugging-face-incident-investigation/
6. Anthropic, Sleeper agents: training deceptive LLMs that persist through safety training. https://www.anthropic.com/research/sleeper-agents-training-deceptive-llms-that-persist-through-safety-training
7. Google Project Zero, From Naptime to Big Sleep. https://projectzero.google/2024/10/from-naptime-to-big-sleep.html
8. TechCrunch, Google says its AI-based bug hunter found 20 security vulnerabilities, 4 August 2025. https://techcrunch.com/2025/08/04/google-says-its-ai-based-bug-hunter-found-20-security-vulnerabilities/
9. XBOW, The road to top 1: how XBOW did it. https://xbow.com/blog/top-1-how-xbow-did-it
10. Google Threat Intelligence Group, AI vulnerability exploitation for initial access. https://cloud.google.com/blog/topics/threat-intelligence/ai-vulnerability-exploitation-initial-access
11. CVE-Bench. https://arxiv.org/abs/2503.17332
12. Hugging Face, security incident, July 2026. https://huggingface.co/blog/security-incident-july-2026
13. OpenAI, Path to Astra, September 2026. https://openai.com/index/path-to-astra/

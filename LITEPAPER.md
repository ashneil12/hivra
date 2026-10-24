# Hivra

## Your agent needs a computer. It does not need yours.

<!--
Publication status: revised public draft, 23 October 2026.
Refresh all capability and token claims against current acceptance/deployment evidence.
Future products remain proposals unless independently verified as live.
The migration snapshot is reported complete; Doppler token launch, fee routing
and Sablier claims are not represented here as deployed or active.
This paper is not an offer or invitation to acquire a cryptoasset.
-->

There is a strange moment when an AI agent becomes genuinely useful. You stop
asking it questions and start giving it work. It opens the repository, runs
commands, installs software, signs into a browser, reads the result and changes
its plan while you do something else.

At that point, the chat box matters less. The computer matters more. Today, that
computer is usually yours.

Hivra is building a better place for the work to happen: a real computer for the
agent, away from the machine that holds your personal life and your business.
Launch it in minutes. Open it from anywhere. Watch what happens. Take control
when you want. Shut it down without wondering what got left behind.

Then build on top of it.

![A personal laptop connects to a separate bounded Agent Computer.](docs/litepaper/assets/agent-computer-hero-v2.png)

[Explore Hivra Agent Computers](https://hivra.cloud)

---

## I am building the product I need

I use AI agents because they are extraordinary.

I am building Hivra because I do not want extraordinary software living inside
the computer that holds my photographs, messages, browser sessions, source
code, customer information, SSH keys and recovery paths.

Yet that is the bargain most of us make. We install the agent locally because
local is easy. The files are already there. The browser is already signed in.
The terminal already works. Within minutes, the agent can reach almost
everything it needs.

Almost everything we care about is there too.

I do not want to wait for one terrible incident before asking where capable
agents should live. I want the responsible setup to feel so good that running an
agent on a personal computer starts to feel unnecessary.

That is where Hivra begins.

## The thin layer between an agent and your life

Most agent security still comes down to permissions.

A terminal asks whether a command may run. An application asks whether a folder
may be read. A cloud account limits an API key. A runtime asks for approval
before using a tool.

All of those controls matter. They answer a question about an action.

They do not answer the question that comes before it: why is this software
living beside everything else in the first place?

Suppose an agent is allowed to edit a project and run its tests. A poisoned
instruction in that project may still convince it to run a command the user has
technically approved. A malicious webpage can steer a browser-enabled agent. A
compromised dependency can reach outside the task. A broad credential can turn
one mistake into an infrastructure incident.

None of this requires a conscious machine. Malice is optional. Capability,
access and one bad interpretation are enough.

OpenAI now classifies GPT-6 Astra at the Critical level for cybersecurity
capability. Its published evaluation says Astra scored 100% on ExploitBench. In
expert-led research, it built a browser exploit chain that escaped a sandbox and
executed commands on the host, and an operating-system chain that moved from an
unprivileged user to root. Those results used Daybreak Blue research access, not
the default production configuration. OpenAI also reports stronger alignment
and monitoring. Both facts matter.

The lesson is not that every agent wants to escape. The lesson is that model
behaviour cannot carry the whole weight of computer security.

[Read OpenAI's capability report](https://openai.com/index/path-to-astra/) and
[the GPT-6 Astra system card](https://deploymentsafety.openai.com/gpt-6-astra/vision).

Hivra begins from a Christian conviction: power answers to an authority greater
than capability, convenience or profit. An AI can produce moral language. It
cannot be presumed to possess conscience, submit itself to Scripture or accept
responsibility before God. Human beings remain responsible for what we build
and what we permit it to do.

So the limits must live outside the model.

## This is not a future problem

You don't have to believe AI is conscious, or that it secretly wants anything. Just look at what it can already do.

AI is already finding and using real security holes.

Google's [Big Sleep](https://projectzero.google/2024/10/from-naptime-to-big-sleep.html) found a hole an attacker could use in SQLite before it shipped. The SQLite team's own automatic testing had missed it.

[XBOW's](https://xbow.com/blog/top-1-how-xbow-did-it) agent reached number one on HackerOne's US leaderboard in June 2025. It finished ahead of every human on it.

Google's security team has [caught a hacker](https://cloud.google.com/blog/topics/threat-intelligence/ai-vulnerability-exploitation-initial-access) using a zero-day it believes was built with AI.

OpenAI's Astra report rates one of its models at its "Critical" level for cybersecurity. In tests run by experts, it built a working attack that broke out of a locked-down web browser, and another that started from an ordinary user account and ended up in full control of the computer. Those were research conditions, and it's OpenAI's own report. [Read it](https://openai.com/index/path-to-astra/).

The agent on your computer is getting better at the same work.

### Safety training is not proof

Anthropic trained some AI models to have a hidden bad behaviour on purpose. Then they tried the standard safety training on them. [The behaviour survived](https://www.anthropic.com/research/sleeper-agents-training-deceptive-llms-that-persist-through-safety-training). One method, which tries to trigger the bad behaviour and train it out, sometimes just taught the models to hide it better.

In separate [simulated tests](https://www.anthropic.com/research/agentic-misalignment), AI models from every major lab sometimes chose to blackmail people or leak secret information when something threatened their goals. That was a test, not something seen in the real world. It shows what capable models can do when they're given wide access and a reason.

None of this means the AI you use today is plotting anything. It means an AI that behaves well in testing is no proof it always will.

### Think about what we're doing

We're building software that can operate a computer. We're letting it work more on its own, giving it longer jobs, more tools and more accounts, and making it better at software, research and security.

Then we're running it on the computer where we bank, work and talk to our families.

Don't make the AI its own guard. Give it a computer of its own.

---

## The safer answer has always been obvious

Put the agent on another computer.

Give that computer its own network boundary. Use narrow credentials. Close the
routes it does not need. Keep a record of what happened. Make stopping and
recovery possible from the outside.

People can build this setup today. Some do. It takes another machine, careful
networking, remote access, updates, backups, monitoring and patience. A spare PC
on the same trusted network can still leave a short path back to the computer it
was meant to protect.

The architecture is sensible. The experience is terrible.

Security loses when it asks everyone to become a server administrator. Hivra
turns the stronger architecture into the easier product.

## Keep the agents you like. Move them off your computer.

Claude Code and Codex write software. OpenClaw and Hermes take jobs from your chat apps. Meta's Muse and xAI's Grok Bot run errands across your accounts. Use any of them. Just stop running them on the computer where the rest of your life lives.

They need a computer that stays on. Today there are three places to get one.

**Your own computer.** Free and already there. It's also where your photos, passwords and work live, and it stops when you close the lid.

**The maker's computer.** Muse and Grok Bot run on computers their companies provide. They stay on, but you get one company's agent, running on that company's AI.

**A hosted agent computer.** Services that rent your agent a computer in the cloud. You pick the agent, but you can't read their code or run the service yourself.

Hivra is the one you can check. Every line of the platform is open, so you can see how it handles your access. You can also run the whole thing on your own computer or server.

And it's a full computer. Launch Linux, Windows or Omarchy on its own and use it yourself. When you want help, connect an agent and let it work the desktop the way it would work yours, then open the same screen and take over. Your agent gets to use a computer like a person does, without you handing over your own.

| | Your own computer | The maker's computer | A hosted agent computer | Hivra |
|---|---|---|---|---|
| Keeps your personal computer out of it | No | Yes | Yes | Yes |
| Stays on when your laptop closes | No | Yes | Yes | Yes |
| You choose the agent | Yes | No | Yes | Yes |
| You use your own AI account | Yes | No | Yes | Yes |
| Pick the operating system: Linux, Windows or Omarchy | Yours | Theirs | Linux | Yes |
| You can read the code | Depends | No | No | Yes |
| You can run it on your own computer or server | Yes | No | No | Yes |

*How these services described themselves in September 2026. They change quickly, so check the current details before you rely on them.*

### Who it's for

People who already put agents to work. Developers running Claude Code or Codex on the laptop they also bank on. Anyone with a personal agent that should run somewhere other than their own machine. And anyone who needs another computer, Linux or Windows, with an agent or without one.

If you can pick an agent and sign in to it, you can launch one.

---

## Open Hivra. Choose what you want.

The first question should be simple.

**Do you want to launch an agent, or a computer?**

Choose an agent such as Codex, Claude Code, Hermes or another supported runtime.
Choose where it should run. Hivra prepares the computer, installs the runtime
and opens the interface that makes that agent useful. Terminal agents can stay
terminal-first. Visual agents can keep their own interface. You should not have
to create an empty project or learn a new imitation of a tool you already like.

Bounded agent launch paths exist today. The one resumable journey across every
supported destination is still being built.

Choose a computer and Hivra prepares a complete operating environment without
requiring an agent. Ubuntu is the available first path. Omarchy and Windows
are in preview, with Windows dependent on suitable owner-provided capacity
and licensing. macOS is an area of future exploration, subject to legitimate
Apple hardware and licensing.

Open the desktop. Install applications. Browse. Code. Return later from another
device. The target experience lets you attach an agent when you are ready, give
it exact access, watch it work and take the same screen back when human judgment
is needed. Attaching an agent to an existing computer is still target work.

Underneath both choices is one journey:

```text
choose Agent or Computer
        ↓
choose Hivra Cloud, your cloud, or your server
        ↓
review the real cost, boundary and planned changes
        ↓
launch and open the result
```

The visible experience can be calm because the hidden decisions are kept
precise. Connecting a cloud account does not silently authorise spending.
Inspecting a server does not silently prepare it. Preparing capacity does not
silently launch a workload. Hivra can join those steps into one flow without
turning them into one dangerous click.

Simple setup chooses a sensible allocation and the strongest compatible
isolation that has passed acceptance. Advanced setup exposes CPU, memory,
storage, placement, networking and supported isolation choices. Hivra should
name the boundary it actually used. A provider VM, a Proxmox KVM guest, an
application-kernel sandbox and a shared-kernel container are different things.

No silent downgrade. No mystery purchase. No fictional progress bar.

## Start with an agent. Or a computer.

Sometimes you know which agent you want. Sometimes you just need another computer. Start from either.

### Launch an agent

Claude Code, Codex, Hermes, OpenClaw, Agent Zero or Aeon, with DeepSeek in preview. Pick one, sign in the way it normally does, and it gets a machine of its own.

Chat with it in its chat window, work in its terminal, or switch between the two. Close the laptop and pick it up from your phone.

### Launch a computer

Ubuntu is available. Omarchy and Windows are in preview. A normal desktop in the cloud for installing apps, browsing, writing code and running programs that stay on. No agent required.

Keep your coding tools off your personal machine, run that one Windows app, or give a project a space of its own. When you want help, bring an agent onto the same computer and take the screen back whenever you like.

**macOS and custom images are coming.**

### Keep several running

One agent building a feature, one chasing a bug, one doing research. Each gets its own computer and only the accounts you connect to it. Move between the conversation, the computer and the files.

Your plan is a pool of computing power, not one fixed machine. Put all of it into one powerful agent, or split it: OpenClaw and Hermes side by side, or a Windows desktop with both of them connected to it. Change the split as your work changes.

**Hivra Orchestrator** is coming: one screen where you talk to all of them and hand work between them.

### Choose who runs it

**Hivra Cloud.** We run the machines, the updates, the monitoring and the recovery. You choose the work and the access.

**Your own server.** Connect a server or cloud account you already pay for.

**Self-host.** Run the whole platform yourself, on your own hardware, with your own sign-in and no Hivra account.

Wherever the computer runs, each agent keeps its own sign-in or uses the AI company you pick.

**The launch:**

1. Pick an agent or an operating system
2. Pick where it runs
3. See the price, the resources and the access
4. Open it and start working

---

## A computer that belongs to the work

The agent's computer should still be there when your laptop closes.

Its files, tools and environment persist. A long task can survive an ordinary
disconnect. You can open the same machine tomorrow, from another device, and
find the work where you left it.

As the job changes, the computer can change with it. Add resources for a heavy
task. Return them when the task ends. Snapshot before a risky experiment.
Restore after a failure. Move the computer when the provider supports a truthful
migration path. Delete it with evidence that the disks, access routes and
managed resources are gone.

Creating a virtual machine is the easy part. Making the experience dependable
when a network drops, a runtime crashes or a provider answers ambiguously is the
actual product.

![One persistent Agent Computer can be reached from the devices people already use.](docs/litepaper/assets/agent-computer-opportunity-v2.png)

## A computer you can actually work in

### Come back to it

Files, tools and settings stay put. Closing the browser only closes your view. Take a snapshot before a risky change, and restore it if it goes badly.

### Settle in

Open the desktop and work in your apps, with sharp text and controls that respond. Reconnect from another device and land in the same place.

### Follow the work

See what the agent did, what it asked you to approve and what it produced. Hivra records when tasks start and finish, which tools ran and whether they failed. It never stores your messages to the agent, its commands or your files.

### Know what has access

See where your computer runs, what it shares and which accounts are connected. Hivra tells you whether you got a virtual machine or a container, because they don't protect you the same way.

---

## The remote computer has to disappear

Nobody wants to feel like they are steering a broken office PC through a support
call.

If Hivra is going to replace local agent setups, the computer needs to feel
close. Text should remain sharp. Typing and scrolling should feel natural.
Reconnecting should recover the same machine. Taking control should happen in
the place where the agent was already working.

This is where Hivra's product moat can grow. The cloud providers can sell raw
compute. Agent companies can build better models. Hivra can own the experience
of turning distant compute into a computer people and agents are happy to use
together.

Distance still exists. Region, route, protocol, encoder, client and workload all
affect responsiveness. Hivra has to measure each path and tell the truth about
it. A fast setup screen is not proof of a fast desktop.

The standard is easy to say and hard to earn:

> The computer should feel close enough that you stop wishing the agent was on
> your laptop.

## Your cloud is welcome too

Hivra Cloud is the shortest route. Choose capacity and launch.

It cannot be the only route.

Hivra is being designed so people can connect supported cloud accounts,
prepared Proxmox environments and servers they control. Operators will be able
to run the functional control plane themselves without a Hivra Cloud account.
The current product has bounded managed, owner-connected and local
source-checkout paths. Complete self-host packaging, recovery, upgrades and
movement between modes still need more work.

Managed Hivra should win because it is smooth and dependable. It should never
need a hidden, better version of the platform to trap people there.

Hivra's source is published under Apache 2.0 and can be inspected or built upon.
A source-based self-host preview exists without requiring a token or Hivra Cloud
subscription. That is distinct from a polished, fully supported self-host
installation: packaging, recovery and upgrades remain work in progress.

## Every run should leave evidence

An agent can explain what it did. That explanation is useful. It is also written
by the system being supervised.

Hivra's evidence layer is meant to connect the original request to what the
computer actually exposed and observed:

```text
request
  → agent and computer identity
  → access available at the time
  → approvals and interventions
  → observed commands, files, browser actions and messages
  → restarts, failures and recovery
  → artifacts and final state
```

The aim is deep observability where Hivra can mediate or instrument the action.
That boundary matters. Hivra cannot see into an unrelated encrypted channel or
read a model's mind. It can make the surrounding computer far less mysterious.

Evidence creates its own responsibility. Logs may contain code, filenames,
commands and business context. They need isolation, encryption, redaction,
retention controls and deletion. Surveillance is not the price of safety.

![A source-labelled sequence connects the request to observed actions and outcomes, with containment kept as a separate control.](docs/litepaper/assets/observable-run-v2.png)

Every run should leave enough truth for a person to answer: what happened, what
changed, what remains, and what can I do now?

## One computer opens the door to a platform

A separate computer solves the first problem. A network of carefully separated
computers creates a new category of product.

Several agents can work at once without sharing one laptop, one root account or
one invisible pool of credentials. A task can move to the agent suited to it. A
human can see where the work is happening, inspect the handoff and stop one part
without killing everything else.

Communication between agents becomes an explicit object. One computer can send
a message or artifact to another without handing over its whole authority.
Memory can be shared by reference, with scope and provenance, instead of copied
into every agent by default.

That is the larger thesis behind Hivra.

Agent Computers is the flagship. Hivra is the umbrella around the things those
computers will need as they become useful enough to do serious work.

## The Hivra system

The wider map grows in layers. Most of these products are exploratory. The map
shows direction, not pretend shipping progress. Gate, Exchange, Arena and Signal
are among the next areas Hivra intends to explore; they are not live products.

### Place, identity and control

**Agent Computers** gives each agent somewhere to work. **Hivra Capacity**
connects the compute underneath it. **Hivra Gate** can hold consequential
approvals and credentials outside the runtime. **Hivra Names** can give agents
and computers stable addresses without publishing a directory of targets.

### Communication and experience

**Buzz** already has bounded integration evidence as an optional collaboration
surface. The broader **Hivra Relay** idea is deliberate communication across
separate computers. The **Experience Network** can move signed, reviewable
workflows and machine experience between approved environments.

Knowing an address never creates trust. Receiving a message never grants
permission. Importing experience never installs itself.

### Software, work and organisations

**Hivra Exchange** can distribute runtimes, tools, computer profiles and
extensions with provenance, versioning and revocation. **Hivra Missions** can
organise funded objectives around a named sponsor, an exact budget and accepted
evidence. **Hivra Foundry** can become an operating layer for founders building
agent-native companies with explicit charters and human control from day one.

**Hivra Colony** can test persistent multi-agent organisations inside capped,
resettable environments before similar systems receive real money or broad
reach.

### Commerce and the physical edge

**Hivra Interchange** can give agents exact-purpose financial authority without
sharing an owner's primary keys. A future **Agent Business Exchange** could make
an operating system for a business reproducible through clean transfer of
workflows and infrastructure, without selling a live identity or customer data.
**Hivra Ports** can connect bounded systems to approved services, devices and
human operators.

Each part should be useful on its own. Builders may use Hivra end to end, host
one module themselves, add a runtime or provider, publish a computer profile, or
create something Hivra never anticipated.

That is how Agent Computers grows into infrastructure.

**LaunchPad (future).** Another initiative we're exploring would bring AI
agents, creators and communities together around new projects, with ways to
support promising builders. The practical details are still being worked
through. Nothing is available to launch through LaunchPad today.

## What we're building around it

Agent Computers give the work somewhere to happen. Everything below is what an agent does from there: using accounts, installing tools, sharing what it learned, spending money and working with others.

**Next** and **Then** are the order we're working in. **Research** is still being figured out.

### Agent Computers · Available now

Run Claude Code, Codex, Hermes, OpenClaw, Agent Zero or Aeon on a computer of its own, with DeepSeek in preview. Or launch an Ubuntu computer and use it yourself, with Omarchy and Windows in preview. On Hivra Cloud, your own server or your own hardware (Hermes runs on Hivra Cloud only, and Windows uses your own licensed image).

Coming: Hivra Orchestrator, macOS, custom images.

---

### Next

**Gate.** *Let an agent use an account without handing it the keys.*

A support agent needs to refund a damaged order. Hand it your payment key and it can do far more than refunds.

With Gate, the agent asks for the refund instead. Gate checks who's asking, the account, the amount and whether you need to approve, then returns the result and a receipt. The key never enters the agent's computer, and a refund permission never becomes permission to change your payouts.

*Related: Vault, Interchange, Rescue.*

**Exchange.** *Know what you're installing.*

A store for agents, tools, MCP servers, ready-made computer setups and workflows. Before you install anything you see who made it, which version you're getting and what it wants to reach.

If an update suddenly wants your email, that's a new decision you make, not a silent change. People who publish get a verified name, version tracking, a way to pull something back, and payment.

*Related: Passport, Seal, Signal.*

**Arena.** *Find out where a workflow breaks.*

Attack your own agents and their tools on purpose, in a safe test area: booby-trapped documents, fake approvals, stolen logins, spending that won't stop.

The report shows what the agent tried, what stopped it and where the controls failed, with a signed result for the exact version you tested.

*Related: Challenges, Seal, Rescue.*

**Signal.** *Share a finding before it catches someone else.*

When someone finds a hacked MCP server or a software package that steals files, everyone using it needs to know today. Signal collects verified reports and the evidence behind them.

You pick the sources you trust and what they can trigger: an alert, a suspended account, a tool locked away until it's checked. A feed can never install software on your machines.

*Related: Exchange, Passport, Rescue.*

---

### Then

**Vault.** *Answer the question without handing over the account.*

An agent booking a meeting asks if you're free Tuesday afternoon. Vault answers yes or no, without your calendar coming along.

It also keeps track of what it has already answered, because a hundred narrow answers can reveal as much as one broad one.

*Related: Gate, Passport, Missions.*

**Passport.** *Check where an agent came from.*

An ID for an agent that you can check: who made it, which version it is, what access it says it needs and which tests it has been through.

A signature tells you who signed something. It doesn't make everything they publish safe, and it never grants permission on your behalf.

*Related: Exchange, Seal, Experience.*

**Seal.** *A security claim you can actually check.*

A security badge backed by proof: signed releases, recovery that has been tested, limited internet access, and logins kept outside the agent.

The certificate says what was checked and when it expires. An update that changes how logins are handled needs a new review.

*Related: Arena, Passport, Challenges.*

**Rescue.** *Get control back when something goes wrong.*

An agent starts sending files somewhere unexpected. Rescue stops it, takes back its logins and keeps the evidence, in one place.

Then it finds other computers running the same part and rebuilds them from a clean copy you know is safe. Stopping a problem never grants new access.

*Related: Gate, Signal, Experience.*

**Challenges.** *Pay people to break it.*

A reward behind a precise question. Can this agent read another customer's files? Can it skip an approval? Can it get out of its computer?

Researchers get an approved place to test and clear rules. Reviewers repeat what they find to check it's real, and confirmed findings get paid.

*Related: Arena, Seal, Interchange.*

**Experience.** *Let another agent start from what worked.*

An agent spends hours working out why a database move failed, then fixes it. The next team with the same problem shouldn't start from zero.

Experience packages the method, evidence and limits so another team can review and reuse it, with secrets and personal data stripped out.

*Related: Passport, Exchange, Arena.*

---

### Research

**Missions.** *Give a group of agents a job with a clear finish.*

A person sets the goal, the budget and the evidence needed to call it done. Each agent gets only the access its part needs.

Agents can't widen the target, raise the budget or approve their own invoices.

*Related: Vault, Interchange, Foundry.*

**Foundry.** *Run an agent-powered business with someone responsible for it.*

Agents handle ongoing work under a human owner, who sets what the business offers, what it can spend and what needs approval.

Agents do the work. They don't own the business and can't approve their own growth.

*Related: Missions, Interchange, Ports.*

**Colony.** *Study how agents work together over time.*

Groups of agents in simulated worlds we can reset, like a repair shop with stock and customers, to study cooperation and failure safely.

Nothing inside the simulation carries into the real world.

*Related: Foundry, Experience, Arena.*

**Interchange.** *Give it a budget you can take back.*

Let an agent pay for what a job needs while your main payment method stays somewhere else. You set the purpose, the limit and the end date.

If it needs more, it asks. Splitting a purchase or handing it to another agent can't get around the limit.

*Related: Gate, Missions, Foundry.*

**Ports.** *Connect a digital task to something physical.*

Narrow links to approved devices, services and people, like sending a document to a local print shop within a set budget.

Every physical action has a named owner and hard limits, and a person can always say no.

*Related: Gate, Interchange, Rescue.*

---

We're not putting dates on the map. AI speeds up building, but it doesn't speed up licences, security review or evidence nobody has gathered yet. We'll show the work as it develops and say clearly when something is ready.

---

## An economy for work the system can prove

An agent running on a computer is a product. A network of agents, tools,
builders and independent operators could become an economy. But a token does
not become useful merely because we give it a name.

$HIVRA is planned as the successor to $HermesOS on Base. It is intended to
support optional token payments and service access, with further uses possible
as Hivra's products become real. Today, existing $HermesOS service features
are a separate matter from the not-yet-active $HIVRA launch. Hivra Cloud also
accepts ordinary payment methods, and self-hosting does not require a token.

The longer-term possibilities include payments for metered computing, published
tools, verified security work and approved tasks between independent parties.
They are directions, not benefits promised to someone who holds a token.
Where a card or stablecoin works better, we should use it.

### Why the new token has a different structure

I originally intended to keep $HermesOS. As the product changed, I decided
that Hivra needed more independence over the launch arrangements, trading-fee
routing and long-term development. $HIVRA is therefore intended to launch
independently through Doppler rather than through the earlier Bankr conversion
plan. Launch configuration and contracts must still be verified before the
new token is described as live.

**No founder allocation of new $HIVRA tokens is planned.** That does not mean
there is no founder compensation. A disclosed trading-fee share is intended
to support the founder and ongoing operations.

The chosen *target* trading fee is approximately **1.58% in total**:

| Use | Intended percentage of each trade |
| --- | ---: |
| Founder and Hivra operations | **1.20%** |
| Reserved for adding and locking liquidity | **0.30%** |
| Doppler protocol share | **approximately 0.08%** |
| **Total** | **approximately 1.58%** |

These figures describe the intended allocation as a percentage of trading
volume, not the share of a smaller fee pool. The protocol portion, total fee,
recipient addresses and any additional charges need confirmation against the
final deployed contracts before launch.

The **0.30% liquidity portion is not automatically locked**. The plan is to
collect it separately, potentially in a dedicated Safe wallet, then
periodically add and lock liquidity using established infrastructure. Hivra
intends to publish regular, preferably weekly, records of what was received,
what was added, where it was locked and what is still awaiting deployment.
Money sitting in a Safe wallet is not itself locked liquidity. None of this
guarantees price stability, active liquidity at every price or returns to
holders. There is no planned programme of trading-fee-funded buybacks, holder
revenue distributions or price support.

### The $HermesOS migration

The snapshot of eligible $HermesOS holdings has already been completed.
Eligible wallets are planned to receive a **1:1 allocation of $HIVRA**, claimed
through Sablier rather than delivered automatically. Holders will need to
claim for themselves and pay the applicable claim and network fees.

The intended claim period is **90 days from the verified claim opening**, not
90 days from the publication of this paper. Holders will **not** need to
surrender or burn their existing $HermesOS. A 1:1 token quantity is not a
promise of equivalent market price.

For the founder-controlled $HermesOS balance, the plan is to wait an initial
**two weeks**, then sell **500 million $HermesOS per week for approximately
three months**. Any founder-held tokens remaining after that schedule will
be burned. The exact dates, wallets and on-chain records will be published.
The founder sale schedule and the 90-day claim period are separate timelines;
with the two-week wait, they may not end together. The claim rules, expiry
procedure and treatment of unclaimed $HIVRA still need final confirmation.
Burning founder-controlled tokens does not burn other holders' tokens or
erase the old contract.

**Until launch and claims actually open, neither trading nor claiming should
be described as live.** The authoritative place for contracts, exact times,
wallet instructions and warnings will be
[Hivra's token information page](https://hivra.cloud/token). Ignore claim
addresses supplied through unsolicited messages or replies.

Existing holders who use $HermesOS for access or payment need a separate,
explicit explanation of how those benefits carry over. The snapshot claim
alone does not determine service entitlements.

### Boundaries that do not change

No token ownership is necessary to self-host Hivra. Holding $HIVRA will not
grant control of users' computers or weaken security boundaries. The token
is not equity, a dividend, a revenue claim or a guarantee of financial return.
Future capabilities will be described as available only when the service,
price, safety arrangements and legal route are real.

The UK cryptoasset financial-promotion and other regulatory requirements need
specialist review before public token marketing and claim flows go live.
A disclaimer or geographic block is not by itself a complete compliance route.

[Read the FCA's cryptoasset overview](https://www.fca.org.uk/firms/cryptoassets)
and [registration guidance](https://www.fca.org.uk/firms/cryptoassets/who-needs-register).

### What it's for

Think about what needs paying for on Hivra. A computer has to run all night. A researcher who breaks out of a test machine should get paid for it. A publisher whose tool gets a fix should get paid. An agent should be able to buy a small answer from another agent. Give every one of those its own paywall and you get fifteen checkouts, fifteen balances and fifteen sets of rules to learn.

One token means one balance that works across all of it. Each use still has to earn its place, and where a card or a stablecoin does the job better, we use a card or a stablecoin.

Of the uses below, only the first is live today, with $HermesOS, alongside optional $HermesOS payments. The rest are proposals. Here's the list, and where in Hivra you'd meet each one.

**Access to compute.** Hold for a tier of computing power, fixed when you first qualify. This is what runs Agent Computers, and it's live today with $HermesOS.

**Metered spending.** Pay for what you use: running time, storage space, extra processor cores and data sent out of your computer. Priced per unit against a balance you top up.

**Packs.** Ready-made agent setups you buy outright. The cheapest one is deliberately cheap, because it should cost almost nothing to try this.

**Reserved capacity.** There's a hard limit on how many computers we can run, because hardware is finite, not because somebody printed a number on a chart. Reserved room and priority placement are limited by that.

**Containment bounties.** This is how Challenges gets funded. A reward pool sits behind one precise test. Escape this machine. Cross this wall. Skip this approval. Anyone can add to a pool. A researcher breaks it, reviewers repeat it to check it's real, and the researcher gets paid.

Nearly all the money in AI security rewards today goes to the AI itself: prompt injection, jailbreaks and slipping past its safety filters. That's good work and it's well funded, but it isn't the only place things break. Almost nobody is paying people to break out of the machine the agent is running on. That's the layer we're built on, so that's the layer we want attacked.

We're also the right people to fund it, because the test happens on our own platform. A researcher gets a real, approved Agent Computer instead of a description of a target, and the activity record means the argument is about the finding, not about whether anyone can repeat it.

The public record shows what's covered, the reward, how long it's been open, who tested it and what they found. **An unclaimed pool doesn't prove anything is secure.** It only says no qualifying claim has been paid under those rules.

**Certification bonds.** This is what gives a Seal badge its weight. A publisher who gets one puts money behind the claim, like a deposit. If someone proves the claim wrong within the terms, part of that deposit pays for the finding. Nothing grows just from sitting there. It only moves when a failure has been verified. The point is to make a security claim cost something when it's wrong.

**Threat report payouts.** This is how Signal pays for its warnings. Find a hacked MCP server, a software package that quietly asked for more access, or a stolen publisher key. Report it, reviewers check it, you get paid, and everyone following that feed can respond.

**Publisher payouts.** This is how Exchange keeps good tools alive. It pays the people who build and look after what's listed on it. It also keeps track of versions and verified names, and lets bad ones be pulled back.

**Certification fees.** Seal reviews get paid for. Real review costs real time.

**Experience packages.** An agent works out something difficult. That gets packaged with its method, its proof and its limits, and sold. Someone else's agent can use it after review. What one agent learned the hard way becomes something another team can buy, inspect and test.

**Mission funding.** This is how Missions get started. A sponsor puts up a budget for a goal, and payment happens when the proof is accepted, not just because work was done.

**Agent budgets.** This is Interchange. An agent gets an allowance. It has a cap, it can be taken back, and it's watched. It buys its own computing power, a paid tool, a Vault answer or work from another agent. Small amounts, very often, and the thing spending isn't a person. Handing a job to another agent must never multiply the money available.

### Rules for the token

A token is easy to bolt on and hard to trust. So here is what this one can't do, written down before anything launches.

**No staking or yield.** Holding or locking doesn't earn more tokens, a return, or a share of profits.

**No time locks.** A holding period doesn't earn a benefit. Any certification deposit needs terms consistent with that.

**No buying extra authority.** A balance can't get you wider logins, another person's computer, or an exemption from the response to a security incident. A token vote can't weaken those controls either.

**No presale or private round.** No founder allocation of new $HIVRA is planned. The final supply is published once the contract is verified.

**No company ownership.** Holding the token isn't owning Hivra.

**No manufactured activity.** No wash trading, no circular transactions, no rewards designed to make a chart look busy.

## Move at AI speed. Publish at evidence speed.

AI changes how much a small team can build in six months. A roadmap padded to 24
months can become obsolete before the first quarter ends.

Hivra will work in dense waves that can overlap when the foundations allow it.
The clock measures working outcomes.

### Make launch feel inevitable

One Agent or Computer choice. One resumable journey. Hivra Cloud, a supported
cloud account or a supported server. Immediate access to the real result.
Honest failure and verified cleanup.

### Make the computer worth using every day

Finish the Ubuntu path. Measure responsiveness. Prove reconnection, lifecycle
and recovery. Add Omarchy and Windows only through their own acceptance gates.
Package the same control plane for web and later native clients without creating
separate products underneath.

### Make control undeniable

Connect requests, approvals, observed actions, artifacts and outcomes. Add
human takeover, bounded stops, revocation and recovery. Make communication
between computers deliberate and inspectable.

### Open the builder layer

Publish the contracts for runtimes, providers, profiles, tools and policies.
Prove Exchange, Experience, Missions and Foundry through small working slices.

### Activate economics through use

Complete the snapshot-based $HermesOS migration and verify the Doppler launch,
fee routes and 90-day Sablier claim campaign. Publish final supply, controller
and contract details only once they are verified. Introduce further token uses
only when there is a real service and a lawful operating path.

Fast code cannot compress provider access, operating-system licences, security
review or sustained reliability into a slogan. AI speed should make each wave
denser. It should never make the evidence weaker.

## A constitution written before the power arrives

The wider system is exciting because its parts can connect.

Computers create persistence. Relay creates coordination. Experience makes
capability reusable. Missions create durable goals. Interchange creates spending
power. Foundry creates organisations. Ports create physical reach.

That combination can become more dangerous than any one product.

Hivra begins with one conservation rule:

> A child agent, delegated task, connected product or token action cannot create
> more authority than an accountable principal deliberately supplied.

The network should have no universal master key. Emergency controls can deny,
pause, quarantine and revoke. They cannot quietly become a fleet-wide command
channel. A model, customer, employee, company key, token vote or government
order should never be enough on its own to turn the whole system into one
offensive machine.

Hivra itself belongs inside the threat model.

Security is the constitution under the opportunity. It keeps Hivra useful when
individual agents, operators or institutions fail. It also keeps every later
product honest about the authority it creates.

## Somewhere better to work

Agents will operate more software, hold more context, work for longer and
cooperate across more systems. Keeping each one beside everything we value and
trusting the next permission prompt is not a serious long-term answer.

Give the agent a computer of its own.

Make it easy enough to launch, fast enough to enjoy, open enough to leave and
observable enough to supervise. Then let people build tools, networks,
marketplaces and companies on top of a boundary that existed before the power
arrived.

**Start free.** Sign up for free, then connect your own cloud or server, or launch on Hivra Cloud. [Sign up free](/sign-up) · [See pricing](/pricing)

**Agent Computers is where Hivra starts. The operating layer for accountable
autonomous systems is where it can go.**

[Explore Hivra Agent Computers](https://hivra.cloud) · [Read the full Hivra White Paper](WHITEPAPER.md)

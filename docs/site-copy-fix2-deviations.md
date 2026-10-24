# Site copy fix pass 2: deviations and open decisions

Branch: claude/site-copy-overhaul. Date: 21 October 2026. This work is local only. Nothing has been pushed or published.

The Terms and Privacy edits are written up, before and after, in docs/legal-copy-changes.md. They need solicitor review before anyone publishes them.

How to read this file. Each entry gives the page, the text before, the text after and why. "Before" is the branch text unless the entry says it is Ash's Markdown. Quoted texts are exact. Where a quoted text itself held quotation marks, they are shown as single quotes. Where a quoted text held a dash, it is written [dash]. Where the record gave a description instead of a text, the entry says so and has no quote marks. Items that need Ash are in "Decisions for Ash". Things nobody checked are in "Not verified".

Pass 3 (unpaid computers and copy that makes sense, 21 October 2026) is the last section of this file. Where it resolves, changes or replaces an earlier decision or entry, the earlier entry carries a line starting RESOLVED, CHANGED or SUPERSEDED that points to it.

## Run-level agent titles (task 6)

Three agent page titles changed. The browser title, the Open Graph title and the Twitter title all read the same string, so each entry covers all three. No h1 and no description changed in this task, because none held the retired phrases. The JSON-LD did not change either.

### /agents/claude-code: page title

- Before: "Run Claude Code in the Cloud, Even When Your Laptop Is Off | Hivra"
- After: "Run Claude Code in the Cloud, on a Computer That Stays On | Hivra"
- Why: Ash's title says Claude Code itself runs when the laptop is off. Only the computer staying on (paid plans) and a tmux or Telegram run are promised in lib/blog/runtime-facts.ts, so the claim moves to the computer. The bare title is 57 characters, inside the 60 cap (65 with the brand). The code never held the exact string "Even With Your Laptop Off". The live string was "Even When Your Laptop Is Off".

### /agents/codex: page title

- Before: "Run OpenAI Codex on an Always-On Cloud Computer | Hivra"
- After: "Run OpenAI Codex on a Cloud Computer That Stays On | Hivra"
- Why: "Always-On" reads as the Codex CLI being always on. It is reworded to the approved computer-level phrase. The bare title is 50 characters (58 with the brand).

### /agents/openclaw: page title

- Before: "OpenClaw Hosting: An Agent You Can Message, Always Available | Hivra"
- After: "OpenClaw Hosting: Message It on a Computer That Stays On | Hivra"
- Why: "Always Available" claims the gateway agent is always available. The claim now sits on the computer, matching the other two titles and the product glossary (agent, computer). The first repair pass used "Message Your Agent on a VM That Stays On" (58 characters bare), because "Message Your Agent on a Computer That Stays On" is 64 characters, over the 60 cap. A reviewer pointed out that the 56 character "Message It" form fits with "computer", so VM was dropped. The bare title is 56 characters (64 with the brand). If "Message It" reads too clipped, the VM wording is the 58 character alternative. The original wording with "computer" ("An Agent You Can Message, on a Computer That Stays On") is 71.

## Deliberate kept change (task 18)

### /tools/agent-survival-check: Restart=always where Ash wrote Restart=on-failure

The page keeps Restart=always. Ash's Markdown says Restart=on-failure. This is a deliberate change and it needs Ash's yes or no (READ-ME-FIRST item 13).

- Page: /tools/agent-survival-check (crash card, systemd unit and fix sentence).
- Ash's source (batches/05/02-agent-survival-check.md): "Restart=on-failure" in the unit, and "a systemd unit that starts the agent in a detached tmux session and restarts it on failure. Replace User=you with your username, then run: sudo systemctl enable --now agent. Honest tradeoff..."
- Shipped: "Restart=always" in the unit (RestartSec=10 unchanged), and "a systemd unit that starts the agent in a detached tmux session and is set to restart it on failure. Replace User=you with your username, then run: sudo systemctl enable --now agent. Test it once: run tmux kill-session -t agent, wait ten seconds, then run tmux ls to check a new session is back. To stop the agent for good, run sudo systemctl stop agent. Honest tradeoff..."
- Reason: when the agent crashes, the tmux window closes, the last session ends and the tmux server exits with status 0. systemd restarts a clean exit only under Restart=always or on-success. So Restart=on-failure never restarts the very crash the card describes (audit/tools.md A1, systemd.service(5), tmux server.c).
- How the sentences got here: "is set to restart it" and the test sentence came from the earlier fix pass, because the unit was not run on a systemd host. In the repair pass the test sentence was reworded. It used to say "stop the agent on purpose", which is ambiguous under Restart=always (systemctl stop does not bring it back, exiting the tmux session does). It now names the kill-session test and says systemctl stop is the way to end the agent.
- Side effect: if someone exits the agent on purpose (typing exit), tmux ends with status 0 and Restart=always starts a fresh session ten seconds later. Only sudo systemctl stop agent ends it, which the page now says.
- Guard: copy-overhaul.test.tsx asserts that Restart=always is present, Restart=on-failure is absent and the new test sentence is there. It passes.

Ash: say yes or no.

RESOLVED in pass 3 (section 2, "Decided by common sense"): Restart=always stays. Ash asked for common sense rather than a yes or no, and the reason above still holds. Ash's Restart=on-failure wording is not restored.

## Other deviations by task

These are grouped by task id in numeric order. The compare lane's records use names (competitor-facts, compare-meta-descriptions) instead of task numbers, so they follow the numbered tasks. The routed cross-lane requests are numbered by request, not by task, so they come last.

### Task 1: tools facts

#### /tools/claude-code-plan-calculator: method, API rates paragraph

- Before: "Sonnet 5.5 is $2, $10, $0.20 and $2.50."
- After: "Sonnet 5.5 is $2, $10, $0.10 and $2.50."
- Why: Anthropic's API pricing table (read 2026-10-21) lists Sonnet 5.5 cache hits at $0.10, footnoted as 0.05x the base input price, the same ratio as Opus 5.5. $0.20 was Sonnet 5's rate carried over (audit/tools.md A2).

#### /tools/claude-code-plan-calculator: FAQ "Where does the dollar estimate come from"

- Before: "A normal three-hour Sonnet 5.5 day comes to about $13.46, close to Anthropic's $13 enterprise average. Take it as a rough guide. It isn't a forecast for you."
- After: "A normal three-hour day comes to about $8.69 on Sonnet 5.5 and $17.39 on Opus 5.5, either side of Anthropic's $13 enterprise average. Take it as a rough guide. It isn't a forecast for you."
- Why: With the correct $0.10 rate, the unchanged estimate assumptions give $8.69 for a Sonnet day. That is 33% below $13, so "close to" is no longer true. Both figures are computed from apiCostPerActiveHour, not typed. "Anthropic's $13 enterprise average" is kept because the blog test pins that substring.

#### /tools/claude-code-plan-calculator: method, "check those assumptions" paragraph

- Before: "We set the assumptions so that a normal three-hour day on Sonnet 5.5 comes to about $13.46, close to that average, and a heavy three-hour day on Opus 5.5 lands above the $30 line."
- After: "With our assumptions, a normal three-hour day comes to about $8.69 on Sonnet 5.5 and $17.39 on Opus 5.5, either side of that average, and a heavy three-hour day on Opus 5.5 lands above the $30 line."
- Why: Same as the FAQ. The assumptions were chosen against the wrong $0.20 rate, so the page no longer claims they were set to land near $13. The $30 claim still holds (a heavy Opus day is $34.77).

#### /tools/claude-code-plan-calculator: method, models left out

- Before: "It also leaves out Haiku 4.5 ($1 and $5), fast mode (available through usage credits only), Team and Enterprise seats, and usage credits themselves."
- After: "It also leaves out Haiku 5.5 ($0.10 and $0.50 for prompts up to 100,000 tokens, $0.50 and $2.50 above that), fast mode (available through usage credits only), Team and Enterprise seats, and usage credits themselves."
- Why: The pricing table and the Claude Code model-config provider table list Haiku 5.5 as the haiku alias on the Anthropic API. Haiku 5.5 is priced by prompt length, so both tiers are stated. The figures are read from claude-plan-facts.ts (api.haiku). In the repair pass, the paragraph's sources were only modelConfig, fable and fastMode, none of which carries prices. So PLAN_SOURCES.apiPricing was added and the paragraph now cites the Claude API pricing page. A test checks it.

#### /tools/claude-code-plan-calculator: method, "How this was checked"

- Before: "How this was checked: every value on this page was read from the Anthropic pages linked above in September 2026, then checked against them a second time. Anthropic changes plans often, so the month matters. Your inputs stay in your browser."
- After: "How this was checked: every value on this page was read from the Anthropic pages linked above in September 2026, then checked against them a second time. The API rates were checked against Anthropic's pricing table again in October 2026. Anthropic changes plans often, so the month matters. Your inputs stay in your browser."
- Why: The Sonnet 5.5 and Haiku rows were corrected from the pricing table on 2026-10-21, so the sentence says the API rates were re-read. There is a new top-level field, CLAUDE_PLAN_FACTS.apiRatesRead. lastVerified stays 2026-09-30, because the plan prices, limits and changelog were not all re-checked.

#### /tools/claude-code-plan-calculator: visible note under the calculator

- Before: "Prices and plan facts as of September 2026, from Anthropic's own pages."
- After: "Prices and plan facts as of September 2026 (API rates as of October 2026), from Anthropic's own pages."
- Why: Repair pass. The note said September while the method section says the API rates were re-read in October, so the page disagreed with itself. The month comes from F.apiRatesRead. The tool-components test pin was changed to the new string. The line "Last checked September 2026." in the method section is left as it is, since lastVerified is still 2026-09-30.

#### /tools/claude-code-plan-calculator: worked example "Light use, where the API can win"

- Before: "API list price, estimated: $19.42/mo" and "the estimate at API list price, $19.42 a month, comes out a little under Pro's $20."
- After: "API list price, estimated: $12.55/mo" and "the estimate at API list price, $12.55 a month, comes out under Pro's $20."
- Why: Recomputed from computePlanResult for 1 day, 1 hour, 100% Sonnet 5.5, with the $0.10 cache read (12.5466). "A little under" is dropped because $12.55 is about 37% under $20. The verdict that API billing is cheaper still holds.

#### /tools/claude-code-plan-calculator: worked example "Long days and a weekly stop"

- Before: "API list price, estimated: $534/mo"
- After: "API list price, estimated: $452/mo"
- Why: Recomputed for 4 days, 6 hours, 50% Opus 5.5 (451.68). The $376 and $627 Opus-only examples, and every fit rating, are unchanged.

#### /tools/agent-survival-check: lid close card, free-fix snippet

- Before: "caffeinate -dimsu"
- After: "caffeinate -is"
- Why: audit/tools.md A7. The keep-awake builder prints -is (or -i on battery). -d keeps the display awake (battery and heat). -u declares user activity with a 5 second default timeout, so it does nothing here. -m (disk) is not needed. The surrounding text already says full system sleep only on AC power, which is -s. A test ties the snippet's flags to buildKeepAwake(KEEP_AWAKE_DEFAULTS).

#### /tools/ai-agent-hosting-cost-calculator: VPS preset hint (default Hetzner CX23)

- Before: no availability note. The hint was only "Same CPU and memory as Hivra's 2 vCPU, 4 GB computer."
- After: the same hint, plus a second line shown only for the CX23 preset: "Hetzner says the number of servers in this range is limited, so you may not be able to order one when you look."
- Why: audit/tools.md A8. Hetzner's cost-optimised page says the number of available servers is limited, and its CX23 row showed as not available when fetched on 2026-10-20. The note states Hetzner's own limited-supply wording. It does not claim the server is unavailable today. The price maths ($6.49 plus $0.60 IPv4) is unchanged.

#### /tools/ai-agent-hosting-cost-calculator: FAQ "How does Hivra compare to a VPS of the same size?"

- Before: "Hetzner's CX23 has the same 2 vCPU and 4 GB. It lists at $6.49 a month in Germany and Finland, plus $0.60 for its IPv4 address, before tax. DigitalOcean and Vultr list 2 vCPU and 4 GB at $24 and $20 a month. Hivra is $9.99 a month and installs and runs the agent for you."
- After: the same answer, with one sentence added after "before tax.": "Hetzner says the number of servers in this range is limited, so you may not be able to order one when you look."
- Why: Repair pass. The FAQ answer (which also feeds the FAQPage markup) gave the CX23 price with no availability caveat, while the preset hint had one. Both now read one exported constant, HETZNER_LIMITED_NOTE. A test checks the note appears twice on the page and sits between the Hetzner price and the DigitalOcean sentence.

#### Test, guard replaced: lib/tools/__tests__/claude-plan-calc.test.ts, and the header comment of lib/tools/claude-plan-calc.ts

This replaces a guard test, so it is listed for Ash's sign-off, not as a routine pin update. The open question is in "Decisions for Ash".

- Before: a test titled "puts a normal three-hour Sonnet day within 5% of Anthropic's $13 average" asserted |day - 13| / 13 < 0.05 for Sonnet, inside a describe titled "the estimate is held to Anthropic's own cost figures". The claude-plan-calc.ts header said the result "is held within reach of Anthropic's own $13-per-active-day average by claude-plan-calc.test.ts".
- After: a test titled "puts a normal three-hour day on Sonnet below Anthropic's $13 average and a normal one on Opus above it" asserts that the Sonnet day is 8.69 and the Opus day is 17.39 to the cent, below and above $13, inside a describe titled "the estimate against Anthropic's own cost figures". The heavy-Opus-above-$30 and heavy-Sonnet-below-$30 tests are untouched. The header comment now states the $8.69 and $17.39 figures, that the heavy Opus day stays above $30, and that nothing holds the estimate to $13.
- Why: The 5% assertion encoded the wrong $0.20 rate. With Anthropic's real $0.10 and the unchanged estimate assumptions, the Sonnet day is $8.69 and cannot be within 5% of $13. Re-tuning the assumptions would move the $376 and $627 examples that Ash said are unaffected, so the test pins the real values the page prints. In the repair pass, the header comment and the describe title stopped promising a calibration that was removed.

### Task 2: tools closing block

#### /tools and all six tool pages: closing block

- Before: "If your agent needs to carry on after you leave your desk, Hivra offers a managed computer starting at $9.99 a month for 2 vCPU and 4 GB of RAM."
- After: "If you want the computer to stay on after you leave your desk, Hivra offers a managed computer starting at $9.99 a month for 2 vCPU and 4 GB of RAM."
- Why: This is Ash's requested wording. It is a claim about the computer staying on, not about a run carrying on (runtime-facts only promises tmux or Telegram runs). The price and size are still built from plan-facts.

CHANGED in pass 3 ("Lane: copy-product"): the closing block gained one sentence after the AI-usage sentence, "Claude Code uses your own Anthropic sign-in, not Hivra credits." The sentence above is unchanged.

### Task 5: Omarchy and Windows conditions

#### / (home), Computers section

- Before: "Launch a computer for yourself. Ubuntu, Windows and Omarchy are among the available operating-system options, depending on your chosen deployment and its requirements. Windows needs your own server and a licensed image. You can add an agent when you need one."
- After: "Launch a computer for yourself. Ubuntu, Omarchy (prepared computer) and Windows on your own server with your licensed image are among the operating-system options, depending on your chosen deployment and its requirements. You can add an agent when you need one."
- Why: Omarchy runs as a prepared computer and refuses a launch when no prepared slot exists. Windows needs the visitor's own server and licence. The word "available" is gone and each system carries the task's exact phrase. The separate Windows sentence is folded into the list, because the phrase now says it.

#### /, /about, /llms.txt and the home JSON-LD: order of the operating systems

- Before: Ash's order was Ubuntu, Windows, Omarchy (the Home chips ran Windows then Omarchy). This is a description, not a quoted text.
- After: Omarchy now comes before Windows in the Home sentence, the About sentence, the llms.txt sentence and the JSON-LD feature list. The Home chips were reordered to Omarchy then Windows in the repair pass, so they match the sentence.
- Why: The task names Omarchy first, and the long Windows phrase reads better last. It is recorded because the first pass changed the order without saying so and left the chips in Ash's old order. One test pin changed deliberately (home-copy.test.ts, chip order only).

#### / (home), "More computers" launch chips

- Before: chip text "Windows" and "Omarchy" (bare names, linking to the launch flow).
- After: chip text, in this order, "Omarchy (prepared computer)" and "Windows on your own server with your licensed image". The name is in bold and the qualifier is in a 13px muted mono small. There is a new COMPUTERS.others[].note field and new .chipText styles.
- Why: The chips were the other place the two names appeared on the homepage with no condition.

#### / (home JSON-LD): SoftwareApplication.featureList

- Before: "Ubuntu, Windows (your own server and a licensed image) or Omarchy"
- After: "Ubuntu, Omarchy (prepared computer) or Windows on your own server with a licensed image"
- Why: This is the task wording, except "a licensed image" instead of "your licensed image". The homepage-structured-data licence scanner exempts only the exact phrase "a licensed image" and flags any other "licensed". The guard was not widened. Exactly one feature still mentions Windows.

#### /about: "Launch a computer for yourself."

- Before: "Agent Computers aren't only for agents. Use an available Ubuntu, Windows or Omarchy setup yourself, with a desktop or terminal as supported by that environment. Windows needs your own server and a licensed image."
- After: "Agent Computers aren't only for agents. You can use one yourself, with a desktop or terminal as supported by that environment. Choose Ubuntu, Omarchy (prepared computer) or Windows on your own server with your licensed image."
- Why: This removes the unqualified "available" and attaches the task's two phrases. The sentence order changed so "yourself" does not trail "your licensed image". It departs from Ash's Markdown wording. The About page test's verbatim list now pins only "Agent Computers aren't only for agents." for this row.

#### /llms.txt: Omarchy and Windows sentence

- Before: "Also available: Windows (on your own Proxmox host, from your own licensed ISO) and Omarchy."
- After: "Also offered, with conditions: Omarchy (prepared computer), and Windows on your own server with your licensed image (your own Proxmox host and your own licensed ISO)."
- Why: Never an unqualified "available". The Proxmox and ISO detail is kept for answer engines. The pins in llms-txt.test.ts and homepage-structured-data.test.tsx were updated to match.

### Task 6: agent pages, beyond the titles

#### /agents/codex: hero, second lead paragraph

- Before: "Hivra runs the **official OpenAI Codex CLI** on a private cloud VM. Sign in with your own ChatGPT account or OpenAI API key, subject to the provider's terms, give it a project and work from the same computer even when you're away from your main machine."
- After: "Hivra runs the **official OpenAI Codex CLI** on a private cloud VM. Sign in with your own ChatGPT account or OpenAI API key, subject to the provider's terms, give it a project and work from the same computer even when you're away from your main machine. A paid Hivra Cloud computer stays on and is not paused for inactivity."
- Why: The Codex title now says the computer stays on, but its hero did not carry the repo-approved paid-plan sentence that the Claude Code and OpenClaw heroes end with (decision C5). STAYS_ON was appended verbatim from app/agents/content/shared.ts through the {staysOn} token. There is no new wording. This is text beyond Ash's batch 02 file. Ash can revert it by removing the token.

#### agent-seo-catalog.test.ts and content/__tests__/content.test.ts: test pins

- Before: The test "keeps Ash's finished titles and the Codex description word for word" pinned the Claude Code and OpenClaw titles to Ash's exact strings. The C5 hero test covered only claude-code and openclaw.
- After: The test is renamed and re-pinned to the three new titles (the Codex description pin is unchanged). Added: every agent's title, description and h1 must not match an always-on, laptop-off or never-offline pattern. The three stays-on titles must end "computer that stays on". A self-check proves the pattern flags the five retired title wordings. The C5 test now also requires the Codex hero to end with STAYS_ON.
- Why: A pin on a text that Ash's fix list told us to change is updated to the new text. The new tests are additions. The h1 scan widens the new always-on check to the task's stated scope (titles, h1, descriptions). No assertion was removed or widened, no skip or allow-list was added, and AGENT_COPY_BANNED_PATTERNS is untouched.

### Task 7: pricing provider-account wording

#### /pricing: intro

- Before: "Prices are per month, in US dollars. Your AI provider's charges are separate, whether you sign in with an eligible existing account or use an API key."
- After: "Prices are per month, in US dollars. Your AI provider's charges are separate, whether you sign in with your own account (where the agent supports it, subject to the provider's terms) or use an API key."
- Why: Ash's Markdown sentence used "eligible", and the repo rule bans it. "Where the agent supports it" carries the agent hedge. "Subject to the provider's terms" is added so the sign-in promise carries the same qualifier as home, About, tools and the Claude Code and Codex line (the C6 convention). Brackets, no dash.

#### /pricing: Claude Code and Codex line

- Before: "Support signing in with your own eligible provider account, subject to the provider's terms."
- After: "Support signing in with your own provider account, subject to the provider's terms."
- Why: "Eligible" is dropped. "Subject to the provider's terms" already carries the condition.

### Task 8: live count label and the C6 sentence

#### / (home hero): live count label

- Before: "agents launched on Hivra"
- After: "agents and computers launched on Hivra"
- Why: The RPC counts every agent and computer that first provisioned (hivra_agents.provisioned_at, plus legacy and archived instances), so the label says what is counted. It is still dynamic and hidden when the lookup fails. No number was added.

#### /llms.txt: Status section, Stats link note

- Before: "A live, dated count of the agents deployed on Hivra, with a 30-day chart when one is available"
- After: "A live, dated count of the agents and computers launched on Hivra, with a 30-day chart when one is available"
- Why: This aligns the note with the new Home label and with /stats (meta description and the "Agents and computers launched" heading). It was not reported in the first pass. It is now recorded and pinned in llms-txt.test.ts, so the three surfaces cannot drift apart.

#### /features: hosting price paragraph

- Before: "Hosting starts at ... The plan covers the managed computer resources. The plan does not include AI usage. Bring your own account or key where the agent supports it, or pay with Hivra credits. Using your own account is subject to the provider's terms." (the price text before "The plan covers" is elided in the record)
- After: "Hosting starts at ... Either size covers the managed computer resources. The plan does not include AI usage. Bring your own account or key where the agent supports it, or pay with Hivra credits. Using your own account is subject to the provider's terms." (same elision)
- Why: The "plan covers ... / plan does not include ..." pair was the C6 doubling named in the features ledger. "Either size covers" keeps Ash's meaning and no longer echoes the approved C6 sentence.

CHANGED in pass 3 ("Lane: copy-product"): the "Hosting starts at" opening of this paragraph is now "Every computer that Hivra Cloud runs for you needs a paid plan, from **$9.99 a month for 2 vCPU and 4 GB of RAM**. A free account works with a computer or server you connect yourself. A larger option is ..." The "Either size covers the managed computer resources." sentence and the AI-usage sentences after it are unchanged.

#### /features: FAQ "Will Hivra do the AI work without an API key?"

- Before: "Hivra provides the computer. The plan does not include AI usage. Bring your own account or key where the agent supports it, or pay with Hivra credits. Using your own account is subject to the provider's terms. Model charges and usage rules are separate."
- After: "Not as part of the plan. Hivra provides the computer, and model charges and usage rules are separate."
- Why: Ash's fix list says to remove the duplicated C6 sentence where it repeats adjacent text (the hosting price paragraph on the same page carries it once). Round 1 left the answer without a direct reply, so the answer now opens with one. The FAQPage JSON-LD follows the same string.

#### /features/browser-automation: FAQ "Does Hivra supply model inference?"

- Before: "The plan does not include AI usage. Bring your own account or key where the agent supports it, or pay with Hivra credits. Hosting and inference are separate costs. Using your own account is subject to the provider's terms."
- After: "The plan does not include AI usage. Bring your own account or key where the agent supports it, or pay with Hivra credits. Using your own account is subject to the provider's terms."
- Why: "Hosting and inference are separate costs." is Ash's Markdown sentence. It said the same as the approved C6 sentence beside it. The guard test pins the C6 sentence, not this one, so Ash's sentence is dropped. Ash could restore it instead of the C6 sentence only by changing the guard, which this pass does not do.

#### /features/no-docker-hosting: C6 paragraph

- Before: "Hosting and model inference are separate. The plan does not include AI usage. Bring your own account or key where the agent supports it, or pay with Hivra credits. Bringing an API key means your model provider may bill you independently of Hivra."
- After: "The plan does not include AI usage. Bring your own account or key where the agent supports it, or pay with Hivra credits. Bringing an API key means your model provider may bill you independently of Hivra."
- Why: Same as browser-automation. Ash's "Hosting and model inference are separate." repeated the approved C6 sentence that follows it. It is dropped. The C6 sentence and the billing sentence stay.

### Task 9: llms.txt agent availability

#### /llms.txt: paid plan or paid size

- Before: "OpenClaw and Agent Zero need a paid plan."
- After: "OpenClaw and Agent Zero need a paid size."
- Why: It matches the pages (home, About, agents and pricing say "a paid size").

SUPERSEDED by pass 3 ("Lane: copy-core"): no page now names OpenClaw and Agent Zero as the paid agents. llms.txt says "Every computer that Hivra Cloud runs for you needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM. A free account works with a computer or server you connect yourself." and no longer says "OpenClaw and Agent Zero need a paid size."

#### /llms.txt: DeepSeek sentence

- Before: "In preview: DeepSeek."
- After: unchanged, "In preview: DeepSeek." The first pass's rewrite to "DeepSeek Harness cannot be launched yet." is withdrawn.
- Why: The old line is true (private preview, not launchable in lib/hivra/preview-catalog.ts), and /why-hivra/evolution still groups DeepSeek under "In preview". The first pass's reason, that the guards keep a "preview" label out, was wrong. They ban only "private preview". The original test pin is restored. Only the "paid plan" half of the task needed changing.

### Task 10: About entity question

#### /about: FAQ and the FAQPage JSON-LD

- Before: six questions, and no entity question about hivra.ai or hivra.app. The lookalike-domain sentence existed only in the callout: "We're not affiliated with unrelated projects using similar names, including sites at hivra.ai or hivra.app."
- After: a new second question, "Is Hivra the same as hivra.ai or hivra.app?" Answer: "No. Hivra at hivra.cloud is unrelated to other projects called Hivra, such as hivra.ai and hivra.app. Hivra is not affiliated with Nous Research, Anthropic or OpenAI." The callout is unchanged.
- Why: This restores one entity FAQ and the exact old sentences (git b9fe7921). The old answer was "No." plus the disambiguation sentence only. The second sentence is added to cover "and Hivra is not affiliated" in the task. The FAQPage JSON-LD mirrors the visible list, so it carries the same text. In the repair pass, the new test's comment stopped claiming that llms.txt and the agent pages carry these sentences. Only llms.txt carries the non-affiliation line, and the disambiguation sentence appears only on About.

### Task 11: Terms, refunds and failed payments

SUPERSEDED in part by pass 3: the failed-payment, plan-change and refund entries below are replaced by the Terms rewrite recorded under "Lane: copy-legal" in pass 3. The 7-day card-payments wording stays.

#### /terms: Refund & Grace Period Policy is now Refund & Failed Payment Policy

- Before: "Refund & Grace Period Policy: ... Additionally, in the event of a payment failure or cancellation, server instances are retained for a 48-hour grace period before secure deletion." (the middle of the section is elided in the record)
- After: "Refund & Failed Payment Policy: ... If a payment fails or you cancel, we mark your Hermes agents (our original chat agents) as suspended straight away, unless you still have another paid plan with us. We may then switch them off, and we delete a suspended Hermes agent only after a warning period, with emails beforehand. The length of that period depends on your account. Computers run by Hivra are not currently suspended automatically when a payment fails or a subscription ends. We may change this, so please do not rely on a computer continuing to run without payment."
- Why: The 48-hour promise is not what the code does. The code suspends at once, deletes weeks later through a warning ladder, powers off only behind a dark flag, and does nothing for Hivra computers. The review added the product definition and the "another paid plan" exception, which the code has in findOtherLaneEntitlement. No deletion period is stated because it varies by customer. The UK 14-day statutory right is deliberately not added (audit/legal.md raises it only as solicitor question 4).

#### /terms: 7-day guarantee

- Before: "we offer a 7-day money-back guarantee following your initial paid subscription charge."
- After: "we offer a 7-day money-back guarantee on card payments, following your initial paid subscription charge."
- Why: It matches MONEY_BACK_GUARANTEE in lib/blog/plan-facts.ts and the public-claims guard, which now passes on /terms without an exemption.

#### /terms: Upgrade-Only item

- Before: "To move to a lower tier, you must cancel your current subscription and initiate a new one, which will result in the deletion of your current server environment and data."
- After: "To move to a lower tier, you must cancel your current subscription and initiate a new one. What happens to your current computer and its data when you cancel is described in the policy above."
- Why: The old clause promised a deletion that no code carries out (Hermes agents are suspended and kept, Hivra computers are untouched). It also contradicted the new failed-payment text in the same section.

### Task 12: Privacy

#### /privacy: managed inference and wallet partners (viewers with token surfaces off)

- Before: "Managed inference and wallet partners (viewers with token surfaces off): ... Venice (inference) and our wallet provider process the data needed for those features." (elided in the record)
- After: "... Venice (inference) and Bankr (wallet) process the data needed for those features."
- Why: Both live processors are named plainly to everyone. The page test's ban on the word Bankr for surfaces-off was narrowed to drop only that word. All token, ticker, on-chain and blockchain bans remain.

#### /privacy: encryption claim

- Before: "All sensitive data, including your Third-Party LLM API keys, is encrypted in transit and at rest."
- After: "Your third-party API keys and wallet credentials are encrypted before we store them, and connections to Hivra use HTTPS."
- Why: The code evidence covers API keys (lib/crypto.ts), Bankr wallet keys and HSTS. It does not cover all sensitive data.

#### /privacy: service provider list intro

- Before: "which service providers may process it" and "We rely on a small set of vetted providers to run Hivra."
- After: "the main service providers that process it" and "We rely on service providers to run Hivra. The main ones are listed below, and each processes only the data needed for its function:"
- Why: The list cannot be guaranteed complete (Tailscale, the GitHub snapshot and Sablier are unlisted), and "vetted" is unsupported.

#### /privacy: section 3, "exclusively"

- Before: "We use your information exclusively to operate, maintain, secure, troubleshoot, and improve Hivra infrastructure."
- After: "We use your information to operate, maintain, secure, troubleshoot, and improve Hivra infrastructure, and to send you account notices and product updates."
- Why: The page's own Resend line says product updates, and audit C6 rates "exclusively" as contradicted.

#### /privacy: section 6, where providers are located

- Before: "Our providers are located in the United States and the European Union." and "United States providers such as PostHog, Vercel, or Stripe"
- After: "Our providers are located mainly in the United States and the European Union." and "United States providers such as PostHog, Vercel, Stripe, or Resend"
- Why: This brings section 6 level with the longer provider list. The safeguards sentence is left as drafted and flagged.

#### /privacy: section 7, retention

SUPERSEDED in part by pass 3: the retention row for an unpaid computer is rewritten, see "Lane: copy-legal" in pass 3.

- Before: description, not a quoted text. The page had account closure, backup, API-key, usage, diagnostics, activity and fraud retention rows with fixed periods (90 days, about 35 days, 24 months, up to 90 days).
- After: description, not a quoted text. Rows that say what is actually done: account erasure by the team on request, no fixed purge date for backups and archives, vault versus computer key deletion, no automatic schedule for usage, diagnostics and fraud records, and activity records kept while the computer exists. The exact text and the evidence per row are in docs/legal-copy-changes.md (P5).
- Why: No job enforces those periods. The 90-day activity prune is off on production.

#### /privacy: services you connect

- Before: "Services you connect: ... Telegram bot, your Hetzner account or apps through Composio ..." with no lines for Apple, Expo or OpenAI (elided in the record).
- After: unchanged. Apple, Expo, OpenAI (voice and avatars) and DigitalOcean are not added.
- Why: A first draft added them. Review showed each announces a feature that is not public (no iOS app, no caller for the OpenAI routes, bring-your-own cloud beyond Hetzner is not available). The wording and evidence are held in docs/legal-copy-changes.md under "Add at launch".

### Task 13: changelog

#### /changelog: intro lede

- Before: "Dated notes on every notable change to Hivra: bug fixes, new features, upstream syncs and infrastructure work."
- After: "Dated notes on notable changes to Hivra: bug fixes, new features, upstream syncs and infrastructure work."
- Why: The newest entry is 21 June 2026, so the page cannot claim every notable change. The release entries are not touched.

CHANGED in pass 3 ("Lane: copy-system"): the lede now ends with "The newest entry is dated 21 June 2026. Later changes are not listed here." The date is read from the newest entry, not typed. No entries were added, so the page is still four months behind (see "Still Ash's call").

### Task 14: status and stats

#### /status: metadata title (tab, Open Graph, Twitter)

- Before: "Hivra Service Status | Current Incidents and Updates"
- After: "Hivra Service Status"
- Why: Ash's fix list. The page lists no incidents or updates, so the title no longer promises them. The visible h1 stays Ash's "How Hivra is running." The earlier pass's h1 change was undone in this repair, so the h1 is no longer a deviation.

CHANGED in pass 3 ("Lane: copy-system"): the status headline no longer reads "All systems operational". It now reads "Public pages operational" with a line saying the page does not check agents, computers or whether sign-in works. The share card title and subtitle changed with it. The metadata title above is unchanged.

#### /stats: tokens processed odometer

- Before: description, not a quoted text. Every other beat showed the real figure plus a random 0 to 999 offset, on a random 350 to 650 ms cadence (about 2 s with reduced motion, where the offset was already off).
- After: description, not a quoted text. No offset and no randomness. The figure is recomputed from the two hourly checkpoints and the clock every 1 s (2 s with reduced motion). The interpolation between checkpoints is unchanged.
- Why: Ash's fix list. The flicker changed digits without data. Real value changes are kept.

#### /stats: tokens figure, screen-reader label

- Before: "Tokens processed, counting live"
- After: "Tokens processed"
- Why: The figure plays between two hourly checkpoints and is about an hour behind, so "counting live" was not true. This is not in Ash's Markdown, because it is not visible text. It was added in the repair.

#### /stats: Agents deployed heading

- Before: Ash's 06-stats.md has "Agents deployed" (h2). HEAD also had "Agents deployed".
- After: "Agents and computers launched"
- Why: Fix-list task 8 (the live count reads "agents and computers launched"). The edit was already in this lane's files when the repair began and was missing from the earlier record. It is recorded here because the files are in this lane. Which lane made it could not be established.

#### /stats: definition under the count

- Before: Ash's 06-stats.md: "A deployment is a created agent instance, not necessarily a unique user, an agent currently online or a paying subscription." HEAD already differed: "A deployment is an agent that was created and came up successfully at least once, not necessarily a unique user, an agent currently online or a paying subscription."
- After: "A launch is an agent or a computer that was created and came up successfully at least once, not necessarily a unique user, one currently online or a paying subscription." The next sentence ("We keep those measures separate so the number isn't mistaken for something it doesn't represent.") is unchanged.
- Why: Fix-list task 8: the page's own term follows the new label. Same provenance note as the heading.

#### /stats: sentence that lists what the page shows

- Before: "... how many were deployed in the last 24 hours and the last 7 days, the date of the first deployment ..."
- After: "... how many were launched in the last 24 hours and the last 7 days, the date of the first launch ..."
- Why: Fix-list task 8 wording, followed through the sentence. Same provenance note.

#### /stats: meta description

- Before: "Live count of every agent successfully deployed on Hivra. Updated as people deploy."
- After: "Live count of every agent and computer launched on Hivra. Updated as people launch."
- Why: Fix-list task 8 wording. Same provenance note. The routed request 9 below records the same change.

#### /stats: chart heading

- Before: "Deploys, last 30 days"
- After: "Launches, last 30 days"
- Why: The h2, definition and intro sentence now say launched, so the chart over the same count follows. It was added in the repair. The card label "First deploy" and the chart's bar labels ("N deploys") come from lib/i18n.ts and still say deploy until that file changes.

### Task 15: roadmap

#### /roadmap: Next, Arena

- Before: "Arena is intended to make evaluation more practical: defined tasks, observable results and ways to compare behaviour rather than relying on a polished demo."
- After: "Arena is intended as a controlled place to put agents and tools under pressure: difficult or adversarial tasks, a check on whether their boundaries hold and evidence of what happened, rather than a polished demo."
- Why: The ecosystem map says Arena is adversarial testing with kept evidence, not benchmarking. The first sentence and the heading are unchanged.

#### /roadmap: Next, Signal

- Before: Heading "Signal: understand what an agent is doing". Body: "Signal explores clearer visibility into actions, risk and operational health, especially when an agent keeps working without you watching."
- After: Heading "Signal: security warnings you can act on". Body: "Security information isn't much use when it sits in a scattered chat thread or arrives after people have installed the affected tool. Signal aims to collect, verify and share actionable notices about unsafe tools, broken integrations and relevant threats. The goal is useful evidence, not an endless feed of unverified alarms."
- Why: The ecosystem map and the litepaper say Signal shares verified security findings. It is not an agent activity monitor.

#### /roadmap: Then, Vault

- Before: "Vault: stronger protection and control for sensitive material."
- After: "Vault: narrowly scoped answers to a question, without opening the whole account behind it."
- Why: The ecosystem map says Vault answers narrow questions instead of handing over the account.

#### /roadmap: Then, Challenges

- Before: "Challenges: structured problems that help people test, learn and improve."
- After: "Challenges: could reward authorised security research, giving researchers permission to find real weaknesses and a clear route for reporting them."
- Why: The ecosystem map and the litepaper say Challenges reward authorised security research. It is worded "could" because the map says scope and reward mechanics must be defined before anyone could treat it as an active programme. The hedge was added in the repair. The first pass stated it flatly.

#### /roadmap: Then, Experience

- Before: "Experience: ways for agents to retain and reuse useful experience over time."
- After: "Experience: explores how to share lessons an agent has learned, with their assumptions, limits and provenance, so another agent or person can decide whether they apply."
- Why: The ecosystem map says Experience publishes checkable lessons for others. It is not agent self-memory. "Explores how to share" follows the map's "explores how to publish". The hedge was added in the repair.

#### /roadmap: Research, Foundry

- Before: "Foundry looks at making new agents and operator configurations easier to create."
- After: "Foundry looks at how agents could run useful services while humans remain responsible for what those services do, what they spend and what happens when they fail."
- Why: The ecosystem map (and the litepaper: an agent-powered business with someone responsible) says Foundry is agent-run services with a human owner. It is not an agent builder.

#### /roadmap: Research, Interchange

- Before: "Interchange explores controlled spending and settlement between systems."
- After: "Interchange explores scoped allowances for a defined job, with limits, records and the ability for the owner to revoke them."
- Why: The ecosystem map says Interchange is budgets an agent can use but not own. "Settlement between systems" is in neither the map nor the litepaper. This was added in the repair. Interchange was not one of Ash's seven named products.

#### /roadmap: Research, Orchestrator

- Before: "We are also exploring richer orchestration, additional computer environments such as macOS, and custom images. Availability, licensing, cost and safety are unresolved considerations."
- After: "We also intend to explore an Orchestrator, a single place to talk to all your agents and hand work between them, alongside additional computer images including macOS where technically and legally feasible, and custom images. These are planned additions, not presently supported configurations. Availability, licensing, cost and safety are unresolved considerations."
- Why: This is the ecosystem page's Orchestrator sentence ("we intend to explore an Orchestrator ... planned additions, not presently supported"), with the definition from LITEPAPER.md. The roadmap no longer calls it "richer orchestration".

#### /roadmap: How to read progress

- Before: "For shipped changes, visit the changelog. For live incidents, visit status."
- After: "For shipped changes, visit the changelog. For the live state of Hivra's public pages, visit status."
- Why: The status page has no incident source, so pointing readers there for live incidents would be untrue.

#### /roadmap: meta description (also Open Graph, Twitter and JSON-LD)

- Before: "Follow Hivra's move from managed AI agent computers towards safer, connected agent infrastructure. See what's available now and what's still planned."
- After: "Follow Hivra's move from managed AI agent computers to safer, connected agent infrastructure. See what's live and what's planned. Not the Hermes Agent roadmap."
- Why: Ash's fix list restores the Hermes Agent disambiguation, which the old description carried because Search Console showed "hermes agent roadmap" landing here. It is 159 characters. The wording was trimmed to fit under 160.

#### /roadmap: Available today, "Choose where it runs"

- Before: Ash's 02-roadmap.md: "Use Hivra Cloud, connect supported infrastructure of your own, or self-host the platform. Self-hosting does not require a Hivra account or a token." The first pass had: "Use Hivra Cloud. Connecting supported infrastructure of your own and self-hosting the platform are both in preview. ..."
- After: "Hivra Cloud is where agent computers run today. Connecting supported infrastructure of your own is a preview that is not yet part of Hivra Cloud, and self-hosting the platform is a preview too. Self-hosting does not require a Hivra account or a token."
- Why: README.md headlines "Self-host preview", and ROADMAP.md puts connecting a server you already have on Canary and "not yet on hivra.cloud". The page's own rule says a feature is "available" only when people can actually use it, so only Hivra Cloud is now stated as available. The heading and topic stay under Available today, as in Ash's structure (see Decisions). The word "preview" for self-hosting comes from README.md. For connect-your-server it comes from the fix list. ROADMAP.md uses "private preview" only for Windows and Omarchy.

CHANGED in pass 3 ("Lane: copy-system"): this topic is rewritten again. The "After" text above is no longer on the page. See "Lane: copy-system" for the new text and the release gate that still applies.

#### /roadmap: "A straightforward way to pay" and "Build with us"

- Before: "Neither using a card nor self-hosting requires you to participate in a token." and "You can inspect the work, self-host, report problems and contribute ideas without having to buy a token."
- After: "Neither using a card nor trying the self-host preview requires you to participate in a token." and "You can inspect the work, try the self-host preview, report problems and contribute ideas without having to buy a token."
- Why: Both are shown to every viewer and offered self-hosting as a plain option. The preview word is now consistent across the page. They are still the same short "you do not need a token" negations (ROADMAP_NEGATIONS). This was added in the repair.

### Task 16: why-hivra

#### /why-hivra: security paragraph

- Before: "Researchers and security teams have shown AI systems discovering vulnerabilities, producing exploit chains and performing sophisticated security tasks. Google's Big Sleep uncovered a security issue in SQLite that existing automated testing had missed. XBOW reported topping HackerOne's US leaderboard in 2025. And research from frontier labs has shown how capable these systems can become under controlled testing." Next paragraph: "The point isn't that every model can do all of those things in normal use."
- After: "Researchers and security teams have shown AI systems discovering vulnerabilities. Google's Big Sleep uncovered a security issue in SQLite that existing automated testing had missed. XBOW reported topping HackerOne's US leaderboard in 2025." Next paragraph: "The point isn't that every model can do those things in normal use."
- Why: Neither phrase is in the linked sources. Big Sleep and XBOW support vulnerability discovery, and the Anthropic page is about backdoored models. The frontier-labs sentence had no source of its own, so it is removed. "All of those things" becomes "those things" because it now points back at two results, not three capabilities. Only that word pair of the next paragraph changed. The header comment in founder-note.ts now states only what was read (Big Sleep, XBOW and the Anthropic sleeper-agents page).

### Task 17: get-started

#### /get-started: plan names and market anchor

- Before: no change to copy.
- After: no change to copy. A regression test was added over the five English card views (free, operator and fleet, monthly and yearly).
- Why: The English display strings were already clean: no market anchor, no dash, and none of the retired plan names. The translated sign-up pages are not clean. See Decisions.

RESOLVED in pass 3 ("Lane: copy-system"): the translated sign-up pages now follow the English labelling, with no Pro or Power on the cards.

### Compare pages (records named competitor-facts and compare-meta-descriptions)

#### /compare/vs-hostinger: prose

- Before: "Hostinger's managed-agent promotion is $5.99 a month on a 24-month commitment, renewing at $11.99." and "Its pages have shown lower prices for both the managed plan and the KVM 2 VPS since we checked, so confirm the current figures before you compare." (the text between the two is elided in the record)
- After: "Hostinger's managed-agent promotion is $4.99 a month on a 24-month commitment, renewing at $11.99." and "Hostinger shows both the managed plan and the KVM 2 VPS at sale prices, so confirm the current figures before you compare."
- Why: Ash's review, and a fetch of hostinger.com/managed-hermes-agent on 2026-10-21 ($4.99 a month, a struck-through list price, "Up to 77% off", renews at $11.99). The old "lower prices since we checked" caveat is no longer true, because the figures are now the current ones. It becomes a sale-price caveat.

#### /compare/vs-hostinger: at a glance

- Before: Entry price "$5.99/mo on a 24-month prepaid term, size not published"; Commitment "Paid upfront for the term ($143.76 for 24 months)"; VPS alternative "KVM 2 at $8.99/mo: 2 vCPU, 8 GB, root access"
- After: Entry price "$4.99/mo on a 24-month prepaid term, size not published"; Commitment "Paid upfront for the term ($119.76 for 24 months, our arithmetic)"; VPS alternative "KVM 2 at $8.79/mo: 2 vCPU, 8 GB, root access"
- Why: Refreshed figures (KVM 2 $8.79 from hostinger.com/vps/docker/openclaw, fetched 2026-10-21). $119.76 is 24 x $4.99. Hostinger shows no total, so "our arithmetic" is in the cell, as the price table row already did for the old total.

#### /compare: price table, Hostinger rows

- Before: Hostinger managed: "$5.99/mo, size not published" and "Paid upfront for 24 months ($143.76, our arithmetic). Renews at $11.99/mo."; Hostinger KVM 2: "$8.99/mo for 2 vCPU and 8 GB RAM, self-managed" and "24-month term paid upfront. Renews at $14.99/mo."
- After: Hostinger managed: "$4.99/mo, size not published" and "Paid upfront for 24 months ($119.76, our arithmetic). Shown as a sale price. Renews at $11.99/mo."; Hostinger KVM 2: "$8.79/mo for 2 vCPU and 8 GB RAM, self-managed" and "24-month term paid upfront, shown as a sale price. Renews at $14.99/mo."
- Why: Same refreshed Hostinger figures. "Shown as a sale price" is added because both vendor pages show a struck-through list price and a discount badge.

#### /compare: Hostinger caveat sentence

- Before: "Hostinger has since shown lower prices for its managed plan and its KVM 2 VPS, so check its pages."
- After: "Hostinger shows its managed plan and its KVM 2 VPS at sale prices, so check its pages."
- Why: The table now carries the current Hostinger prices, so "has since shown lower prices" would be wrong. The caveat becomes the sale-price one.

#### /compare/vs-agent-37: also on Agent 37's pages

- Before: "Also on Agent 37's pages: flat managed plans from $3.99 a month (1 vCPU and 4 GB of RAM) to $29.99 a month (2 vCPU and 8 GB of RAM), and a free managed agent that sleeps when idle and is removed after 30 days asleep."
- After: "Also on Agent 37's pages: flat managed plans from $3.99 a month (1 vCPU and 4 GB of RAM), through $29.99 a month (2 vCPU and 8 GB of RAM), to $99.99 a month for teams (4 vCPU and 16 GB of RAM), and a free managed agent that sleeps when idle and is removed after 30 days asleep."
- Why: Agent 37 now has a $99.99 top plan (agent37.com/personal, fetched 2026-10-21: 4 vCPU, 16 GB, 40 GB, "For teams"). The tier's name (Max) is left out on purpose. The repo's banned-claims scanner rejects one wording of it, and rewording to slip past that regex would dodge its intent. keyFigures gains "$99.99", so a test keeps it on the page.

#### /compare/vs-agent-37: security attestation (Alternative column)

- Before: "Says SOC 2 Type I, Type II in progress; ask for the report"
- After: "Says SOC 2 Type I, Type II in progress; its trust centre lists SOC 2 as in progress, so ask for the report"
- Why: The prose already said the Trust Center lists SOC 2 as in progress, and the table cell now matches. It was confirmed in the browser pane at trust.agent37.com on 2026-10-21 (SOC 2 in progress, GDPR in progress).

#### /compare/vs-nous-hermes-cloud: always-on, stopped and larger-size rows

- Before: Always-on cost row "About $16.80 over 30 days for 4 vCPU and 2 GB RAM, plus model usage"; "Used a few hours a week" row "Stop it to pay about $0.90 a month for storage"; criterion "Largest size listed" with "8 vCPU and 4 GB RAM at $1.09/day"
- After: "About $16.80 over 30 days at its last published rate for 4 vCPU and 2 GB RAM, plus model usage"; "Stop it and, at its last published rate, pay about $0.90 a month for storage"; criterion "Larger size" with "8 vCPU and 4 GB RAM at $1.09/day, as last published"
- Why: portal.nousresearch.com/cloud, fetched 2026-10-21, shows no per-size prices and sends readers to the Portal (sign-in). The $0.56, $0.03 and $1.09 daily rates are corroborated only by a rival's blog (audit compare-1.md N-04, N-10), which names only two tiers. So "Largest" could not be supported, and the rest is marked as last published.

#### /compare/vs-nous-hermes-cloud: glance criterion

- Before: "Always-on cost, entry size"
- After: "Always-on cost, smaller size"
- Why: Repair of a review finding. "Entry size" claimed the 4 vCPU and 2 GB instance is Nous's smallest, which rests on the same rival-blog source as the figures. "Smaller size" pairs with the "Larger size" row and claims nothing about Nous's range. A test now rejects "entry size" on that page.

#### /compare/vs-nous-hermes-cloud: price sentence

- Before: "Nous Hermes Cloud lists its 4 vCPU and 2 GB instance at $0.56 a day running and $0.03 a day stopped, and asks for at least $2 of credit to deploy."
- After: "Nous Hermes Cloud's last published price for its 4 vCPU and 2 GB instance was $0.56 a day running and $0.03 a day stopped, and its page asks for at least $2 of credit to deploy."
- Why: "Lists" implied a public price list that no longer exists. The $2 minimum is still on the page (fetched 2026-10-21: "$2 minimum in credits, or an active subscription, to deploy a Cloud Agent"). keyFigures $0.56, $0.03, $2, $1.09 and $16.80 all remain on the page.

#### /compare: price table, Nous row

- Before: "$0.56/day running for 4 vCPU and 2 GB RAM, about $16.80 over 30 days"; the terms end "Model usage is extra. Hermes only."
- After: "Last published: $0.56/day running for 4 vCPU and 2 GB RAM, about $16.80 over 30 days"; the terms end "Hermes only. The linked page no longer lists per-size prices: Nous now shows them only after you sign in to its Portal."
- Why: Softened because the figure cannot be sourced from a public vendor page. This repair makes the terms cell say outright that the linked page no longer lists the price. The row label stays "Nous Hermes Cloud" (no "Medium").

#### /compare/vs-xcloud: agents and sources

- Before: Agents "OpenClaw, Hermes Agent, DeepSeek Harness"; four sources.
- After: Agents "OpenClaw, Hermes Agent, DeepSeek Harness, Paperclip"; a fifth source "xCloud Paperclip hosting" (https://xcloud.host/paperclip-hosting/).
- Why: Audit compare-1.md X-05 (verified, incomplete), and a fetch of xcloud.host/paperclip-hosting/ on 2026-10-21: managed Paperclip hosting on the same Cloud VPS 6 GB, 16 GB and 24 GB sizes at $9.99, $19.99 and $29.99. xcloud.host/pricing does not mention Paperclip, so the cell cites the dedicated page. This is also a real visible change on 2026-10-21 for the page whose sitemap date follows the facts date.

#### All comparison pages: sitemap and facts date

- Before: COMPETITOR_FACTS_CHECKED = "2026-10-02". The /compare hub lastmod was PAGE_LAST_MODIFIED.compareHub (2026-10-20). The first pass of this lane had also changed seo-urls.ts and seo-urls.test.ts so the hub took the later of the facts date and compareHub.
- After: COMPETITOR_FACTS_CHECKED = "2026-10-21", with a docblock that says which vendors were re-read that day. compareHub in seo-lastmod.ts is set to "2026-10-21" (the registry convention: set the page's entry to the day its prices changed). seo-urls.ts and seo-urls.test.ts are back to their original text (no diff against HEAD).
- Why: Review finding. Changing sitemap logic went beyond a date bump, and the test mirrored the production expression. The hub's visible price table changed on 2026-10-21 (Hostinger, Agent 37 and Nous rows), so a registry date edit is the in-scope fix. The four host comparisons keep their existing later-of rule, untouched.

#### /compare/vs-xcloud and the facts docblock in competitor-facts.ts

- Before: the docblock said the facts were "each read from the vendor's own pages on COMPETITOR_FACTS_CHECKED".
- After: COMPETITOR_FACTS_CHECKED is described as the day of the latest re-read. The 2026-10-21 refresh note lists what was re-read (Hostinger, Agent 37, xCloud, the Nous $2 minimum) and what was last matched in the 2026-10-20 audit (Railway, Render, Hetzner, DigitalOcean, Fly Sprites, E2B, Orgo, Cloudways, and the Agent 37 metered rates and refund terms).
- Why: Review finding. One shared date must not claim every vendor was read that day. xCloud, the vendor whose sitemap date and time element follow the facts date without a text change, was re-read in this repair.

#### All ten compare pages: meta descriptions

- Before: one shared description on every compare page (SHARED_META_DESCRIPTION, also a literal in app/compare/page.tsx): "A practical comparison of Hivra and alternative AI agent hosting, including pricing models, limitations and who each option suits."
- After, one description per page:
  - /compare: "Hivra compared with Agent 37, Hostinger, xCloud, Nous Hermes Cloud, self-hosting, Railway and Render, with a dated price table. Prices as of October 2026."
  - Alternatives page: "Fly Sprites, E2B, Railway, DigitalOcean, Cloudways, Orgo, a VPS or Hivra: which kind of computer suits an AI agent. Prices as of October 2026."
  - /compare/openclaw-to-hermes: "Hivra can host OpenClaw on a paid computer, or you can move to Hermes with its own migration command. What carries over and what you rebuild."
  - /compare/vs-agent-37: "Hivra is $9.99 a month for 2 vCPU and 4 GB of RAM. Agent 37 meters the same size at $4.76 a month, always on. Where each wins. Prices as of October 2026."
  - /compare/vs-hostinger: "Hostinger's prepaid 24-month sale price against Hivra at $9.99 a month for 2 vCPU and 4 GB of RAM, and when its VPS wins. Prices as of October 2026."
  - /compare/vs-nous-hermes-cloud: "Nous Hermes Cloud meters Hermes by the second; Hivra is $9.99 a month for 2 vCPU and 4 GB of RAM. Not affiliated with Nous. Prices as of October 2026."
  - /compare/vs-railway: "Railway deploys apps; Hivra hosts a persistent agent from $9.99 a month for 2 vCPU and 4 GB of RAM. How the two differ. Prices as of October 2026."
  - /compare/vs-render: "Render's $25 Standard Hermes template: its README warns of no default login. Hivra is $9.99 a month for 2 vCPU and 4 GB of RAM. Prices as of October 2026."
  - vs-self-hosted: "Hetzner costs less each month; Hivra is $9.99 a month for 2 vCPU and 4 GB of RAM and handles upkeep. When self-hosting wins. Prices as of October 2026."
  - /compare/vs-xcloud: "xCloud's $9.99 promotion is 4 vCPU and 6 GB of RAM; Hivra is $9.99 a month for 2 vCPU and 4 GB of RAM. Renewal and beta terms. Prices as of October 2026."
- Why: Per the fix list, each page gets its own description, each at most 155 characters. The drafts in ledgers/compare.json were the starting point. The Railway, Render, self-hosted and xCloud drafts had prices but no stamp, and were shortened to fit 155 characters with it. The Agent 37 draft ("meters compute from $4.76 a month") misdescribed a single always-on shape, so it ties the $4.76 to that shape and builds Hivra's half from ENTRY_PRICE_PROSE (the first pass hard-coded $9.99 and leaned on the words "the same size"). "Sale price" replaces "promotion" for Hostinger. The Render draft's "a login you add yourself" is replaced by an attributed claim, "its README warns of no default login", because the audit supports the missing login only as what the template README says. Hivra's price and size text comes from ENTRY_PRICE_PROSE (plan-facts) on all nine pages that state it. The month comes from formatCheckedMonth(), the same source as the page stamps.

#### /compare/openclaw-to-hermes: no price stamp

- Before: Reviewers asked whether this page's description should carry the stamp, because its glance table shows "From $9.99/mo".
- After: unchanged, no stamp. Its description quotes no price, so none is added. The PRICES_AS_OF_STAMP comment now says the stamp ends every description that quotes a price, not every page that does.
- Why: The ledger draft in ledgers/compare.json has no stamp. Adding "Prices as of October 2026." (27 characters) to the 141-character description would exceed 155 and would stamp a description that states no price.

#### /compare: DESCRIPTION constant in app/compare/page.tsx

- Before: const DESCRIPTION = "A practical comparison of Hivra ..." (a string literal kept equal to the directory copy by a test)
- After: const DESCRIPTION = COMPARE_DIRECTORY.metaDescription;
- Why: The description now carries a month stamp, so a second literal would drift every time the check month rolls. Only the title must stay a literal for the title scanners, and it does. The metadata-titles and absolute-title-metadata tests pass.

### Routed requests (numbered by request, not by task)

These were cross-lane requests applied by the routing pass. Request 8 was not applied and is under Decisions. Requests 11, 15 and 16 are not copy deviations: request 11 was a confirmation, and 15 and 16 changed code comments and the vocabulary baseline.

SUPERSEDED in part by pass 3: requests 2, 3 and 4 below printed Haiku-only monthly totals scaled by the 10x rate ratio. The copy-blog lane removed those totals (see "Lane: copy-blog" in pass 3).

#### Request 1: /blog/claude-max-vs-pro-for-claude-code (article and its test)

- Before: "Anthropic says Haiku 5.5 will join the Claude 5.5 family in the coming weeks, so recheck the Haiku row before you rely on it." The table was stamped "as of September 2026".
- After: "Haiku 5.5 is priced by prompt length. The Haiku row above is for prompts up to 100,000 tokens. Above that it costs $0.50 input, $2.50 output, $0.05 cache read and $0.625 cache write." The table is stamped "as of October 2026".
- Why: Anthropic's pricing table, fetched 2026-10-21 at platform.claude.com/docs/en/about-claude/pricing, lists Haiku 5.5 with these rates, and the audit (tools.md A3) agrees. The generated table row already showed Haiku 5.5, so the old next sentence contradicted it. The sentence is built from API.haiku.longPrompt. The stamp comes from F.apiRatesRead. In the test, the "as of" pin changed to October 2026, the new sentence is pinned, and the four long-prompt constants were added to the existing constants-derived dollar allow-list.

#### Request 2: /blog/cost-of-running-ai-agent

- Before: Claude Haiku 4.5 ($1 input / $5 output per MTok); Batch $0.50/$2.50; lean setup "usually spends $3 to $8 a month"; minimal self-hosted row "$3 to $10 of Haiku tokens", cash "$10 to $17", with your time "$60 to $117"; FAQ "$10 to $17 a month"
- After: Claude Haiku 5.5 ($0.10 / $0.50 per MTok up to 100,000 tokens, $0.50 / $2.50 above); Batch $0.05/$0.25; lean setup "about $1 a month on tokens or less"; row "$1 or less of Haiku tokens", cash "$7 to $8", with your time "$57 to $108"; FAQ "$7 to $8 a month"
- Why: Prices come from the Anthropic pricing page fetched 2026-10-21. The dollar ranges are the article's own earlier Haiku estimate scaled by the exact 10x price ratio. The article never states the token volume behind it, so Ash should confirm. The original sentence "The monthly ranges below were worked out at April 2026 prices and have not been recalculated." is kept (a sibling-post test pins it). It is followed by "The Haiku token figures are the exception: they use the Haiku 5.5 rates above."

#### Request 3: /blog/ai-agent-api-cost-optimization

- Before: Haiku 4.5 $1/$5 gives $10.80 a month ($5.40 on Batch at $0.50/$2.50); shortAnswer and FAQ "about $11"; the FAQ says Haiku 4.5 costs more per token than gpt-6-luna; Hivra illustration: Haiku part "$2-4", API "$10-22", full stack "$20-32"; screenshots "$0.30/month"
- After: Haiku 5.5 $0.10/$0.50 gives $1.08 a month ($0.54 on Batch at $0.05/$0.25); shortAnswer and FAQ "about $1"; the FAQ says Haiku 5.5 lists at the same $0.10/$0.50 as gpt-6-luna; illustration: Haiku part "under $1", API "$8-19", full stack "$18-29"; screenshots "$0.03/month"
- Why: Rates are from the Anthropic pricing page fetched 2026-10-21. Worked costs are recomputed from the article's stated 4.8M input and 1.2M output tokens. The illustration's Haiku part is scaled by the 10x ratio and its totals re-added, which Ash should confirm. The pass also fixed the Haiku 4.5 mentions the request did not list (lines 33, 39, 40, 64, 65, 88), so the article does not contradict itself. It added a note that Haiku 5.5 rates apply to prompts up to 100,000 tokens, and that an 8,000-token run is well inside that. It dropped the unsourced "strong on structured tool-calling" remark about Haiku 4.5 from the FAQ.

#### Request 4: /blog/byo-api-key-explained

- Before: Claude Haiku 4.5 at $1 / $5 per million, Batch $0.50 and $2.50; agent on Haiku "usually spends $3 to $12 a month"; "Haiku 4.5 for speed"
- After: Claude Haiku 5.5 at $0.10 / $0.50 per million on prompts up to 100,000 tokens, Batch $0.05 and $0.25; "usually spends a dollar or so a month"; "Haiku 5.5 for speed"
- Why: The rates are from the Anthropic pricing page fetched 2026-10-21. The monthly estimate is the old range divided by 10, so it is derived, not measured.

#### Request 5: /blog/self-hosting-hermes-guide

- Before: "Claude Haiku 4.5 at $1 in and $5 out per million tokens"
- After: "Claude Haiku 5.5 at $0.10 in and $0.50 out per million tokens" (for prompts up to 100,000 tokens)
- Why: Sourced from the Anthropic pricing page fetched 2026-10-21. The following screenshot-token sentence carries no dollar figure and still holds.

#### Request 6: /blog/run-codex-24-7-in-the-cloud (three places)

- Before: "Hostinger KVM 2 at $8.99 a month on the 24-month plan, paid upfront (about $216 in one payment), renewing at $14.99"
- After: "Hostinger KVM 2 at $8.79 a month on the 24-month plan, paid upfront (about $211 in one payment), renewing at $14.99"
- Why: hostinger.com/pricing/vps-hosting, fetched 2026-10-21, shows $8.79/mo on a 24-month plan, paid upfront, renewing at $14.99 (2 vCPU, 8 GB, 100 GB NVMe). 24 x $8.79 = $210.96. It now matches /compare/vs-hostinger. No $8.99 or $216 is left in the repo.

#### Request 7: /blog/best-vps-for-hermes-agent

- Before: "Hostinger KVM 2 ... $8.99/month on a two-year promotional term, renewing at $14.99/month" (elided in the record)
- After: "Hostinger KVM 2 ... $8.79/month on a two-year promotional term, renewing at $14.99/month" (same elision)
- Why: Same Hostinger page, fetched 2026-10-21. It matches the /compare pages.

#### Request 9: /stats and the llms.txt Stats note

This is the same change that the task 14 stats entries above record from the system lane. Both lanes touched it.

- Before: description "Live count of every agent successfully deployed on Hivra. Updated as people deploy."; h2 "Agents deployed" (Ash's 06-stats.md heading); "A deployment is an agent that was created and came up successfully at least once ... an agent currently online"; llms.txt "the agents deployed on Hivra"
- After: description "Live count of every agent and computer launched on Hivra. Updated as people launch."; h2 "Agents and computers launched"; "A launch is an agent or a computer that was created and came up successfully at least once ... one currently online"; llms.txt "the agents and computers launched on Hivra"
- Why: The counter reads hivra_agents, which includes computers launched without an agent (computerProfile ubuntu-desktop, omarchy, windows), and the homepage links to /stats as "agents and computers launched". The "how many were deployed" and "first deployment" sentences became "launched" and "first launch", so the page uses one word. The English aria label and the llms.txt Stats note follow. The stats page.test.tsx and StatsPageContent.test.tsx pins changed. The h2 and definition are Ash's wording from 06-stats.md, so Ash should confirm or revert this.

#### Request 10: i18n English stats.hero.label

- Before: not given in the record.
- After: "agents and computers launched on Hivra"
- Why: It is an unused key (no consumer found), so the key was kept rather than deleted from eight locales.

#### Request 12: launch flow, OpenClaw card (LaunchJourney.tsx)

- Before: "An always-on agent you reach from your messaging apps."
- After: "An agent you reach from your messaging apps, on a computer that stays on."
- Why: The claim now sits on the computer, not the agent, matching the agents lane's OpenClaw title. It is true for paid Hivra Cloud computers, which are not paused for inactivity (audit tools.md A5). No test pinned the old string.

#### Request 13: /get-started, dead command guidance string (all locales)

- Before: "planGuidance.command: 'Command is best for the biggest workloads...'" (and its translations)
- After: the key is removed from all eight locale blocks. The page renders nothing if a plan ever resolved to "command".
- Why: The string was unreachable (only free, operator and fleet can be selected) and carried the retired plan name Command. The PlanKey type still includes "command", because PLANS.command stays for existing subscribers. get-started/page.tsx renders null for it instead of indexing a missing key. tsc is clean.

#### Request 14: /get-started market anchors in zh, es, pt, fr, de, ja, ko

- Before: translated market anchors such as "Comparable agent platforms start around $19/month" on paid plan cards
- After: no market anchor (an empty string, so the block is hidden)
- Why: A competitor price with no source cannot be kept current. English was already emptied for this reason. The "$19/month" competitor price had no source in any audit file. The page renders the block only when the string is non-empty.

## Decisions for Ash

These are the flags from every lane. Where a record has a recommendation, it is stated. Items marked DECISION were marked that way in the lane record.

### /tools pages

- RESOLVED in pass 3 (kept as "either side of"; see section 2). DECISION, /tools/claude-code-plan-calculator: the estimate assumptions (50K output tokens an hour normal, 100K heavy, 98% cache reads) were chosen on 2026-09-30 to put a normal 3-hour Sonnet day near Anthropic's $13 average, using the wrong $0.20 cache-read rate. With the correct $0.10 the Sonnet day is $8.69 and the Opus day is $17.39. They were not re-tuned, because the brief said the examples move to $8.69, $12.55 and $452 and that $376 and $627 stay. So the pages now say the two days sit "either side of" $13, and the 5% calibration test became a test that pins $8.69 and $17.39. Nothing now holds the estimate near $13. If you want the Sonnet day back near $13, the assumptions must change, which would move $376, $627 and every other figure. Choices: re-tune and re-pin everything, or accept "either side of".
- RESOLVED in pass 3 for the Restart=always question (kept; see section 2). The other unit problems in this bullet stay open. DECISION, /tools/agent-survival-check: item 13 on READ-ME-FIRST still needs your yes or no on Restart=always (see "Deliberate kept change"). Other audit A1 problems in the same unit are untouched: bare claude has no PATH under systemd (a ~/.local/bin or npm-prefix install will not be found), there is no WorkingDirectory=, and After=network-online.target has no Wants=. The unit and the new tmux kill-session test were not run on a systemd host.
- /tools/claude-code-plan-calculator: Haiku 5.5 is priced by prompt length (over 100,000 tokens costs five times as much on every line). claude-plan-facts.ts stores both tiers (api.haiku plus api.haiku.longPrompt). The tool does not model Haiku. The blog's price table prints only the up-to-100,000-token tier, and the article now has a sentence for the higher tier.
- /tools/claude-code-plan-calculator: claude-plan-facts.ts lastVerified stays 2026-09-30 (its own rule: bump it only when every value and changelog row is re-checked). A new apiRatesRead = 2026-10-21 covers the four API rate rows, which were re-read on Anthropic's pricing table (the Fable 5.1 and Opus 5.5 rows matched). No changelog row was added for the Haiku 5.5 launch, because its date was not on any page read.
- /tools/claude-code-plan-calculator and the blog: the usd() helper now keeps a third decimal for rates that need it ($0.125, $0.625) instead of rounding to $0.13 and $0.63. Whole-dollar and two-decimal output is unchanged. The blog article that prints the API table uses the same helper.
- /tools/ai-agent-hosting-cost-calculator: the CX23 note is generic on purpose. Hetzner's page showed CX23 as not available when the audit fetched it on 2026-10-20, and availability changes, so the copy says only that the range is limited. If the default preset should change (for example to a Vultr or DigitalOcean 4 GB plan), that is your call.
- /tools and all six tool pages: the closing block has two stays-on sentences in a row: "If you want the computer to stay on after you leave your desk..." then "A paid Hivra Cloud computer stays on and is not paused for inactivity." Both are approved wording, so both were left.

### /compare pages

- /compare/vs-hostinger and /compare: Hostinger's $4.99 and $8.79 are shown by Hostinger as sale prices ("Up to 77% off ... this Black Friday" on the managed page; KVM 2 "down from $24.49"). They will probably move when that sale ends. The pages and the price table say "sale price" and tell readers to confirm. If you want to avoid a second refresh straight after launch, soften the headline numbers further or set a reminder to re-read both pages.
- /compare/vs-nous-hermes-cloud and /compare: the Nous per-size prices ($0.56/day, $1.09/day, $0.03/day stopped, about $16.80 and $0.90) still cannot be sourced from any public vendor page. They are repo figures corroborated only by a rival's blog. They are labelled "last published" in the prose, the table cells, the sources note and the /compare price table. The price-table terms now say the linked page no longer lists them, and the glance row no longer calls the instance the "entry size". Decide whether to keep them, drop the Nous row, or re-read them from a signed-in Portal.
- /compare/vs-agent-37: the $99.99 top plan is described as "a month for teams (4 vCPU and 16 GB of RAM)" and its name (Max) is left out on purpose. The banned-claims scanner in app/features/__tests__/public-claims.ts matches the string "Max plan". Wording such as "Max tier" would pass the regex but would be written to get round it, so it was not used. If you want the name on the page, decide it as a copy rule (or a scanner exception) and it will be added.
- All compare pages: COMPETITOR_FACTS_CHECKED is 2026-10-21 for every competitor figure, but only Hostinger, Agent 37 plans, SOC 2 and the Trust Center, xCloud and the Nous $2 minimum were re-read that day. Railway, Render, Hetzner, DigitalOcean, Fly Sprites, E2B, Orgo and Cloudways figures, and Agent 37's metered rates and refund terms, were last matched against vendor pages by the 2026-10-20 audit. The docblock in competitor-facts.ts now says so. The reader-facing stamp is month-precision ("October 2026"), so it stays accurate. The /compare hub's sitemap date (compareHub, now 2026-10-21) and its time element include the DigitalOcean and Hetzner-style rows that were not re-read that day.
- /compare/vs-xcloud: the sitemap date and time element follow the facts date (2026-10-21). That is now backed by a re-read of the xcloud.host pricing, OpenClaw, Paperclip, docs and refund pages that day, and by a visible change (Paperclip added to the agent list), not only a meta description.
- /compare/vs-xcloud: the xCloud OpenClaw deploy docs page showed no last-updated date when re-read (the 2026-10-20 audit saw a modified date of 2026-10-15). Its beta label, its "support for this beta feature is limited" wording and its 4 GB RAM minimum are still there, and the page copy quotes only the beta label, so nothing on the page is stale. It is worth a glance on the next refresh.
- Blog quotes of the Hostinger KVM 2 price: a reviewer found four stale quotes. That finding is accurate but obsolete. The two blog articles already say $8.79 (another lane edited them), and no $5.99, $143.76 or $8.99 remains in dashboard/src outside the tests that assert their absence. The earlier cross-lane requests are withdrawn.

### / (home), /about and /llms.txt

- RESOLVED in pass 3 (kept; see section 2). DECISION, /llms.txt: it keeps "In preview: DeepSeek." unchanged. The task listed it as misaligned, but only "paid plan" differed from the pages. If you want llms.txt to say it cannot be launched yet, change that one sentence in src/lib/llms-txt.ts and the matching pin in src/lib/__tests__/llms-txt.test.ts. Plain "In preview" is allowed by the guards. Only "private preview" is banned.
- DECISION, /about: "the exact sentence that hivra.ai and hivra.app are unrelated and Hivra is not affiliated" was read as the two old site-wide sentences (the disambiguation sentence and the non-affiliation line), and both are in the one new FAQ answer. The old answer was the disambiguation sentence alone. About now states non-affiliation in four places: the "isn't affiliated with the makers of the agents" lead, the callout, the Nous, Anthropic and OpenAI FAQ, and this answer. Recommendation: drop the second sentence from the new answer if that reads as repetition.
- /, /about and /llms.txt: the phrase "Omarchy (prepared computer)" is not explained on the page. Per READ-ME-FIRST decision 3, keep it only while the release has no guaranteed prepared Omarchy slot. If every launch gets one, plain "Omarchy" becomes true again.
- / (home JSON-LD): the JSON-LD says "a licensed image", not "your licensed image", because the homepage-structured-data licence scanner exempts only that exact phrase. Home visible copy, About and llms.txt use "your licensed image". Making them identical would mean widening a guard, which was not done.
- /, /about and /llms.txt: Windows and Omarchy remain unverified against production. Whether the served environment has a prepared Omarchy slot, and Windows on a customer's Proxmox host, cannot be checked from code.
- Test file note: src/app/__tests__/homepage-structured-data.test.tsx is outside the home lane's listed ownership. Two pins (the featureList string and the llms.txt Omarchy and Windows regex) and one stale comment were edited, because the file pins the exact text this task changes. No assertion was removed or loosened and the licence scanner is unchanged.

### /agents pages

- DECISION, /agents/openclaw: the h1 "OpenClaw, on call even when you're not online." is Ash's headline and contains none of the retired phrases, so it is unchanged. It is the same kind of agent-level claim. runtime-facts.ts says OpenClaw runs on the computer itself and needs no open browser, and its hero paragraph ends with the paid-plan sentence. Recommendation, if you want it computer-level: "OpenClaw, on a computer that stays on even when you're not online." (also change the pin in app/agents/content/__tests__/content.test.ts). The new always-on test now scans every agent h1, and this one passes.
- DECISION, /agents/codex: the hero now ends with the approved paid-plan sentence (new text beyond Ash's source). To undo it, remove the {staysOn} token in app/agents/content/codex.ts and remove "codex" from the slug list in the C5 test in content.test.ts.
- DECISION, /agents/openclaw: title wording. The title is "OpenClaw Hosting: Message It on a Computer That Stays On" (56 characters). If you prefer the clearer "OpenClaw Hosting: Message Your Agent on a VM That Stays On" (58), it uses VM, which is not in the product glossary but is used in the page's own description ("managed cloud VM"). The catalog test pins would need the matching string.
- /agents/claude-code, /agents/codex and /agents/openclaw: the three stays-on titles carry no "paid" qualifier, because a title cannot. The paid qualifier now sits in the Claude Code, Codex and OpenClaw hero paragraphs (STAYS_ON). Hivra has no hosted free computer, so every cloud computer is a paid one anyway.
- Agent Zero page: the first-pass cross-lane note on "An always-available paid computer." (the Agent Zero body term) stands. It is left as a computer-level, paid-qualified body line, not a title, h1 or description.

### /pricing, /features, /changelog, /why-hivra and /get-started

- /features/browser-automation, /features/no-docker-hosting and the /features FAQ: the repair drops two of Ash's own Markdown sentences ("Hosting and inference are separate costs." on browser-automation, "Hosting and model inference are separate." on no-docker-hosting) in favour of the owner-approved C6 sentence, because the claims.test guard pins the C6 sentence and no test pins Ash's. You can overrule this, but keeping both means the same fact twice on the page. The /features FAQ also loses Ash's long answer for a short direct one.
- /pricing: the C6 sentence appears twice (pricing-content.ts lines 240 and 306) and its own test pins exactly two, in different sections. It was not changed, because /pricing was not named in the Features task.
- /pricing: "whether a given Claude or ChatGPT plan permits this use" is a provider-terms question that cannot be verified from code. The page now says "subject to the provider's terms" beside the promise but cannot say which plans qualify.
- /features: "Not as part of the plan." on the FAQ is true to the C6 wording (the plan does not include AI usage). How Hivra credits are bought, and which agents accept an own-account sign-in, remain production facts not checked here.
- /changelog: there are no "Hermes Pro" lines left on this branch tip. dashboard/hermes_changelog.md has no whole-word Pro, Power, Command or Starter (its only "Pro" substrings are "Proxmox"). Ash's Markdown line "Works on Hermes Pro browser agents and Hivra browser boxes." was already changed to "Works on Hermes browser agents ..." by commit cb43a5f0 (core3-fix), together with dash fixes, British spellings and other wording. The entries are byte-for-byte the branch tip, not Ash's Markdown, and are pinned by sha256 in lib/__tests__/changelog-data.test.ts. To restore the Markdown exactly, revert hermes_changelog.md to cb51f053 and the pins (ledger core3-fix).
- RESOLVED in pass 3 for the translated sign-up pages, which now follow the English labelling (see section 2 and "Lane: copy-system"). The billing names Pro and Power elsewhere stay Ash's call (section 4). DECISION, /get-started: the translated pages (es, pt, fr, de, ja; zh and ko likewise name Pro) still show the billing names Pro and Power in the plan guidance and, through plan.name, on the cards. plan-card-copy.ts keeps them on purpose for other languages. Either extend the "no Pro/Power" rule to the translated sign-up pages (an i18n lane rewords planGuidance and the card names) or record that the rule covers English only. The English market anchor and Command guidance string are already gone. Status for task 17 is partial because of this.
- /get-started: get-started/page.tsx line 579 (`{selectedPlan === "command" ? null : setup.planGuidance[selectedPlan]}`) is in the site lane's folder but was not made by that lane. It appeared after round 1, with the edits to src/lib/i18n.ts that removed the "command" planGuidance keys and emptied marketAnchor in all locales (another lane, the routed requests 13 and 14). It is unreachable at runtime, because only free, operator and fleet are offered, and it exists so the type-check passes. tsc is clean on the tree as it stands now.
- /get-started: with ?cadence=yearly the page shows Hivra annual prices ($79 and $149 a year). copy-rules findBannedClaims flags that ("Do not state a Hivra annual price"). This is the checkout's own yearly toggle (existing tests pin it), so it is left. The new regression test scans banned claims on the monthly views only and says why in a comment. Decide whether the yearly toggle stays on the public sign-up page.
- /why-hivra: the "frontier labs under controlled testing" idea is now simply absent. If you want a lab reference back, the Anthropic sleeper-agents link could support a sentence about models trained to behave deceptively in constructed tests, not about capability. It is your call.

### /roadmap, /status and /stats

- CHANGED in pass 3, release gate still open (see section 2 and "Lane: copy-system"): the Roadmap now says Hivra Cloud runs computers for you on a paid plan, that you can connect a server you already have (a free account is enough) and that self-hosting the whole platform is a preview. That is true only if the release includes the connect flow. DECISION, /roadmap: is connecting your own server in the release? The roadmap now calls it a preview that is "not yet part of Hivra Cloud", because ROADMAP.md says it is on Canary and not yet on hivra.cloud (READ-ME-FIRST item 9 asks the same question). If it ships on hivra.cloud, change that sentence (ecosystem-alignment.test.ts will fail when ROADMAP.md changes, by design). If it does not, consider moving the "Choose where it runs" topic out of "Available today", since previews sit under a heading that says available. Ash's structure was kept. The word "preview" comes from README.md ("Self-host preview") for self-hosting. For connect-your-server it comes from the fix list, not from README.md or ROADMAP.md.
- DECISION, /status: it still has no incident list, incident history or data source. The metadata title is now just "Hivra Service Status" and the h1 is Ash's "How Hivra is running." The live checks cover four public pages from the viewer's browser. Ash's "Current incidents" and "Recent history" sections stay omitted.
- DECISION, /status: the closing line "We would rather explain a disruption plainly than hide it behind a vague uptime percentage." is Ash's wording and is kept. It is a stated preference, and the page does avoid uptime percentages, but nothing on the page can explain a disruption beyond the email contact line below it. Recommendation: keep it, or replace it with "This page shows what its live checks find, not an uptime percentage." if you want only claims the page itself backs.
- DECISION, /stats: "We won't publish guessed figures" from 06-stats.md stays out. The flicker is gone and the screen-reader label no longer says "live", but the tokens figure is still a smoothed value between two hourly checkpoints, about an hour behind reality. Either restore the sentence and say plainly that the figure is hourly and smoothed, or leave both out.
- DECISION, other pages (read only, not edited): the word "preview" for connect-your-server and self-hosting is not used on other public pages, which present them as plain options. Examples: dashboard/src/components/landing/home/content.ts lines 65, 299 to 308 and 371; dashboard/src/app/pricing/pricing-content.ts lines 66, 123, 154, 174 and 183 to 189; dashboard/src/app/about/about-content.ts lines 180 to 195 and 266; dashboard/src/app/layout.tsx lines 78, 121 and 138 (the site description); dashboard/src/lib/llms-txt.ts lines 64, 91 to 94 and 151 ("Available now on Hivra Cloud: ... You can also self-host the platform on your own server", line 151 re-checked); the agent pages (app/agents/content/*.ts) say "explore self-hosting". LITEPAPER.md ("Choose who runs it") also lists "Your own server" and "Self-host" without a preview qualifier. Ash picks the one word for all pages.
- /stats: the vocabulary is mixed until lib/i18n.ts changes. The heading, definition, intro and chart now say "launched" or "launches", but the card label "First deploy" and the chart bar labels ("N deploys") still say deploy. Not established: which lane made the "launched" edits in the stats files (fix-list task 8). They are recorded in the task 14 entries above.
- /roadmap: wording not changed, because it was outside the seven named products. Gate is described more loosely than the map's "access an account without handing it the secret", but the litepaper's Gate text does include "whether you need to approve", so it does not contradict. Colony is looser than the map's practice worlds but not contradictory. Exchange, Passport, Seal, Rescue, Missions and Ports are looser but not contradictory. Say if you want Gate and Colony aligned word for word too.
- /roadmap: ROADMAP.md places the Hivra Orchestrator "After the announcement", and the litepaper says it "is coming". The roadmap page keeps it under Research as "intend to explore", matching the ecosystem page. ROADMAP.md also calls Windows and Omarchy "private preview", which the roadmap page does not mention.
- /roadmap: "Not the Hermes Agent roadmap" is back in the description only, as asked. It is not in the title or the hero, so the hero still does not say whose roadmap this is.
- /roadmap: still open from earlier ledgers and untouched. The snapshot sentence in roadmap-content.ts (SNAPSHOT_SENTENCE) says the snapshot "has already been completed as of 20 October 2026", which an earlier ledger says is not true yet. It is hidden unless token surfaces are on and must be checked on the day they are switched on. The "keeping that earlier document" sentence has no archive link.

### /terms and /privacy

- SOLICITOR REVIEW REQUIRED before any Terms or Privacy edit is published. docs/legal-copy-changes.md opens with a 7-item pre-publish checklist and holds every before and after.
- RESOLVED in pass 3 (dates are set on the publish day; copy-legal left both unchanged on purpose). BLOCKER before publish: both Last Updated dates (Terms "May 2, 2026", Privacy "September 24, 2026") are unchanged and stale, and Privacy section 11 promises material changes show in that date. Set them on approval and update the two page tests. This is checklist item 2.
- RESOLVED by policy in pass 3: Ash decided that an unpaid Hivra computer is stopped (48 hours after the first failed card payment, at the next sweep once a plan has ended). The Terms now say so, and the lapse code exists in the lapsed-computers tree. Both are true only once that code is merged and HIVRA_LAPSE_ENFORCE_LIVE is "true" (section 1). DEFECT OR POLICY (F1), /terms: no code suspends, stops or deletes a Hivra computer when a subscription fails or ends, so a lapsed computer appears to keep running unpaid. The Terms now say only that computers run by Hivra are not currently suspended automatically and that this may change. This publishes an operational gap. Decide before publishing. Recommendation: fix billing or decide the policy, then reword.
- RESOLVED in pass 3 (hold until the features are public; see section 2). DECISION, /privacy: the Apple, Expo, OpenAI (voice and avatars) and DigitalOcean provider lines are held off the page. The data flows exist in code, so when those features go public the lines must go in (exact text in docs/legal-copy-changes.md, "Add at launch"). Recommendation: hold until public.
- F2, /terms: the deletion period for lapsed Hermes agents is 8 or 44 days depending on how stale-suspended-sweep classifies the customer, and power-off needs DUNNING_GRACE_ENFORCE_LIVE=true. The Terms state no number.
- F3, /privacy: five of nine original retention promises had no job behind them, and the 90-day activity prune is off on production. The page says what is done.
- F4, /privacy: left as drafted and flagged. "Session replays: up to 30 days. Product-analytics events: up to 12 months." (PostHog settings, unverifiable) and "typically up to 7 years" for billing records, which the operator deletion script contradicts. The task said to flag what cannot be verified. Pre-publish checklist item 5 requires confirming them.
- F6, /terms: the UK 14-day statutory cancellation right is not added, because the audit supports no wording. The solicitor decides, alongside the card-payments-only 7-day guarantee and the DMCC subscription rules.
- F7, /privacy: "rigorous security hardening", "Your agent environments are isolated", Hetzner "European Union", the SCC and UK Addendum reliance and "Each processes only the data needed" are left as drafted and are not proven by code.
- F8, /privacy: the Base network data providers line stays behind the token gate. If on-chain payments or Bankr wallet reads run with token surfaces off, it should be shown to everyone.
- PARTLY SUPERSEDED in pass 3: the Terms no longer say monthly-only billing, Stripe-only payment or "each Hermes agent" (see "Lane: copy-legal"). The tier names Pro and Power stay (decision L1) and everything else in this bullet stays open. /terms and /privacy: still open and out of lane scope. There is no legal entity, address, governing law or minimum age. Privacy section 2 omits several data categories (wallet data, connected-service tokens, first-touch attribution, risk scores). The Terms still say monthly-only billing, Stripe-only payment, "each Hermes agent" and the tier names Pro and Power (kept by decision L1; only you can overrule). The liability clause has no cap.

### Blog articles

- /blog/claude-max-vs-pro-for-claude-code: the article and its test must be committed together. The working-tree edit to the article (API_AS_OF from F.apiRatesRead, and the Haiku 5.5 prompt-length sentence) matches the cross-lane request the tools lane returned, so it was read as that request applied (routed request 1). The test file also carries pins for the new prompt-length sentence, "as of October 2026" and the longPrompt constants allow-list. They pass only while the article edit stays. The other four blog articles that had stale Haiku 4.5 prices (cost-of-running-ai-agent, ai-agent-api-cost-optimization, byo-api-key-explained, self-hosting-hermes-guide) now mention Haiku 5.5 in the working tree. That was confirmed by grep only, not by checking their sums.
- RESOLVED in pass 3: the scaled Haiku-only totals were replaced (see section 2 and "Lane: copy-blog"). Routed requests 2, 3 and 4 (cost-of-running-ai-agent, ai-agent-api-cost-optimization, byo-api-key-explained): the token volume behind the old Haiku ranges is not stated in the articles, so the new dollar figures are the old estimates scaled by the exact 10x price ratio. They are arithmetic, not measurement. Please confirm them.
- Blog article titles outside the agents lane still say "How to keep Claude Code running 24/7 (even when your laptop closes)" (lib/blog/articles/*). It is a similar agent-level claim for the blog lane or you to look at.
- Haiku 4.5 still appears in src/lib/models.ts, src/lib/services/hetzner-instance-builders.ts and the what-is-hermes-agent blog article. Those are model-picker entries and a list of models Hermes supports, not Anthropic price claims, so they were left alone.

### Token-gated papers

- The token-gated papers disagree with each other and with the pages on Omarchy and Windows. The litepaper says plain "Windows or Omarchy", and the whitepaper says "private preview". The wording needs one decision by the litepaper or token copy owner.

### Routed requests that were skipped or left alone

- RESOLVED in pass 3 (left alone on purpose; see section 2). Request 8, LITEPAPER.md, docs/litepaper/restricted/LITEPAPER.md, dashboard/public/restricted/LITEPAPER.md and the built docs/litepaper/index.html (Windows and Omarchy wording at lines 165 and 246, drop "DeepSeek in preview"): not applied, for you to decide. The overhaul's own plans (plans/why.md) put LITEPAPER.md and docs/litepaper/** on the do-not-edit list, and the litepaper is your own token-gated text. Token wording goes to legal review, and your text is applied verbatim. The change would have to be made in three copies and regenerated into the built HTML, which test_content.py pins. Line 246 already ends with "Windows uses your own licensed image". Suggested text if you want it: line 165 "Ubuntu, Omarchy (prepared computer) or Windows on your own server with your licensed image."; line 246 the same phrase, and either drop "with DeepSeek in preview" or use llms.txt's "DeepSeek Harness cannot be launched yet".
- Request 16 extras, the vocabulary baseline: the regenerated baseline also lowered app/dashboard/agent/[id]/page.tsx runtime 5 to 3, components/hivra/RuntimeSurfaceFrame.tsx runtime 3 to 1, and removed components/hivra/PoolMeter.tsx and components/landing/FullTokenomicsSection.tsx. Those files are not part of this pass's copy changes, and lowering them could break a later merge with other branches. Only the terms and privacy page entries were applied. Re-run the update command after the branches are merged.
- RESOLVED in pass 3: the "$25-62/month" full range and the other scaled totals were removed (see "Lane: copy-blog"). /blog/ai-agent-api-cost-optimization: not requested and left alone. "Full range: about $25-62/month" has a lower bound with no stated derivation, so it was not rescaled. The lean total beside it is now $18-29, so you may want to re-derive the full range.
- RESOLVED in pass 3: the label now reads "Agents and computers running now" (see "Lane: copy-system"). /stats: not requested and left alone. The "Agents live now" label and "how many agents are live right now" text. The running-now count also includes computers (hivra_agents status running). Whether the live card should also say "agents and computers" is your call.
- PARTLY RESOLVED in pass 3: copy-blog set lastModified to 2026-10-21 on 21 blog articles (see "Lane: copy-blog"). Seven edited blog articles: not requested and left alone. lastModified (six still 2026-10-05, claude-max-vs-pro-for-claude-code 2026-09-30) was not bumped. The prices were refreshed on 2026-10-21, so an SEO owner may want it moved. what-is-hermes-agent.ts still lists "Claude Haiku 4.5, Sonnet 4.6, Opus 4.6" as supported models, which is a model-support list and not a price, so it was left.
- RESOLVED in pass 3: the translated pages now follow the English labelling (see section 2 and "Lane: copy-system"). Translated /get-started pages: not requested and left alone. They still show the billing names Pro and Power, the old "always-on" wording and the old guarantee words (already recorded by the system lane). Only the $19 anchor and the Command guidance were removed there.

### Sitemap dates (lib/seo-lastmod.ts)

- Tool pages: the sitemap lastmod for the tool pages is Foundation-lane code. The plan calculator's visible note says API rates as of October 2026, and the method section keeps "Last checked September 2026." on purpose, because lastVerified was not re-read.
- CHANGED in pass 3: copy-product moved AGENT_PAGES_LAST_MODIFIED to 2026-10-21 because the agent page text changed. Agent pages: AGENT_PAGES_LAST_MODIFIED stays 2026-10-20. The title changes are metadata only (lib/seo-lastmod.ts says that does not move the date), but the Codex hero gained one visible sentence. Bump it to 2026-10-21 if you count that as a substantive change. Nothing pins the current value.
- RESOLVED in pass 3 (set on the publish day; see section 2). /pricing, /features, /features/browser-automation, /features/no-docker-hosting, /why-hivra and /changelog: their visible text changed on 2026-10-21, but their entries still read 2026-10-20. The compare lane has already moved compareHub to 2026-10-21. This can wait until ship time.
- RESOLVED in pass 3 (set on the publish day; see section 2). /roadmap, /status and /stats: their entries still say 2026-10-20, although their copy changed again on 21 October. Set the dates to the final release date when it is known.

## Not verified

### Tools pages

- The Haiku 5.5 launch date: it is not on any page read, so no changelog row was added.
- Hetzner CX23 availability today: only the audit's 2026-10-20 snapshot of the cost-optimised page was read (the "limited" sentence and the "not available" CX23 row). Hetzner was not re-fetched.
- The CX23 hint and FAQ sentence, the longer example lines and the new plan-calculator note were checked in jsdom and by test assertions only. There was no browser or phone-width look.
- After the repair, only a scoped jest set was run: src/lib/tools, src/components/tools, src/app/tools, the claude-max-vs-pro blog test, static-copy-safety and llms-txt (24 suites, 457 tests, all pass). The wider set from the first pass (all of src/lib/blog, the llms.txt route, metadata-titles, absolute-title-metadata, seo-urls, agent-seo-catalog; 40 suites, 685 tests) passed before the repair and was not re-run, though the repair touched only this lane's tool files and tests. The whole suite was not run.
- The systemd unit (Restart=always) and the tmux behaviour behind it, including the new tmux kill-session -t agent then tmux ls test, were not run. There is no systemd host or tmux on this Mac. The claim rests on systemd.service(5) and tmux source as read by the audit.
- The Anthropic page fetches in the first pass went through a summarising fetch. The Sonnet 5.5, Opus 5.5, Fable 5.1 and Haiku rows were read from the saved raw table output. The model-config provider table (haiku alias to Haiku 5.5) is from the summary only, and the last 20,928 characters of that page were not read.
- The Haiku 5.5 sums in four other blog articles (cost-of-running-ai-agent, ai-agent-api-cost-optimization, byo-api-key-explained, self-hosting-hermes-guide) were not re-checked by the tools lane. They belong to the blog lane.

### Compare pages

- Rendered pages were checked only through jsdom tests, tsc and eslint, not in a browser at 1440 or 390 wide. The longer Nous table cell, the longer Agent 37 security cell, the longer Nous price-table terms and the longer xCloud agents cell may wrap differently from before.
- Hostinger KVM 2: the page shows $8.79 with "Renews at $14.99/mo for 2 years" but does not itself label $8.79 as a 24-month price (it says all plans are paid upfront and the monthly rate is the plan total divided by months). The existing "24-month term" wording is unchanged.
- Agent 37's metered rates ($4.76, $9.34) and its refund and auto top-up terms were not re-fetched on 2026-10-21. The 2026-10-20 audit found them unchanged.
- Railway, Render, Hetzner, DigitalOcean, Fly Sprites, E2B, Orgo and Cloudways figures on these pages were not re-fetched on 2026-10-21 (the 2026-10-20 audit matched).
- xCloud's pricing page does not say whether $9.99 is promotional or first purchase (the OpenClaw page says "first-purchase monthly rate"; the pricing page says "Promotional rates"). The pages keep the existing "promotional" wording and "the page does not say how long the promotion lasts".
- The 13 suites run (241 tests), tsc and eslint cover this lane's files and everything else on disk when they ran. The full suite and other lanes' in-progress files were not run.
- The mutation check (a $35 Render description failing the figure test) was run once and the file was then restored by copy. The final text was re-read and shows $25.

### Home, About and llms.txt

- The two launch chips were not rendered in a browser at 1440 or 390 wide. The long Windows qualifier should wrap inside its chip (CSS reasoned, not seen), and the chip order change is not seen either. The .chipText rules are covered only by home-layout.test.ts, which does not check them.
- Token-surfaces-off HTML was checked only through the jest page renders (About and Home), not a served page.
- Safari, VoiceOver and the live site were not checked.
- tsc --noEmit was last run in the first pass (clean). The repair pass changed only string literals, comments and the order of two array items, and jest compiled all touched files, but tsc was not re-run, and other lanes edit the same tree.

### Agent pages

- Nothing was rendered in a browser. The new titles and the Codex hero are verified in metadata, rendered-page jest tests and test output only. Google may truncate long titles. With the " | Hivra" suffix, Claude Code is 65, OpenClaw 64 and Codex 58 characters, so only the brand suffix would fall past a roughly 60 character cut and the "Stays On" phrase survives.
- The previous lane's Hermes, Aeon and Agent Zero titles were not touched.
- The wider jest set (seo-urls, metadata-titles, absolute-title-metadata, static-copy-safety, llms-txt, src/lib/seo) was last run before the final h1 test edit. That edit touched only agent-seo-catalog.test.ts, which was re-run with src/app/agents afterwards. The whole suite was not run.
- Whether the agent-catalog.ts and welcome-agent-catalog.ts strings listed in the agents lane's cross-lane requests render on any public page. agent-catalog.ts tagline and badge feed the signed-in agent picker (components/agents/AgentsPage.tsx), and the welcome eyebrow feeds get-started and sign-in. The public /agents pages use their own taglines in app/agents/content/hub.ts.

### Pricing, features, changelog, why-hivra and get-started

- Nothing was rendered in a browser or at 390px wide. Checks are jest (jsdom) text assertions only.
- The OpenAI prompt-injection page (https://openai.com/index/prompt-injections/) returns 403 to scripted fetches and was not re-read this pass. The prior lane read it in a browser on 2026-10-20. None of the softened phrases rest on it, and the header comment no longer makes a claim about it.
- The Anthropic, Big Sleep and XBOW pages were read by the round-1 pass and not re-fetched in the repair.
- Jest ran on src/app/features, pricing, why-hivra, get-started, changelog, src/app/__tests__, llms-txt and seo-urls only (28 suites, 299 tests, all passed). The wider list (compare, tools, components/landing, token, claim) was not run, because nothing there was touched.
- tsc --noEmit -p . printed no errors and eslint printed no problems on the 8 touched source and test files, but both ran against a tree that other lanes were editing at the same time, so they are point-in-time results.
- Whether the live site shows the same text depends on Stripe, flags and deployment state. Nothing here is deployed.
- Whether the "Either size" and "Not as part of the plan." wordings read well to Ash is untested. Both are short and easy to change.

### Roadmap, status and stats

- Nothing was rendered in a browser. The /status title, the odometer, the /stats chart heading and the reworded /roadmap are checked by jest, tsc and eslint only, at no viewport width. Check the longer new lines (the Orchestrator sentence, the "Choose where it runs" paragraph) at 390 px.
- The odometer was checked only with fake timers and a stubbed Date.now. Its behaviour over a real hour of checkpoints was not observed live.
- Stats and status data paths were not run against production. The checkpoints come from /api/stats/public and their accuracy is not checkable from code.
- Whether connect-your-server is part of the release (and so whether "not yet part of Hivra Cloud" will still be true at launch) cannot be checked from code. It is your call.
- The roadmap tests pin the "Self-host preview" heading in README.md and the "not yet on hivra.cloud" line in ROADMAP.md as they are on this branch. If those files change on main before merge, ecosystem-alignment.test.ts will fail by design.
- tsc and eslint passed at the time they ran. Another lane's later edit could still break the whole-project type-check.

### Terms and Privacy

- Live production flag states: ACTIVITY_RETENTION_ENABLED, COLD_STORAGE_RETENTION_ENABLED, DUNNING_GRACE_ENFORCE_LIVE, HERMES_BILLING_LEGACY_HARD_DELETE, LIFECYCLE_EMAILS_ENABLED, CRYPTO_BILLING_ENABLED. The Terms sentence "deleted only after a warning period" holds only while HERMES_BILLING_LEGACY_HARD_DELETE is unset.
- Whether production has migration 20260923190000 (activity records deleted with the computer).
- Whether any lapse handling for Hivra computers exists outside this repo (provisioner scripts, host jobs, operator practice). Only src and migrations were searched.
- Which retention ladder (8 or 44 days) a given cancelled customer gets in production.
- Whether instance_deletion_archives rows are ever deleted, and whether daily backups and cold archives are encrypted.
- How Telegram bot tokens are stored (not traced).
- PostHog replay and event retention, the Supabase region, and the physical location of the Proxmox hosts.
- Whether Resend is correctly described as a US provider (stated from general knowledge, not from the repo).
- No browser render of the final pages was taken. Text was verified through the page tests and source, not a screenshot.

### Routed requests

- Request 12: the OpenClaw card claim was not checked for a Free-plan or own-server launch.

## Pass 3: unpaid computers and copy that makes sense (21 October 2026)

This section records the pass that followed Ash's decision on unpaid computers. Nine lanes worked in parallel. Three edited the code tree, the lapsed-computers worktree (branch claude/lapsed-computers-suspend, cut from origin/canary b32b918e): lapse-core, lapse-ui and routed-code. Six edited this copy tree: copy-legal, copy-core, copy-system, copy-product, copy-blog and routed-copy. The code tree is the truth for behaviour. This tree is 56 commits behind canary.

Nothing in this section has been pushed, published, deployed or switched on. No lane applied a migration, changed an environment variable, called Stripe, Proxmox or Resend, or sent an email. The earlier audit read the Canary database with SELECT only. Production was not queried.

How to read this section. The lane records are the lanes' own reports. "Done" in a lane's task list means the lane saw the final text in the file and the relevant tests passed. Entries give the page, the text before, the text after and why. Quoted texts are exact. Where a quoted text itself held quotation marks, they are shown as single quotes. Where a quoted text held a dash, it is written [dash]. "Still Ash's call" is section 4. "Not verified" is section 5.

Integration note (read-only check of both trees with git status, not from a lane record). Three files are edited in both trees: dashboard/src/components/launch/LaunchJourney.tsx, dashboard/src/lib/i18n.ts and dashboard/src/lib/subscription/plans.ts. Whoever merges the two trees has to reconcile them. Those edits were not compared for conflicts.

### 1. What Ash decided, and the policy in plain words

Ash, 21 October 2026: "I'm not giving away free computers anymore. If you miss a payment you can keep it for free? Come on."

In plain words:

1. Every computer that Hivra runs for you (Hivra Cloud) is paid. There is no free hosted computer, trial, starter credit or promo. A free account works with a computer or server you connect yourself, and you can self-host the open-source platform. Token entitlements stay as the token pages describe them.
2. If a card payment fails, the card is retried and the computer keeps running for up to 48 hours after the first failed payment (the existing grace anchor, PAYMENT_GRACE_HOURS). If it is still unpaid then, the computer is stopped.
3. If a plan is cancelled or has ended, the computer is stopped at the next sweep, about 15 minutes later, once the paid period is over. This covers cancel, unpaid, an Apple or yearly plan that has ended, a token tier that has been lost for 48 hours, and a manual grant that has passed its end date. The code uses 24 hours for the token tier, not 48. See "Still Ash's call".
4. A computer stopped for billing keeps its files. This change deletes nothing. Start, restart and force restart are refused (402, plan needed) for as long as the owner has no paid entitlement. That is decided live from the same entitlement check the sweep uses, so nothing is stored and it clears by itself the moment payment resumes. Stop, snapshot, export and delete stay available, so data is never held hostage. The owner presses Start after paying. The owner gets one plain email when the computer is stopped, and is emailed before anything is ever deleted.
5. A hosted computer that still sits on a Free account follows the same rule as a lapsed one. It is stopped when enforcement is live. There is no separate switch and no separate cohort.
6. Enforcement ships dark. Nothing changes for any customer until the owner sets HIVRA_LAPSE_ENFORCE_LIVE to exactly "true" (src/lib/hivra/lapse-flags.ts, one function). The customer-facing copy and the switch ship together. The copy is written for the world with enforcement on. No string is gated on the flag, and no helper or component was built for that. Ash: "don't overengineer anything, build what you have to build."
7. The older Hermes lane (hermes_instances) is not changed by this pass beyond wording that was already false. Its gaps are listed for a follow-up.

The canonical public wording, built from the plan-facts constants and never typed by hand: "Every computer that Hivra Cloud runs for you needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM. A free account works with a computer or server you connect yourself." The short form is "Every Hivra Cloud computer needs a paid plan." No page singles out OpenClaw or Agent Zero as the only paid agents. Starter, Pro and Power are not used as plan names in public copy.

#### What the code now does (lane lapse-core)

- A sweep runs every 15 minutes from the existing grace cron. It selects running Hivra-managed computers with no deployment target or connection, groups them by owner, and stops at most 5 per run. A failed read of any plan table means "don't know", and that owner is skipped. Each owner is asked again immediately before each stop, so someone who has just paid is not stopped.
- Start, restart, force restart and resize on a Hivra-managed computer with a lapsed owner return 402 `instance_entitlement_suspended` while the switch is on. Stop, snapshot, restore, rename, update_runtime and delete stay open. The gate fails open on any doubt.
- A billing stop turns Proxmox autostart off. Start now turns it back on (`qm set <vmid> --onboot 1`, best effort), so a paying owner's computer survives a host reboot.
- The stopped email goes out best effort, in plain text. It says nothing was deleted and to press Start after fixing billing. It makes no deletion promise.
- A token tier inside its 24 hour requalification grace is treated as paid, so the sweep waits for the grace the breach email promises.
- With the switch off, the cron still reads the running fleet and each owner's plan every 15 minutes and logs one dry-run warning listing lapsed computer ids.

#### Copy that is false until the switch is on

The code must be merged into canary and HIVRA_LAPSE_ENFORCE_LIVE must be exactly "true" where the page is served. Until then each of these overstates what happens:

- Terms: the opening sentence ("Every computer that Hivra Cloud runs for you needs a paid plan") and the Failed Payments and Cancellation item (copy-legal).
- Privacy: the unpaid-computer sentence in section 7 (copy-legal).
- Pricing FAQ "What happens if I stop paying?" and "Will Hivra turn my computer off when I'm not using it?" (copy-core).
- Billing: the plan-on-hold text, the rating plate, the cancel dialog, the payment-failed email and the deletion emails (lapse-ui), and the launch hold message (routed-code).
- The blog memory FAQ on what happens after cancelling (copy-blog).

The sentence "we email you before we delete anything" is true only when a pre-deletion email exists for Hivra computers. This change only stops computers. The deletion sweep and its warning email are a later change (design plan step 10). Copy-legal, copy-core and copy-blog all flag this.

#### Before the switch goes on

From the lapse-core flags:

- Read the dry-run log first (log.warn "hivra lapse sweep (dry run)", counts and computer ids). Any owner with a running Hivra Cloud computer and no paid entitlement will be stopped, including Ash's own account, ops admins and test fixtures, unless they hold a manual_ grant. Give fixtures and admins a manual_ grant.
- There is no live Stripe check. A customer who paid after the 48 hour anchor, or whose webhook was dropped, can still read as past_due-expired or inactive and be stopped on the next sweep. Protection is only the existing grace and subscription-state reconcilers. A guard (one stripe.subscriptions.retrieve, skip on active, trialing or error) is a one-function follow-up. They can press Start once paid.
- Existing free hosted computers on Free accounts are covered by the same rule. They are stopped when the switch goes on, at most 5 per 15 minutes, and the email goes at stop time. There is no earlier warning.
- The stopped email needs RESEND_API_KEY and the owner's Clerk email. Without them it is skipped and the stop stands.
- The payment-failed email is gated by HERMES_DUNNING_EMAIL_ENABLED (default off). Recommended: turn it on together with HIVRA_LAPSE_ENFORCE_LIVE.

### 2. Decided by common sense, as Ash asked

Ash asked for common sense on the open items in "Decisions for Ash" rather than a yes or no on each. These were open. This pass resolved them as below. Each is also marked RESOLVED, CHANGED or SUPERSEDED where it first appeared.

1. Plan-calculator assumptions (/tools/claude-code-plan-calculator). Kept honest as "either side of $13". The estimate assumptions (50K output tokens an hour normal, 100K heavy, 98% cache reads) were not re-tuned, because re-tuning would move $376, $627 and every other figure. The pages say the Sonnet day ($8.69) and the Opus day ($17.39) sit "either side of" Anthropic's $13 average, and the test pins $8.69 and $17.39. Nothing holds the estimate near $13, and the page no longer implies it does.
2. Restart=always (/tools/agent-survival-check). Kept. Ash's Markdown says Restart=on-failure, and the earlier reason for keeping Restart=always still holds. Ash's wording is not restored. The other unit problems in that bullet stay open (no PATH under systemd, no WorkingDirectory=, no Wants= beside After=network-online.target).
3. llms.txt keeps "In preview: DeepSeek." The line is true (not launchable in lib/hivra/preview-catalog.ts) and /why-hivra/evolution groups DeepSeek under "In preview" too. Copy-core changed only the paid-plan wording in llms.txt. The DeepSeek line and the Omarchy and Windows wording are unchanged.
4. Translated sign-up pages now follow the English labelling. Copy-system rebuilt the zh-CN, es, pt-BR, fr, de, ja and ko /get-started cards: "Hivra Cloud" and "More room", the English bullets, the size line, and plan guidance that names no Pro or Power. The billing names Pro and Power elsewhere stay Ash's call (section 4). The wording was written in each language and needs a native speaker.
5. Blog scaled figures replaced. The Haiku-only monthly totals that were the old estimates multiplied by the 10x rate ratio are gone from cost-of-running-ai-agent, ai-agent-api-cost-optimization and byo-api-key-explained. The sourced rates stay, the articles say the Haiku-only part falls to roughly a tenth, and the "$25-62/month" full range is removed. Only the totals that follow from stated inputs remain (copy-blog).
6. Provider lines held until the features are public. The Apple, Expo, OpenAI (voice and avatars) and DigitalOcean lines stay off the Privacy page. The data flows exist in code, so the lines must go in when those features go public. The exact text waits in docs/legal-copy-changes.md under "Add at launch". Copy-legal did not add them.
7. Litepaper copies left alone. LITEPAPER.md, docs/litepaper/restricted/LITEPAPER.md, dashboard/public/restricted/LITEPAPER.md and the built docs/litepaper/index.html were not edited by any lane. The litepaper is Ash's own token-gated text, token wording goes to legal review, and the change would need three copies and a rebuilt HTML that test_content.py pins.
8. Dates set at publish. Copy-legal left both Last Updated dates unchanged on purpose (Terms "May 2, 2026", Privacy "September 24, 2026"). The sitemap dates for the pages edited on 21 October are set on the publish day. Two exceptions already moved: AGENT_PAGES_LAST_MODIFIED is now 2026-10-21 (copy-product), and 21 blog articles carry lastModified 2026-10-21 (copy-blog).

Also resolved or changed by the policy:

9. "A lapsed Hivra computer appears to keep running unpaid" (earlier DEFECT OR POLICY, F1). Resolved by policy. Ash decided that an unpaid computer is stopped, the lapse code exists in the code tree, and the Terms now say so. Both are true only once that code is merged and the switch is on (section 1).
10. /stats live label. The running figure now reads "Agents and computers running now" (copy-system). The number is unchanged and still includes unpaid and legacy computers until enforcement is live.
11. /roadmap connect-your-own-server. Changed, release gate still open. Home, Pricing, Get started and the Roadmap now offer a free account with a server you already have. That is true only if the release that ships this copy includes the connect flow. If it does not, take those four offers out (section 4).
12. Terms billing wording. The Terms no longer say monthly-only billing, Stripe-only payment or "each Hermes agent". The tier names Pro and Power stay (decision L1).

### 3. Lane records: deviations and flags

Nine lanes, in order: lapse-core, lapse-ui, copy-legal, copy-core, copy-system, copy-product, copy-blog, routed-code, routed-copy. No unresolved review findings were recorded by any lane.

#### Lane: lapse-core (code tree)

What was built, by task:

- Stop function: done. stopHivraManagedComputer(userId, agentId) is exported from lib/recovery/stop-deleted-user-computers.ts, and stopDeletedUserComputer is a one-line wrapper. The lease operation-failure note now says "Computer containment is incomplete" (shared by both sweeps, accepted, no reader of the old text). The existing stop tests pass unchanged.
- Sweep: done. lib/recovery/hivra-lapse-enforce.ts decides with ownerHasNoPaidPlan and stops at most 5 per run. After repair the decision is error-aware (resolveEffectiveSubscription is called with throwOnQueryError), each owner is asked again immediately before each stop, and the header comment no longer reads backwards. A new test runs the real resolver against a mocked database where one read returns an error and asserts that nothing acts.
- Cron call: done. The */15 grace route calls runHivraLapseSweep() inside its own try/catch, and gained export const maxDuration = 800 so five serial 120 second stops and their emails cannot be killed by the default function limit.
- Start gate: done. lib/hivra/lapse-gate.ts also covers resize, because resize stops the VM and starts it again. The gate returns 402 instance_entitlement_suspended before the capacity check, lease or host call, and fails open. startKickoff now runs `qm set <vmid> --onboot 1` (best effort) before the start helper.
- Email: done. lib/email/hivra-computer-stopped.ts wording now fits a Free account too. It keeps the per-computer, per-UTC-day idempotency key.
- Flags test: done. lapse-flags.ts is unchanged and its test pins that only the exact string "true" enables.
- Checks: done. Typecheck, lint and the copy scan were clean after repair. 181 suites and 4126 tests passed across src/lib/hivra, src/lib/recovery and src/app/api/hivra/agents.

##### instance-entitlement.ts and its test (not owned by this lane)

- Before: "Brief: token tiers are decided by resolveEffectiveSubscription alone."
- After: "Added exported hasTokenTierInGrace() (reads token_tier_qualifications, throws on a read error) plus a rewritten grace comment, used by ownerHasNoPaidPlan so a tier inside the REQUALIFICATION_GRACE_HOURS (24) grace is not stopped. Also added an additive option throwOnQueryError to resolveEffectiveSubscription (default off, so every other caller is unchanged) that checks the error on all four plan reads."
- Why: Without hasTokenTierInGrace the sweep would stop a token holder the breach email promises 24 hours to. Without throwOnQueryError the resolver drops Supabase errors, so a failed read made a paying owner look unpaid, which the brief ("any error or doubt means skip") forbids. Both edits are small, additive and tested. They must land in the same commit as this lane or the build breaks (missing export or option).

##### hivra-lapse-enforce.ts: no live Stripe retrieve

- Before: "Design plan step (a): a live Stripe retrieve to skip an owner whose payment webhook was dropped."
- After: "Not built. The sweep relies on resolveEffectiveSubscription plus the existing reconcile-subscription-grace and reconcile-subscription-state crons."
- Why: Smallest change that makes the policy true (Ash: do not overengineer). Accepted gap, listed as a pre-switch follow-up in the flags.

Flags:

- DECISION FOR ASH: policy item 3 and the design plan say a token tier lost for 48 hours, but the code (REQUALIFICATION_GRACE_HOURS in tier-thresholds.ts, shortened from 48 to 24 on 2026-04-30) and the breach email use 24 hours, and the sweep follows 24. Pick one: change the policy text to 24, or change the constant. Any lapse-ui copy must say 24 hours for token tiers (built from REQUALIFICATION_GRACE_HOURS), not 48.
- BEFORE THE SWITCH GOES ON: any owner with a running Hivra Cloud computer and no paid entitlement will be stopped, including Ash's own account, ops admins and test fixtures, unless they hold a manual_ grant. Read the dry-run log (log.warn 'hivra lapse sweep (dry run)', counts and computer ids) first and give fixtures and admins a manual_ grant.
- BEFORE THE SWITCH GOES ON (accepted gap): no live Stripe check. A customer who paid after the 48 h anchor, or whose webhook was dropped, can still read past_due-expired or inactive and be stopped on the next 15 minute sweep. Protection is only the existing grace and subscription-state reconcilers. A guard (one stripe.subscriptions.retrieve, skip on active, trialing or error) is a one-function follow-up if wanted. They can press Start once paid.
- Existing free hosted computers on Free accounts are covered by the same rule (policy item 5) and will be stopped when the switch goes on, at most 5 per 15 minutes. The email goes at stop time. There is no earlier warning. Advance notice to grandfathered free users is a separate decision.
- The stopped email comes from the shared sender with the reply-to inbox, plain text. It needs RESEND_API_KEY and the owner's Clerk email, otherwise it is skipped and the stop stands.
- The 402 message reuses HOSTED_COMPUTE_REQUIRES_PLAN_MESSAGE (the billing copy lane's file). If lapse-ui rewrites it to the canonical sentence, the Start refusal follows automatically.
- With the switch off, the cron still reads the running fleet and each owner's plan every 15 minutes (about four reads per owner, 10 owners at a time) and emits one log.warn listing lapsed computer ids. Not customer-visible, but not zero load.
- A computer stopped for billing has Proxmox autostart off until the owner presses Start (the power-on script now turns it back on). A regular owner Stop still leaves onboot alone (existing behaviour, not changed).
- Follow-up (not built): the Hermes lane (hermes_instances) is unchanged and has its own gaps.
- Follow-up (not built): nothing deletes a stopped lapsed computer, so disks stay on the host until a later deletion sweep with a warning email exists. Computers that were hibernated or archived are not "running", so they are not stopped, but Start on them is refused once live.

#### Lane: lapse-ui (code tree)

Billing screens, emails and prompts. The finding numbers (F01 to F20) are those of the sense-billing-ui audit. Written for the world with enforcement on.

Status by finding:

- F01 done: Billing Overview hold text, hold title and no-plan text match the policy (stopped after the 48 hours, files kept, press Start after paying). The launch hold message in launch-plan.ts was reworded to match (applied by routed-code).
- F02 done: Hermes lane wording says only what is true in the lane's files. The 402 message in instances/[id]/route.ts and the start-failure message in agent-start-failure.ts carry the replacement text (routed-code). Flipping DUNNING_GRACE_ENFORCE_LIVE and the hour-0 versus hour-48 suspended flag are code and Ash decisions.
- F03 done: payment-failed email rewritten. After a repair round its closing line no longer says "there is nothing more to do", because Stripe retries the card for about two weeks and nothing cancels a past_due subscription.
- F04 done: deletion warning, final reminder and the cold-storage pending-deletion and archived emails say no paid plan is active, pay any open invoice or choose a plan in Billing, then start the agent. The remaining dashes in the footers and sign-offs were removed.
- F04b flagged (code, skipped): in stale-suspended-sweep, classify any non-free hermes_subscriptions plan as the long ladder whatever the status, and make purge-expired skip scheduled_for_deletion rows whose owner is still past_due. stale-suspended-sweep.ts filters status active, so a lapsed payer gets the 3 plus 5 day free ladder. No text written by this lane gives a retention number.
- F05 partial: no "stays free" or "free hosted agent sleeps" pitch remains in the lane's files. Still open outside its files: the Terms sentence that free-tier computers "remain available" (since rewritten in the copy tree), the grandfathered-computer decision, and the capacity-pause email.
- F06 flagged (cohort code, skipped): add !isPaidPlan to day1_active and count hivra_agents for day1_idle, day1_active and stalled_5d in lifecycle-email-sweep. The day1_active email is plan-neutral meanwhile ("Three things worth trying next"), so it cannot mislead a payer.
- F07 done: day-7, warm-pool and cold-storage emails reworded, with prices read from PLANS and plan-facts instead of typed.
- F08 done: four dark-shipped prompts reworded (no free hosted agent that sleeps, no Pro, no 24/7 or 4x). After repair the usage footer uses the canonical sentence, and the paywall ledger no longer says Free is "Not included" for the agents feature.
- F09 flagged (Ash decides): see "Still Ash's call".
- F10 done: Plans tab intro uses the canonical sentence and no longer contradicts the Free card.
- F11 partial: the live downgrade error text in change-plan/route.ts is fixed (routed-code). Still stale: the dead i18n strings switcher.description and switcher.guarantee in eight locale blocks (en, zh, es, pt, fr, de, ja, ko), 16 strings. Only switcher.title is rendered (billing/page.tsx).
- F12 flagged (code, skipped): refuse a self-serve downgrade while usage exceeds the target plan's slots or pool, naming what to stop. NEXT_PUBLIC_HERMES_SELF_SERVE_DOWNGRADE value unverified.
- F13 done: cancel dialog says what cancelling does. After repair the "Just busy?" offer no longer promises open-ended retention.
- F14 done: Billing plate names the 48 hours for a failed card payment (card plans only; Apple and token grace excluded). The launch API message in instance-service.ts names PAYMENT_GRACE_HOURS (routed-code).
- F15 flagged (skipped): one breach-grace constant for the token email, wallet UI and cron (24 vs 48 vs 72 hours today), and reword the yearly-ended email to say the computer was switched off and files are kept. Sources: tier-eligibility-notifications.ts:103, refresh-token-tiers/route.ts:71, yearly-token-subscription-notifications.ts:110 and 155.
- F16 flagged (code, skipped): give Workspace Cloud the same 48 hour cutoff and stop its computer on cancel or lapse, then change "Renews" to "Current period ends". instance-entitlement.ts has no grace cutoff for workspace_cloud.
- F17 done: welcome email says "A Hivra computer stays on" instead of "your agent stays up". The other places (LaunchJourney description, agent-catalog tagline and badge, i18n planGuidance.operator) were reworded by routed-code.
- F18 done: marketplace and email-support perks removed from the larger and Command plans, and Command specs corrected to 8 vCPU and 16GB total. The Command support-hour lines were left and flagged.
- F19 flagged (skipped): one measured wake time in a shared constant. Until then say "about a minute" and "a few minutes". cold-storage.ts still says "about 5 minutes" (an existing claim kept in the rewritten emails). WakeFlow says 70 seconds and 2 to 3 minutes.
- F20 flagged (skipped): after Ash confirms the refund process, add "Email info@hivra.cloud to claim it." to the PlansTab footnote. "Card payments: 7-day money-back guarantee." has no claim route.

##### Billing, Overview, plan on hold (card) (F01)

- Before: "A payment didn't go through, so this plan isn't active right now. Pay the open invoice or update your card in the billing portal."
- After: "A payment didn't go through, so this plan is on hold and your Hivra Cloud computers are stopped. Their files are kept. Pay the open invoice or update your card in the billing portal, then press Start on each computer."
- Why: Policy 2 and 4: stopped after the 48 hours, files kept, Start after paying. Written for enforcement on.

##### Billing, Overview, plan on hold (no live card subscription) (F01)

- Before: "A payment didn't go through, so this plan isn't active right now. Contact support to settle it."
- After: "A payment didn't go through, so this plan is on hold and your Hivra Cloud computers are stopped. Their files are kept. Contact support to settle it, then press Start on each computer."
- Why: Same as above.

##### Billing, Overview, plan on hold title (F01)

- Before: "<Plan name> plan on hold (for example 'Pro plan on hold')"
- After: "Hivra Cloud plan on hold"
- Why: The F01 proposal. It also stops the screen depending on the Pro and Power names (F09).

##### Billing, Overview, no plan or plan ended (F01)

- Before: "Pick a plan to run agents and computers on Hivra's servers."
- After: "Every computer that Hivra Cloud runs for you needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM. A free account works with a computer or server you connect yourself. If a plan has ended, your Hivra Cloud computers are stopped and their files are kept. Choose a plan, then press Start."
- Why: Canonical wording from plan-facts constants. Also true for a customer whose plan ended.

##### Billing, Overview plate, idle-policy cell for a Free account that holds a Hivra-run computer (F05)

- Before: "Sleeps after 4 idle days"
- After: "Needs a paid plan"
- Why: Repair round. Under policy 5 that computer is stopped once enforcement is live and Start is refused, so a sleep rule is false. The cell label is still the i18n "Idle policy" (not this lane's file). See the flags.

##### Billing, Plans, intro (F10)

- Before: "Every plan runs your agents and computers on Hivra's servers. Bring your own model key and we add nothing to what you spend."
- After: "Every computer that Hivra Cloud runs for you needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM. A free account works with a computer or server you connect yourself. Bring your own model key and we add nothing to what you spend."
- Why: The old intro said every plan runs on Hivra's servers while the Free card says "Run by Hivra: No".

##### Billing, Overview, rating plate on a card plan with status past_due (F14)

- Before: nothing beyond the "Payment due" badge.
- After: "A payment didn't go through. Your computers keep running for up to 48 hours after the first failed payment. If it is still unpaid then, they are stopped. Pay the open invoice or update your card in the billing portal, then press Start on each computer."
- Why: Names the keep-alive window (48 from PAYMENT_GRACE_HOURS) and, after the repair round, the Start step (it first said "stopped until you pay", which implied an automatic restart that policy 4 does not have). Not shown for Apple or token plans, which have their own grace.

##### Cancel subscription dialog, description (F13)

- Before: "One question, then you can cancel either way."
- After: "One question, then you can cancel either way. When your plan ends, Hivra stops running your computers. Their files are kept, and we email you before anything is deleted."
- Why: The dialog never said what cancelling does to the computer. Timing is left as "when your plan ends" because the Stripe portal's cancel timing is not visible in code.

##### Cancel subscription dialog, "I'm not using it" offer (F13)

- Before: "You could pause instead / If you're just busy, email us and we'll pause your billing instead of losing your agent's setup and memory, picking back up later takes one reply. / Email us about pausing (mailto subject 'Pause my subscription')"
- After: "Just busy? / You can cancel now and choose a plan again later. Your files are kept, and we email you before anything is deleted. Once a plan is active, press Start to carry on. / Email us a question (mailto subject 'A question before I cancel')"
- Why: No code pauses billing, and a manual pause would leave a free computer running. Repair round: the first rewrite said "come back whenever you like" and "pick up where you left off", an open-ended retention promise the Hermes-lane sweeps do not keep. No duration is stated until Ash settles retention (F04b).

##### Wake banner for an inactivity-paused free agent, dark (F08)

- Before: "... Waking it back up now, about 30 seconds. Free agents sleep. Pro agents never do, so yours stays on 24/7 and is ready the second you are. [Keep it always-on]"
- After: "... Waking it back up now, about a minute. A paid plan keeps the computer running, so it is ready the second you are. [Keep it running]"
- Why: No free hosted tier that sleeps, no plan name, the claim on the computer and not the agent, and it matches the 70 second wake page.

##### Usage footer under "Your agent at work", dark (F08)

- Before: "That's real work from a free agent. Free sleeps after 4 idle days and runs on 1 GB. For $9.99 a month, Pro stays on 24/7 with 4x the memory and room to do a lot more. [Go Pro]"
- After: "That's real work from your agent. Every computer that Hivra Cloud runs for you needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM. A free account works with a computer or server you connect yourself. A paid computer stays on and is not paused for inactivity. [See plans]"
- Why: Repair round: the first rewrite dropped "Cloud", left out the free-account sentence and ended "It stays on..." with no clear antecedent. Now it is the canonical sentence from plan-facts, with the always-on claim on the paid computer. The finding's "On the free account it sleeps..." was not used because it still describes a free hosted tier.

##### Archive countdown wall, dark (F08)

- Before: "... Its memory, its files, the chats you connected. Free agents get archived after they sleep. Pro agents never do. Keep yours live and always-on for $9.99 a month."
- After: "... get packed away: its memory, its files and the chats you connected. A free account doesn't keep a computer running. A paid plan, from $9.99 a month, keeps yours live and on."
- Why: Same reasons. Price from plan-facts.

##### Feature-lock paywall modal, dark (F08)

- Before: "Eyebrow 'Pro feature'; agents body 'Free includes one agent. Pro runs three at once...'; generic title 'This feature needs Pro', body 'This capability isn't included on the Free plan. Pro unlocks browsing, persistent memory, scheduled tasks, and 4x the compute.', example 'e.g. your agent goes always-on (never paused for inactivity)...'; CTA 'Upgrade to Pro, $9.99/mo'; ledger 'Pro · $9.99/mo'; ledger Free row 'Not included' for every feature"
- After: "Eyebrow 'Paid feature'; agents body 'The free account includes one agent on your own computer. A paid plan runs three at once...'; generic title 'This feature needs a paid plan', body 'This capability isn't included on the free account. A paid plan adds browsing, persistent memory, scheduled tasks, and a computer that Hivra runs for you.', example 'e.g. Hivra runs a computer that stays on, and your agent gains browsing, memory, and scheduled tasks.'; CTA 'See plans, from $9.99/mo'; ledger 'Paid plan · from $9.99/mo'; ledger Free row '1 agent, on your own computer' for the agents feature, 'Not included' for the other features"
- Why: Removes the Pro name and the free-hosted comparison, and moves always-on from the agent to the computer. Repair round: the agents dialog said the free account includes one agent while the ledger under it said Free is "Not included", so the ledger row now agrees.

##### Payment-failed email (F03)

- Before: "Subject 'your agent hit a card snag'. 'Quick heads up. Your card didn't go through this month, so this cycle's payment failed.' 'Your agent is still running. Its memory, chats, and everything it's set up for you are safe. But if the card keeps failing, the box gets shut down automatically and all of that goes with it.' 'Money tight or meant to cancel? Just reply and tell me. I read every email.'"
- After: "Subject 'your payment didn't go through'. 'Quick heads up. Your latest Hivra payment didn't go through.' 'Your computer keeps running for up to 48 hours after the first failed payment. If it is still unpaid then, we stop it. Its files are kept, and we email you before anything is deleted. Once the payment goes through, you can start it again.' 'If you meant to cancel, reply and tell me, or cancel in Billing, so the card is not tried again. I read every email.'"
- Why: Policy 2 and 4. It replaces Ash's 2026-07-07 verbatim copy with his 21 October policy, and the file header says so. No retention number is stated (none is decided). Repair round: the first closing line was "If you meant to cancel, there is nothing more to do. Reply if anything looks wrong.", which is false because Stripe retries the card for about two weeks and nothing cancels a past_due subscription. The invitation to reply is restored, with a way to stop the charge.

##### Deletion warning email (F04)

- Before: "Subject 'Your Hivra agent will be deleted soon'. 'Your Hivra agent has been idle.' 'Your agent has been suspended for a while now. To keep things tidy on the host (idle VMs add up fast), it's scheduled to be permanently deleted in N days, on DATE.' 'If you still want it, just log in and resume it any time before then. That'll cancel the deletion automatically.' [Open the dashboard]"
- After: "Subject 'Your Hivra agent will be deleted soon unless a plan is active'. 'Your Hivra agent is suspended and scheduled for deletion.' 'Your agent has been suspended for a while now, because no paid plan is active on your account. It is scheduled to be permanently deleted in N days, on DATE.' 'To keep it, pay any open invoice or choose a plan in Billing, then start the agent again. It cannot be started until a plan is active.' [Open Billing]"
- Why: Start is refused with a 402 until the plan is paid, so "log in and resume" is false. One wording for every recipient, because the templates take no reason input.

##### Deletion warning email, hidden preheader (F04)

- Before: "Your idle agent is scheduled for deletion. Log in to keep it."
- After: "Your agent is scheduled for deletion. Pay or choose a plan to keep it."
- Why: Same reason as the body (recorded late, found by the reviewer).

##### Deletion warning email, closing line, text and html (F04)

- Before: "If you don't, no action needed [dash] the agent and its data will be removed. (html: ... removed on the date above.)"
- After: "If you don't, no action needed: the agent and its data will be removed. (html: ... removed on the date above.)"
- Why: The dash was replaced by a colon (recorded late).

##### Deletion warning and final reminder emails, footer and sign-off, text and html (F04)

- Before: "Reply to this email if you have questions [dash] I read every reply. / [dash] Ash"
- After: "Reply to this email if you have questions. I read every reply. / Ash"
- Why: Repair round. Customer-facing dashes still printed in both emails, because the lines were not added lines, so the copy scan missed them. Both tests now ban the en and em dash in text and html.

##### Deletion final reminder email (F04)

- Before: "Subject 'Last chance - your Hivra agent gets deleted tomorrow'. 'Quick heads-up - your Hivra agent will be permanently deleted in roughly H hours, on DATE. This is the last reminder.' 'If you want to keep it, log in and resume any time before then. That cancels the deletion.' preheader 'your idle agent gets deleted tomorrow' [Open the dashboard]"
- After: "Subject 'Last chance: your Hivra agent gets deleted tomorrow unless a plan is active'. 'Quick heads-up: your Hivra agent will be permanently deleted in roughly H hours, on DATE, because no paid plan is active on your account. This is the last reminder.' 'To keep it, pay any open invoice or choose a plan in Billing before then, then start the agent again. It cannot be started until a plan is active.' preheader 'Final reminder: your agent gets deleted tomorrow unless a plan is active.' [Open Billing]"
- Why: Same reason. The em dashes were also removed.

##### Cold-storage "pending deletion" and "final notice" emails (F04)

- Before: "'Bring it back by clicking Start in your dashboard:' (text); 'Restoring takes about 5 minutes [dash] chat history and settings come back intact.' (html); button 'Restore my agent' to the dashboard; subject '... in N days [dash] last chance'; 'no action is required [dash] it'll be removed automatically.'"
- After: "'To keep it, press Start in your dashboard: <url>' then 'If no paid plan is active on your account, pay any open invoice or choose a plan in Billing first, because it cannot be started until one is: <billing url>' (text); html: 'To keep it, press Start in your dashboard. If no paid plan is active on your account, pay any open invoice or choose a plan in Billing first, because it cannot be started until one is. Restoring takes about 5 minutes, and chat history and settings come back intact.'; button 'Open Billing' to /dashboard/billing; subject '... in N days: last chance'; 'no action is required. It will be removed automatically.'"
- Why: Repair round. This email goes to cold-archived free and lapsed owners, who cannot Start without a paid plan (402). The wording is conditional because the row does not say why it was archived. No retention number is stated.

##### Cold-storage "paused" email (F04)

- Before: "'When you're ready to use it again, hit Start in your dashboard:' (text); 'When you're ready, hit Start. Restoring takes about 5 minutes the first time [dash] chat history ...' (html); preheader 'Your agent is paused in cold storage [dash] restore it any time.'; footer '... I read every reply. [dash] Ash'"
- After: "'When you're ready to use it again, press Start in your dashboard:' plus the same 'If no paid plan is active on your account, pay any open invoice or choose a plan in Billing first, because it cannot be started until one is' line; 'Restoring takes about 5 minutes the first time, and chat history and settings come back intact.'; preheader 'Your agent is paused in cold storage and your data is safe.'; footer 'Reply to this email if anything's unclear. I read every reply.'"
- Why: Repair round: "restore it any time" and one-click Start are false for an owner with no paid plan. The dashes were removed from the three cold-storage sign-offs ("[dash] Ash" became "Ash").

##### Cold-storage "paused" email, upsell line (F07)

- Before: "Want it to never pause? Pro agents stay always-on, they're never put to sleep for inactivity."
- After: "Want it to stay on? A paid plan keeps your computer running and never pauses it for inactivity."
- Why: No Pro name, and the claim is on the computer.

##### Day-one active lifecycle email (F05)

- Before: "Three things it can't do yet on a free account: ... All three come with Pro. No rush, a free account stays free for as long as you want it."
- After: "Three things worth trying next: (same three bullets) ... (closing line removed). Preheader 'Day one done. Three things worth trying next.'"
- Why: F05 forbids "stays free". The cohort sends this to hosted-agent owners, who now are paid, so a plan-neutral email is the only honest text until the cohort code is fixed (F06, flagged).

##### Day-seven lifecycle email (F07)

- Before: "Subject 'the honest pitch for Pro'. Bullets: 'Always-on, your agent is never paused for inactivity (a free agent sleeps after 4 idle days).' '2 vCPU / 4 GB RAM, double the headroom, noticeably faster under load.' Prices typed '$9.99/mo, or $79/yr.'"
- After: "Subject 'what a paid plan adds'; title 'What a paid plan adds.'; intro '... here is what a paid plan adds.' Bullets: 'A computer that stays on: Hivra runs it for you and does not pause it for inactivity.' '2 vCPU and 4 GB of RAM: run by Hivra, so you don't set up or look after a server.' (other three bullets keep their text, dash replaced by a colon). Prices built from PLANS."
- Why: No free hosted agent that sleeps. 2 vCPU and 4 GB is four times the free size, not double. No Pro name.

##### Day-seven lifecycle email, preheader and bold price line (F07)

- Before: "preheader '$9.99/mo or $79/yr. Five things change. That's the list.'; bold line '$9.99/mo, or $79/yr.'"
- After: "preheader '$9.99/mo, or $79/yr. Five things change. That's the list.' (comma added); bold line '$9.99/mo, or $79/yr.' built from PLANS"
- Why: Prices now come from the table checkout reads. The preheader gained a comma to match the body (recorded late).

##### Warm-pool campaign email, dormant (F07)

- Before: "'Free can't read live pages. Pro can.' / 'Here's what changes on Pro:' / 'If free covers you, ignore this, it stays free.' / typed prices"
- After: "'Browsing needs a computer run by Hivra.' / 'Here is what changes on a paid plan:' / 'If your own computer covers you, ignore this.' / prices built from PLANS"
- Why: Same reasons. The campaign is owner-triggered and dated June. It was not retired.

##### Warm-pool campaign email, preheader (F07)

- Before: "Three things your agent picks up on Pro. $9.99/mo or $79/yr."
- After: "Three things your agent picks up on a paid plan. $9.99/mo, or $79/yr. (price built from PLANS, comma added)"
- Why: No Pro name (recorded late).

##### Welcome email (F17)

- Before: "... or pick a plan and Hivra runs one for you, and your agent stays up with no Docker and no babysitting."
- After: "... or pick a plan and Hivra runs one for you. A Hivra computer stays on, with no Docker and no babysitting."
- Why: Only the computer is kept on. On the free path the agent runs on the customer's own computer.

##### Plan cards, Billing Plans and get-started (F18)

- Before: "Larger plan features: 'Future marketplace access', 'Email support (48 hr)'. Command features: 'Future marketplace access'. Command specs: '10 vCPU total', '56GB total'."
- After: "Those two perks removed from the larger plan, the marketplace perk removed from Command, Command specs '8 vCPU total' and '16GB total'."
- Why: The perks do not exist. Command's own numbers are 8 vCPU and 16384 MB.

Flags:

- F03 needs Ash: the payment-failed email replaces his 2026-07-07 verbatim copy with the 21 October policy wording (the header comment says so), and the closing line now reads "If you meant to cancel, reply and tell me, or cancel in Billing, so the card is not tried again. I read every email." Please re-read it once. "I read every email" still depends on replies to info@hermesos.cloud reaching a mailbox (unverified).
- F03 timing (updated): lib/billing/dunning.ts now sends the email from the first failed attempt (routed-code removed the attempt-2 gate), so the email matches the 48 hours from the first failed payment. It still only goes out when HERMES_DUNNING_EMAIL_ENABLED=true (default off). Recommended: turn it on together with HIVRA_LAPSE_ENFORCE_LIVE (Ash's env call).
- Hermes lane: the Billing, cancel-dialog and payment-email text says the computers are stopped. That is true for Hivra Cloud computers once HIVRA_LAPSE_ENFORCE_LIVE=true. A Hermes-lane agent is marked suspended and cannot be started, but its VM is only stopped if DUNNING_GRACE_ENFORCE_LIVE=true (default off). Recommended: flip both switches together at launch, or accept the Hermes gap per policy 7.
- F04b (code): stale-suspended-sweep puts a lapsed payer on the 3 plus 5 day free ladder, and the cold-retention sweep uses 30 or 60 days for archived rows. The emails say "deleted in N days" with the real N, so they are true, but a cancelled or lapsed Hermes-lane payer can lose the files about 8 days after the plan ends. That is why neither the cancel dialog nor any email says files are kept for any length of time. Recommended: classify any non-free plan row as the long ladder and guard purge-expired for past_due owners. Ash decides how many days files are kept.
- F06 (code): lifecycle-email-sweep sends day1_active to paying customers and day1_idle ("never deployed") to people who launched a Hivra computer. Recommended: an isPaidPlan gate plus counting hivra_agents. day1_active is plan-neutral meanwhile.
- F09: Pro and Power still print on the plate, plan cards, ChangePlanModal, token tier labels, i18n planGuidance.fleet and the Terms page. Recommended: display names "Hivra Cloud" and "Hivra Cloud, more room" set once in plans.ts, with the test pins updated in the same change.
- F12 recommendation: block a self-serve downgrade while usage exceeds the target plan (code). F15: one breach-grace constant, then reword the yearly-ended email. F16: apply the 48 hour cutoff to Workspace Cloud. F19: one measured wake time. F20: add the claim route after Ash confirms refunds are processed by hand.
- F05 decision still open: policy 5 stops grandfathered free hosted computers when enforcement is live. No customer notice exists for that cohort (the stopped email only follows a stop). Recommended: a heads-up email before the free_hosted cohort is switched on.
- Terms (code tree, not this lane's, handed to the legal lane): dashboard/src/app/terms/page.tsx line 43 says free-tier computers "remain available" (contradicts policy 5), line 44 says computers are retained "for a 48-hour grace period before secure deletion" after a payment failure or cancellation (contradicts policy 3 and 4: stopped, files kept, emailed before deletion), and line 45 says moving to a lower tier "will result in the deletion of your current server environment and data" (the false claim F11 removed from the API message). The copy tree's Terms rewrite must match.
- Billing plate cell label: the Free-account cell now reads "Needs a paid plan" under the i18n label "Idle policy" (copy.plate.idlePolicy, not this lane's file), which reads a little oddly. Recommended: rename that label or hide the cell for a free account. copy.plate.sleepsAfterIdle, FREE_IDLE_SLEEP_DAYS and planIdlePolicy('free') ("Sleeps after 4 idle days", pinned in lib/billing/__tests__/plan-display.test.ts) are now unused by the Billing Overview. Delete them with the F05 decision.
- capacity-pause.ts (left unchanged on purpose): the email says "wake it anytime", "Waking it up takes one click" and "still fully restorable, any time". The capacity sweep parks free-tier Hermes-lane agents first, and policy 7 leaves that lane unchanged, so Start still works for them today. Once Ash decides the grandfathered free hosted cohort (F05), reword it with the same "if no paid plan is active, choose a plan in Billing first" line used in cold-storage.ts. It also still has em dashes and a "Pro", neither added by this lane.
- Persistent memory is listed as a paid-only feature in the day-seven email, the warm-pool email, the paywall copy and the plan feature lists, but nothing in code locks it on Free (only browser automation and scheduled tasks are gated). The claim was kept where it already existed. Recommended: confirm it or remove it everywhere in one pass.
- Command plan (delisted): "Priority infrastructure support (24 hr)", "1:1 dedicated support (first 14 days)" and "1-click deploy from prompt library" are unverified promises. They were left because they are not plainly wrong. Recommended: remove them or confirm the processes.
- The cancel dialog sentence "When your plan ends, Hivra stops running your computers" is generic. A customer who is also covered by an Apple plan or token tier would keep them. Judged too rare to special-case.
- The earlier cross-lane requests (change-plan route, instances route 402, agent-start-failure, launch-plan, instance-service, LaunchJourney, agent-catalog, i18n planGuidance.operator, dunning.ts and the four non-owned prompts) were found applied in the tree by routed-code. Each was confirmed by grepping for the new text. Their tests were not run by this lane.

#### Lane: copy-legal (copy tree)

Terms, Privacy and docs/legal-copy-changes.md. Solicitor review is still required before any of this is published. The 48 in the Terms is now rendered from PAYMENT_GRACE_HOURS (imported in the page and in the test, and the test pins it to 48), so the visible text is unchanged.

Status by task:

- Lapsed computer keeps running (and lapse-trace G13): done. Terms section 4 has a separate Failed Payments and Cancellation item. Hermes wording is kept as its own labelled item. Behaviour was re-read in the code tree (lapse-flags.ts, lapse-gate.ts, hivra-lapse-enforce.ts, the action route 402, plans.ts). Jest on terms, privacy, vocabulary and static-copy-safety passed (5 suites, 57 tests). The sentence is false until the lapse code is merged and HIVRA_LAPSE_ENFORCE_LIVE is true.
- Legacy free computers "remain available": done. The sentence is deleted. The opening paragraph now says every computer Hivra Cloud runs for you needs a paid plan and a free account works with a computer or server you connect yourself. The test asserts none of "Free-tier computers", "remain available" or "created before this change" remain.
- Billing names and cadence: flagged. Monthly-only wording is fixed and Stripe is narrowed to card payments. Pro and Power are kept in the Terms on purpose (decision L1), so the plan-name part is Ash's call.
- Refund logic and Hermes naming: done. No claim route was added.
- Upgrade-Only versus cancel: done. Replaced by Plan Changes, true whether or not in-place downgrades are switched on. The code tree's refusal message has since changed, so the doc records the Terms versus message difference as an open point.
- Section 2 "production-grade": done.
- Terms silent on Hivra credits: partial. One descriptive sentence was added. The refund, expiry and guarantee scope of credits is not stated (F15).
- Privacy abandoned computers and lapse retention: done. The retention row is rewritten. P9 in the doc names the HIVRA_LAPSE_ENFORCE_LIVE dependency.
- Privacy operator-access explanation: done.
- docs/legal-copy-changes.md: done. Repaired against the code as it now is. It no longer mentions the invented HIVRA_LAPSE_ENFORCE_FREE switch, HIVRA_LAPSE_EMAIL_ENABLED or "entitlement columns". Checklist 8 names all three sentences (T7 opening, T9, P9) and describes the real single switch, sweep, Start 402 and email files. Checklist 9 is now the Stripe retry check, with the null-anchor fail-open. Checklist 11 and T11 are rewritten for the new change-plan message. Checklist 12 says the stop email goes out with the same switch. F13 says Free-account hosted computers fall under the same switch. F17 says 24 hours in code versus 48 in the policy. Line citations are fixed. The solicitor-review statement stays at the top.

##### /terms, section 4, Failed Payments and Cancellation

- Before: "If a payment fails or you cancel, we mark your Hermes agents (our original chat agents) as suspended straight away, unless you still have another paid plan with us. We may then switch them off, and we delete a suspended Hermes agent only after a warning period, with emails beforehand. The length of that period depends on your account. Computers run by Hivra are not currently suspended automatically when a payment fails or a subscription ends. We may change this, so please do not rely on a computer continuing to run without payment."
- After: "Failed Payments and Cancellation: Except for Hermes agents, which the next item covers, a computer that Hivra Cloud runs for you runs only while its plan is paid. If a card payment fails, we retry the card and keep your computer running for up to 48 hours after the first failed payment. If the payment has still not gone through by then, or when a cancelled plan ends, we stop your computer. We keep its files for a limited time, so that you can start it again once payment resumes, and we email you before we delete anything. If you still have another paid plan with us, your computer keeps running under that plan."
- Why: Ash's 21 October 2026 policy. True only when the lapse enforcement is merged and HIVRA_LAPSE_ENFORCE_LIVE is true. The Start refusal, the stop email and Free-account computers are deliberately not stated.

##### /terms, section 4, Hermes Agents (new item)

- Before: the Hermes sentences sat in the single failed-payment item quoted above.
- After: "Hermes Agents: Hermes agents (the agents you launch as Hermes) follow an older process. If a payment fails or you cancel, we mark your Hermes agents as suspended straight away, unless you still have another paid plan with us. We may then switch them off, and we delete a suspended Hermes agent only after a warning period, with emails beforehand. The length of that period depends on your account."
- Why: The Hermes sentences are kept for the older lane and labelled so a customer can map them.

##### /terms, section 4, opening paragraph

- Before: "A free account does not include a computer run by Hivra; it works with computers you connect yourself. A computer run by Hivra requires a paid plan[ or a qualifying token-based access path]. Free-tier computers created before this change remain available under the limits they were created with. Paid tiers (Pro, Power) are billed on a monthly subscription basis according to the tier you select. Payments and card verification are processed securely via Stripe."
- After: "A free account does not include a computer that Hivra Cloud runs for you; it works with a computer or server you connect yourself. Every computer that Hivra Cloud runs for you needs a paid plan[ or a qualifying token-based access path]. Paid tiers (Pro, Power) are billed for the tier and billing period you choose when you subscribe. Card payments and card verification are processed securely via Stripe. Hivra credits, where offered, pay for AI model usage through Hivra. They are separate from your plan, which does not include AI usage."
- Why: No free hosted computers, billing is not monthly only, Stripe is only the card route, and credits are described without a refund rule. Pro and Power are kept (decision L1). The "needs a paid plan" sentence is also false until the lapse switch is live, now listed in checklist 8.

##### /terms, section 4, refund

- Before: "Refund & Failed Payment Policy: Because we provision dedicated computing infrastructure for each Hermes agent, we incur immediate, non-recoverable server costs. Therefore, we offer a 7-day money-back guarantee on card payments, following your initial paid subscription charge."
- After: "Refund Policy: We set up a dedicated computer for you when you start, and that cost cannot be recovered. We still offer a 7-day money-back guarantee on card payments, counted from your first paid subscription charge."
- Why: Unrecoverable cost does not imply a refund, Hermes is one of six agents, the 7 days are counted from the first charge, and there is no claim route because no code handles refund requests.

##### /terms, section 4, plan changes

- Before: "Upgrade-Only Plans: Due to the nature of our dedicated infrastructure provisioning, Hivra subscription tiers cannot be downgraded. You may upgrade your tier at any time. To move to a lower tier, you must cancel your current subscription and initiate a new one. What happens to your current computer and its data when you cancel is described in the policy above."
- After: "Plan Changes: Due to the nature of our dedicated infrastructure provisioning, you may upgrade your plan at any time, but moving to a smaller size is not always possible in place. If the billing page does not offer it, you must cancel your current subscription and subscribe again. What happens to your computer when you cancel is described above."
- Why: The old first sentence was true only while the downgrade flag is off. The new wording is true either way. The code tree's refusal message now points to email help rather than cancelling, recorded as an open alignment point.

##### /terms, section 2

- Before: "Hivra provides a fully managed, production-grade cloud environment for autonomous AI agents. The service includes provisioning infrastructure, persisting memory, and providing a communication interface to interact with your deployed agents."
- After: "Hivra provides computers for AI agents, and for you to work with them. You can run them on Hivra Cloud, on a computer or server you connect yourself, or by self-hosting the open-source platform. On Hivra Cloud the service includes setting up the computer, keeping its files and settings, and giving you a way to open it and work with your agents."
- Why: Other pages refuse to promise a service grade or blanket backups. The old text described only managed hosting and a Hermes-specific feature.

##### /privacy, section 7, agent data and computer contents

- Before: "Agent data and computer contents: removed when you delete the computer. Copies of its settings, operational backups and cold-storage archives can remain for a limited time afterwards, and we do not currently set a fixed purge date for them. Abandoned or errored computers are removed on a rolling schedule."
- After: "Agent data and computer contents: removed when you delete the computer. If a computer's plan stays unpaid, we stop it and keep its files for a limited time, and we email you before we delete anything. Copies of its settings, operational backups and cold-storage archives can remain after the computer is deleted, and we do not currently set a fixed purge date for them. Computers that fail to set up are removed on a rolling schedule."
- Why: No code removes abandoned computers, "limited time" contradicted "no fixed purge date", and the lapse path needed a row. False until the lapse switch is live (checklist 8 names it).

##### /privacy, section 5

- Before: "... but replay and debugging systems can still capture contextual application data needed for support."
- After: "... but replay and debugging systems can still capture contextual application data needed for support. Authorised operators can also connect to the hosts that run your computers and to the computers themselves. Backups and archives of a computer can contain everything stored on it, including your files and any credentials saved there."
- Why: The introduction promises to explain operator access, and the body only mentioned counters and health checks.

Flags:

- The Terms opening sentence (every Hivra Cloud computer needs a paid plan), the Terms failed-payment item and the Privacy unpaid-computer sentence are all false until the lapse code is merged into canary and HIVRA_LAPSE_ENFORCE_LIVE is exactly true where the page is served. The pages do not check the flag (Ash's instruction). Publish the copy and the switch together. Checklist item 8 names all three.
- Free-account hosted computers fall under the same single switch (policy item 5 stands, and the earlier HIVRA_LAPSE_ENFORCE_FREE idea does not exist in code). With the switch on they are stopped at the next sweep with no earlier warning email, and the stop email follows. Ash and the solicitor should accept or change that.
- Token tier: the policy says 48 hours after a tier is lost, but the lapse code gives 24 hours (REQUALIFICATION_GRACE_HOURS in lib/billing/tier-thresholds.ts, also what the breach email promises). Ash decides whether the code or the policy moves. The page states no token figure.
- "We keep its files for a limited time" and "we email you before we delete anything" describe a deletion step that does not exist for Hivra computers (the lapse change only stops). Recommended: no number until the deletion step and its warning email exist.
- The Terms say "we retry the card". Whether Stripe retries across the 48 hours is dashboard configuration, now checklist item 9. The resolver also fails open when the failed-payment grace timestamp is missing, so "up to 48 hours" is a maximum in the normal case.
- Terms Plan Changes tells customers to cancel and subscribe again, while the code tree's downgrade refusal message says to email info@hivra.cloud. Ash aligns the two (checklist item 11).
- The stop email is sent with the same switch and is not promised in the Terms. Ash can choose to add "we email you when we stop your computer".
- Pro and Power remain in Terms section 4 (decision L1). Recommended: replace them with price and size after the solicitor has seen the rest.
- Hivra credits: guarantee, expiry and refund scope for credits is a policy call for Ash and the solicitor (F15). Only a description was added.
- Not in the copy, for Ash and the solicitor: liability cap and carve-outs, legal entity, governing law, minimum age, the UK 14-day statutory right, DMCC subscription rules, solicitor review of every edit, and both Last Updated dates (deliberately unchanged).

#### Lane: copy-core (copy tree)

Home, About, Pricing, Sign-up, Get started activation, checkout cancelled, footer and llms.txt. Final jest run: 26 suites, 264 tests pass. The finding numbers (F1 to F15) are those of the sense-core audit.

Status by finding:

- F2 done: the per-agent "Needs a paid size" note is removed everywhere in this lane's files. Home, About, Pricing and llms.txt now say, in the plan-facts sentences, that every Hivra Cloud computer needs a paid plan and a free account works with your own computer or server. The About costs section no longer repeats the price a second time (reviewer finding, fixed this pass).
- F3 done: Pricing and About state the free-account rule (Pricing intro, the "Already rent a server?" panel, "Is Hivra free?", a new FAQ "Does Hivra run a free computer for me?", and the About costs section and FAQ). No "trial" wording. The Home and Pricing metadata descriptions that typed "$9.99" are now built from ENTRY_PLAN_PRICE with identical output. The Pricing PAGE_TITLE still spells "$9.99" on purpose, because app/__tests__/absolute-title-metadata.test.ts reads the title from source.
- F4 done: sign-up intro, home hero proof line, computers block, home pricing "Connect your server" card, closing ask and the /reserve and /reserved metadata carry the paid note or the free-account rule.
- F5 done: no "Future marketplace access" or "Email support (48 hr)" exists in any home, About or Pricing file. The two sources outside this lane were fixed by other lanes, so the earlier cross-lane requests are withdrawn. lib/ecosystem-map.ts now carries the canonical short form.
- F10 done: a free account no longer reads "nearly ready to run your first computer".
- F11 done: checkout-cancelled falls back to the entry size, never the dearer size.
- F12 done: the Home FAQ no longer offers Hivra credits for Claude Code, and no longer says Claude Code takes a key (reviewer finding, fixed this pass). Code basis: lib/launch/model-access.ts in the code tree returns only native for claude-code, and its unsupportedReason says "Not available for Claude Code yet. Its own sign-in takes an Anthropic Console account instead."
- F13 done: the footer link no longer says "Download the app" while /download says "Public download coming soon". It flips by itself when PUBLIC_PROJECT_LINKS.desktop.macos is published.
- F14 flagged: Pricing says each size limits how many agents run at once, without numbers. The audit's numbers (3 and 5) are withheld on purpose.
- F15 done: the About FAQ asks and answers what is true.
- llms.txt implies free hosted computers: done. The paragraph carries the canonical rule before the Hermes limit and no longer names OpenClaw and Agent Zero as the paid ones. The DeepSeek preview line and the Omarchy and Windows wording are unchanged.
- F1 partial: the Pricing part is complete and matches the Terms. It stays partial because code enforcement, the Terms and the optional STAYS_ON rewording are other lanes' work, and the copy describes enforcement as on while HIVRA_LAPSE_ENFORCE_LIVE ships dark.

##### Home, agent cards (F2)

- Before: "OpenClaw card note: 'Needs a paid size.' Agent Zero card note: 'Needs a paid size.'"
- After: "Both notes removed. Hermes card keeps 'Hermes runs on Hivra Cloud only.' A line under the section heading says it once: 'Every computer that Hivra Cloud runs for you needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM. A free account works with a computer or server you connect yourself.'"
- Why: Singling out two agents told visitors the other four run free on Hivra Cloud. The code refuses every Hivra-hosted launch on a Free account (resource-gate.ts).

##### About, "Run supported AI agents" (F2)

- Before: "Different agents have different requirements, including cloud-only and paid-plan restrictions. Hermes runs on Hivra Cloud only. OpenClaw and Agent Zero need a paid size."
- After: "Different agents have different requirements, including cloud-only restrictions. Hermes runs on Hivra Cloud only. Every Hivra Cloud computer needs a paid plan."
- Why: The same per-agent distinction. The verbatim pin in the About test was updated to the new sentence.

##### Pricing, "Important differences between agents" (F2)

- Before: "Intro: 'Some agent options have requirements beyond the computer size:' Items: 'Hermes: Runs on Hivra Cloud only.' and 'OpenClaw and Agent Zero: Require a paid Hivra Cloud size.'"
- After: "Intro: 'What you can run depends on where it runs:' Items: 'On Hivra Cloud: Every Hivra Cloud computer needs a paid plan, whichever agent you run on it. Hermes runs on Hivra Cloud only.' and 'On your own computer or server: A free account works with a computer or server you connect yourself.' (The Claude Code and Codex item and the Other supported agents item are kept.)"
- Why: Removes the per-agent paid distinction and states the rule by where the computer runs.

##### llms.txt (F2 and the llms.txt finding)

- Before: "... or launch an Ubuntu computer and use it yourself. Hermes runs on Hivra Cloud only. OpenClaw and Agent Zero need a paid size. You can also self-host ..."
- After: "... or launch an Ubuntu computer and use it yourself. Every computer that Hivra Cloud runs for you needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM. A free account works with a computer or server you connect yourself. Hermes runs on Hivra Cloud only. You can also self-host ...  Pricing link note gains: 'Every Hivra Cloud computer needs a paid plan, and a free account works with a computer or server you connect yourself'"
- Why: An AI crawler read the old sentence as Claude Code, Codex, Hermes, Aeon and Ubuntu being launchable free. Price and size are built from ENTRY_PLAN_PRICE and ENTRY_PLAN_SIZE.

##### Pricing, "Is Hivra free?" (F3)

- Before: "The open-source platform is free to self-host. That doesn't make the physical or cloud server free, and your AI usage still has a cost. Hivra Cloud is a separate paid hosting service."
- After: "The open-source platform is free to self-host, and a free Hivra account works with a computer or server you connect yourself. That doesn't make the physical or cloud server free, and your AI usage still has a cost. A computer that Hivra runs for you is paid, from $9.99 a month for 2 vCPU and 4 GB of RAM."
- Why: The page never said what the free account is, so a reader could not tell whether a hosted computer is free.

##### Pricing, new FAQ, second question (F3)

- Before: none.
- After: "Q: 'Does Hivra run a free computer for me?' A: 'No. Every computer that Hivra Cloud runs for you needs a paid plan. A free account works with a computer or server that you connect yourself, and you can self-host the open-source platform at no software cost.'"
- Why: Requested in the lane brief. It also enters the FAQPage JSON-LD.

##### Pricing, intro and "Already rent a server?" (F3)

- Before: "Intro had two paragraphs. Panel: 'You can also connect infrastructure you pay for to Hivra, where supported. That gives you a different route from buying Hivra Cloud resources, while leaving the server bill with your own provider.'"
- After: "Intro gains a middle paragraph with the canonical rule. Panel: 'You can also connect infrastructure you pay for to Hivra, where supported. A free account is enough for that. Hivra does not run a computer for you on a free account, and your server bill stays with your own provider.'"
- Why: States the free-account rule where a visitor compares options.

##### About, costs section and FAQ (F3)

- Before: "FAQ 'Can I run Hivra without paying for cloud hosting?': 'Yes. Self-host the open-source platform on your own server. You'll still pay your infrastructure and AI providers.' Costs section had no paid-computer sentence."
- After: "FAQ: 'Yes. Create a free account and connect your own computer or server, or self-host the open-source platform. Hivra doesn't run a computer for you without a paid plan, and you'll still pay your infrastructure and AI providers.' Costs section gains, after the price paragraph (which already states $9.99 and 2 vCPU and 4 GB of RAM): 'Every Hivra Cloud computer needs a paid plan. A free account works with a computer or server you connect yourself.'"
- Why: The only free route named was self-hosting from source, and the free account was missing. This pass the costs sentence became the short form, because the full canonical sentence repeated the price in the adjacent paragraph.

##### Sign-up, and /reserve and /reserved which redirect to it (F4)

- Before: "Intro was one paragraph: 'Run a supported AI agent on a persistent computer, use a computer without an agent or bring your own infrastructure.' /reserve and /reserved description: 'Create your account and launch an agent or a computer on Hivra.'"
- After: "A second paragraph: 'Every computer that Hivra Cloud runs for you needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM. A free account works with a computer or server you connect yourself.' /reserve and /reserved description: 'Create your Hivra account. A free account works with a computer or server you connect yourself. Every Hivra Cloud computer needs a paid plan.'"
- Why: A new visitor expected a free start and met the paywall after creating an account.

##### Home, hero, computers, connect-your-server card, closing, FAQ (F4)

- Before: "Hero proof: 'Let Hivra host it, connect your own server, or self-host the platform.' Connect card: 'Use infrastructure you already rent and pay that provider directly.' Computers block and closing had no cost line. FAQ 'Do I have to use Hivra Cloud?' ended after 'Some managed agents and capabilities are Hivra Cloud-specific.'"
- After: "Hero proof: 'Let Hivra host it on a paid plan, connect your own server with a free account, or self-host the platform.' Connect card adds ' A free account is enough.' Computers block adds 'Every Hivra Cloud computer needs a paid plan.' Closing adds the canonical two sentences. FAQ adds ' Every Hivra Cloud computer needs a paid plan.'"
- Why: Every place a visitor chooses what to start now says what the free account is for and that Hivra-run computers are paid.

##### Get started, activation (F10)

- Before: "Lead for every plan: 'You're nearly ready to run your first computer.' Free processing line: 'Setting up your free account. Launch opens next, where you can connect your own computer or choose a plan.' No-plan screen: 'You're activating the Free plan', 'We didn't see a plan selection, so we've defaulted to Free. Confirm to continue, or choose a paid plan instead.', button 'Continue with Free'."
- After: "Free lead: 'Your free account is nearly ready.' (paid plans keep the old lead). Free processing line: 'Launch opens next, where you can connect your own computer or server. Every Hivra Cloud computer needs a paid plan.' No-plan screen: 'You're setting up a free account', 'We didn't see a plan selection, so we've defaulted to a free account. A free account works with a computer or server you connect yourself. Confirm to continue, or choose a paid plan instead.', button 'Continue with a free account'."
- Why: A free account cannot launch a Hivra-run computer, and the site calls it an account elsewhere, not a plan.

##### Checkout cancelled (F11)

- Before: "A missing or unknown plan in the link fell back to 'fleet': the retry button showed and started the $19.99 size."
- After: "Falls back to 'operator': the retry button shows 'Try again' with '$9.99/month, 2 vCPU and 4 GB RAM' and posts plan operator."
- Why: Nobody chose the dearer size. It matches /get-started.

##### Home FAQ "Can I keep using Claude Code or Codex?" (F12)

- Before: "...The plan does not include AI usage. Bring your own account or key where the agent supports it, or pay with Hivra credits."
- After: "...The plan does not include AI usage. Claude Code uses your own Claude or Anthropic account. For Codex, bring your own account or key, or pay with Hivra credits."
- Why: Claude Code has only its own sign-in in the code (model-access.ts returns native only, and says the key route is not available for Claude Code yet), so neither credits nor a key is offered for it. Codex supports native, key and credits.

##### Site footer, components/landing/Footer.tsx (F13)

- Before: "Link label 'Download the app' to /download"
- After: "Link label 'Mac app (coming soon)' to /download, which becomes 'Download the app' once the macOS release is published"
- Why: /download says "Public download coming soon."

##### Pricing, options pool sentence (F14)

- Before: "Each plan is a pool of CPU and memory for your agents' computers."
- After: "Each plan is a pool of CPU and memory for your agents' computers, and each size also sets how many agents can run at once."
- Why: The code refuses the next launch at the limit (3 and 5). The numbers are left out because the copy rules ban agent counts on public pages.

##### About FAQ, affiliation (F15)

- Before: "Q: 'Is the platform independent of Anthropic, OpenAI and Nous Research?' A: 'Yes. Hivra isn't affiliated with those companies.'"
- After: "Q: 'Is Hivra affiliated with Anthropic, OpenAI or Nous Research?' A: 'No. Hivra isn't affiliated with those companies. It supports agents they make, such as Claude Code, Codex and Hermes, so what those agents can do depends on their makers' software and terms.'"
- Why: The question was about independence, the answer was about affiliation, and Hivra depends on their tools.

##### Pricing FAQ, "Will Hivra turn my computer off when I'm not using it?" (F1)

- Before: "'A paid Hivra Cloud computer stays on and is not paused for inactivity. If you start a long-running process, configure it appropriately so it survives the closure of a terminal or session.' (the first pass inserted 'It is stopped only if the plan behind it stops being paid.')"
- After: "'A paid Hivra Cloud computer stays on and is not paused for inactivity. It is stopped if the plan behind it stops being paid. If you start a long-running process, configure it appropriately so it survives the closure of a terminal or session.'"
- Why: The owner can press Stop and the older Hermes lane has other stop paths, so an absolute "only" was not guaranteed. The approved sentence about inactivity is unchanged.

##### Pricing FAQ, "What happens if I stop paying?" (F1)

- Before: "First pass: 'A computer that Hivra Cloud runs for you runs only while its plan is paid. If a card payment fails, we retry the card and keep the computer running for up to 48 hours after the first failed payment. If it is still unpaid then, or when a cancelled plan ends, we stop the computer. A stopped computer keeps its files, and you can start it again once you have a paid plan. The terms have the details, including the older process for Hermes agents.' Before that pass the page had no such question."
- After: "'Except for Hermes agents, which follow an older process set out in the terms, a computer that Hivra Cloud runs for you runs only while its plan is paid. If a card payment fails, we retry the card and keep the computer running for up to 48 hours after the first failed payment. If it is still unpaid then, or when a cancelled plan ends, we stop the computer. A stopped computer keeps its files for a limited time, so you can start it again once you have a paid plan.' ('terms' links to /terms, and 48 is PAYMENT_GRACE_HOURS.)"
- Why: Owner policy of 21 October 2026, written for enforcement on. The code stops Hermes agents straight away (no 48 hour wait) and the Terms say files are kept "for a limited time", so the exception now leads the answer as it does in the Terms, and the files sentence uses the Terms wording. No deletion or email promise is made on this page.

Flags:

- F14: decide whether Pricing may publish the agent limit as numbers. The audit proposed 3 and 5 (AGENT_SLOTS, enforced at launch), but copy-rules.ts and public-claims.ts ban agent counts on public pages, and the owner's proposed ladder says 1 and 3. The limit was shipped without numbers. Recommended: keep it numberless until the ladder question is settled. The Get started cards already show 3 and 5 at the till.
- Pricing FAQ "What happens if I stop paying?" describes enforcement as live, but HIVRA_LAPSE_ENFORCE_LIVE ships dark. Until Ash sets it, a lapsed Hivra computer still keeps running. The copy and the switch must go out together, as decided.
- The Terms say "we email you before we delete anything". No code deletes or warns for hivra_agents yet (design plan step 10 is a later PR). Pricing now says only "keeps its files for a limited time" and promises no email or deletion. The Terms lane or Ash should confirm the Terms sentence is true before publishing. The length of "a limited time" is not stated anywhere and none was invented.
- Hermes customers: Pricing and the Terms now both lead with "Except for Hermes agents", pointing to the Terms for the older process (suspended straight away, deleted only after a warning period). The Hermes lane (hermes_instances) is unchanged by this pass, so that exception stays true only while the older lane exists.
- STAYS_ON ("A paid Hivra Cloud computer stays on and is not paused for inactivity") is pinned wording and is still repeated on Home, About, Pricing, Download and newupdate. It stays true while paid, so it was not touched. The audit's optional "stays on while your plan is paid" needs Ash's approval.
- The footer label is "Mac app (coming soon)", not the audit's "Desktop app (coming soon)", because /download is macOS only. Ash may prefer the generic word.
- F16 (holding the token unlocks a hosted computer without a payment) is not changed: token pages are outside this lane. Ash to confirm the token route stays a "bought" entitlement under the no-free-computers rule.
- F8 (the Roadmap calls connect-your-own-server a preview, while the free account depends on it and Home, Pricing and Get started offer it) is not this lane's and is still open. Home and Pricing now lean on "a free account works with your own computer or server" more than before, so the Roadmap lane should settle it. (Copy-system rewrote the Roadmap topic in this pass. See the next lane.)

#### Lane: copy-system (copy tree)

Get started cards and translations, Roadmap, Status, Stats, Changelog, Ecosystem pages and the token-access text. The repair-pass jest run passed (6 suites, 127 tests across get-started, components/status and i18n), with eslint and tsc clean. The finding numbers are those of the sense-core and sense-legal-system audits.

Status by task:

- F5 done: the larger-size sign-up card no longer lists "Future marketplace access" or "Email support (48 hr)". plans.ts was not touched by this lane.
- F6 done: in all seven translated locales the guarantee says card payments only, in badges.paid, guarantee.paid, createAccountIntroPaid and billing.switcher.guarantee. The English billing strip matches the English page. Repair this pass: the English and zh-CN billing strips had lost their "Upgrade-only plans" half, and both were restored. The wording was written in each language and needs a native speaker. See the routed-copy lane for a conflicting record about that half.
- F7 (sign-up cards) flagged: the cards, plan switcher and phone summary call the plans Hivra Cloud and More room with the size line, in every language. The billing names Pro and Power still exist in plans.ts, checkout and the dashboard, so the name still changes after payment. Renaming is Ash's call.
- F8 done: the Roadmap topic "Choose where it runs" is rewritten. It is true only if the release that ships it includes the connect flow. ROADMAP.md lines 22 to 24 and 91 still say Canary, not yet on hivra.cloud.
- F9 done: the token-access text no longer promises that a machine keeps running for a grace period then pauses. It says access is lost if the balance stays below the minimum for 24 hours and can be earned back after a 7-day wait, in all eight languages. It uses 24 hours, not the 48 in the task, because the code says 24.
- Translated /get-started billing names and bullets: done. The price, larger-size and three-agent assertions now read from PLANS, plan-facts (LARGER_PLAN_PRICE, LARGER_PLAN_SIZE) and AGENT_SLOTS, so a change fails a test instead of leaving seven languages stale.
- Status overclaims platform health: partial. The headline, summary, share card and the "Sign-in page" row are fixed. The OG alt text in lib/og-meta.ts was outside the lane and was handled by routed-copy.
- Changelog four months stale: flagged. The intro now states the newest entry's date. No entries were invented.
- Stats "agents live now" label: done.
- Ecosystem pages: done, no change needed. The one false-by-policy line was in lib/ecosystem-map.ts, handled by routed-copy.

##### /get-started, larger-size card, every language (F5)

- Before: "Everything in Hivra Cloud | Burst CPU when capacity allows | Priority scheduling | Future marketplace access | Email support (48 hr)"
- After: "Everything in Hivra Cloud | Twice the CPU and memory: 4 vCPU and 8 GB of RAM | Burst CPU when capacity allows | Priority scheduling"
- Why: The ecosystem pages say planned products are not available and pricing says planned perks are never repeated. No 48 hour support commitment exists in code, and support is by email for everyone. The size line comes from plan-facts, so it cannot go stale.

##### /get-started in zh-CN, es, pt-BR, fr, de, ja and ko, card, plan switcher and phone summary (F6)

- Before: "The card used the billing name from plans.ts: Pro (entry) and Power (larger). Entry bullets: 'Always-on' (followed by an em dash and 'never paused for inactivity'), Autonomous browsing & tool use, Persistent memory across sessions, Scheduled tasks & cron jobs, 'BYO AI key' (followed by an em dash and 'zero markup'). Larger bullets: Everything in Pro, Burst CPU when capacity allows, Priority scheduling, Future marketplace access, Email support (48 hr). No size line next to the price."
- After: "Hivra Cloud (entry) and More room (larger), the same bullets as the English card (A paid Hivra Cloud computer stays on and is not paused for inactivity. | Autonomous browsing & tool use | Persistent memory across sessions | Scheduled tasks & cron jobs | Bring your own account or key where the agent supports it, or pay with Hivra credits; larger: Everything in Hivra Cloud | Twice the CPU and memory: 4 vCPU and 8 GB of RAM | Burst CPU when capacity allows | Priority scheduling), and the size line (2 vCPU and 4 GB of RAM, 4 vCPU and 8 GB of RAM) beside the price."
- Why: Every language now follows the English page. A translated page no longer shows a plan name the public site never uses, an agent-level always-on promise or unshipped perks.

##### Billing switcher guarantee, English (F6)

- Before: "7-day money-back guarantee · Upgrade-only plans"
- After: "7-day money-back guarantee on card payments · Upgrade-only plans"
- Why: The guarantee covers card payments only (plan-facts MONEY_BACK_GUARANTEE, the Terms). Every other English string already said so. The upgrade-only half is kept (it was briefly dropped in an earlier edit and restored in the repair pass).

##### /get-started in zh-CN, guarantee and plan guidance (F6)

- Before: "badges.paid and guarantee.paid: 7 天退款保证 | createAccountIntroPaid: 账户信息将成为你的登录凭据。注册后，你会继续进入安全结账流程，并受到 7 天退款保证保护。 | billing.switcher.guarantee: 7 天退款政策 · 仅支持升级 | planGuidance.operator: Pro 适合独立开发者、黑客松项目，以及想快速上线一个 Agent 的用户。 | planGuidance.fleet: Power 适合多 Agent 工作流、更重的浏览任务，以及希望立刻获得更多算力余量的团队。"
- After: "badges.paid and guarantee.paid: 银行卡付款享 7 天退款保证 | createAccountIntroPaid: 账户信息将成为你的登录凭据。注册后，你会继续进入安全结账流程，银行卡付款受我们的 7 天退款保证保护。 | billing.switcher.guarantee: 银行卡付款享 7 天退款保证 · 仅支持升级 | planGuidance.operator: Hivra Cloud 最适合独立开发者和日常使用，有余量同时运行三个 Agent。 | planGuidance.fleet: 较大的规格（4 vCPU 和 8 GB 内存）最适合多 Agent 工作流、更重的浏览任务，以及希望立刻获得更多算力余量的团队。"
- Why: The refund is limited to card payments as in English, and the plan guidance names the plans the way the English page does. Written for this pass. A native speaker should check.

##### /get-started in es, guarantee and plan guidance (F6)

- Before: "badges.paid and guarantee.paid: Garantía de devolución de 7 días | createAccountIntroPaid: Los datos de tu cuenta se convierten en tus credenciales de acceso. Tras el registro, continuarás al checkout seguro. Protegido por nuestra garantía de devolución de 7 días. | billing.switcher.guarantee: Política de reembolso de 7 días · Solo actualizaciones | planGuidance.operator: Pro es ideal para builders en solitario, proyectos de hackathon y poner en marcha un agente rápidamente. | planGuidance.fleet: Power es ideal para flujos multi-agente, navegación más intensa y equipos que quieren más capacidad de cómputo de inmediato."
- After: "badges.paid and guarantee.paid: Garantía de devolución de 7 días en pagos con tarjeta | createAccountIntroPaid: Los datos de tu cuenta se convierten en tus credenciales de acceso. Tras el registro, continuarás al checkout seguro. Protegido por nuestra garantía de devolución de 7 días en pagos con tarjeta. | billing.switcher.guarantee: Garantía de devolución de 7 días en pagos con tarjeta · Solo actualizaciones | planGuidance.operator: Hivra Cloud es ideal para builders en solitario y para el uso diario, con espacio para tres agentes funcionando a la vez. | planGuidance.fleet: El tamaño mayor, de 4 vCPU y 8 GB de RAM, es ideal para flujos multi-agente, navegación más intensa y equipos que quieren más capacidad de cómputo de inmediato."
- Why: Same as zh-CN. A native speaker should check.

##### /get-started in pt-BR, guarantee and plan guidance (F6)

- Before: "badges.paid: Garantia de 7 Dias | guarantee.paid: Garantia de reembolso em 7 dias | createAccountIntroPaid: Seus dados de conta se tornam suas credenciais de login. Após o cadastro, você prosseguirá para o checkout seguro. Protegido pela nossa garantia de reembolso em 7 dias. | billing.switcher.guarantee: Política de reembolso em 7 dias · Planos somente com upgrade | planGuidance.operator: O Pro é ideal para desenvolvedores solo, projetos de hackathon e para colocar um agente no ar rapidamente. | planGuidance.fleet: O Power é ideal para workflows multi-agente, navegação mais intensa e equipes que querem mais margem de compute imediatamente."
- After: "badges.paid and guarantee.paid: Garantia de reembolso de 7 dias em pagamentos com cartão | createAccountIntroPaid: Seus dados de conta se tornam suas credenciais de login. Após o cadastro, você prosseguirá para o checkout seguro. Protegido pela nossa garantia de reembolso de 7 dias em pagamentos com cartão. | billing.switcher.guarantee: Garantia de reembolso de 7 dias em pagamentos com cartão · Planos somente com upgrade | planGuidance.operator: O Hivra Cloud é ideal para desenvolvedores solo e para o uso diário, com espaço para três agentes rodando ao mesmo tempo. | planGuidance.fleet: O tamanho maior, com 4 vCPU e 8 GB de RAM, é ideal para workflows multi-agente, navegação mais intensa e equipes que querem mais margem de compute imediatamente."
- Why: Same as zh-CN, and the pt-BR badge and guarantee now match each other. A native speaker should check.

##### /get-started in fr, guarantee and plan guidance (F6)

- Before: "badges.paid and guarantee.paid: Garantie satisfait ou remboursé 7 jours | createAccountIntroPaid: Vos informations de compte deviennent vos identifiants de connexion. Après l'inscription, vous continuerez vers le paiement sécurisé. Protégé par notre garantie satisfait ou remboursé 7 jours. | billing.switcher.guarantee: Politique de remboursement sous 7 jours · Plans avec upgrade uniquement | planGuidance.operator: Pro est idéal pour les développeurs solos, les projets de hackathon et la mise en ligne rapide d'un agent. | planGuidance.fleet: Power est idéal pour les workflows multi-agents, la navigation intensive et les équipes qui veulent plus de marge de compute immédiatement."
- After: "badges.paid and guarantee.paid: Garantie satisfait ou remboursé 7 jours pour les paiements par carte | createAccountIntroPaid: Vos informations de compte deviennent vos identifiants de connexion. Après l'inscription, vous continuerez vers le paiement sécurisé. Protégé par notre garantie satisfait ou remboursé 7 jours pour les paiements par carte. | billing.switcher.guarantee: Garantie satisfait ou remboursé 7 jours pour les paiements par carte · Plans avec upgrade uniquement | planGuidance.operator: Hivra Cloud est idéal pour les développeurs solos et l'usage quotidien, avec de la place pour trois agents en même temps. | planGuidance.fleet: La taille supérieure, 4 vCPU et 8 Go de RAM, est idéale pour les workflows multi-agents, la navigation intensive et les équipes qui veulent plus de marge de compute immédiatement."
- Why: Same as zh-CN. A native speaker should check.

##### /get-started in de, guarantee and plan guidance (F6)

- Before: "badges.paid and guarantee.paid: 7-Tage-Geld-zurück-Garantie | createAccountIntroPaid: Deine Kontodaten werden zu deinen Login-Zugangsdaten. Nach der Registrierung geht es zum sicheren Checkout. Geschützt durch unsere 7-Tage-Geld-zurück-Garantie. | billing.switcher.guarantee: 7-Tage-Rückerstattungsrichtlinie · Nur Upgrade-Pläne | planGuidance.operator: Pro ist ideal für Solo-Entwickler, Hackathon-Projekte und den schnellen Start mit einem Agenten. | planGuidance.fleet: Power ist optimal für Multi-Agent-Workflows, intensiveres Browsen und Teams, die sofort mehr Compute-Headroom benötigen."
- After: "badges.paid and guarantee.paid: 7-Tage-Geld-zurück-Garantie bei Kartenzahlung | createAccountIntroPaid: Deine Kontodaten werden zu deinen Login-Zugangsdaten. Nach der Registrierung geht es zum sicheren Checkout. Geschützt durch unsere 7-Tage-Geld-zurück-Garantie bei Kartenzahlung. | billing.switcher.guarantee: 7-Tage-Geld-zurück-Garantie bei Kartenzahlung · Nur Upgrade-Pläne | planGuidance.operator: Hivra Cloud ist ideal für Solo-Entwickler und den täglichen Einsatz, mit Platz für drei Agenten, die gleichzeitig laufen. | planGuidance.fleet: Die größere Variante mit 4 vCPU und 8 GB RAM ist optimal für Multi-Agent-Workflows, intensiveres Browsen und Teams, die sofort mehr Compute-Headroom benötigen."
- Why: Same as zh-CN. A native speaker should check.

##### /get-started in ja, guarantee and plan guidance (F6)

- Before: "badges.paid and guarantee.paid: 7 日間返金保証 | createAccountIntroPaid: 入力したアカウント情報がログイン認証情報になります。サインアップ後、安全なチェックアウトへ進みます。7 日間返金保証付き。 | billing.switcher.guarantee: 7 日間返金ポリシー · アップグレード専用プラン | planGuidance.operator: Pro は個人ビルダー、ハッカソンプロジェクト、1 つのエージェントを素早く立ち上げたい方に最適です。 | planGuidance.fleet: Power はマルチエージェントのワークフロー、ヘビーなブラウジング、すぐに多くのコンピュートが必要なチームに最適です。"
- After: "badges.paid and guarantee.paid: カード決済は 7 日間返金保証 | createAccountIntroPaid: 入力したアカウント情報がログイン認証情報になります。サインアップ後、安全なチェックアウトへ進みます。カード決済には 7 日間返金保証が付きます。 | billing.switcher.guarantee: カード決済は 7 日間返金保証 · アップグレード専用プラン | planGuidance.operator: Hivra Cloud は個人ビルダーや日常使いに最適で、3 つのエージェントを同時に動かせる余裕があります。 | planGuidance.fleet: より大きなサイズ（4 vCPU と 8 GB の RAM）は、マルチエージェントのワークフロー、ヘビーなブラウジング、すぐに多くのコンピュートが必要なチームに最適です。"
- Why: Same as zh-CN. A native speaker should check.

##### /get-started in ko, guarantee and plan guidance (F6)

- Before: "badges.paid and guarantee.paid: 7일 환불 보장 | createAccountIntroPaid: 계정 정보가 로그인 자격 증명이 됩니다. 가입 후 안전한 결제 단계로 진행됩니다. 7일 환불 보장이 적용됩니다. | billing.switcher.guarantee: 7일 환불 정책 · 업그레이드 전용 플랜 | planGuidance.operator: Pro는 개인 빌더, 해커톤 프로젝트, 에이전트를 빠르게 가동하는 데 가장 적합합니다. | planGuidance.fleet: Power는 멀티 에이전트 워크플로, 무거운 브라우징, 즉각적으로 더 많은 컴퓨팅 여유를 원하는 팀에 가장 적합합니다."
- After: "badges.paid and guarantee.paid: 카드 결제 7일 환불 보장 | createAccountIntroPaid: 계정 정보가 로그인 자격 증명이 됩니다. 가입 후 안전한 결제 단계로 진행됩니다. 카드 결제에는 7일 환불 보장이 적용됩니다. | billing.switcher.guarantee: 카드 결제 7일 환불 보장 · 업그레이드 전용 플랜 | planGuidance.operator: Hivra Cloud는 개인 빌더와 일상적인 사용에 가장 적합하며, 에이전트 3개를 동시에 실행할 여유가 있습니다. | planGuidance.fleet: 더 큰 사양(4 vCPU와 8 GB RAM)은 멀티 에이전트 워크플로, 무거운 브라우징, 즉각적으로 더 많은 컴퓨팅 여유를 원하는 팀에 가장 적합합니다."
- Why: Same as zh-CN. A native speaker should check.

##### Billing, Token Access description, English (F9)

- Before: "Hold at least the minimum $HermesOS in a verified wallet to unlock a basic machine. If your balance drops below the minimum, agents on that machine keep running for a grace period, then pause until you hold enough again."
- After: "Hold at least the minimum $HermesOS in a verified wallet to unlock a basic machine. If your balance stays below the minimum for 24 hours, you lose this access. After a 7-day waiting period, you can get it back by holding enough again."
- Why: No code pauses a Hivra computer on this route, and the wait before access can be earned again was left out. The window is 24 hours because REQUALIFICATION_GRACE_HOURS is 24 (tier-thresholds.ts:268) and the customer email promises 24 hours. The 48 hours in the finding and the task comes from a stale comment at token-tier-eligibility.ts:31. The wording says only that access is lost, not that a computer is switched off, because this tree has no lapse flag.

##### Billing, Token Access description, zh-CN (F9)

- Before: "在已验证钱包中持有不少于最低数量的 $HermesOS，即可解锁一台基础机器。如果余额低于最低数量，该机器上的 Agent 会在宽限期内继续运行，之后暂停，直到你再次持有足够数量。"
- After: "在已验证钱包中持有不少于最低数量的 $HermesOS，即可解锁一台基础机器。如果余额连续 24 小时低于最低数量，你将失去这项权限。经过 7 天的等待期后，只要再次持有足够数量，即可重新获得。"
- Why: Same as English. A native speaker should check.

##### Billing, Token Access description, es (F9)

- Before: "Mantén al menos el mínimo de $HermesOS en una billetera verificada para desbloquear una máquina básica. Si tu saldo baja del mínimo, los agentes de esa máquina siguen funcionando durante un periodo de gracia y luego se pausan hasta que vuelvas a tener suficiente."
- After: "Mantén al menos el mínimo de $HermesOS en una billetera verificada para desbloquear una máquina básica. Si tu saldo se mantiene por debajo del mínimo durante 24 horas, pierdes este acceso. Tras un periodo de espera de 7 días, puedes recuperarlo volviendo a tener suficiente."
- Why: Same as English. A native speaker should check.

##### Billing, Token Access description, pt-BR (F9)

- Before: "Mantenha pelo menos o mínimo de $HermesOS em uma carteira verificada para liberar uma máquina básica. Se o saldo cair abaixo do mínimo, os agentes dessa máquina continuam rodando por um período de carência e depois pausam até você voltar a ter o suficiente."
- After: "Mantenha pelo menos o mínimo de $HermesOS em uma carteira verificada para liberar uma máquina básica. Se o saldo ficar abaixo do mínimo por 24 horas, você perde esse acesso. Depois de um período de espera de 7 dias, você pode recuperá-lo ao voltar a ter o suficiente."
- Why: Same as English. A native speaker should check.

##### Billing, Token Access description, fr (F9)

- Before: "Détenez au moins le minimum de $HermesOS dans un portefeuille vérifié pour débloquer une machine de base. Si votre solde passe sous le minimum, les agents de cette machine continuent de tourner pendant une période de grâce, puis se mettent en pause jusqu'à ce que vous déteniez de nouveau assez."
- After: "Détenez au moins le minimum de $HermesOS dans un portefeuille vérifié pour débloquer une machine de base. Si votre solde reste sous le minimum pendant 24 heures, vous perdez cet accès. Après une période d'attente de 7 jours, vous pouvez le retrouver en détenant de nouveau assez."
- Why: Same as English. A native speaker should check.

##### Billing, Token Access description, de (F9)

- Before: "Halte mindestens das Minimum an $HermesOS in einer verifizierten Wallet, um eine Basis-Maschine freizuschalten. Fällt dein Guthaben unter das Minimum, laufen die Agents auf dieser Maschine für eine Kulanzfrist weiter und pausieren dann, bis du wieder genug hältst."
- After: "Halte mindestens das Minimum an $HermesOS in einer verifizierten Wallet, um eine Basis-Maschine freizuschalten. Bleibt dein Guthaben 24 Stunden lang unter dem Minimum, verlierst du diesen Zugang. Nach einer Wartezeit von 7 Tagen kannst du ihn zurückerhalten, indem du wieder genug hältst."
- Why: Same as English. A native speaker should check.

##### Billing, Token Access description, ja (F9)

- Before: "認証済みウォレットで最低数量以上の $HermesOS を保有すると、ベーシックマシンが使えるようになります。残高が最低数量を下回ると、そのマシンのエージェントは猶予期間中は動き続け、その後は十分な量を再び保有するまで一時停止します。"
- After: "認証済みウォレットで最低数量以上の $HermesOS を保有すると、ベーシックマシンが使えるようになります。残高が 24 時間にわたって最低数量を下回ったままの場合、このアクセスは失われます。7 日間の待機期間が過ぎたあと、再び十分な量を保有すれば取り戻せます。"
- Why: Same as English. A native speaker should check.

##### Billing, Token Access description, ko (F9)

- Before: "검증된 지갑에 최소 수량 이상의 $HermesOS를 보유하면 기본 머신이 열립니다. 잔액이 최소 수량 아래로 내려가면 해당 머신의 에이전트는 유예 기간 동안 계속 실행된 뒤, 다시 충분히 보유할 때까지 일시 중지됩니다."
- After: "검증된 지갑에 최소 수량 이상의 $HermesOS를 보유하면 기본 머신이 열립니다. 잔액이 24시간 동안 최소 수량 아래로 유지되면 이 접근 권한을 잃습니다. 7일의 대기 기간이 지난 뒤 다시 충분히 보유하면 권한을 되찾을 수 있습니다."
- Why: Same as English. A native speaker should check.

##### /roadmap, Available today, "Choose where it runs" (F8)

- Before: "Hivra Cloud is where agent computers run today. Connecting supported infrastructure of your own is a preview that is not yet part of Hivra Cloud, and self-hosting the platform is a preview too."
- After: "Hivra Cloud is where Hivra runs computers for you, on a paid plan. You can also connect a server you already have, and a free account is enough for that. Self-hosting the whole platform is a preview."
- Why: Free is defined as bringing your own computer, so the free account depends on the connect flow, and Home, Pricing and Get started already offer it. Self-hosting stays a preview as in README.md. True only if the release that ships this copy includes the connect flow.

##### /status, headline and summary, four states (status overclaims)

- Before: "All systems operational / Every public surface responded normally. | Some systems degraded / A public surface is slow or returning errors. | Major outage / A public surface is unreachable right now. | Checking systems… / Pinging each public surface from your browser."
- After: "Public pages operational / The public pages listed below responded normally. This does not check agents, computers or whether sign-in works. | Some public pages degraded / A public page is slow or returning errors. | A public page is not responding / A public page is unreachable right now. | Checking public pages… / Pinging each public page from your browser."
- Why: The page loads four public pages from the visitor's browser, which says nothing about agents, computers, provisioning, billing or the sign-in service, and on one origin a single failed route cannot be a major outage. The long body wording is the lane's, built from the finding's proposal.

##### /status, second check row (status overclaims, repair)

- Before: "Row label 'Sign-in' (aria label 'Sign-in: Operational')"
- After: "Row label 'Sign-in page' (aria label 'Sign-in page: Operational')"
- Why: The row only proves the /sign-in page HTML loads, and the summary right above says the page does not check whether sign-in works. The old label read as the sign-in service being checked and healthy.

##### /status social card, opengraph-image.tsx (status overclaims)

- Before: "Title: Live platform health. Subtitle: Real-time operational status of Hivra's public surfaces."
- After: "Title: Public page status. Subtitle: Live checks of Hivra's public pages, run from your browser."
- Why: Same as the headline. The card's alt text in lib/og-meta.ts was handled by routed-copy.

##### /stats, running-now figure: English card, translated page, aria label and page sentence

- Before: "Agents live now | how many agents are live right now | {n} agents live now"
- After: "Agents and computers running now | how many agents and computers are running right now | {n} agents and computers running now"
- Why: hivra_agents_running_now() counts every running row, computers included, so the label now says what is counted and does not call it live paid use.

##### /changelog, list intro

- Before: "Dated notes on notable changes to Hivra: bug fixes, new features, upstream syncs and infrastructure work."
- After: "Dated notes on notable changes to Hivra: bug fixes, new features, upstream syncs and infrastructure work. The newest entry is dated 21 June 2026. Later changes are not listed here."
- Why: The page read as a current record but the newest entry is four months old. The date is read from the newest entry in hermes_changelog.md (no typed date), so the sentence stays true when an entry is added. No entries were invented.

Flags:

- F9, decision for Ash and the code lane: the task and the audit say a token tier is lost after 48 hours, but the code says 24. REQUALIFICATION_GRACE_HOURS = 24 (tier-thresholds.ts:268, shortened from 48h on 2026-04-30) and the customer email says "You keep the tier for a 24-hour grace period" (tier-eligibility-notifications.ts:103). 48h survives only in a stale comment (token-tier-eligibility.ts:31), which routed-code has since corrected. The copy says 24 hours and a 7-day wait. Policy item 3 should say 24 hours for token tiers.
- F9, possible lapse-sweep bug: on a fresh breach the evaluator sets currently_eligible = false at once (token-tier-eligibility.ts:966-975) and the entitlement resolver only reads currently_eligible = true (instance-entitlement.ts:266-270, whose comment claimed it stays true through the grace). If the lapse sweep used that resolver it could stop a token-entitled computer at the first breach tick, not after 24 hours, which breaks the email's promise. Not a copy issue. (Routed-code and lapse-core handled this with hasTokenTierInGrace in the lapse check, and corrected the comment.)
- F9 text omits the re-qualification cap (2 per rolling year, REQUALIFICATION_CAP_PER_YEAR). It says access can be earned back after a 7-day wait, which is true unless the cap is hit. Add the cap only if Ash wants the full rule. Token benefits are Ash's, so the tier and the "basic machine" unlock were left as they were.
- F8, gate before shipping: the Roadmap, Home, Pricing and Get started now offer connecting a server you already have, with a free account. That is true only if the release that ships this copy includes the connect flow. ROADMAP.md lines 22 to 24 ("Where things stand", On Canary, not yet on hivra.cloud, connecting a server you already have) and the Slice 3 row at line 91 still say Canary only. If the release does not include it, take the free-account and connect-a-server offers out of those four places instead. ecosystem-alignment.test.ts still reads that ROADMAP.md line as a tripwire. When ROADMAP.md is updated to say the flow is live, replace the tripwire with a check that ROADMAP.md no longer says Canary only (a reviewer's point, accepted as a note for that later change, not made now because it would loosen a guard).
- F7, decision for Ash: plans.ts, checkout and the dashboard still name the plans Pro and Power, so a customer who bought "Hivra Cloud" sees "Pro" afterwards, and "Pro" also means a different size in the public ladder. Recommended: change only the display names in plans.ts to Hivra Cloud and More room (keys and Stripe ids stay) and set the Stripe product names to match. The i18n token-tier labels "Pro tier" and "Power tier" are a separate token question and were not changed.
- F6, native speakers needed: the card-payments wording, the plan guidance and the token-access text were written for zh-CN, es, pt-BR, fr, de, ja and ko in this pass, with no native review. The bullets on every translated card are still English, as they were before.
- Changelog: nothing was added. The newest entry is 21 June 2026 and about 728 merges have landed since, including the 7 October end of free hosted computers. Ash or the author should write the July to October entries. The intro sentence will pick up the new newest date by itself. The RSS feed still reports a June lastBuildDate.
- Optional, needs Ash: the sentence "A paid Hivra Cloud computer stays on and is not paused for inactivity." is still true while a plan is paid, so it was kept. With lapse enforcement on, "stays on while your plan is paid" would be clearer, but the sentence is pinned in plan-facts, runtime-facts and several tests, so it needs owner approval.
- Status page: the closing line "We would rather explain a disruption plainly than hide it behind a vague uptime percentage." is still Ash's open decision. The Sign-in row now says "Sign-in page" and the summary says sign-in is not checked.
- Stats: the number under "Agents and computers running now" still counts unpaid and legacy free computers until the lapse code is live and enforced, so it will fall when that lands. Only the label changed.
- Scope note for the orchestrator: the status headline lives in dashboard/src/components/status/StatusPageContent.client.tsx and its test, which sit outside the brief's literal owned list (app/status/**). The edit was needed, and no other lane edits those two files in this tree. Please accept them as in scope for this lane.
- Tests that tie the translated text to code now: the larger size (PLANS.fleet), the price with its size (plan-facts) and the "three agents" wording (AGENT_SLOTS.operator = 3, with the words per language listed in i18n.test.ts). If the entry slot count changes, that test fails first and the words must be rewritten in all eight languages. The English guidance string and the seven translations still hand-type 4 vCPU, 8 GB and "three agents" in the source. Only the tests were tied to the constants, not the strings.
- Follow-up, not this pass: dashboard/src/lib/i18n.ts has about 631 lines that already contain an em or en dash (billing switcher descriptions in six languages, token strings and others), all older than this work. The copy scan only reads added lines, so it reports 0. A separate sweep could clean them.
- docs/site-copy-fix2-deviations.md was out of date at the lines that say the translated /get-started pages still show Pro and Power, the old always-on wording and the old guarantee words, and at the /roadmap connect-your-server decision. This section and the RESOLVED, CHANGED and SUPERSEDED lines above bring that ledger up to date.

#### Lane: copy-product (copy tree)

Agent pages, the Agents hub, Features pages, Compare pages, Tools closing block and the SEO catalog. Jest on agents, features, compare, tools, lib/compare, lib/tools, components/tools, agent-seo-catalog.test, llms-txt.test and seo-urls.test: 33 suites, 775 tests pass. The guard suites (metadata-titles, static-copy-safety, user-copy-vocabulary, open-graph, absolute-title): 6 suites, 33 tests pass. The finding numbers (A1 to A3, C1, C2, T1, F1 to F3, X1) are those of the sense-product audit.

Status by finding:

- A1 done: the per-agent paid distinction is removed everywhere in the lane. Every agent page, the hub, the features pages, the compare pages and the SEO descriptions state one rule. After review: the OpenClaw features FAQ no longer opens with a flat "No."; the OpenClaw and Agent Zero step titles are neutral; the Aeon, Claude Code and Hermes cost FAQs carry the shared rule; and the residual "supported paid" wording is gone. The Agent Zero FAQ question "Does Agent Zero need a paid plan?" was kept on purpose.
- A2 done: the Features page no longer calls connecting your own server a Hetzner-only preview. It names Claude Code, Codex, OpenClaw, Agent Zero and Aeon as able to run on a server you connect yourself, keeps Hermes as Hivra Cloud only, and carries the canonical sentences. Canary evidence: InfrastructureEntryChooser.tsx and InfrastructurePreflightResult.tsx.
- C1 done: the self-hosting comparison gives the Hetzner CX23 in euros and dollars with the same supply caveat as the tools pages. No price was invented. EUR 5.49 and USD 6.49 (Germany and Finland, excluding VAT and IPv4) were re-read on docs.hetzner.com on 21 October 2026, and the reviewer confirmed them.
- T1 done: a sentence was added after the owner-approved AI-usage sentence on every tools page. A test fails if Claude Code ever gains a credits path.
- F1 done: staged Hermes rollout is worded as something Hivra can do, not something that always happens.
- F2 flagged: the two agent-level headlines now speak about the computer. The /features H1 was Ash's own wording, so the change needs his yes.
- F3 done: the memory-retention FAQ says only what is certain. No retention or deletion promise was added.
- A3 done: Aeon copy says what the code does. Code basis: lib/hivra/agent-catalog.ts and resource-gate.ts in the code tree (pool-exempt agents take a slot but not the shared budget).
- C2 done: compare pages no longer send readers elsewhere for "a GUI desktop" or call Hivra "terminal-first".
- X1 done: no copy change needed beyond the above. Every "stays on" sentence still says "paid", and nothing promises that a computer stays on, or that anything is kept, after payment stops.
- llms-txt per-agent wording (agent and feature pages): done.
- Sitemap lastmod for the pages this lane changed (seo-lastmod.ts): partial. AGENT_PAGES_LAST_MODIFIED moved to 2026-10-21. The matching dates for /features, the feature detail pages, the compare detail pages, /tools and all six tool pages live in dashboard/src/lib/seo-lastmod.ts (not this lane's) and are still 2026-10-20. compareHub is already 2026-10-21. A cross-lane request was filed. Until it lands, the sitemap dates agent pages a day later than the other pages this lane edited. The alternative is to set AGENT_PAGES_LAST_MODIFIED back to 2026-10-20.

##### /features/openclaw-alternative, FAQ "Can I use OpenClaw for free on Hivra?" (A1)

- Before: "OpenClaw needs a paid size on Hivra. Framework software and hosted compute are different things."
- After: "Not on a computer that Hivra Cloud runs for you. Every computer that Hivra Cloud runs for you needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM. A free account works with a computer or server you connect yourself. The OpenClaw software is free. The computer that runs it is what you pay for."
- Why: Only OpenClaw was called paid, which read as if Hermes, Claude Code, Codex and Aeon host for free. Canary refuses every Hivra-hosted launch on a Free account. The first version opened with a flat "No.", which the review showed contradicts the next sentence, because OpenClaw can run free on a server you connect (ownServer true in lib/launch/contracts.ts). The answer is scoped to the computer Hivra runs.

##### /features/openclaw-alternative, two-paths paragraph and comparison table row (A1)

- Before: "Keep using OpenClaw, hosted on a supported paid Hivra deployment, or try Hermes if you prefer ... | Long-running hosted computer: Supported paid deployment / Hivra Cloud managed deployment"
- After: "Keep using OpenClaw, hosted on a paid Hivra computer, or try Hermes, also on a paid Hivra computer, if you prefer ... | Long-running hosted computer: A paid Hivra Cloud computer / A paid Hivra Cloud computer"
- Why: The same rule for both agents. "Supported paid deployment" for OpenClaw only implied Hermes was not paid.

##### /features, item 06 and "What is included in the hosting price?" (A1)

- Before: "Host OpenClaw on a supported paid plan, or choose Hermes if its approach ... | Hosting starts at **$9.99 a month for 2 vCPU and 4 GB of RAM**. A larger option is ..."
- After: "Host OpenClaw on a paid Hivra computer, or choose Hermes, also on a paid Hivra computer, if its approach ... | Every computer that Hivra Cloud runs for you needs a paid plan, from **$9.99 a month for 2 vCPU and 4 GB of RAM**. A free account works with a computer or server you connect yourself. A larger option is ..."
- Why: One rule for every agent, and it says what the free account is for.

##### /features, hub: persistent browser item and "Can I run several agents?" FAQ (A1)

- Before: "On supported paid Hermes deployments, a persistent Chromium browser is available on the agent's cloud computer. | Yes, on supported paid plans within the agent and compute limits shown at checkout."
- After: "On supported Hermes deployments, a persistent Chromium browser is available on the agent's cloud computer. | Yes, within the agent and compute limits of your plan, shown at checkout."
- Why: Review finding: "supported paid" implies a free or unsupported Hivra Cloud computer exists. Every Hivra Cloud computer is paid, so the word adds nothing and misleads.

##### /features/browser-automation, what the browser does (A1)

- Before: "On supported paid deployments, the browser stays available even after you close your laptop."
- After: "On a paid Hivra Cloud computer, the browser stays available even after you close your laptop."
- Why: Same review finding. "Paid" is kept here because this is a stays-on claim, and only a paid computer stays on.

##### /features/multi-agent, intro paragraph and "How many agents can I run?" FAQ (A1)

- Before: "... all managed under the same account on supported paid plans. | Hivra's supported paid plans use shared compute resources with agent-count limits."
- After: "... all managed under the same account on a Hivra Cloud plan. | Hivra's plans use shared compute resources with agent-count limits."
- Why: Same review finding.

##### /agents/openclaw and /agents/agent-zero, step titles (A1)

- Before: "Pick a paid plan | Choose Agent Zero and a paid plan"
- After: "Pick a plan | Choose Agent Zero and a plan"
- Why: Review finding: paid wording sat in the headings of only two of the six agent pages, which read as if OpenClaw and Agent Zero are the paid ones. The body of every page carries the one rule.

##### /agents/openclaw, "Pick a plan" step (A1)

- Before: "OpenClaw needs a paid size on Hivra Cloud. The entry plan is **{entry}**. OpenClaw needs a minimum of ..."
- After: "Every computer that Hivra Cloud runs for you needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM. A free account works with a computer or server you connect yourself. OpenClaw needs a minimum of ..."
- Why: Removes the per-agent paid note.

##### /agents/agent-zero, step and FAQ "Does Agent Zero need a paid plan?" (A1)

- Before: "Agent Zero needs a paid size. The entry plan is **{entry}**. Agent Zero's minimum footprint ... | Yes, Agent Zero needs a paid size. The entry option is {entry}; the larger size is {larger}. {aiNote}"
- After: "Every computer that Hivra Cloud runs for you needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM. A free account works with a computer or server you connect yourself. Agent Zero's minimum footprint ... | Yes, on Hivra Cloud, as for every agent. Every computer that Hivra Cloud runs for you needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM. A free account works with a computer or server you connect yourself. The larger size is {larger}. {aiNote}"
- Why: Removes the per-agent paid note. "Agent Zero needs a paid size" was also not strictly true for a server you connect yourself. The FAQ question text is unchanged on purpose (see the flags).

##### /agents/claude-code and /agents/codex, launch step (A1)

- Before: "Managed hosting starts at **{entry}**. If you need more room, ... | Entry hosting is **{entry}**; the **{largerPrice} a month** plan provides {largerCompute}."
- After: "Every computer that Hivra Cloud runs for you needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM. A free account works with a computer or server you connect yourself. If you need more room, ... | (same sentence pair) The **$19.99 a month** plan provides {largerCompute}."
- Why: These two pages never said the computer is paid.

##### /agents/claude-code, FAQ "How much does it cost?" (A1)

- Before: "Hivra hosting starts at {entry}, or {larger}. Anthropic usage or subscription charges are separate. {refund}"
- After: "Every computer that Hivra Cloud runs for you needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM. A free account works with a computer or server you connect yourself. The larger size is $19.99 a month for 4 vCPU and 8 GB of RAM. Anthropic usage or subscription charges are separate. {refund}"
- Why: The same canonical wording as the launch step. The old line gave a price without saying the computer needs a paid plan.

##### /agents/aeon, FAQ "What does it cost?" (A1)

- Before: "Managed hosting starts at {entryPrice} a month. The dashboard uses very little compute, but the associated GitHub Actions minutes and any third-party services are governed by their own providers' billing. {aiNote}"
- After: "Every computer that Hivra Cloud runs for you needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM. A free account works with a computer or server you connect yourself. The dashboard uses very little compute, but the associated GitHub Actions minutes and any third-party services are governed by their own providers' billing. {aiNote}"
- Why: Review finding: the one agent-page price statement that did not carry the rule.

##### /agents/hermes, FAQ "What does hosting cost?" (A1)

- Before: "{entry}, or {larger}, plus your model usage. {refund}"
- After: "Every Hivra Cloud computer needs a paid plan. The entry option is $9.99 a month for 2 vCPU and 4 GB of RAM, or $19.99 a month for 4 vCPU and 8 GB of RAM, plus your model usage. {refund}"
- Why: The same fix for consistency with the Aeon and Claude Code cost answers. Hermes gets the short form because it runs on Hivra Cloud only.

##### /agents/hermes, "Choose Hermes" step (A1)

- Before: "give the agent a name and choose a paid hosting plan. Hermes runs on Hivra Cloud only."
- After: "give the agent a name and choose a plan. Every Hivra Cloud computer needs a paid plan. Hermes runs on Hivra Cloud only."
- Why: The short canonical form. Hermes cannot use the connect-your-own-server sentence.

##### /agents hub, lead and "Start with the resources you need" (A1)

- Before: "On a paid plan, the computer stays available after you close your laptop. | Paid hosting starts at **{entry}**. The **{largerPrice} a month** option ..."
- After: "Every Hivra Cloud computer needs a paid plan, and a paid computer stays available after you close your laptop. | Every computer that Hivra Cloud runs for you needs a paid plan, from **{entry}**. A free account works with a computer or server you connect yourself. The **{largerPrice} a month** option ..."
- Why: States the rule once up top and once with the price.

##### /agents/aeon, "Launch the dashboard" step (A1)

- Before: "Plans start at **{entryPrice} a month**. Hivra provisions the small dashboard computer ..."
- After: "Every computer that Hivra Cloud runs for you needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM. A free account works with a computer or server you connect yourself. Hivra provisions the small dashboard computer ..."
- Why: The same canonical wording on every agent page.

##### Agent page meta descriptions (OpenClaw, Agent Zero) and sitemap lastmod (A1)

- Before: "... scheduled routines. Paid hosting from $9.99/mo. | ... dashboard and tools. Paid hosting starts at $9.99/mo. | AGENT_PAGES_LAST_MODIFIED 2026-10-20"
- After: "... scheduled routines. From $9.99/mo. | ... dashboard and tools. From $9.99/mo. | AGENT_PAGES_LAST_MODIFIED 2026-10-21"
- Why: Only two descriptions said "Paid hosting", and the other four said "From $9.99/mo". The lastmod moves because page content really changed. The matching dates for the other pages are a cross-lane request (seo-lastmod.ts).

##### /compare/openclaw-to-hermes (meta description, lede, FAQ) and /compare/vs-xcloud table (A1)

- Before: "Hivra can host OpenClaw on a paid computer, or you can move to Hermes with its own migration command. ... | Hivra can host it on a supported paid computer. | No. Hivra supports paid OpenClaw deployments as well as Hermes. | OpenClaw hosting status: Available on a paid size"
- After: "Hivra can host OpenClaw or Hermes on a paid computer. Hermes has its own command to move an OpenClaw setup. ... | Hivra can host it on a paid Hivra Cloud computer, just as it hosts Hermes. | No. Hivra can host OpenClaw as well as Hermes. Every Hivra Cloud computer needs a paid plan. | OpenClaw hosting status: Available on Hivra Cloud"
- Why: Removes "paid" from OpenClaw alone and states the rule for every computer.

##### /features/no-docker-hosting, paragraph and FAQ "Can I choose the server region?" (A2)

- Before: "Hermes runs on Hivra Cloud only. Hivra also has a preview bring-your-own-Hetzner-Cloud option for selected other agents, including OpenClaw, Claude Code and Codex. That preview is not a universal deployment option and may have different features. | Not on standard Hivra Cloud sign-up today. A separate Hetzner-project deployment option is in preview for certain frameworks."
- After: "Hermes runs on Hivra Cloud only. Claude Code, Codex, OpenClaw, Agent Zero and Aeon can also run on a server you connect yourself, such as a Hetzner Cloud project or a Linux server that Hivra can reach over SSH. Every computer that Hivra Cloud runs for you needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM. A free account works with a computer or server you connect yourself. Hivra checks what each server can run, and features can differ from a Hivra Cloud computer. | Not on Hivra Cloud today. For Claude Code, Codex, OpenClaw, Agent Zero and Aeon, you can connect your own server or a Hetzner Cloud project and choose where it runs."
- Why: The free account is built on connecting your own machine. Canary accepts any SSH-reachable Linux server and five agents, and does not label it preview. It matches the Roadmap lane.

##### /features/no-docker-hosting, Provisioning item (A2)

- Before: "You aren't asked to rent a separate VPS just to try a supported managed deployment."
- After: "You aren't asked to rent a separate VPS for a supported managed deployment."
- Why: "Just to try" read as a try-before-you-pay offer.

##### /compare/vs-self-hosted, "What you are actually paying for" and at-a-glance cost row (C1)

- Before: "A Hetzner CX23, with 2 vCPU and 4 GB RAM, is €5.49 per month before VAT and a public IPv4 address. Hivra's managed computer starts at ... | From €5.49/mo before VAT and a public IPv4 address (unmanaged)"
- After: "A Hetzner CX23, with 2 vCPU and 4 GB RAM, is €5.49 per month before VAT and a public IPv4 address (Hetzner's price adjustment page lists the same server at $6.49 in US dollars for Germany and Finland). Hetzner says the number of servers in this range is limited, so you may not be able to order one when you look. Hivra's managed computer starts at ... | From €5.49/mo before VAT and a public IPv4 address (unmanaged), or $6.49 in US dollars for Germany and Finland. Hetzner says supply in this range is limited"
- Why: The same server, source and stock caveat as the tools pages, so the reader can compare in dollars. "For Germany and Finland" was added after review because Hetzner lists CX23 only for those locations, as the tools page says.

##### /tools and all six tool pages, closing block (T1)

- Before: "The plan does not include AI usage. Bring your own account or key where the agent supports it, or pay with Hivra credits. There is a 7-day money-back guarantee on card payments."
- After: "The plan does not include AI usage. Bring your own account or key where the agent supports it, or pay with Hivra credits. Claude Code uses your own Anthropic sign-in, not Hivra credits. There is a 7-day money-back guarantee on card payments."
- Why: Every page can end in a Run Claude Code on Hivra button, but Claude Code has only the native sign-in. The owner-approved sentence is kept word for word.

##### /compare/vs-self-hosted, /compare/openclaw-to-hermes tables and /features/no-docker-hosting, staged rollout (F1)

- Before: "Hermes updates are tested on one agent before wider rollout | For supported managed Hermes deployments, Hivra tests new versions before a wider rollout. | Hivra tests managed releases, but regressions are possible."
- After: "Hermes updates can be rolled out in stages, starting with a single agent | For supported managed Hermes deployments, Hivra can roll a new version out in stages, starting with a single agent. | Hivra can stage managed releases, but regressions are possible."
- Why: The staged ladder exists in code, but a box on the floating tag with no registered release is not tested first.

##### /features H1, lead and scheduled-tasks item, and /tools closing heading (F2)

- Before: "Give your agent a computer. We'll keep it running. | (the lead ended at '...what your agent is allowed to do.'; item 03 ended with the stays-on sentence) | Agents that stay on."
- After: "Give your agent a computer that stays on. | (the lead ends '... what your agent is allowed to do. A paid Hivra Cloud computer stays on and is not paused for inactivity.'; item 03 no longer repeats it) | Computers that stay on."
- Why: The headlines said the agent is kept running, but only the computer stays on, and only a paid one. The sentence moved to the lead so it appears once, under the headline. The H1 was Ash's own wording, so it is flagged for his yes.

##### /tools/agent-survival-check, bridge paragraph (F2)

- Before: "... and that computer stays on with your files, sessions and login."
- After: "... and that paid computer stays on with your files, sessions and login."
- Why: Only a paid computer stays on.

##### /features/persistent-memory, FAQ "How long does memory remain?" (F3)

- Before: "It is stored with the hosted agent while that environment exists. Retention and recovery after deletion are governed by the relevant product behaviour and terms."
- After: "It stays with the agent's computer for as long as that computer exists. Export anything you want to keep before you cancel or delete the computer."
- Why: The old answer pointed at "the relevant product behaviour". Any specific retention promise would be wrong for at least one lane today.

##### /agents/aeon (what Hivra provides) and /agents hub, Aeon card (A3)

- Before: "Hosting that doesn't consume your plan's normal shared CPU and RAM allocation for Aeon's background jobs. | The dashboard stays available without the background jobs consuming your agent computer's main CPU and RAM allocation."
- After: "A small dashboard computer that counts as one of your agents but uses none of your plan's shared CPU and RAM. | The dashboard computer counts as one of your agents but uses none of your plan's shared CPU and RAM."
- Why: The scheduled jobs run on the owner's GitHub Actions and never use Hivra CPU. What is exempt is the small dashboard computer, which still takes one agent place.

##### /compare (directory) and /compare/best-ai-agent-host (C2)

- Before: "If you want a GUI desktop, an on-demand sandbox API, or a product already tied to your existing cloud stack ... | If you need a full desktop, test a desktop product rather than assuming a terminal-first host can replace it."
- After: "If you want a purpose-built computer-use product, an on-demand sandbox API, or a product already tied to your existing cloud stack ... | If you need a purpose-built computer-use desktop, test a product built for that against your own task before assuming a general-purpose computer can replace it."
- Why: Hivra launches Ubuntu desktop computers. Calling it terminal-first and sending readers elsewhere for a desktop contradicted the launch flow.

Flags:

- F2: the /features H1 was Ash's own wording (01-features-directory.md). It was changed to "Give your agent a computer that stays on." because the old one said the agent is kept running. It needs his yes. The fallback is to restore "Give your agent a computer. We'll keep it running." and keep only the lead sentence under it.
- A2: whether connect-your-own-server is live on hivra.cloud cannot be seen from code (ROADMAP.md says Canary only). The copy is written for the world where the release ships with it. Also unresolved: components/infrastructure/InfrastructureEntryChooser.tsx says DigitalOcean Managed Agents can run Hermes while Hermes ownServer is false, so "Hermes runs on Hivra Cloud only" may need a DigitalOcean exception if that route is live.
- Guards left as they are (hard rule): lib/tools/copy-rules.ts still says "BYO cloud beyond Hetzner is not available" and AGENT_COPY_BANNED_PATTERNS in lib/hivra/agent-seo-catalog.ts still bans aws, gcp, azure, digitalocean and google cloud on agent pages. The new copy trips neither. Recommended: Ash decides whether those reasons and bans should be reworded now that any Linux server can be connected, but only on his say.
- X1 optional sentence, not added: after hub.ts "Paid computers stay available.", add "If a payment fails or you cancel, Hivra stops the computer. Its files are kept, so you can start it again after you pay." once HIVRA_LAPSE_ENFORCE_LIVE is set, because it is only true then. The lane brief said to change nothing here, so it was not added.
- Dependency: agents, features and compare files import HOSTED_COMPUTE_NEEDS_PLAN, HOSTED_COMPUTE_NEEDS_PLAN_SENTENCE, HOSTED_COMPUTE_NEEDS_PLAN_SHORT and FREE_ACCOUNT_SENTENCE from dashboard/src/lib/blog/plan-facts.ts, which is not in this lane. Those four exports must stay as they are.
- Left alone, wording risk: the /agents H1 "Pick your agent. We'll give it a computer." could read as a gift. The next paragraph now says every computer needs a paid plan. Ash may prefer "We'll run it on a computer".
- Hetzner figures: the compare page's EUR 5.49 is the docs.hetzner.com price adjustment figure (excluding VAT and IPv4), which the lane and the reviewer re-read on 21 October 2026. The cost-optimized page's EUR 5.99 includes IPv4. The blog finding sense-blog B4 proposes changing 5.49 to 5.99, which is only right if the wording also changes to "including IPv4".
- HostingCostCalculatorTool still prints "Prices as of September 2026" (RATES.lastVerified 2026-09-24). It was not moved, because only the Hetzner CX23 price was re-checked, not the Vultr, DigitalOcean and Lightsail rows. The compare pages are dated October 2026.
- Agent Zero FAQ question kept: "Does Agent Zero need a paid plan?" still names Agent Zero because it matches how people ask and the answer opens "Yes, on Hivra Cloud, as for every agent." followed by the canonical sentence pair. If Ash wants no agent named next to "paid" at all, change the question to "What does Agent Zero cost on Hivra?" and drop the "Yes, on Hivra Cloud, as for every agent." opener (one line in agent-zero.ts, no test pin).
- lib/compare/directory.ts line 40 and line 83 still say "Paid hosting starts at ..." and "Hivra hosting starts at ..." (true under the policy, not the canonical wording). They were left because the finding rated this cosmetic and the compare pages already state the rule in their body copy. Say so if you want them switched to the canonical sentence.

#### Lane: copy-blog (copy tree)

Blog articles and lib/blog/plan-facts.ts. The canonical sentences are built in plan-facts.ts from ENTRY_PLAN_PRICE and ENTRY_PLAN_SIZE (HOSTED_COMPUTE_NEEDS_PLAN, _SENTENCE, _SHORT and FREE_ACCOUNT_SENTENCE). The finding numbers (B1 to B11) are those of the sense-blog audit.

Status by finding:

- B1 done: no article singles out OpenClaw or Agent Zero as the paid ones, and none reads as if an unpaid Hivra computer exists. The widened SELECTIVE_PAID_PLAN_CLAIMS guard in hosted-compute-copy.test.ts matches the old strings and none of the new ones.
- B2 done: the memory cancellation FAQ promises no roadmap download window. It states the policy and carries the Hermes carve-out. Written for the world with enforcement on.
- B3 done: the cost article's headline, table and FAQs tell one story. The only dollar total kept follows from stated inputs.
- B4 done: every string that quotes a Hetzner CX23, CX33 or CX43 price carries its basis (excluding or before VAT and IPv4) in the same paragraph, answer or snippet. Every page that quotes the price also says Hetzner showed the plans as unavailable in October 2026 and to check stock. Both Hetzner pages were fetched on 21 October 2026 in the first pass (cost-optimised page: CX23 5.99 and CX33 8.99 including IPv4, "currently unavailable"; price-adjustment doc: 5.49, 8.49 and 15.99 excluding IPv4 and VAT, effective 15 June 2026), and a reviewer reconfirmed. No new figure was invented.
- B5 done: the GPT-5.5 retirement is written as past and attributed to OpenAI's page: 14 October 2026, noon PDT (19:00 UTC), from Codex with ChatGPT sign-in. The API and API-key Codex sessions are unaffected. Source fetched on 21 October 2026 (learn.chatgpt.com/docs/pricing).
- B6 done: byo-api-key-explained no longer says every request goes straight to the provider.
- B7 done: the named, unsourced cost anecdotes and the "cut 30 to 40%" lines stay removed. The Reddit 4x and 15x token sentence is softened to rough community figures.
- B8 done: byo-api-key-explained no longer says the total "almost always comes in under" AI SaaS prices and no longer names GPT-5 mini as the cheap OpenAI option.
- B9 done: the money-back guarantee is not sold as a way to try Hivra in any article. A new test fails for any article whose section states the guarantee under a heading with try, test, trial, sample or evaluate.
- B10 done: the doubled "on card payments" qualifier is gone from is-openclaw-free.
- B11 done: Telegram overhead is priced at the Sonnet 5.5 input rate ($2 per million tokens as of October 2026): 15,000 x $2 / 1e6 = $0.03 and 20,000 x $2 / 1e6 = $0.04.
- Haiku re-rate follow-up (seven price articles): done. The Haiku-only monthly totals that were the old estimates scaled by the 10x rate ratio stay removed. The FAQ no longer says its Sonnet, Opus and browser ranges are "at October 2026 rates", since they are not computed from those rates and their volumes are not stated.
- lastModified: done. The 21 articles with changed facts now carry lastModified 2026-10-21, so the visible "Updated" date, Article dateModified and the sitemap match the October 2026 price and date claims beside them. No test or code pins an article's lastModified. Flagged as a house-convention call.
- Report completeness: done. A crossLaneRequests item was added for the agent-catalog minPlan values (see routed-code).

##### /blog/ai-agent-hosting-guide (B1)

- Before: "OpenClaw and Agent Zero need a paid plan. If you're weighing those last two against each other, see [Agent Zero vs OpenClaw hosting](...)."
- After: "If you're weighing OpenClaw against Agent Zero, see [Agent Zero vs OpenClaw hosting](/blog/agent-zero-vs-openclaw-hosting). Every computer that Hivra Cloud runs for you needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM. A free account works with a computer or server you connect yourself."
- Why: The canonical sentences had been inserted between the list of six agents and "those last two", so the pointer no longer clearly meant OpenClaw and Agent Zero. The pointer now names them and comes first, and the canonical sentences close the paragraph.

##### /blog/ai-agent-vps (B1)

- Before: "OpenClaw and Agent Zero need a paid plan."
- After: "Every Hivra Cloud computer needs a paid plan. A free account works with a computer or server you connect yourself."
- Why: Canary refuses every Hivra-hosted launch on a Free account whichever agent it runs. The short form is used because the sentence sits beside the plan maths.

##### /blog/how-to-self-host-openclaw (B1)

- Before: "Hivra hosts both on managed VMs: [OpenClaw itself](/agents/openclaw) on paid plans, and Hermes launched from the dashboard. | managed hosting on Hivra, launched from the dashboard. Hivra also hosts OpenClaw itself on paid plans | ClawHost and Blink Claw host OpenClaw directly, and so does Hivra on paid plans. Hivra also hosts Hermes Agent, which has its own `hermes claw migrate` command"
- After: "Hivra hosts both on managed VMs, each on a paid plan: [OpenClaw itself](/agents/openclaw), and Hermes launched from the dashboard. | managed hosting on Hivra's paid plans, launched from the dashboard. Hivra also hosts OpenClaw itself on the same paid plans | ClawHost and Blink Claw host OpenClaw directly, and so does Hivra, on a paid plan. Hivra also hosts Hermes Agent on the same plans, and Hermes has its own `hermes claw migrate` command"
- Why: "On paid plans" attached only to OpenClaw read as if Hermes were free.

##### /blog/is-openclaw-free-what-it-costs-to-run (B1)

- Before: "Table cell: OpenClaw needs a paid plan at that size | Answers: OpenClaw needs a paid plan, ... | Free hosted plan FAQ: Not on Hivra. OpenClaw needs a paid plan, from $9.99 a month. A machine you already own, or a Pi you buy outright, is the route with no monthly hosting bill."
- After: "Table cell: Every Hivra Cloud computer needs a paid plan; you still bring the model | Answers: Every Hivra Cloud computer needs a paid plan, and OpenClaw's starts at $9.99 a month for 2 vCPU and 4 GB of RAM. | Free hosted plan FAQ: Not on Hivra. Every computer that Hivra Cloud runs for you needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM. A free account works with a computer or server you connect yourself. A machine you already own, or a Pi you buy outright, is the route with no monthly hosting bill."
- Why: The same selective claim, and the FAQ hard-coded "$9.99" with no size. It is now interpolated with its size, and says what a free account does include.

##### /blog/openclaw-broken-after-update (B1)

- Before: "Line 71: It needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM. | FAQ 'Is there a way to run OpenClaw without running the server myself?': Hivra runs the open-source OpenClaw agent on a private managed VM with the server side handled for you, on paid plans from $9.99 a month for 2 vCPU and 4 GB of RAM."
- After: "Line 71: Every Hivra Cloud computer needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM. | FAQ: Hivra runs the open-source OpenClaw agent on a private managed VM with the server side handled for you. Every Hivra Cloud computer needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM."
- Why: The first pass fixed line 71 only. The FAQ (shipped as JSON-LD) still attached the paid-plan fact to OpenClaw alone.

##### /blog/agent-zero-vs-openclaw-hosting (B1)

- Before: "Hivra. Both agents need a paid plan, from $9.99 a month"
- After: "Hivra. Every Hivra Cloud computer needs a paid plan, whichever agent runs on it, from $9.99 a month"
- Why: The same selective claim.

##### /blog/run-ai-agents-24-7 and /blog/claude-code-vs-codex-24-7 (B1)

- Before: "run-ai-agents-24-7 table: Always-on compute | ... | Yes | Yes, on paid plans | | claude-code-vs-codex-24-7: that comes from the host (included with paid plans on Hivra)"
- After: "run-ai-agents-24-7 table: ... | Yes | Yes | | claude-code-vs-codex-24-7: that comes from the host (included on every Hivra Cloud computer)"
- Why: Both read as if a Hivra computer without the feature exists on a non-paid plan. Every Hivra Cloud computer is paid, so the qualifier says nothing and misleads.

##### /blog/persistent-memory-explained, FAQ and FAQPage JSON-LD (B2)

- Before: "(A grace window to download after cancellation is on the roadmap; for now, take your export while you're still subscribed.)"
- After: "Every Hivra Cloud computer needs a paid plan. Except for Hermes agents, which follow an older process that the Terms describe, the computer is stopped when a plan ends or when a card payment is still unpaid after the retries. Its files are kept for a limited time so that you can start it again once you have paid, and Hivra emails you before anything is deleted. Hivra does not promise how long that time is or that the files are backed up, so keep your own export. The Terms set out what happens then."
- Why: The roadmap has no such item and no window length is decided. The text states the policy and matches the copy-tree Terms items. The Hermes carve-out was added after review: the Terms put Hermes agents on an older process, and the answer opens with a Hermes agent's memory files. Written for the world with enforcement on.

##### /blog/cost-of-running-ai-agent (B3)

- Before: "shortAnswer: A persistent AI agent costs a server, tokens and your time. A minimal self-hosted setup is a Hetzner server from €5.49 a month, a small token bill and 1 to 2 hours of upkeep, worth $50 to $100 at $50 an hour. | (original, first pass: A minimal self-hosted setup is about $10-17 a month in cash, or $60-117 once you count maintenance at $50 an hour.) | Table row: $1 or less of Haiku tokens ... $7 to $8 | $57 to $108 | FAQ: That's $7 to $8 a month ... | FAQ: costs at least $8 to $15 a month, server and tokens included."
- After: "shortAnswer: A minimal self-hosted agent costs a Hetzner server from €5.49 a month before VAT and IPv4, a small token bill and at least 1 to 2 hours of upkeep a month, or $50 to $100 at $50 an hour. Hivra is $9.99 a month for 2 vCPU and 4 GB of RAM, plus about $4-20 in tokens. | Table row: a small bill for Haiku tokens ... €5.49 for the server, plus the tokens | The same, plus $50 to $100 of your time | FAQ: The server is the fixed part of the bill, the Haiku tokens are small, and the setup is yours to do. | FAQ: a Hetzner CX23 is €5.49 a month excluding VAT and IPv4, and the tokens come on top."
- Why: The headline, table and FAQs gave three different minimums, and the table's $7 to $8 rested on "$1 or less of Haiku tokens", a figure scaled by the 10x rate ratio with no stated token volume. Only $50 to $100 follows from stated inputs. After review the hours are labelled as the article's own estimate ("at least", matching its time section) and the headline carries the VAT and IPv4 basis. The lead sentence was shortened to stay within 60 words.

##### /blog/cost-of-running-ai-agent and /blog/byo-api-key-explained, Haiku totals (Haiku re-rate)

- Before: "cost: Haiku token figures are the exception: they use the Haiku 5.5 rates above. | cost: usually spends about $1 a month on tokens or less. | byo: usually spends a dollar or so a month."
- After: "cost: The Haiku-only part of these ranges falls to roughly a tenth, because the Haiku rate is a tenth of what it was. | cost: At April 2026 Haiku prices, a lean setup ... usually spent $3 to $8 a month on tokens, and that Haiku-only part is now roughly a tenth of it. | byo: An agent running 10 to 30 scheduled tasks a day on Haiku usually spent $3 to $12 a month at April 2026 prices, and the Haiku rate is now a tenth of what it was, so that Haiku-only range falls to roughly a tenth."
- Why: The "about $1 a month" and "a dollar or so" totals were the articles' own April ranges scaled by the price ratio, on token volumes the articles never state. The sourced rates and the stated ratio are kept, and the new monthly total is removed.

##### /blog/ai-agent-api-cost-optimization (Haiku re-rate)

- Before: "Haiku 5.5 ... under $1/month. ... Total API: $8-19/month. Full stack: about $18-29/month for a persistent agent on that host size. | FAQ: (5 to 7 scheduled tasks, mixed Haiku and Sonnet at October 2026 rates): ... $8-19/month in API tokens plus $9.99/month ... = $18-29/month total. ... Full range: about $25-62/month for a fully operational persistent agent."
- After: "Weekly research tasks on Sonnet 5.5: $5-10/month. Occasional complex reasoning on Opus 5.5: $3-8/month. Competitive monitoring and daily summaries go on Haiku 5.5, using half-price batching where a task can wait ($0.05/$0.25 per MTok). Haiku 5.5's rate is a tenth of what Haiku 4.5's was, so the Haiku line is the small one. The token volumes behind these ranges are not stated, so there is no monthly total here: add the host, which is $9.99/month on Hivra for 2 vCPU and 4 GB of RAM, to the lines you expect to use. | FAQ: As an illustration, not a measurement (5 to 7 scheduled tasks, mixed Haiku and Sonnet): Sonnet research tasks $5-10/month and occasional Opus reasoning $3-8/month, with the Haiku part small ... No monthly total is given, because the token volumes behind these ranges are not stated."
- Why: Those totals mixed the scaled Haiku line with Sonnet and Opus ranges whose volumes the article does not state. After review the FAQ no longer dates those ranges "at October 2026 rates", since they are not computed from the rate card. The worked table (stated 4.8M input, 1.2M output tokens) is unchanged.

##### /blog/best-vps-for-hermes-agent, metaDescription, intro, shortAnswer, paragraphs, FAQs (B4)

- Before: "metaDescription: Hetzner CX33 (4 vCPU, 8GB, €8.49/month ex VAT) is the recommended VPS for Hermes Agent. Specs and prices for Hetzner, OVH, DigitalOcean and Vultr. | intro: and at €5.49/month you can afford one. | shortAnswer: ... The CX33 (4 vCPU, 8GB RAM, 80GB NVMe, €8.49/month excluding VAT and IPv4) is the recommended tier, and the CX23 (2 vCPU, 4GB RAM, 40GB NVMe) is the minimum. OVH's VPS-2 undercuts the CX33 slightly. ... | CX33 paragraph: The CX33 at €8.49/month is the recommended tier. | DigitalOcean paragraph: versus Hetzner's €8.49, the gap | CX43: Hetzner CX43 (16GB, €15.99/month) handles | FAQ cheapest: ... This is the community-consensus minimum. Below 4GB RAM | FAQ Hetzner or DigitalOcean: The CX33 (4 vCPU, 8GB, €8.49/month) costs about a fifth"
- After: "metaDescription: Hetzner CX33 (4 vCPU, 8GB, €8.49/month before VAT and IPv4) is the recommended VPS for Hermes Agent. Specs and prices for four providers. | intro: and from €5.49/month (before VAT and IPv4) you can afford one. | shortAnswer: ... The CX33 (4 vCPU, 8GB RAM, €8.49/month excluding VAT and IPv4) is the recommended tier and the CX23 (2 vCPU, 4GB RAM) the minimum, but Hetzner showed both as unavailable in October 2026, so check stock. OVH's VPS-2 undercuts the CX33 slightly. ... | CX33 paragraph: The CX33 at €8.49/month (excluding VAT and IPv4) is the recommended tier. | DigitalOcean paragraph: versus Hetzner's €8.49 (excluding VAT and IPv4), the gap | CX43: Hetzner CX43 (16GB, €15.99/month excluding VAT and IPv4) handles | FAQ cheapest: ... This is the community-consensus minimum, though Hetzner showed the CX23 as unavailable in October 2026, so check stock. Below 4GB RAM | FAQ Hetzner or DigitalOcean: The CX33 (4 vCPU, 8GB, €8.49/month excluding VAT and IPv4) costs about a fifth"
- Why: The first pass checked the basis once per page, so one compliant sentence let a metaDescription (search snippet) and two FAQ answers (JSON-LD) ship a bare price. The headline recommended an unavailable plan with no stock note. The facts are Hetzner's own figures fetched on 21 October 2026. The shortAnswer stays at 57 words and the metaDescription at 137 characters.

##### /blog/how-to-self-host-hermes-agent (B4)

- Before: "Hetzner's CX23 at €5.49/month excluding VAT and IPv4 is the community budget option many people quote. | Server cost: a CX23-class VPS around €5.49/month excluding VAT. LLM API | FAQ: Hetzner CX23 at €5.49/month excluding VAT (2 vCPU, 4 GB RAM). ... Re-check the vendor page before you pay."
- After: "... many people quote, though Hetzner showed it as unavailable in October 2026, so check stock. | ... around €5.49/month excluding VAT and IPv4. LLM API | FAQ: Hetzner CX23 at €5.49/month excluding VAT and IPv4 (2 vCPU, 4 GB RAM). ... Re-check the vendor page before you pay: Hetzner showed this plan as unavailable in October 2026."
- Why: Two prices carried "excluding VAT" only, and a page that recommends the CX23 gave no stock note.

##### /blog/how-to-self-host-openclaw, self-hosting-hermes-guide, what-is-hermes-agent, agent-zero-vs-openclaw-hosting and ai-agent-vps (B4)

- Before: "how-to-self-host-openclaw: ..., both excluding VAT and IPv4, are the community-recommended budget options. | self-hosting-hermes-guide: ... is the one to get if you'll use browser automation. DigitalOcean's ... | ... makes Hetzner's CX23 at €5.49/month (before VAT and IPv4) the realistic minimum. | what-is-hermes-agent FAQ: the CX23, is €5.49/month excluding VAT and IPv4. Hosting services like Hivra | agent-zero-vs-openclaw-hosting: ... to $20-24 at Vultr, Linode, or DigitalOcean. Add your time: | ai-agent-vps: and that page showed both plans as unavailable, so check stock"
- After: "how-to-self-host-openclaw: ... community-recommended budget options. Hetzner showed both as unavailable in October 2026, so check stock first. | self-hosting-hermes-guide: ... browser automation. Hetzner showed both as unavailable in October 2026, so check stock. DigitalOcean's ... | ... the realistic minimum, though Hetzner showed it as unavailable in October 2026, so check stock. | what-is-hermes-agent FAQ: ... excluding VAT and IPv4, though Hetzner showed it as unavailable in October 2026, so check stock. Hosting services like Hivra | agent-zero-vs-openclaw-hosting: ... DigitalOcean. Hetzner showed the CX23 and CX33 as unavailable in October 2026, so check stock. Add your time: | ai-agent-vps: ... as unavailable in October 2026, so check stock"
- Why: These pages quote or recommend the plans Hetzner's page showed as unavailable, with no stock note. One short clause each, and no new price.

##### /blog/cost-of-running-ai-agent, headline (B4)

- Before: "a Hetzner server from €5.49 a month"
- After: "a Hetzner server from €5.49 a month before VAT and IPv4"
- Why: The headline answer (also the FAQPage lead) gave a price with no basis. See the B3 entry for the full sentence.

##### /blog/codex-pricing-by-chatgpt-plan, body and FAQ (B5)

- Before: "Third, GPT-5.5 retires on 14 October 2026. OpenAI's pricing and speed pages say GPT-5.5 leaves ChatGPT, ChatGPT Work and Codex on all plans that day. The OpenAI API is not affected. | Q: When does GPT-5.5 leave Codex?"
- After: "Third, the GPT-5.5 retirement date has passed. OpenAI's pricing and speed pages give 14 October 2026, at noon PDT (19:00 UTC), as the date GPT-5.5 retires from Codex with ChatGPT sign-in, so check the model picker for what your plan offers now. The OpenAI API and Codex sessions that use an API key are not affected. | Q: When was GPT-5.5 due to leave Codex?"
- Why: It was seven days past the date and written as future, in the FAQ JSON-LD too. The claim was narrowed to what OpenAI's page says (Codex with ChatGPT sign-in).

##### /blog/byo-api-key-explained, shortAnswer, intro, paragraph and privacy paragraph (B6)

- Before: "shortAnswer: ...and your prompts don't pass through a Hivra proxy. | intro: Requests go straight from the agent to the model provider, and the provider sends you the bill. Hivra isn't in that loop. | paragraph: That's how Hivra works: you pay Hivra for managed hosting and the dashboard, from $9.99/month for 2 vCPU and 4 GB of RAM, and every AI request your agent makes goes straight to the provider. ... Hivra also sells managed Venice credits. | privacy: ...don't pass through a Hivra proxy or a Hivra-owned key. They aren't invisible"
- After: "shortAnswer: ...and with your own key your prompts don't pass through a Hivra proxy. | intro: With your own credentials, requests go straight from the agent to the model provider, and the provider sends you the bill. Hivra isn't in that loop. | paragraph: That's how Hivra works when you bring your own key or login: you pay Hivra for managed hosting and the dashboard, from $9.99/month for 2 vCPU and 4 GB of RAM, and the requests your agent makes with that key or login go straight to the provider. ... Hivra also sells managed Venice credits, and those requests do pass through Hivra. | privacy: ...don't pass through a Hivra proxy or a Hivra-owned key (managed Venice credits are the exception: those requests do pass through Hivra). They aren't invisible"
- Why: Managed Venice credit requests go through Hivra's own managed-venice routes, so the unqualified claims were false. The earlier record said the intro was qualified, but it was the shortAnswer. The intro is qualified this round. The tagline ("Bring your own key and ... no Hivra proxy in between") already states its condition and is unchanged.

##### /blog/ai-agent-api-cost-optimization, anecdotes (B7)

- Before: "Section 'What do real developers actually spend?' (Ari Vance $847.32 to $159, Helen Mireille $560 a month, r/AI_Agents figures) | In the write-ups above, this one change cut 30 to 40% of the bill. Nothing else comes close. | That was 22% of Vance's savings. | A Reddit r/AI_Agents thread tracking this precisely found agents use approximately 4x more tokens ... about 15x."
- After: "Section removed. | On the worked table above, moving the same 600 runs from Sonnet 5.5 to Haiku 5.5 takes the month from about $22 to about $1, so sending the work that suits Haiku there is the biggest single lever. | (sentence removed) | One Reddit r/AI_Agents thread reported agents using approximately 4x more tokens ... and multi-agent setups about 15x. Treat those as rough community figures, not measurements."
- Why: No source for any named person, and the 30 to 40% line did not follow from the anecdotes. The replacement is recomputed from the article's own stated inputs (20 runs a day for 30 days, 8,000 input and 2,000 output tokens, so $21.60 to $1.08).

##### /blog/byo-api-key-explained, cost paragraph and OpenAI paragraph (B8)

- Before: "On OpenAI, GPT-5 mini at $0.25 in and $2 out is a cheap, capable option. Add Hivra hosting to your own API spend and the total almost always comes in under what AI SaaS products charge for the same work, because they stack their margin on top of the same provider prices. | OpenAI's API gives you GPT-5 and GPT-5 mini. Mini, at $0.25 in and $2 out, makes sense when you run lots of small tasks and the cost per request adds up."
- After: "On OpenAI, gpt-6-luna at $0.10 in and $0.50 out is the cheapest of its latest models as of October 2026, and GPT-5 mini ($0.25 in, $2 out) is still listed with its older models. Add Hivra hosting to your own API spend and you have the whole bill, with no Hivra markup on your own key. AI SaaS products add their margin on top of the same provider prices. | OpenAI's API lists gpt-6-luna, gpt-6.1-sol and gpt-6-astra as its latest models, and GPT-5 and GPT-5 mini are still on the price list. gpt-6-luna, at $0.10 in and $0.50 out, makes sense when you run lots of small tasks and the cost per request adds up."
- Why: "Almost always cheaper" was an unmeasured comparison with unnamed products, and GPT-5 mini is no longer OpenAI's cheap option. The earlier record listed only the first change, and both are recorded now. The rates match the OpenAI table in ai-agent-api-cost-optimization, and the reviewer confirmed gpt-6-luna, gpt-6.1-sol and gpt-6-astra sit under latest models on OpenAI's pricing page.

##### /blog/do-you-need-a-gpu-to-run-an-ai-agent, run-ai-agents-24-7, agent-zero-vs-openclaw-hosting, is-it-safe-to-leave-an-ai-agent-running-unattended and managed-vs-self-hosted-ai-agents (B9)

- Before: "they come with a 7-day money-back guarantee on card payments, so you can try one agent without buying hardware. | ..., so you can test the loop end to end. | Heading: Running both, and the fastest way to try either one | If the agent does not earn its keep, delete its computer. | Heading: Try it with the boundaries already built | the managed route is easy to evaluate: ... and see whether a computer you don't have to administer fits how you work."
- After: "...and they come with a 7-day money-back guarantee on card payments. There is no hardware to buy. | (clause removed) | Heading: Running both, and skipping the setup | If you stop using an agent, delete its computer to free its share of the plan. | Heading: Run it with the boundaries already built | the managed route is the one to look at: ... and you have a computer you don't have to administer."
- Why: Policy is no trials. Wording that says the guarantee exists so you can try or test turns it into a pay-then-refund trial.

##### /blog/managed-vs-self-hosted-ai-agents and /blog/claude-code-vs-codex-24-7, headings (B9)

- Before: "managed-vs-self-hosted: heading 'Try the managed side' | claude-code-vs-codex-24-7: heading 'Try the comparison on your own backlog'; 'sign in with the subscription you already have, and hand it a real task from this week's list.'"
- After: "managed-vs-self-hosted: heading 'What the managed route looks like' | claude-code-vs-codex-24-7: heading 'Run the comparison on your own backlog'; '... sign in with the subscription you already have, and give it a task from this week's list.'"
- Why: Each heading sat directly above a paragraph that states the money-back guarantee, so the guarantee was still framed as a way to try Hivra. Both reviewers found them. The first pass renamed only sibling headings.

##### /blog/is-openclaw-free-what-it-costs-to-run (B10)

- Before: "Paid plans aren't paused for inactivity, and card payments come with a 7-day money-back guarantee on card payments. | Card payments come with a 7-day money-back guarantee on card payments."
- After: "Paid plans aren't paused for inactivity, and they come with a 7-day money-back guarantee on card payments. | Paid plans come with a 7-day money-back guarantee on card payments."
- Why: The constant already ends "on card payments", so the qualifier was said twice.

##### /blog/hermes-agent-telegram-discord-setup (B11)

- Before: "At Sonnet 4.6 pricing, that is approximately $0.03-0.06 per message in overhead alone."
- After: "At Sonnet 5.5 input pricing ($2 per million tokens, as of October 2026), that is roughly $0.03 to $0.04 per message in overhead alone."
- Why: $0.03 only matches $2 per million, and every other cost article uses Sonnet 5.5. 15,000 to 20,000 tokens at $2 per million is $0.03 to $0.04.

##### 21 blog articles, lastModified (review)

- Before: "lastModified 2026-09-30, 2026-10-05, 2026-10-06, 2026-10-14 (or equal to publishedDate on codex-pricing and is-openclaw-free)"
- After: "lastModified 2026-10-21 on all 21"
- Why: The visible "Updated" date, Article dateModified and the sitemap understated edits that re-date prices to October 2026 and add a 14 October date. On codex-pricing-by-chatgpt-plan and is-openclaw-free the page now shows an "Updated" label because lastModified differs from publishedDate.

Flags:

- Copy and switch must ship together. The memory FAQ says the computer "is stopped" and that Hivra emails before anything is deleted. Both are true only once HIVRA_LAPSE_ENFORCE_LIVE is on, the stop email exists, and a pre-deletion email exists for Hivra computers. Per the lapse design plan step 10, the delete sweep for hivra_agents is a later PR. Recommended: do not publish this blog branch to a host where the switch is off, or keep the "emails you before anything is deleted" sentence tied to that later change landing.
- Hermes agents: the FAQ now says Hermes agents follow an older process described in the Terms. That is only as true as the Terms item (app/terms/page.tsx, copy-legal). If copy-legal changes or drops the "Hermes Agents" item, change the FAQ's carve-out with it.
- Hetzner: the blog still names the CX33 as the recommended tier and the CX23 as the minimum, but Hetzner's own page showed both unavailable on 21 October 2026. Every page that quotes the price now says so and to check stock. Whether Hetzner stays the headline recommendation, or the blog switches provider, is Ash's call. Recommended: keep it, re-read Hetzner's page before launch, and update the "unavailable in October 2026" sentences (a test pins them on every page that quotes 5.49 or 8.49) if stock returns.
- lastModified was set to 2026-10-21 on 21 articles. No test or code pins it and the previous pass left it alone, so this is a house-convention call. Recommended: keep it, because it drives the visible "Updated" date, dateModified and the sitemap. Revert only if Ash wants dates to move on content passes, not copy passes.
- The cost articles still carry April 2026 monthly ranges ($3 to $12, $3 to $8, $20-50, $60-120, $4 to $20 of tokens, $5-20 and similar) that no source in the repo can refresh. cost-of-running says they were not recalculated, but byo-api-key-explained and a few others rely on the dated wording only. Recommended: rework them from stated token volumes in a later pass, or leave them labelled as is.
- Code and copy: agent-catalog.ts still lists Hermes, Claude Code, Codex, Aeon and linux-terminal as minPlan "free", while the launch gate (resource-gate.ts) refuses a Free account for every Hivra-hosted type. Routed-code has since added a comment at canLaunchAgent saying the catalog does not decide hosted access. Not a blog issue. See routed-code.

#### Lane: routed-code (code tree)

Edits other lanes asked for in code-tree files. Checks: copy scan 0 dash hits, tsc clean, eslint 0 errors on all touched files (5 old warnings), jest green on every touched or neighbouring suite (about 160 suites, including user-copy-vocabulary, static-copy-safety, llms-txt, launch page, get-started, stripe-webhook and token-tier-eligibility).

Applied:

- change-plan/route.ts: DOWNGRADE_UNAVAILABLE_MESSAGE and the move-to-free string reworded (see the entries below). The test pin and the stale doc comment were updated. info@hivra.cloud is the existing SUPPORT_EMAIL.
- instances/[id]/route.ts: the 402 text was replaced.
- agent-start-failure.ts: the userMessage was replaced. No test pinned it.
- launch-plan.ts: the payment_overdue message was replaced. It is true because readPlanOnHold only returns payment_overdue after the 48 hour grace is over. Three test pins were updated (launch-plan.test.ts and two in LaunchJourney.first-run.test.tsx).
- instance-service.ts: the past_due message names the window from PAYMENT_GRACE_HOURS, and the no-entitlement branch says the plan is on hold when readPlanOnHold finds a payment_overdue row (not for workspace_cloud). One test was added for the on-hold branch and one assertion for the grace hours. Message only, no behaviour change.
- LaunchJourney OpenClaw tile description, agent-catalog OpenClaw tagline, badge "Always-on" to "Messaging" (the badge has no readers), and the i18n English planGuidance.operator were reworded. No test pinned any of them.
- dunning.ts: the payment-failed email now goes out from the first failed attempt. The MIN_ATTEMPT_COUNT gate and the "first_attempt" skip reason were removed instead of setting the constant to 1 (same behaviour, no dead constant). It is safe because handlePaymentFailed only reaches the email for a row already bound to that subscription, and the ledger still dedupes per invoice.
- Remaining free-agent prompts reworded to paid-plan wording: instances/[id]/page.tsx wake banner and button, agent/[id]/page.tsx browser lock, instances/[id]/cron/route.ts, and MemoryUsageBanner body (title "Out of RAM on the free plan" kept, because tests pin it). Two agent page tests were updated.
- activity-retention.ts: comments now say the Privacy page promises records for as long as the computer exists, not 90 days. Comment only.
- token-tier-eligibility.ts comment now says 24 hours. The instance-entitlement.ts header note was corrected: the evaluator sets currently_eligible = false at the breach, so the resolver does not count a tier inside its grace.
- DECISION taken (the "decide" part of the request): honour the 24 hour token grace in the lapse check only, not in the shared resolver, because changing the resolver would change launch gating for every customer and break the ship-dark rule. hasTokenTierInGrace(userId) in instance-entitlement.ts (unsuspended row, last_breach_at newer than now minus 24 hours, the same cut-off as the evaluator's suspend step, throws on a read error) is called from ownerHasNoPaidPlan in lapse-gate.ts, so the sweep and the Start gate both wait for the grace the breach email promises. An unreadable row means "treat as paid". Tests: 3 new lapse-gate cases, 3 helper tests, and mock factories in two other lapse tests extended.
- agent-catalog.ts: took the option of no longer describing minPlan as a plan floor. The JSDoc on minPlan and a note on canLaunchAgent (which no app code calls) now say every Hivra Cloud computer needs a paid plan and resource-gate.ts decides. A LaunchJourney comment was made non-selective. Line 250 (Linux Sandbox) was correct as "free", because it only runs on a server the owner connected.

Skipped:

- plans.ts, remove "Future marketplace access" and "Email support (48 hr)": already gone in the code tree (an earlier uncommitted edit removed both). Command still lists "1-click deploy from prompt library", "Priority infrastructure support (24 hr)" and "1:1 dedicated support (first 14 days)", also unbacked, but Command is not in ACTIVE_PLAN_KEYS so no card shows them.
- plans.ts, decide the display names Pro and Power (F7): Ash's decision, left as is. Consequence stated by the lane: the new on-hold and plan-guidance wording avoids the plan name, but launch tiles still read "Pro plan on hold" and "Needs Pro".
- instance-service.ts, 'Active subscription required' on a non-active, non-past_due status: not applicable, because sub is non-null there and readPlanOnHold is only meaningful when the resolver returned null. Only the !sub branch got the on-hold branch.
- agent-catalog.ts, set minPlan on Hermes, Claude Code, Codex and Aeon to the entry paid tier: not done, because the doc option was taken. The values drive nothing for a Free account (hivraCloudFit and resource-gate refuse it whatever minPlan says), but the code tree's agent-seo-catalog.test.ts still derives "needs a paid plan" from minPlan, so raising them would fail it and force edits to SEO copy the blog lane owns. The copy tree's version of that test no longer reads minPlan. Once merged, raising the four to "pro" is a safe follow-up.

##### Token tier grace in the lapse check (lib/hivra/lapse-gate.ts)

- Before: "Policy text: a token tier is stopped after 48 hours lost. Code: the evaluator sets currently_eligible = false at the breach and the resolver counts only true, so the sweep would have stopped a token holder's computer within about 15 minutes of the breach."
- After: "The lapse check also treats an unsuspended token tier whose breach is under 24 hours old (REQUALIFICATION_GRACE_HOURS) as paid, so the stop comes after the 24 hour grace the breach email promises. The shared resolver is unchanged."
- Why: The real grace is 24 hours (shortened from 48 on 2026-04-30), not the 48 in the policy text or the old comments. Flag for Ash: the production token-holder population is unknown (Canary has 0 token rows).

##### Dunning email timing (lib/billing/dunning.ts)

- Before: "Payment-failed email sent only from the second failed attempt (silent first attempt)."
- After: "Sent from the first failed attempt, once per invoice. The first_attempt skip reason no longer exists."
- Why: The email promises 48 hours from the first failed payment, and Stripe's second attempt can land after that. Flag for Ash: the email is still gated by HERMES_DUNNING_EMAIL_ENABLED (default off), a second switch to flip together with HIVRA_LAPSE_ENFORCE_LIVE.

##### Downgrade rejection (POST /api/billing/change-plan)

- Before: "Plan downgrades are not available due to dedicated server infrastructure ... cancel your subscription and re-subscribe, note this will remove your current server."
- After: "Moving to a smaller plan isn't available yet. You can upgrade any time, or email info@hivra.cloud and we'll help."
- Why: Cancelling stops the computer and keeps its files. It does not remove it.

##### Move to free from change-plan (POST /api/billing/change-plan)

- Before: "To move to the Free plan, cancel your subscription instead [dash] in-place plan changes only switch between paid tiers."
- After: "To move to the free account, cancel your subscription instead. In-place plan changes only switch between paid plans."
- Why: Free account wording and no dash.

##### Hermes-lane start refusal (POST /api/instances/[id], 402)

- Before: "Compute is suspended until billing or token eligibility is restored."
- After: "This agent is suspended because a payment didn't go through or your plan ended. Pay the open invoice, update your card or choose a plan in Billing, then start it again."
- Why: "Token eligibility" is jargon. The new text says only what is true.

##### Start refusal for any 402 (describeAgentStartFailure, Manage and Launch)

- Before: "Compute is suspended for this agent. Open Billing to restore eligibility before starting it again."
- After: "This computer cannot be started until a paid plan is active. Open Billing to pay or choose a plan, then press Start again."
- Why: This is also the text a customer sees for the new Hivra Start refusal.

##### Plan on hold message (launch screen, payment_overdue)

- Before: "Your {plan name} plan is on hold because a payment didn't go through. Update your payment in Billing ..."
- After: "Your plan is on hold because a payment didn't go through, so your Hivra Cloud computers are stopped. Update your payment in Billing ..."
- Why: It says what happens to the computers. True only once enforcement is live, which is the world this copy is written for.

##### Hermes-lane launch refusals (InstanceService.createInstance)

- Before: "past_due: '... your existing agents keep running during the grace period.' No-plan: 'Active subscription required. Choose a plan ...' even for a lapsed payer."
- After: "past_due names the window ('keep running for up to 48 hours after the first failed payment', from PAYMENT_GRACE_HOURS). A payment_overdue hold now says 'Your plan is on hold because a payment didn't go through. Update your payment in Billing to launch a computer.'"
- Why: "The grace period" was never defined, and a lapsed payer was told to choose a plan they already have. It uses "computer" as the request specified, in the Hermes agent lane. Wording only.

##### OpenClaw and plan guidance wording (launch tile, agent catalog, get-started plan guidance in English)

- Before: "An always-on agent ...; badge Always-on; 'Pro is best for solo builders ... your agent stays always-on'."
- After: "An agent you reach from your messaging apps. On a Hivra Cloud computer it keeps running when your laptop is closed.; tagline 'On a computer that stays on, set it once and it runs.'; badge Messaging; 'Hivra Cloud is best for solo builders and daily drivers. Hivra runs a computer that stays on ...'"
- Why: Only the computer is kept on, not the agent, and the Pro name is removed. Other locales in i18n.ts, the "Always-on agent" eyebrow in welcome-agent-catalog.ts and agent-seo-catalog.ts line 387 still say "always-on agent" (flagged, not in the request).

##### Free-agent upgrade prompts (instance wake banner, agent browser lock, scheduled task limit, memory banner)

- Before: "Free agents sleep after a few idle days, Upgrade to Pro to keep it always-on / Upgrade to Pro or above to enable the live browser / Free includes one standing task. Upgrade to Pro to run more. / Upgrade to Pro for several times the memory."
- After: "{name} was paused after a few idle days ... A paid plan keeps the computer running (See plans) / The live browser needs a paid plan. (See plans) / The free account includes one standing task. See plans in Billing to run more. / ... A paid plan has several times the memory."
- Why: The same paid-plan wording as the four prompts fixed by lapse-ui: no Pro name, no free hosted agent that sleeps. The memory banner title "Out of RAM on the free plan" was kept (tests pin it).

##### Privacy retention comment (lib/ops/activity-retention.ts, comment only)

- Before: "Policy matches the Privacy Policy section 7, promises up to 90 days."
- After: "The page says records are kept as long as the computer exists. 90 days is only this job's clamp."
- Why: It matches the rewritten Privacy page (flag F12).

#### Lane: routed-copy (copy tree)

Applied:

- Ecosystem map (copy-core and copy-system, two overlapping requests, one edit): the Agent Computers paragraph is built from HOSTED_COMPUTE_NEEDS_PLAN_SHORT and FREE_ACCOUNT_SENTENCE, imported from lib/blog/plan-facts. The copy-core wording was picked because it uses the canonical constants. The copy-system wording ("your own computer or server") was not used. The header comment now records that this one sentence departs from Ash's 05-ecosystem.md.
- subscription/plans.ts (copy-core): "Future marketplace access" and "Email support (48 hr)" were removed from the fleet (larger) plan, and the repeated "Future marketplace access" from the command plan. Plan keys, Stripe ids and the other bullets are untouched. These bullets fed the signed-in billing plan cards via planCardFeatures.
- og-meta.ts (copy-system): OG_IMAGE.status.alt now matches the already-changed status share card.
- LaunchJourney.tsx (copy-blog): the stale selective comment was replaced with the same two-line comment the code tree already uses. Comment only. The claim is true in this tree (line 1431 refuses a Free plan for any hivra-managed destination, separate from managedPaidRequired).
- i18n "Upgrade-only plans" (copy-legal): the record says the " · Upgrade-only plans" half was removed from the English billing switcher guarantee (i18n.ts:518) and the zh-CN equivalent (i18n.ts:1065), and that the i18n test was pinned to plain MONEY_BACK_GUARANTEE. CONFLICT: the files read in this tree today still carry the upgrade-only half in both (line 518 "7-day money-back guarantee on card payments · Upgrade-only plans", line 1065 "银行卡付款享 7 天退款保证 · 仅支持升级"), and i18n.test.ts line 395 pins the English strip to `${MONEY_BACK_GUARANTEE} · Upgrade-only plans`. That matches the copy-system repair record, which restored the half. The final state is the restored one. Nothing renders these strings today. See "Still Ash's call".

Skipped:

- Hetzner prices (copy-product request, sense-blog B4: do not mix EUR 5.49 and 8.49 with 5.99 and 8.99): a guard, not a change, and nothing needed doing. Every blog price is EUR 5.49 or 8.49 worded "excluding VAT and IPv4" or "before VAT and IPv4", and 5.99 and 8.99 appear only labelled "with IPv4". The compare page pins EUR 5.49 "before VAT and a public IPv4 address" and USD 6.49, the same basis. One loose spot left as is: best-vps-for-hermes-agent.ts line 9 (metaDescription) said "8.49/month ex VAT" without IPv4. It is true, and adding " and IPv4" risked the meta-description length limit. (Copy-blog has since changed that line to "before VAT and IPv4", see its lane.)
- plan-facts.ts (copy-product request): keep exporting HOSTED_COMPUTE_NEEDS_PLAN, _SENTENCE, _SHORT and FREE_ACCOUNT_SENTENCE with current text. Already satisfied, so no edit. All four are exported with unchanged text, and ecosystem-map.ts now imports two of them.

##### Ecosystem map, Agent Computers paragraph (/ecosystem and /roadmap, and llms.txt which reads the same module)

- Before: "Which desktops, operating systems and agents are available depends on the deployment option, and some require a paid Hivra Cloud plan."
- After: "Which desktops, operating systems and agents are available depends on the deployment option. Every Hivra Cloud computer needs a paid plan. A free account works with a computer or server you connect yourself."
- Why: "Some require a paid plan" implies the other agents run free on Hivra Cloud, which contradicts the 21 October policy that every Hivra Cloud computer is paid. The rest of the paragraph is Ash's 05-ecosystem.md word for word, and this sentence departs from it. The wording is the canonical short form plus the free-account sentence, as two sentences, not the single joined sentence copy-core suggested. Needs Ash's nod.

##### Plan bullets, larger and Command plans (signed-in Billing Plans tab via planCardFeatures, and any non-English sign-up path that reads PLANS features)

- Before: "Power plan bullets included 'Future marketplace access' and 'Email support (48 hr)'. Command plan included 'Future marketplace access'."
- After: "Those bullets are gone. Power shows 'Everything in Pro', 'Burst CPU when capacity allows' and 'Priority scheduling'."
- Why: They sell an unshipped marketplace and an unbacked 48 hour support promise. The English sign-up card already dropped them via plan-card-copy.ts. The copy tree's Command specs still read "10 vCPU total" and "56GB total". The code tree corrected them to 8 vCPU and 16GB (lapse-ui F18). Command is delisted.

##### i18n switcher guarantee, English and zh-CN (dashboard.billing.switcher.guarantee; nothing renders it today, only switcher.title is read by billing/page.tsx)

- Before: "7-day money-back guarantee on card payments · Upgrade-only plans (zh-CN: ... · 仅支持升级)"
- After: "7-day money-back guarantee on card payments (zh-CN: 银行卡付款享 7 天退款保证), as recorded. The files today still read as in Before (see the conflict above)."
- Why: "Upgrade-only" is true only while HERMES_SELF_SERVE_DOWNGRADE_ENABLED is unset, and the Terms no longer say it.

##### og-meta status alt (/status share card alt text)

- Before: "Hivra status: live platform health"
- After: "Hivra status: live checks of public pages"
- Why: The status page and its card no longer claim platform health, so the alt text now matches.

#### Lane: gate-repair-copy (copy tree)

The verification gate ran tsc, eslint, 357 jest suites and a render of 73 routes with token surfaces off. Everything passed except one literal forbidden-word hit, which blocked "all green".

##### /blog/what-is-hermes-agent: "snapshots" in the checkpoint sentence

- Before: "v0.5.0 also introduces checkpoint and rollback: before making any file changes, the agent snapshots the working directory, so you can run `/rollback` if something goes wrong."
- After: "v0.5.0 also introduces checkpoint and rollback: before making any file changes, the agent saves a checkpoint of the working directory, so you can run `/rollback` if something goes wrong."
- Why: The gate's token-word scan treats "snapshot" as a token-surface word (the Privacy and homepage tests do the same for viewers with surfaces off). Here it is a verb about the Hermes checkpoint feature, not a token surface, and the sentence was already in HEAD and in origin/canary, so it was not caused by this pass. It was reworded rather than waived, so the next gate run reports zero hits. The claim itself is unchanged (it describes the feature as the article already did) and no guard test pins the old sentence.
- Second gate round: the gate then scanned all 44 blog articles instead of 20 and found "portfolio snapshot" (a finance summary the agent sends) in two more articles, again already in HEAD and in origin/canary and not caused by this pass. Both were reworded, not waived, so the scan reports zero "snapshot" hits in any blog article:
  - /blog/hermes-agent-cron-scheduled-tasks, the daily briefing list. Before: "Portfolio snapshot if you track investments". After: "Portfolio summary if you track investments".
  - /blog/what-can-hermes-agent-actually-do, the scheduled-tasks answer. Before: "a portfolio snapshot pulled from a finance API". After: "your portfolio numbers pulled from a finance API" (a second "summary" in that sentence read badly).
  - /blog/what-can-hermes-agent-actually-do, the finance answer. Before: "Morning portfolio snapshot." After: "Morning portfolio summary."
  - The claim in each is unchanged, so lastModified in both articles was left as it was (2026-09-30 and 2026-10-07): the dates say when the facts were last checked, and nothing was re-checked. No test or guard pins the old wording.
- Other gate items, no repair needed: the tmux cheat sheet row id "log-snapshot" is a tmux term in the page data, not visible copy. The /privacy processors line names Bankr and Venice on purpose (intended exception). The tier names in the Terms billing paragraph are the kept wording of decision L1 and stay Ash's and the solicitor's call (F11). The eslint warning in checkout/canceled/page.tsx comes from window.location.href lines that are already in HEAD.

### 4. Still Ash's call

The eight items Ash asked to see, then the other calls the lanes raised. Each points to the lane section that has the detail.

1. Plan names Pro and Power, across billing and public pages. Pro and Power still print on the Billing plate, plan cards, ChangePlanModal, token tier labels ("Pro tier", "Power tier"), i18n planGuidance.fleet and the Terms page (kept there by decision L1). plans.ts, checkout and the dashboard still use them, so a customer who bought "Hivra Cloud" sees "Pro" afterwards, and "Pro" also means a different size in the public ladder. Routed-code adds that launch tiles still read "Pro plan on hold" and "Needs Pro". Recommended by lapse-ui and copy-system: set the display names once in plans.ts to "Hivra Cloud" and "Hivra Cloud, more room" (keys and Stripe ids stay, Stripe product names to match) and update the test pins in the same change. The token tier labels are a separate token question. The Terms names go last, after the solicitor has seen the rest.
2. Token-holder basic machine. Three questions. (a) Holding the token unlocks a basic hosted computer without a payment (copy-core F16). Ash confirms the token route stays a "bought" entitlement under the no-free-computers rule. Token benefits are Ash's, so copy-system left the tier and the "basic machine" unlock as they were. (b) The policy says a token tier lost for 48 hours, but the code and the breach email use 24 hours (REQUALIFICATION_GRACE_HOURS, shortened from 48 on 2026-04-30). The sweep and the new token text follow 24. Pick one: change the policy text to 24, or change the constant. A related inconsistency: the token email, the wallet UI and the cron use different breach windows (24 vs 48 vs 72 hours today, lapse-ui F15). (c) The token text omits the re-qualification cap (2 per rolling year). Add it only if Ash wants the full rule. The production token-holder population is unknown (Canary has 0 token rows).
3. Trialing mapping. The earlier lapse audit notes that a Stripe "trialing" status counts as entitled (STRIPE_ACCESS_STATUSES), so any legacy card trial keeps a hosted computer. That sits badly with "no trial". Count such rows in the dry run, then decide whether they stay entitled. A past_due row with no grace anchor also never lapses (fail-open by design). Neither was counted, because no database was queried. The same audit found that on Canary all 8 running Hivra computers sit on paid-plan rows with no payer record (no Stripe id, no end date, no Apple, yearly or token record). The resolver treats those as permanent entitlement, so the sweep would never stop them.
4. Changelog freshness. The newest changelog entry is 21 June 2026 and about 728 merges have landed since, including the 7 October end of free hosted computers. Copy-system made the page say so and invented no entries. Ash or the author writes the July to October entries. The RSS feed still reports a June lastBuildDate.
5. The Hermes-lane gaps (policy item 7 leaves them for a follow-up). A Hermes-lane agent is marked suspended and cannot be started, but its VM is only powered off if DUNNING_GRACE_ENFORCE_LIVE=true, which is off when unset, and never for cancelled, unpaid or paused rows. Whether the suspended flag lands at hour 0 or hour 48 is a code decision (lapse-ui F02). Workspace Cloud has no grace cutoff and no stop on cancel (F16). The capacity-pause email still says "wake it anytime", "Waking it up takes one click" and "still fully restorable, any time", because the capacity sweep parks free-tier Hermes agents first and Start still works for them. The earlier audit also found 3 running Hermes rows on a Free account on Canary with no VM identifiers (probably phantom, not checked on the host). The Terms and Pricing say "Except for Hermes agents" for as long as this older lane exists. An optional audit follow-up: extend enforceGraceExpiredComputeStop to also match subscription_canceled rows after the owner's paid period. Recommended: flip DUNNING_GRACE_ENFORCE_LIVE and HERMES_DUNNING_EMAIL_ENABLED together with HIVRA_LAPSE_ENFORCE_LIVE, or accept the gap.
6. The stale-suspended-sweep ladder bug (lapse-ui F04b). stale-suspended-sweep.ts filters status active, so a lapsed or cancelled payer is classed as free and gets the 3 plus 5 day ladder, not the 30 plus 14 day paid ladder, and the cold-retention sweep uses 30 or 60 days for archived rows. A Hermes-lane payer can lose files about 8 days after the plan ends. That is why no cancel dialog or email says files are kept for any length of time. The emails say "deleted in N days" with the real N, so they are true. Recommended: classify any non-free plan row as the long ladder whatever the status, and make purge-expired skip scheduled_for_deletion rows whose owner is still past_due. Ash decides how many days files are kept. The Terms state no number and no copy invents one.
7. Free hosted computers on the production database, which was not queried. Under policy 5 every existing free hosted computer is stopped when the switch goes on, at most 5 per 15 minutes, with no warning email before the stop (the email follows it). Whether any exist on production, and how many, is unknown, because production (the production database) was not queried. Canary has no Free-owned non-deleted Hivra computer row. 7 deleted hivra-managed rows belong to owners now on Free and 48 to owners with no subscription row, so such computers existed before. Ash decides whether a heads-up email goes to that grandfathered cohort first (lapse-core and lapse-ui F05). The Terms sentence that free-tier computers "remain available" is gone from the copy tree.
8. Production census needing his OK. The question "who stopped paying and still has a computer" can only be answered on production. The classification SQL in the audit's db-census record is reusable as written, but production lacks about 68 public tables, so every column must be checked first. Do not infer production's count from Canary's zero. Needs Ash's explicit OK for a read-only production census. Fix the code paths before any production run that would act on the results.

Other calls raised by the lanes:

Before the switch goes on (section 1 lists them):

- Give Ash's own account, ops admins and test fixtures a manual_ grant before reading the dry run. OPS_ADMIN_USER_IDS names only one admin.
- Accept or close the missing live Stripe check (one function if wanted).
- Set the environment variables together: HIVRA_LAPSE_ENFORCE_LIVE, HERMES_DUNNING_EMAIL_ENABLED and DUNNING_GRACE_ENFORCE_LIVE. These are Ash's env calls. Whether any is set on Canary or production is not known.
- Publish the copy and the switch together. The sentences "we email you before we delete anything" and "files kept for a limited time" need a deletion step and a pre-deletion email that do not exist for Hivra computers yet.

Billing copy:

- F03: re-read the rewritten payment-failed email once. It replaces Ash's 2026-07-07 verbatim copy. "I read every email" depends on replies to info@hermesos.cloud reaching a mailbox.
- F05: the idle-policy cell label ("Idle policy") reads oddly beside "Needs a paid plan". Rename it or hide the cell, and delete the now-unused sleep constants and strings with the F05 decision.
- F06: day1_active and day1_idle go to the wrong people. An isPaidPlan gate plus counting hivra_agents is a code follow-up.
- F12: block a self-serve downgrade while usage exceeds the target plan. F15: one breach-grace constant. F16: the Workspace Cloud cutoff. F19: one measured wake time. F20: add the refund claim route once Ash confirms refunds are handled by hand.
- Persistent memory is listed as paid-only in several places, but nothing in code locks it on Free. Confirm it or remove it everywhere in one pass.
- The Command plan (delisted) still lists "Priority infrastructure support (24 hr)", "1:1 dedicated support (first 14 days)" and "1-click deploy from prompt library", which are unverified promises.
- Dead i18n strings: switcher.description and switcher.guarantee in eight locale blocks (16 strings) are unrendered and stale. The records conflict about whether the "Upgrade-only plans" half of the guarantee strip was removed. The files today still carry it in English and zh-CN, and the copy-system record shows it in the other six languages too, while the Terms no longer say upgrade-only. Decide, then align all eight.

Terms and Privacy (solicitor review is required first):

- Align Terms "Plan Changes" (cancel and subscribe again) with the code tree's refusal message (email info@hivra.cloud). The code tree's Terms page, lines 43 to 45, still has the old wording and must match the copy tree's rewrite.
- Add "we email you when we stop your computer" to the Terms, or not.
- Hivra credits: guarantee, expiry and refund scope. Not in the copy: liability cap and carve-outs, legal entity, governing law, minimum age, the UK 14-day statutory right, DMCC subscription rules.
- Both Last Updated dates are set on the publish day.

Public copy:

- F14: publish the agent limit as numbers on Pricing, or not (3 and 5 in AGENT_SLOTS, 1 and 3 in the owner's proposed ladder, and the copy rules ban agent counts).
- The /features H1, "Give your agent a computer that stays on.", replaced Ash's own wording and needs his yes. Fallback: restore "Give your agent a computer. We'll keep it running." and keep only the lead sentence.
- Footer label "Mac app (coming soon)" versus "Desktop app (coming soon)". The /agents H1 "Pick your agent. We'll give it a computer." could read as a gift ("We'll run it on a computer"). The Agent Zero FAQ question names Agent Zero next to "paid". The compare directory lines 40 and 83 are not in the canonical wording. The optional sentence "If a payment fails or you cancel, Hivra stops the computer. Its files are kept, so you can start it again after you pay." for the hub. "A paid Hivra Cloud computer stays on and is not paused for inactivity" could become "stays on while your plan is paid", but it is pinned and needs owner approval.
- Roadmap gate: connect-your-own-server is offered on Roadmap, Home, Pricing and Get started with a free account. Confirm the release includes the connect flow, or take those four offers out. Also, the InfrastructureEntryChooser says DigitalOcean Managed Agents can run Hermes, so "Hermes runs on Hivra Cloud only" may need an exception.
- Guards left as they are: copy-rules.ts ("BYO cloud beyond Hetzner is not available") and the agent-page ban on aws, gcp, azure, digitalocean and google cloud. Reword them only on Ash's say.
- Status closing line "We would rather explain a disruption plainly..." stays Ash's open decision. The /stats number will fall when enforcement is live.
- Hetzner stays the headline blog recommendation although its page showed CX23 and CX33 unavailable on 21 October 2026. The April 2026 monthly token ranges in the cost articles cannot be refreshed from any source in the repo. The HostingCostCalculatorTool still says "Prices as of September 2026". Blog lastModified of 2026-10-21 on 21 articles is a house-convention call.
- Native-speaker review of the zh-CN, es, pt-BR, fr, de, ja and ko card, guidance and token text. About 631 older lines in i18n.ts still contain an em or en dash, a separate sweep.
- The sitemap lastmod dates for /features, the feature and compare detail pages, /tools and the six tool pages are still 2026-10-20 in seo-lastmod.ts. They are set on the publish day, or apply copy-product's request, or set AGENT_PAGES_LAST_MODIFIED back.
- Follow-up in code: raise agent-catalog minPlan on Hermes, Claude Code, Codex and Aeon to the entry paid tier once the copy tree's agent-seo-catalog test change is merged. "Always-on agent" wording remains in other i18n locales, welcome-agent-catalog.ts and agent-seo-catalog.ts line 387.

Integration:

- Three files are edited in both trees (LaunchJourney.tsx, i18n.ts, plans.ts), and the copy tree is 56 commits behind canary. The copy tree's plans.ts still has the wrong Command specs. The code tree's lapse-core changes to instance-entitlement.ts must land in the same commit as the sweep.

### 5. Not verified

By lane. Nothing below was checked unless a lane says so elsewhere in this section.

lapse-core:

- Nothing was run against a real database, Proxmox host, Resend or Clerk. The stop path was verified only through its existing unit tests and mocked calls from the sweep. The new "--onboot 1" line in the start script was asserted as text, not executed on a host.
- No live acceptance on Canary (disposable fixture, dry-run read, flip to live, Start and Resize answering 402, pay, Start works and onboot is 1). That is a later step after the orchestrator commits.
- The prepared-canary start branch and a self-managed computer through the route are not exercised by their own route tests (the gate sits before the prepared branch, and self-managed is covered in lapse-gate.test.ts only).
- Only the touched folders were run (181 suites, 4126 tests across src/lib/hivra, src/lib/recovery, src/app/api/hivra/agents, the grace cron route, the email test, the instance-entitlement test and agent-start-failure), not the whole dashboard suite.
- The sweep's runtime against the real fleet (reads plus up to 5 stops of up to 120 seconds each) was not timed. maxDuration 800 is a margin, not a measurement.

lapse-ui:

- No screen was rendered in a browser and no email was previewed in a mail client. Everything is checked by jest with jsdom and string assertions, plus tsc and eslint.
- The copy is written for HIVRA_LAPSE_ENFORCE_LIVE=true. It was not run against lapse-core's sweep, so "stopped within about 15 minutes" and "press Start" rest on policy and on reading lapse-gate.ts and hivra-computer-stopped.ts.
- Whether the Stripe billing portal cancels at period end or at once, whether it lets a customer cancel a past_due subscription (the payment email now says "cancel in Billing"), and Stripe's real retry schedule (the code comment says about 4 over about 2 weeks). The cancel dialog avoids timing. The only timing claim is 48 hours from the first failed payment, which matches the grace anchor in stripe-webhook-service.ts.
- Whether DUNNING_GRACE_ENFORCE_LIVE, HERMES_DUNNING_EMAIL_ENABLED, LIFECYCLE_EMAILS_ENABLED, WARM_POOL_CAMPAIGN_ENABLED and the NEXT_PUBLIC upsell flags are set on Canary or production.
- Whether replies to info@hermesos.cloud reach a mailbox.
- Whether persistent memory is locked on Free anywhere outside this repo's code.
- Who exactly receives the cold-storage emails in production (the cron selects by lifecycle_state only, so the "if no paid plan is active" wording is conditional on purpose).
- Texts written by other lanes in non-owned files were read back by grep only. Their tests were not run by this lane.

copy-legal:

- Nothing was checked against production or Canary live flags (HIVRA_LAPSE_ENFORCE_LIVE, HERMES_BILLING_LEGACY_HARD_DELETE, DUNNING_GRACE_ENFORCE_LIVE, COLD_STORAGE_RETENTION_ENABLED).
- The lapse code is new and uncommitted in the code tree. It was read but its tests and the sweep were not run.
- Stripe card retry configuration is not visible in the repository.
- Pages were not rendered in a browser. They are checked through jest rendering tests only.

copy-core:

- No visual check. The added paragraphs on Home (Agents, Closing), Sign-up (a new second paragraph with a 10px top margin in sign-up.module.css) and the Pricing intro were checked only through jest and tsc, not in a browser at desktop or phone width.
- Nothing was run against the served site. The copy tree is not deployed, and the lane read behaviour from the code tree only.
- Whether Codex shows a Hivra-credits option in the served UI. The catalog and model-access.ts give Codex native, key and credits, but the deploy-card flag was not checked.
- Whether Stripe cancels at the end of the paid period (portal setting). "When a cancelled plan ends" in the Pricing FAQ assumes the Terms lane's reading.
- Whether the production promotion includes connect-your-own-server (F8). Home, Pricing and the sign-up page now say a free account works with it.
- The Pricing FAQ link: the renderer links the first occurrence of "terms", which is now inside the Hermes clause. It is pinned in data (links = [{text:'terms',href:'/terms'}]) and by the unchanged renderer logic in pricing/linked-text.tsx, but the rendered anchor position was not checked in a browser.

copy-system:

- No page was rendered in a browser, so nothing was checked at 390 px or in dark mode: the new status headline and row label, the longer roadmap paragraph, the translated sign-up cards and the changelog intro were checked by jest, eslint and tsc only.
- The status share card is tested as a React element with next/og mocked, not rendered to a PNG.
- "Burst CPU when capacity allows" and "Priority scheduling" were kept from the audit's list. lib/proxmox/cpu-priority.ts implements the scheduling weights, but its own comment says it needs a live contention test, which was not run.
- How the token entitlement and the lapse sweep treat the 24-hour grace in practice (see the flag). Code was read, not run.
- Whether the release that ships this copy includes the connect-your-own-server flow (decides F8 and the free-account offers).
- The 21 June 2026 date in the changelog intro comes from hermes_changelog.md as it is today. It was not compared with the live site.
- Whether any page outside the lane still carries old wording (home, pricing, about, llms.txt and the sign-up page were not edited by this lane).
- The repair pass re-ran only the suites it touched (get-started, components/status, i18n). The roadmap, stats, changelog, ecosystem and ecosystem-map suites passed in the earlier run and were not re-run, because no file they cover changed.
- The switcher.guarantee strings are not rendered by any component today (grep finds none), so the restored English and zh-CN text is checked by the i18n test only, not on a page.

copy-product:

- No page was rendered in a browser at 1440 or 390 wide. Checks are source text plus jest render tests.
- Competitor numbers and claims (Agent 37, Hostinger, xCloud, Nous, Railway, Render, DigitalOcean, Vultr, Cloudways, Fly, E2B, Orgo) were not re-fetched. Only the Hetzner CX23 USD and EUR price was re-read (by the lane and by the reviewer).
- The Hetzner supply caveat (HETZNER_LIMITED_NOTE) rests on the tools lane's 20 October 2026 reading of Hetzner's cost-optimized page. The reviewer re-read it and agrees. The lane did not.
- "Hivra checks what each server can run" rests on the preflight check in the code tree's infrastructure components (InfrastructurePreflightResult.tsx). The code was read, but no connect flow was run, and no free-account launch of Claude Code, Codex or Aeon on a connected server was run.
- Whether any Hermes release is registered in production, so staged rollout is actually in use (F1 is worded as "can").
- Whether Ubuntu desktop launch is generally available on the served build (C2 only removes the contradiction).
- Production state of hivra.cloud for connect-your-server, DigitalOcean Managed Agents and agent attach, which code cannot show.
- The sitemap lastmod request is not applied. Until the owner of seo-lastmod.ts applies it, /features, /compare detail and /tools pages are dated 2026-10-20 while agent pages are dated 2026-10-21.

copy-blog:

- Vultr ($20 and $48), Linode ($24), OVH (about $4.54 and $8.50), Hostinger ($8.79, $211 "by our arithmetic") and the 15 June claim for Vultr and Linode prices were not re-fetched. The ai-agent-vps table is still dated September 2026 for those rows.
- Hetzner availability today and in other locations: only the cost-optimised page as fetched on 21 October 2026 was read (first pass), and a reviewer reconfirmed it. It was not re-fetched in the repair pass.
- The 15,000 to 20,000 token Telegram overhead per message is the article's own figure and was not re-checked against Hermes docs. Only the price arithmetic was.
- The non-pricing articles (claude-code-remote-control, hermes-vs-openclaw, ai-agent-memory-systems and similar) were swept by grep for plan, cancel, stop and free wording, not read line by line, and their vendor feature claims were not checked.
- Nothing was seen in a browser. Rendered pages were checked only through jest (article-page, blog page, llms-txt and seo-urls tests), not at phone width or live.
- The "Updated" label now appearing on codex-pricing-by-chatgpt-plan and is-openclaw-free (lastModified now differs from publishedDate) was checked only by the article-page test, not visually.
- Whether the copy-tree Terms text that B2 mirrors is the version that will be published. copy-legal owns that file.

routed-code and routed-copy:

- Neither lane recorded an unverified list. Their checks are the jest, tsc, eslint and copy-scan runs described in their lane sections. Nothing in their records shows a browser render or a live check.

Audit and this write-up:

- Production (the production database) was not queried. The Canary census was SELECT only. Whether the 8 running Canary computers are actually powered on in Proxmox, who owns the three owner accounts, which are fixtures, and why five paid rows have no Stripe id were not established.
- The Vercel environment values for HIVRA_LAPSE_ENFORCE_LIVE, DUNNING_GRACE_ENFORCE_LIVE, HERMES_DUNNING_EMAIL_ENABLED and related flags on Canary and production were not read.
- The two trees' edits to LaunchJourney.tsx, i18n.ts and plans.ts were not compared for conflicts.
- This section was written from the lane records, the earlier audit files, and read-only reads of both trees (file lists and a few text spot-checks). The lane records were not re-run, and the full test suite was not run for this section.

# Hermes Deploy — Changelog

> Last updated: 2026-06-21

What's new on the platform, newest first. Each release is dated and linkable (e.g. `/changelog#2026-06-10`).

---

## [2026-06-21] Agent Rename and Stronger Telegram Connect

### ✨ Rename your agent anytime
The dashboard now has an inline rename: click the pencil next to your agent's name, type a new name, and press Enter. It takes effect instantly without interrupting the running agent — no support ticket, no database edit.

### 🛠️ Reliability & fixes
- **Telegram token validated before it's saved.** A dead, revoked, or mistyped bot token is now rejected at submission with a clear error from Telegram — it can't land silently and do nothing.
- **Telegram apply retries transient failures.** If the bot-token update hits a brief SSH blip, it retries automatically and surfaces a clear, retryable error when it gives up instead of a silent failure.

---

## [2026-06-19] Cookie Import — Log Your Agent Into Your Accounts

### ✨ Your agent's browser can use your accounts
Export your browser cookies and load them straight into your agent's cloud browser — it logs in across hundreds of sites automatically. No password sharing: cookies are parsed on-box and never touch the LLM. Works on Hermes **Pro browser agents** and Hivra browser boxes. Import Netscape format, Cookie-Editor JSON, or Playwright storageState; a few bad cookies won't block the whole import. Bonus: a warmed, logged-in profile means Cloudflare and bot-detection challenges drop sharply.

Find it: **Browser tab → Log in with your accounts**.

### 🛠️ Reliability & fixes
- **Browser sidecar can't OOM an undersized box.** Two-layer RAM check: the dashboard blocks browser-agent provisioning below 2.5 GB, and the sidecar re-checks the VM's actual memory before launching Chromium. Undersized boxes exit cleanly instead of crashing.

---

## [2026-06-18] Reliability & Improvements

### 🛠️ Reliability & fixes
- **Telegram connect uses native pairing.** The old browser-based ID capture — polling Telegram's getUpdates to learn your numeric user ID — was the top connect-funnel drop-off: webhook conflicts, timeouts, and silent failures. Both the Hermes and Hivra lanes now pair through the agent runtime directly. On Hivra, tap a deeplink once and the token burns. On Hermes, DM the bot and confirm a one-time 8-character code. No more polling, no more credentials in redirect URLs.
- **Web search works on every agent out of the box.** Fresh deployments no longer default to a keyless search backend that fails immediately. Every agent now ships with DuckDuckGo as the default search backend — free and operator-tier boxes can search the web from day one with no API key required.
- **Hivra.cloud is now the canonical URL across SEO, social links, and sitemaps.** Canonical tags, open-graph metadata, IndexNow pings, and sitemap entries all point to hivra.cloud. The legacy hermesos.cloud domain redirects — ending the SEO and social-preview leak for crawlers that don't follow 301s.

---

## [2026-06-14] Agent Memory, Templates, LLM Picker, and Claude on Venice

### ✨ Agents now have memory
Add anything to **Settings → Memory** and every agent you own carries that context forward — no more re-explaining your preferences, project details, or working style each session.

### ✨ Save, share, and fork agent templates
Build an agent configuration you like? Save it as a template, share it with a link, or fork someone else's setup in one click. Your best agents become starting points for new ones.

### ✨ Per-agent model selector
Each agent now has its own model picker. Run one on Claude Fable 5, another on a lighter model, another on Venice — the right model for each job, without touching anything else.

### ✨ Claude models on Venice
Select a Claude model and let managed Venice inference handle the billing. Full Anthropic capability, billed to your Venice credits instead of a separate API key.

### ✨ A new way to get started
Your first deploy is now a short conversation, not a form. Tell your agent who you are and what you need — it comes out of onboarding ready to work, with the right skills loaded.

### ✨ Install skills without leaving the dashboard
The **HivraSkills** tab is live. Browse the curated catalog and install in one click — your agent picks up the new skill immediately, no restart needed.

### 🛠️ Reliability & fixes
- **Workspace iframe loads for all gateway-backend agents.** Customers who hit "Open this dashboard from Hivra to authenticate" on the gateway lane are unblocked.
- **Agent switcher is now a collapsible handle.** It no longer covers the chat input or controls.
- **Cross-tenant routing hardened.** Archived agents' Caddy site files are fully removed so routing can't leak between accounts.
- **Venice URL stays current after domain changes.** `hivra.cloud` is now the canonical app URL; stale `hermesos.cloud` addresses auto-heal so 301s can't kill inference.
- **Post-deploy Telegram nudge suppressed once connected.** No redundant "connect your bot" prompt after you already have.
- **Fresh-signup guest bootstrap weathers package-manager locks.** The apt-lists lock during Proxmox guest init no longer causes teardown.
- **Analytics noise reduced.** Google Translate and `$exception` noise filtered out of error capture.

---

## [2026-06-13] Agent Activity, Telegram Connect, and Platform Fixes

### ✨ See what your agent has been up to
A new **recent-work card** on your agent's dashboard surfaces the last few tasks it ran — a quick recap without digging through chat history.

### ✨ Telegram connect, front and center
The Telegram connect step now appears prominently during deploy on both the free and paid lanes. One tap and your agent can reach you over Telegram from day one.

### ✨ Bankr wallet and skills for CLI agents
CLI agents (Codex, Claude Code) now have access to the **Bankr wallet** — deposit, withdraw, view history — plus the ability to install skills from the catalog.

### ✨ Paid agents resume automatically
Paid-plan agents that were incorrectly paused for inactivity now wake back up on their own. No manual restart needed.

### ✨ Clearer paid plan indicators
Persistent upgrade cues now appear exactly when you hit a limit, so the path forward is always obvious.

### 🛠️ Reliability & fixes
- **Agent switcher no longer overlaps chat controls.** The panel now sits below the chat input instead of in front of it.
- **Fresh-account first deploy no longer crash-loops.** A missing root-gateway flag was blocking provisioning for some new signups — fixed.
- **Orphaned disk volumes no longer stall new instances.** The Proxmox allocator skips leftover LVM volumes instead of looping forever.
- **Venice URL self-heals after domain cutovers.** Managed-Venice agents update their base URL automatically so a domain change no longer causes permanent 301 redirects.
- **Webfree container resolution hardened.** Watchdog, harvester, and handoff routes all find the right container after topology changes.
- **WebUI Caddyfile self-repair gated to the right instance type.** Gateway-backend instances no longer get their routing corrupted by a repair meant for WebUI-backend instances.

---

## [2026-06-12] Aeon with Managed Credits

### ✨ Fund your Aeon with your Venice wallet
Aeon agents can now draw their LLM usage straight from your **managed Venice wallet**. Opt in on the Aeon deploy card — the toggle is off by default, so nothing changes unless you choose it. Once enabled, your agent connects automatically and bills to your credits. No credits yet? Launching with the option on now shows the deposit flow so you know exactly what to do next.

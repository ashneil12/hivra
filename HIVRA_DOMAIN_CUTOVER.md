# Hivra domain cutover — frontend → hivra.cloud (backend stays hermesos.cloud)

**Strategy:** move ONLY the brand/frontend surface to `hivra.cloud`. The backend — agent gateways `*.agents.hermesos.cloud`, the Cloudflare **Pro** zone + its per-instance records, per-VM Caddy/certs, `PROXMOX_*_GATEWAY_DOMAIN` — **stays on hermesos.cloud, untouched.** No second Pro plan, no fleet cert/DNS migration.

**GSC change-of-address:** ✅ already done by Ash — skip all Search Console steps below.

**Golden ordering rule:** hivra.cloud must SERVE the app + auth BEFORE you flip `SITE_URL` or the 301 — otherwise the live site emits canonicals/redirects to a dead domain. The phases below respect that. Markers: **[YOU]** = a dashboard click (Vercel/Cloudflare/Clerk/Resend/Namecheap); **[CODE]** = a repo change.

---

## Phase 0 — Pre-stage (safe to do NOW, before the domain is live)
Additive — pre-authorizes hivra.cloud without changing the live domain.
- **[CODE] Add hivra.cloud to the agent frame-ancestors CSP** so the future hivra.cloud dashboard can iframe agents. `dashboard/src/lib/services/webui-instance-builder.ts` → the `Content-Security-Policy "frame-ancestors 'self' https://hermesos.cloud https://dashboard.hermesos.cloud https://canary.hermesos.cloud"` → append `https://hivra.cloud https://www.hivra.cloud`.
- **[YOU] env** `NEXT_PUBLIC_CLERK_ALLOWED_ORIGINS` → add `https://hivra.cloud,https://www.hivra.cloud` (keep the hermesos ones too during transition).
- Deploy. Nothing changes for live users (hivra.cloud isn't serving yet).

## Phase 1 — DNS: get hivra.cloud ready  [YOU]
hivra.cloud is parked on Namecheap. Recommended: move it to **Cloudflare free** (you do NOT need a 2nd Pro plan for the frontend).
1. Cloudflare → Add site → `hivra.cloud` → Free → copy the 2 nameservers.
2. Namecheap → hivra.cloud → Nameservers → Custom DNS → paste the Cloudflare NS. (Propagation 5 min–few hrs.)
3. You'll add the actual records in Phases 2-4.
(Alt: keep Namecheap DNS + add records there — works, but Cloudflare makes the Clerk/email records easier.)

## Phase 2 — Vercel: dual-serve hivra.cloud  [YOU]
On the **prod** Vercel project (`hermesos`):
1. Settings → Domains → Add `hivra.cloud` + `www.hivra.cloud`.
2. Add the DNS target Vercel shows (apex `A 76.76.21.21`; www `CNAME cname.vercel-dns.com`) in Cloudflare as **DNS-only (grey cloud)** so Vercel issues the cert cleanly.
3. Set `hivra.cloud` = **Primary**; `www` → redirect to apex.
4. Wait for the TLS cert (green). Now hivra.cloud serves the SAME app as hermesos.cloud (dual-serving). Flip nothing else yet.

## Phase 3 — Clerk: auth on hivra.cloud  [YOU] (the fiddly one)
1. Clerk Dashboard → production instance → Domains → add/set primary `hivra.cloud`.
2. Add the DNS records Clerk gives (`clerk`, `accounts`, `clkmail`, `clk._domainkey`, `clk2._domainkey`) in the hivra.cloud Cloudflare zone (CNAME, DNS-only). Verify (green).
3. If the Frontend API URL changes, update `NEXT_PUBLIC_CLERK_*` env + the layout preconnect (Phase 5).
4. **Keep the hermesos.cloud Clerk domain live** during transition — don't delete until the hermesos frontend is fully redirected.

## Phase 4 — Resend: email from hivra.cloud  [YOU]
1. Resend → Domains → Add `hivra.cloud` → add SPF (TXT) + DKIM (CNAME/TXT) (+ MX if you take replies) in Cloudflare. Verify (green).
2. Set env on prod Vercel: `RESEND_FROM_EMAIL="Hivra <noreply@hivra.cloud>"`, `RESEND_REPLY_TO_EMAIL="info@hivra.cloud"`. The email lib already reads these envs (hermesos is just the code fallback) → no code change strictly needed, but flip the fallbacks in Phase 5 for cleanliness.

## Phase 5 — Code: flip the frontend domain  [CODE] (deploy once Phases 1-4 are green)
Change ONLY frontend refs. **DO NOT touch `agents.hermesos.cloud` / `PROXMOX_*_GATEWAY_DOMAIN`.**
- `dashboard/src/lib/seo-urls.ts:5` `SITE_URL` → `https://hivra.cloud`
- `dashboard/src/app/layout.tsx:32` `SITE_URL` → `https://hivra.cloud`; og-image URLs (L99, L114) → `https://hivra.cloud/og-image.png`; clerk preconnect/dns-prefetch (L146-147) → `clerk.hivra.cloud` (only if the Clerk domain changed); twitter `@hermesos` (L109-110) → new handle or leave.
- `dashboard/src/app/page.tsx:27` `SITE_URL` → `https://hivra.cloud`
- `dashboard/src/lib/email/*` the `?? "noreply@hermesos.cloud"` / reply fallbacks → `@hivra.cloud`.
- This auto-fixes **canonicals, OG, JSON-LD org, and sitemap.xml** (all derive from `SITE_URL`) → they now point at hivra.cloud.
- ⚠️ `og-image.png` content is still the old-brand raster (flagged earlier) — swap the actual image file when a designer has it; the URL flip alone is fine for now.

## Phase 6 — Transitional "formerly HermesOS"  [CODE]
- Small hero eyebrow / banner: **"Hivra — formerly HermesOS"** (keep a few months, then remove).
- FAQ "What happened to HermesOS?" — already live ✅.
- Optional title-tag for the transition: `%s | Hivra (formerly HermesOS)`.
This keeps the **"hermesos" brand-term searchers** oriented (low bounce) and signals the equivalence to Google.

## Phase 7 — Fleet reconcile (so EXISTING agents accept the new origin)  [YOU/CODE]
frame-ancestors is baked per-instance at provision; existing agents won't allow the hivra.cloud iframe until reconciled.
- `POST /api/cron/redeploy-webui-instances` (CRON_SECRET, ≤10 ids/batch) OR the normal reconcile cron. Verify ONE agent iframes inside the hivra.cloud dashboard before doing the rest.

## Phase 8 — The 301  [YOU] (LAST — only after hivra.cloud fully serves + auths)
On the **hermesos.cloud** Cloudflare zone (Pro) → Rules → **Redirect Rules**:
- **When:** `(http.host eq "hermesos.cloud") or (http.host eq "www.hermesos.cloud")`
- **Then:** **301** (permanent), Dynamic → `concat("https://hivra.cloud", http.request.uri.path)`, **Preserve query string: ON**.
- Path-preserving + scoped to apex/www only → `*.agents.hermesos.cloud` is **untouched** (backend keeps serving).
- ⚠️ 301 not 302; ⚠️ preserve the path (NOT a blanket redirect to homepage — that's what tanks rankings).

## Phase 9 — Verify
- `curl -I https://hermesos.cloud/compare/vs-railway` → `301` → `https://hivra.cloud/compare/vs-railway` (path kept).
- `curl -I https://www.hermesos.cloud` → 301 → hivra.cloud.
- `curl -I https://<sub>.agents.hermesos.cloud` → still **200** (backend untouched).
- hivra.cloud loads; Clerk login works on hivra.cloud; a test email arrives from `@hivra.cloud`; an existing agent iframes in the hivra.cloud dashboard (post Phase 7).
- Paste a hivra.cloud link into a social card validator → Hivra OG.

## Rollback (everything is reversible — backend never moved, hermesos.cloud stays alive)
- **301:** delete the Cloudflare redirect rule → hermesos.cloud serves again (still a Vercel domain).
- **Frontend:** revert the `SITE_URL` commit → Vercel redeploy → back to hermesos.cloud canonicals.
- **Clerk/Resend:** the hermesos configs stay until you delete them → revert = flip env/DNS back.

## Suggested execution order
`Phase 0 (now) → 1 → 2 → 3 → 4 → 5 → 6 → 7 → (soak/verify) → 8 → 9`. Phases 1-4 are dashboard/DNS (yours); 0/5/6 are code (I can do); 7-8 are the cutover triggers.

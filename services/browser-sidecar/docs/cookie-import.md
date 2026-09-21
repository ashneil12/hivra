# Log your agent's browser into your accounts (cookie import)

Your agent has its own browser running in the cloud — separate from the one on
your laptop. **Cookie import** copies your existing logins into it, so the agent
can use your accounts (Gmail, X, LinkedIn, your dashboards, anything) without you
re-typing passwords or 2FA. You export a small file from your browser and drop it
into Hermes — that's it.

> ⚠️ **These are your live login sessions.** Only import cookies for accounts you
> want your agent to act in, and only on a box that's yours. The file goes
> straight into your agent's browser on your own VM — it's never shown to the AI
> model and never leaves your instance.

---

## The 60-second version

1. **Install the extension:** [**Get cookies.txt LOCALLY**](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc)
   (Chrome/Edge/Brave) or the [Firefox add-on](https://addons.mozilla.org/firefox/addon/get-cookies-txt-locally/).
   It's open-source and runs **entirely on your machine** — nothing is uploaded
   anywhere, which is exactly what you want for login cookies.
2. **Go to the site you're logged into** (e.g. open `mail.google.com` in a tab
   where you're signed in).
3. **Click the extension icon → "Export"** (or "Export As ⇒ cookies.txt"). It
   saves a small `cookies.txt` for that site.
4. **In Hermes:** open your agent → **Browser → Import cookies** → drop the file in.
5. Done. Hermes shows you which sites it imported. Open the **live browser** and
   you'll be logged in — and so is your agent.

Repeat steps 2–4 for each site you want the agent to have access to.

---

## Which extension / file formats work

You don't have to use a specific tool — Hermes auto-detects the format. Any of
these work:

| Tool | Format it exports | Notes |
|---|---|---|
| **Get cookies.txt LOCALLY** *(recommended)* | `cookies.txt` (Netscape) | Open-source, local-only, one click per site. The safe default. |
| **Cookie-Editor** | JSON | Also one-click; pick "Export". Fine, just not open-source. |
| Playwright / Puppeteer `storageState` | `{ "cookies": [...] }` JSON | If you already have a saved session file. |

If you're not sure, use **Get cookies.txt LOCALLY** — it's the privacy-safe pick
and the steps above are written for it.

---

## Tips & troubleshooting

- **Export from the exact site you want.** "Get cookies.txt LOCALLY" exports the
  cookies for the **current tab's site**, so be on `gmail.com` (not a new tab)
  when you click it. To grab several sites, export each one and upload them — you
  can import as many files as you like.
- **Still shows logged out?** A few sites tie the session to your device or IP and
  will re-prompt. For those, use the **live browser** view to log in directly —
  that login persists too, and you can combine the two.
- **Logins expire.** Cookies have an expiry; when a site eventually logs the agent
  out, just re-export and re-import. (Some sites issue short-lived sessions.)
- **Revoking access:** logging out of the site in your own browser, or resetting
  the agent's browser identity, clears it. You stay in control.

---

## How it works (for the curious)

The file is parsed **server-side on your VM** (never sent to the language model),
normalized to the browser's cookie format, and loaded into your agent's
persistent browser context (`addCookies`). Because the context is persistent, the
login survives restarts. The agent drives that same browser over CDP and you watch
it over noVNC — so once the cookies are in, you and your agent are looking at the
same logged-in session.

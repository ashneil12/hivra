import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright";
import type { BrowserContext, Page } from "playwright";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { cookieHost, type PlaywrightCookie } from "../cookies/parse.js";

interface Session {
  session_id: string;
  identity: string;
  page: Page;
  created_at: number;
  last_used_at: number;
}

// One persistent context per identity. Multiple sessions can share an identity
// (each gets its own Page within the same context) — matches the prompt's
// "One persistent context per named identity" requirement.
//
// Persistent context locks the userDataDir, so two SessionManager processes
// pointing at the same identity will conflict. That's intentional — we run one
// sidecar per VM.
// SCRIPTURE_ANCHOR: session-stewards | 1 Peter 4:10 | Verse: As each has received a gift, employ it in serving one another as good managers of grace.
export class SessionManager {
  private contexts = new Map<string, BrowserContext>();
  private sessions = new Map<string, Session>();

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  activeCount(): number {
    return this.sessions.size;
  }

  contextCount(): number {
    return this.contexts.size;
  }

  async start(identity: string): Promise<{ session_id: string }> {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(identity)) {
      throw new Error("identity must match /^[a-z0-9][a-z0-9_-]{0,63}$/i");
    }

    const ctx = await this.getOrCreateContext(identity);
    const page = await ctx.newPage();
    page.setDefaultNavigationTimeout(this.config.DEFAULT_NAVIGATION_TIMEOUT_MS);
    page.setDefaultTimeout(this.config.DEFAULT_ACTION_TIMEOUT_MS);

    const session_id = randomBytes(16).toString("hex");
    const now = Date.now();
    this.sessions.set(session_id, {
      session_id,
      identity,
      page,
      created_at: now,
      last_used_at: now,
    });
    return { session_id };
  }

  async end(session_id: string): Promise<void> {
    const s = this.sessions.get(session_id);
    if (!s) return;
    // Close BEFORE removing from the map, and surface the failure. The old
    // order (delete then close) orphaned the Page on a close error — it was no
    // longer tracked, so neither a retry nor shutdown() could reap it — and
    // the route reported ok:true regardless. Keeping it tracked on failure
    // means shutdown()'s context.close() still reaps it.
    try {
      await s.page.close();
    } catch (err) {
      this.logger.warn({ err: (err as Error).message, session_id }, "page close failed");
      throw err;
    }
    this.sessions.delete(session_id);
  }

  get(session_id: string): Session | undefined {
    const s = this.sessions.get(session_id);
    if (s) s.last_used_at = Date.now();
    return s;
  }

  /**
   * Import cookies into an identity's persistent context — the same context the
   * agent drives over CDP and the user watches over noVNC, so this logs that
   * browser into the user's accounts. addCookies() writes through to the
   * persistent userDataDir, so the login survives restarts. Values are never
   * logged.
   */
  async importCookies(
    identity: string,
    cookies: PlaywrightCookie[],
  ): Promise<{ imported: number; skipped: number; domains: string[] }> {
    if (!cookies.length) throw new Error("no cookies to import");
    const { ctx, release } = await this.resolveCookieTarget(identity);
    try {
      // addCookies is atomic: if ANY single cookie is malformed the whole call
      // throws ("Invalid cookie fields"). Try the fast bulk path first, then fall
      // back to per-cookie writes so a few unparseable cookies from a big "export
      // all" don't sink the entire import — we salvage every good one.
      let imported = 0;
      try {
        await ctx.addCookies(cookies);
        imported = cookies.length;
      } catch (bulkErr) {
        this.logger.warn(
          { identity, reason: (bulkErr as Error).message?.slice(0, 160) },
          "bulk cookie import failed; retrying per-cookie",
        );
        for (const c of cookies) {
          try {
            await ctx.addCookies([c]);
            imported += 1;
          } catch (err) {
            this.logger.warn(
              {
                identity,
                name: c.name,
                host: cookieHost(c),
                reason: (err as Error).message?.slice(0, 120),
              },
              "cookie skipped",
            );
          }
        }
      }

      const skipped = cookies.length - imported;
      const domains = [...new Set(cookies.map(cookieHost).filter(Boolean))].sort();
      this.logger.info({ identity, imported, skipped, domains }, "cookies imported");
      return { imported, skipped, domains };
    } finally {
      await release();
    }
  }

  /**
   * Pick the browser context that cookies should be written to — i.e. the one
   * the AGENT actually drives and the user watches over noVNC.
   *
   * In CDP mode (AGENT_CDP_ENABLED) that is the long-lived Chrome started by
   * docker/cdp-proxy.mjs on the "cdp" profile, NOT a SessionManager context: the
   * Vex toolset is suppressed in CDP mode, and a second Chromium can't even open
   * the "cdp" profile while that Chrome holds its SingletonLock. So we connect
   * over CDP to the running Chrome and write to its default context. Closing the
   * returned browser only disconnects our CDP client — the agent's Chrome (which
   * Playwright did not launch here) keeps running.
   *
   * Outside CDP mode we fall back to the identity's own persistent context.
   */
  private async resolveCookieTarget(
    identity: string,
  ): Promise<{ ctx: BrowserContext; release: () => Promise<void> }> {
    if (/^(1|true|yes|on)$/i.test(process.env.AGENT_CDP_ENABLED ?? "")) {
      const port = Number(process.env.AGENT_CDP_PORT || 9223);
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const ctx = browser.contexts()[0];
      if (!ctx) {
        await browser.close().catch(() => {});
        throw new Error("agent CDP browser has no context to import into");
      }
      return { ctx, release: () => browser.close().catch(() => {}) };
    }
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(identity)) {
      throw new Error("identity must match /^[a-z0-9][a-z0-9_-]{0,63}$/i");
    }
    const ctx = await this.getOrCreateContext(identity);
    return { ctx, release: async () => {} };
  }

  // Wipe an identity's persistent context. Used by `flows/logout.yaml`.
  async resetIdentity(identity: string): Promise<void> {
    const ctx = this.contexts.get(identity);
    if (ctx) {
      this.contexts.delete(identity);
      // Close this identity's pages before the context. Snapshot the ids first
      // (don't mutate the Map we're iterating) and close each Page explicitly
      // so cleanup is consistent with end() and not solely reliant on
      // context.close()'s page reaping.
      const ownedSessionIds = [...this.sessions]
        .filter(([, s]) => s.identity === identity)
        .map(([id]) => id);
      for (const id of ownedSessionIds) {
        const s = this.sessions.get(id);
        this.sessions.delete(id);
        if (!s) continue;
        try {
          await s.page.close();
        } catch (err) {
          this.logger.warn(
            { err: (err as Error).message, session_id: id },
            "page close failed during resetIdentity",
          );
        }
      }
      try {
        await ctx.close();
      } catch (err) {
        this.logger.warn({ err: (err as Error).message, identity }, "context close failed");
      }
    }
    // Wipe the userDataDir on disk.
    const { rm } = await import("node:fs/promises");
    const dir = this.profileDir(identity);
    await rm(dir, { recursive: true, force: true });
  }

  async shutdown(): Promise<void> {
    for (const [id] of this.sessions) {
      // Best-effort during shutdown: a page that won't close is reaped by the
      // context.close() below, so don't let one failure abort the loop.
      try {
        await this.end(id);
      } catch {
        /* logged in end(); context close below reaps the page */
      }
    }
    for (const [identity, ctx] of this.contexts) {
      try {
        await ctx.close();
      } catch (err) {
        this.logger.warn({ err: (err as Error).message, identity }, "context close failed during shutdown");
      }
    }
    this.contexts.clear();
  }

  private profileDir(identity: string): string {
    return join(this.config.PROFILES_DIR, identity);
  }

  private async getOrCreateContext(identity: string): Promise<BrowserContext> {
    const existing = this.contexts.get(identity);
    if (existing) return existing;

    const dir = this.profileDir(identity);
    await mkdir(dir, { recursive: true });
    // A previous container left Chrome's Singleton* symlinks bound to its
    // now-dead hostname; Chromium then refuses to open the profile ("in use by
    // another process on another computer"). We only reach here when no live
    // context for this identity exists in THIS process, so clearing the stale
    // locks is safe and lets the relaunch succeed across restarts.
    for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      await rm(join(dir, lock), { force: true }).catch(() => {});
    }

    const ctx = await chromium.launchPersistentContext(dir, {
      headless: this.config.PLAYWRIGHT_HEADLESS,
      slowMo: this.config.PLAYWRIGHT_SLOW_MO_MS,
      viewport: { width: 1280, height: 800 },
      acceptDownloads: false,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        // Cap the HTTP disk cache so a long-lived persistent context can't grow
        // the profile (and the mounted browser-state volume) unbounded. Mirrors
        // the CDP path's bound. See finding_browser_sidecar_bloat_root_cause.
        `--disk-cache-size=${Number(process.env.SIDECAR_DISK_CACHE_MB ?? 256) * 1024 * 1024}`,
      ],
    });

    this.contexts.set(identity, ctx);
    this.logger.info({ identity, dir }, "persistent context opened");
    return ctx;
  }
}

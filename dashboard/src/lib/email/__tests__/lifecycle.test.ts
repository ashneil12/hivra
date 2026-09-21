/**
 * Lifecycle email content tests. Locks in:
 *   - every key builds a complete subject/text/html/ctaUrl
 *   - the voice rules (no exclamation points, no hype words, signed
 *     "— Ash / Founder, Hivra"; the stalled email signs as the agent)
 *   - CTA deep links per key (welcome / instance page / billing)
 *   - the day-7 offer states the real prices
 *   - send() fails soft when Resend isn't configured
 */

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

import {
  LIFECYCLE_EMAIL_KEYS,
  buildLifecycleEmail,
  sendLifecycleEmail,
} from "@/lib/email/lifecycle";

const PARAMS = {
  firstName: "Sam",
  agentName: "Hermes",
  instanceId: "inst-123",
};

describe("buildLifecycleEmail", () => {
  it("builds subject, text, html and ctaUrl for every key", () => {
    for (const key of LIFECYCLE_EMAIL_KEYS) {
      const content = buildLifecycleEmail(key, PARAMS);
      expect(content.subject.length).toBeGreaterThan(0);
      expect(content.text.length).toBeGreaterThan(0);
      expect(content.html).toContain("<!doctype html>");
      expect(content.html).toContain(content.ctaUrl);
      expect(content.text).toContain(content.ctaUrl);
    }
  });

  it("never uses exclamation points or hype words", () => {
    for (const key of LIFECYCLE_EMAIL_KEYS) {
      const { subject, text, html } = buildLifecycleEmail(key, PARAMS);
      expect(subject).not.toContain("!");
      expect(text).not.toContain("!");
      const all = `${subject}\n${text}\n${html}`;
      expect(all).not.toMatch(/unlock|supercharge|game-?chang/i);
      expect(all).not.toMatch(/hope this finds you well/i);
    }
  });

  it("signs the founder emails '— Ash / Founder, Hivra'", () => {
    for (const key of ["day1_idle", "day1_active", "day3_usecase", "day7_offer", "trial_day5"] as const) {
      const { text } = buildLifecycleEmail(key, PARAMS);
      expect(text).toContain("— Ash");
      expect(text).toContain("Founder, Hivra");
    }
  });

  it("writes the stalled email as the agent, with an Ash footnote", () => {
    const { subject, text, html } = buildLifecycleEmail("stalled_5d", PARAMS);
    expect(subject).toBe("it's Hermes — two things I could be doing");
    expect(text).toContain("It's Hermes.");
    expect(text).toContain("— Hermes");
    expect(text).toContain("on its behalf");
    expect(text).toContain("Ash, Founder, Hivra");
    expect(html).toContain("on its behalf");
  });

  it("falls back to 'your agent' when no agent name is set", () => {
    const { subject } = buildLifecycleEmail("stalled_5d", { agentName: null });
    expect(subject).toBe("it's your agent — two things I could be doing");
    const active = buildLifecycleEmail("day1_active", { agentName: "  " });
    expect(active.subject).toBe("your agent made it through day one");
  });

  it("deep-links each key to the right surface", () => {
    expect(buildLifecycleEmail("day1_idle", PARAMS).ctaUrl).toBe(
      "https://hivra.cloud/dashboard/welcome"
    );
    expect(buildLifecycleEmail("day1_active", PARAMS).ctaUrl).toBe(
      "https://hivra.cloud/dashboard/instances/inst-123"
    );
    expect(buildLifecycleEmail("day3_usecase", PARAMS).ctaUrl).toBe(
      "https://hivra.cloud/dashboard/instances/inst-123"
    );
    expect(buildLifecycleEmail("day7_offer", PARAMS).ctaUrl).toBe(
      "https://hivra.cloud/dashboard/billing"
    );
    expect(buildLifecycleEmail("stalled_5d", PARAMS).ctaUrl).toBe(
      "https://hivra.cloud/dashboard/instances/inst-123"
    );
    expect(buildLifecycleEmail("trial_day5", PARAMS).ctaUrl).toBe(
      "https://hivra.cloud/dashboard/billing"
    );
    // No instance to link to → plain dashboard.
    expect(buildLifecycleEmail("day3_usecase", { instanceId: null }).ctaUrl).toBe(
      "https://hivra.cloud/dashboard"
    );
  });

  it("trial day-5 says what happens next, states the price, and offers the cancel path", () => {
    const { subject, text } = buildLifecycleEmail("trial_day5", PARAMS);
    expect(subject).toBe("your Pro trial ends in two days");
    expect(text).toContain("five days into the seven-day Pro trial");
    expect(text).toContain("$9.99/mo");
    expect(text).toMatch(/cancel from the billing page/i);
    expect(text).toMatch(/won't be charged/i);
  });

  it("day-7 offer states the real prices and what changes", () => {
    const { text } = buildLifecycleEmail("day7_offer", PARAMS);
    expect(text).toContain("$9.99/mo");
    expect(text).toContain("$79/yr");
    expect(text).toContain("2 vCPU / 4 GB");
    expect(text).toMatch(/web browsing/i);
    expect(text).toMatch(/persistent memory/i);
    expect(text).toMatch(/scheduled tasks/i);
  });

  it("day-1 active introduces the three Pro capabilities", () => {
    const { text } = buildLifecycleEmail("day1_active", PARAMS);
    expect(text).toMatch(/web browsing/i);
    expect(text).toMatch(/persistent memory/i);
    expect(text).toMatch(/scheduled tasks/i);
    expect(text).toContain("Hermes has been up for a day");
  });

  it("personalizes the greeting and falls back cleanly", () => {
    expect(buildLifecycleEmail("day1_idle", PARAMS).text).toContain("Hey Sam,");
    expect(buildLifecycleEmail("day1_idle", {}).text).toContain("Hey,");
  });

  describe("goal / first-task personalization (Wave 1.2)", () => {
    it("day-1 idle names the captured goal back to the user", () => {
      const { text, html } = buildLifecycleEmail("day1_idle", {
        ...PARAMS,
        goal: "research",
      });
      expect(text).toContain("signed up yesterday to research a topic, but never deployed");
      expect(html).toContain("research a topic");
    });

    it("day-1 idle stays generic when no goal was captured", () => {
      const { text } = buildLifecycleEmail("day1_idle", PARAMS);
      expect(text).toContain("You signed up yesterday but never deployed an agent.");
      expect(text).not.toMatch(/signed up yesterday to .* but never deployed/);
    });

    it("day-1 idle ignores an unknown goal id and falls back", () => {
      const { text } = buildLifecycleEmail("day1_idle", {
        ...PARAMS,
        goal: "not_a_real_goal",
      });
      expect(text).toContain("You signed up yesterday but never deployed an agent.");
    });

    it("day-3 use-case tells a story matched to the chosen goal", () => {
      const research = buildLifecycleEmail("day3_usecase", { ...PARAMS, goal: "research" });
      expect(research.text).toContain("You signed up to research a topic.");
      expect(research.text).toMatch(/new papers and posts on the topic/);

      const build = buildLifecycleEmail("day3_usecase", { ...PARAMS, goal: "build" });
      expect(build.text).toMatch(/failing CI runs on my repo/);
      // Different goals get genuinely different examples.
      expect(build.text).not.toEqual(research.text);
    });

    it("day-3 use-case leads with the captured first task when present", () => {
      const { text, html } = buildLifecycleEmail("day3_usecase", {
        ...PARAMS,
        goal: "research",
        firstTask: "Find me the best CRM for a 3-person team.",
      });
      expect(text).toContain(
        'You started your agent off with "Find me the best CRM for a 3-person team"'
      );
      expect(html).toContain("You started your agent off with");
    });

    it("day-3 use-case collapses and caps a long multi-line first task", () => {
      const longTask =
        "  Build me\na full\nmarketing plan " + "x".repeat(300) + ".";
      const { text } = buildLifecycleEmail("day3_usecase", {
        ...PARAMS,
        firstTask: longTask,
      });
      // Whitespace collapsed to single spaces, no raw newlines inlined.
      expect(text).toContain('"Build me a full marketing plan');
      // Truncated with an ellipsis — the raw 300-x run must not appear in full.
      expect(text).toContain("…");
      expect(text).not.toContain("x".repeat(200));
    });

    it("day-3 use-case falls back to the generic example with no goal or task", () => {
      const { text } = buildLifecycleEmail("day3_usecase", PARAMS);
      expect(text).toContain("Most people use their agent like a search box.");
      expect(text).toMatch(/scan the news for my industry/);
    });

    it("HTML-escapes a first task that contains markup", () => {
      const { html } = buildLifecycleEmail("day3_usecase", {
        ...PARAMS,
        firstTask: 'Watch <script>alert(1)</script> & report',
      });
      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;");
    });

    it("still passes the no-exclamation / no-hype voice rules when personalized", () => {
      for (const goal of ["research", "build", "grow", "automate"]) {
        for (const key of ["day1_idle", "day3_usecase"] as const) {
          const { subject, text, html } = buildLifecycleEmail(key, {
            ...PARAMS,
            goal,
            firstTask: "Draft a launch announcement.",
          });
          expect(subject).not.toContain("!");
          expect(text).not.toContain("!");
          const all = `${subject}\n${text}\n${html}`;
          expect(all).not.toMatch(/unlock|supercharge|game-?chang/i);
        }
      }
    });
  });

  describe("activity_digest", () => {
    const DIGEST_PARAMS = {
      firstName: "Sam",
      agentName: "Atlas",
      instanceId: "inst-123",
      activityDigest: {
        sessionCount: 3,
        totalMessages: 42,
        topModel: "glm-5.1",
        estimatedCostUsd: 0.1234,
        attentionLabels: ["Approval needed"],
      },
    };

    it("subjects with the agent name and summarizes the week", () => {
      const { subject, text, ctaUrl } = buildLifecycleEmail("activity_digest", DIGEST_PARAMS);
      expect(subject).toBe("What Atlas did this week");
      expect(text).toContain("3 sessions this week");
      expect(text).toContain("42 messages exchanged");
      expect(text).toContain("glm-5.1");
      expect(text).toContain("$0.12");
      expect(text).toContain("Approval needed");
      // Deep-links to the agent, signs as Ash.
      expect(ctaUrl).toBe("https://hivra.cloud/dashboard/instances/inst-123");
      expect(text).toContain("— Ash");
      expect(text).toContain("Founder, Hivra");
    });

    it("singularizes a one-session week and renders sub-cent spend", () => {
      const { text } = buildLifecycleEmail("activity_digest", {
        ...DIGEST_PARAMS,
        activityDigest: {
          sessionCount: 1,
          totalMessages: 1,
          topModel: null,
          estimatedCostUsd: 0.0009,
          attentionLabels: [],
        },
      });
      expect(text).toContain("1 session this week");
      expect(text).toContain("1 message exchanged");
      expect(text).toContain("$0.0009");
      expect(text).not.toMatch(/waiting on you/i);
    });

    it("omits unknown stats instead of showing hollow zeros", () => {
      const { text } = buildLifecycleEmail("activity_digest", {
        agentName: "Atlas",
        activityDigest: {
          sessionCount: 2,
          totalMessages: null,
          topModel: null,
          estimatedCostUsd: null,
          attentionLabels: [],
        },
      });
      expect(text).toContain("2 sessions this week");
      expect(text).not.toMatch(/messages exchanged/i);
      expect(text).not.toMatch(/mostly on/i);
      expect(text).not.toMatch(/estimated compute/i);
    });

    it("falls back to 'your agent' and a zero digest when nothing is passed", () => {
      const content = buildLifecycleEmail("activity_digest", {});
      expect(content.subject).toBe("What your agent did this week");
      expect(content.text.length).toBeGreaterThan(0);
      expect(content.html).toContain("<!doctype html>");
      expect(content.ctaUrl).toBe("https://hivra.cloud/dashboard");
    });
  });
});

describe("sendLifecycleEmail", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.RESEND_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("fails soft when RESEND_API_KEY is missing", async () => {
    const res = await sendLifecycleEmail("day1_idle", {
      ...PARAMS,
      email: "user@example.com",
      idempotencyKey: "lifecycle_day1_idle_user_1",
    });
    expect(res).toEqual({ sent: false, reason: "not_configured" });
  });
});

import { BLOG_ARTICLES } from "@/lib/blog-data";
import { LARGER_PLAN_PRICE, LARGER_PLAN_SIZE } from "@/lib/blog/plan-facts";
import { CLI_RUN_LIFETIME } from "@/lib/blog/runtime-facts";
import { BLOG_TOPICS, topicForArticle } from "../topics";
import { article } from "../articles/claude-code-remote-control";

// The two offline messages are not in Anthropic's docs. They are assembled from user-filed issues on
// github.com/anthropics/claude-code (90172, 90877, 91839, 95577, 98310) and Search Console queries, with typographic
// apostrophes (U+2019). A reworded or "tidied" quote would send readers looking for a string nobody sees, so these
// are pinned character for character.
const CANT_REACH_TITLE = "Can\u2019t reach your computer";
const CANT_REACH_BODY = "It may be asleep or offline. This session will reconnect when it\u2019s back.";
const SESSION_OFFLINE =
  "Claude Code on the computer running this session is offline. If that computer is asleep or lost its connection, this session reconnects when it\u2019s back. If Claude Code was closed, start it there again and reopen this conversation.";
const MACHINE_NAME_VARIANT =
  "Claude Code on <machine> is offline. If <machine> is asleep or lost its connection, this session reconnects when it\u2019s back...";

const sectionCopy = article.sections.flatMap((section) => section.paragraphs).join("\n\n");
const fullCopy = [
  article.title,
  article.metaTitle ?? "",
  article.metaDescription,
  article.tagline,
  article.intro,
  article.shortAnswer ?? "",
  ...article.sections.flatMap((section) => [section.heading, ...section.paragraphs]),
  ...article.faqs.flatMap(({ q, a }) => [q, a]),
].join("\n");

/**
 * The messages sit in blockquotes as inline code, not in fenced blocks: a fenced block does not wrap, so the long
 * second message scrolled sideways at every width and hid most of the string a reader came to match.
 */
function quotedCode(copy: string): string[] {
  return [...copy.matchAll(/^> `([^`]+)`$/gm)].map((match) => match[1]);
}

/** The contents of every fenced code block in the section copy. */
function fencedBlocks(copy: string): string[] {
  return [...copy.matchAll(/```\w*\n([\s\S]*?)\n```/g)].map((match) => match[1]);
}

function internalLinks(copy: string): string[] {
  return [...copy.matchAll(/\]\((\/[^)\s]*)\)/g)].map((match) => match[1]);
}

describe("Claude Code Remote Control article", () => {
  it("is registered under its canonical slug and sits in the keep-agents-running topic right after the 24/7 post", () => {
    expect(article.slug).toBe("claude-code-remote-control");
    expect(BLOG_ARTICLES[article.slug]).toBe(article);
    expect(topicForArticle(article.slug)?.slug).toBe("keep-agents-running");
    const topic = BLOG_TOPICS.find((candidate) => candidate.slug === "keep-agents-running")!;
    expect(topic.articles.indexOf(article.slug)).toBe(topic.articles.indexOf("keep-claude-code-running-24-7") + 1);
  });

  it("opens with a 40 to 60 word short answer that states what it is, the start command and the one rule", () => {
    const answer = article.shortAnswer ?? "";
    const words = answer.trim().split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(40);
    expect(words).toBeLessThanOrEqual(60);
    expect(answer).toContain("Claude Code session that keeps running on your own machine");
    expect(answer).toContain("`claude remote-control`");
    expect(answer).toContain("that machine must stay on and the `claude` process must keep running");
  });

  it("names both offline messages in the meta description and the intro, and does not say the session never leaves the machine", () => {
    // These two strings are the only proven Hivra demand (86 impressions in 28 days), so the snippet must contain them.
    expect(article.metaDescription.length).toBeGreaterThanOrEqual(70);
    expect(article.metaDescription.length).toBeLessThanOrEqual(155);
    expect(article.metaDescription).toContain(CANT_REACH_TITLE);
    expect(article.metaDescription).toContain("computer running this session is offline");
    expect(article.intro).toContain(`"${CANT_REACH_TITLE}"`);
    expect(article.intro).toContain("\"Claude Code on the computer running this session is offline\"");
    // The transcript is stored on Anthropic's servers while connected, so the session does not "never leave" the machine.
    expect(fullCopy).not.toMatch(/never leaves your machine/i);
    expect(article.intro).toContain("while Claude keeps running on your machine, with code execution and file access staying there");
  });

  it("quotes the first offline message exactly, as code", () => {
    expect(quotedCode(sectionCopy)).toContain(CANT_REACH_TITLE);
    expect(quotedCode(sectionCopy)).toContain(CANT_REACH_BODY);
    expect(sectionCopy).toContain("`Remote Control host unreachable (computer_unreachable)`");
  });

  it("quotes the second offline message exactly, as code, and its machine-name variant", () => {
    expect(quotedCode(sectionCopy)).toContain(SESSION_OFFLINE);
    expect(sectionCopy).toContain(`\`${MACHINE_NAME_VARIANT}\``);
  });

  it("discloses that the capital letters in the middle of the second message are our reading", () => {
    // The middle sentence comes from a lowercase Search Console query; the issues quote only the opening and closing
    // sentences (and issue 98310's machine-name variant has capitals). The page must not present it as a screenshot.
    expect(sectionCopy).toContain("The search query is lowercase, so the capital letters in that sentence are our reading.");
    expect(sectionCopy).toContain("We could not check it against a live session");
  });

  it("says both offline messages come from user reports, not from Anthropic's docs", () => {
    expect(sectionCopy).toMatch(/Anthropic does not publish this message in its docs/);
    expect(sectionCopy).toMatch(/This one is not in Anthropic's docs either/);
    expect(article.faqs.map(({ a }) => a).join("\n")).toMatch(/Anthropic does not document this message/);
    expect(article.faqs.map(({ a }) => a).join("\n")).toMatch(/Anthropic does not publish this message\. It comes from user reports/);
    // The only threshold Anthropic leaves out must stay out.
    expect(sectionCopy).toContain("Anthropic does not publish how long \"offline long enough\" is");
  });

  it("never tells a reader a host that has exited will reconnect by itself", () => {
    // Only a sleep is documented as reconnecting automatically. A server-mode host that is awake but offline for roughly
    // 10 minutes exits, so a reader told to "do nothing else" would be left with a dead host.
    expect(fullCopy).not.toContain("do nothing else");
    expect(fullCopy).not.toContain("you do not need to start anything");
    expect(fullCopy).not.toMatch(/reconnects by itself, and/);
    for (const heading of [
      "The \"Can’t reach your computer\" message",
      "The \"Claude Code on the computer running this session is offline\" message",
    ]) {
      const section = article.sections.find((candidate) => candidate.heading === heading)!;
      expect(section.paragraphs.join("\n")).toContain("roughly 10 minutes");
      expect(section.paragraphs.join("\n")).toMatch(/(?:If it was asleep|After a sleep), Claude Code reconnects by itself/);
    }
    const offlineFaq = article.faqs.find(({ q }) => q.includes("running this session is offline"))!;
    expect(offlineFaq.a).toContain("a network outage of roughly 10 minutes exits the claude remote-control process");
  });

  it("scopes the first message to the Desktop app, the only client every cited report names", () => {
    // Issues 88692, 90172, 90877, 94229 and 94833 are all Claude Desktop app reports. None is a browser, phone or CLI
    // report, so the page must not say the banner appears in a browser or give terminal-only fixes.
    const first = article.sections.find((section) => section.heading === "The \"Can’t reach your computer\" message")!;
    const copy = first.paragraphs.join("\n");
    expect(copy).toContain("Every report we found comes from the Claude Desktop app");
    expect(copy).toContain("The Claude app cannot reach the machine that hosts the session.");
    expect(copy).not.toMatch(/or browser/i);
    expect(copy).toContain("If the host is the Claude Desktop app, reopen the app on that computer, then open the session again.");
    expect(copy).toContain("a Windows reinstall that regenerates the device identity");
    expect(copy).toContain("the Desktop app restarting itself to install an update, with the running sessions not coming back afterwards ([issue 90172](https://github.com/anthropics/claude-code/issues/90172))");
    expect(copy).toContain("Anthropic has not confirmed any of these.");
    expect(copy).toContain("If you started the session from the command line, run `/remote-control` to reconnect.");
    const faq = article.faqs.find(({ q }) => q.startsWith("What does \"Can’t reach your computer\""))!;
    expect(faq.a).toContain("when the Claude Desktop app cannot reach the machine hosting a session");
    expect(faq.a).toContain("If the host is the Claude Desktop app, reopen it on that computer");
    expect(faq.a).not.toMatch(/or browser/i);
  });

  it("gives each message its own fix", () => {
    const first = article.sections.find((section) => section.heading === "The \"Can\u2019t reach your computer\" message")!;
    const second = article.sections.find((section) => section.heading === "The \"Claude Code on the computer running this session is offline\" message")!;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first.paragraphs.join("\n")).toContain("Wake the machine");
    expect(first.paragraphs.join("\n")).toContain("`claude remote-control` in the same directory");
    expect(second.paragraphs.join("\n")).toContain("**The computer is asleep or lost its connection.**");
    expect(second.paragraphs.join("\n")).toContain("**Claude Code was closed.**");
  });

  it("gives the start commands exactly as Anthropic's docs do", () => {
    const blocks = fencedBlocks(sectionCopy).join("\n");
    for (const command of [
      "claude remote-control",
      "claude remote-control --name \"My Project\"",
      "claude --remote-control",
      "claude --remote-control \"My Project\"",
      "/remote-control",
      "/remote-control My Project",
    ]) {
      expect(blocks.split("\n")).toContain(command);
    }
    expect(sectionCopy).toContain("`/rc` is short for `/remote-control`, `--rc` for `--remote-control`, and `claude rc` for `claude remote-control`");
    expect(sectionCopy).toContain("`Enable Remote Control? (y/n)`");
    expect(sectionCopy).toContain("`Trust <directory>? [y/N]`");
    expect(sectionCopy).toContain("`claude remote-control --continue`");
    expect(sectionCopy).toContain("`claude remote-control --session-id <id>`");
  });

  it("quotes the official error messages that block Remote Control, with the cause and fix", () => {
    for (const message of [
      "`Remote Control requires a claude.ai subscription.`",
      "`Remote Control requires claude.ai subscription auth.`",
      "`Remote Control requires a full-scope login token`",
      "`Remote credentials fetch failed`",
      "`Workspace not trusted`",
      // The "not available" family, which the top related search ("claude code remote control not available") is about.
      "`You must be logged in to use Remote Control. Remote Control is only available with claude.ai subscriptions.`",
      "`Remote Control isn't enabled for this account`",
      "`Remote Control is disabled by your organization's policy`",
      "`Remote Control is only available when using Claude via api.anthropic.com`",
      "`Remote Control requires feature-flag evaluation`",
    ]) {
      expect(sectionCopy).toContain(message);
    }
    expect(sectionCopy).toContain("`claude auth login`");
    expect(sectionCopy).toContain("`claude remote-control --verbose`");
    expect(sectionCopy).toContain("`claude doctor`");
    expect(sectionCopy).toContain("`/status`");
    // Causes of the org-policy message, in the docs' order, with the HIPAA and Owner cases kept.
    const policy = sectionCopy.split("\n").find((line) => line.startsWith("- `Remote Control is disabled by your organization's policy`"))!;
    expect(policy.indexOf("`disableRemoteControl`")).toBeLessThan(policy.indexOf("a Pro or Max plan"));
    expect(policy.indexOf("a Pro or Max plan")).toBeLessThan(policy.indexOf("HIPAA"));
    expect(policy.indexOf("HIPAA")).toBeLessThan(policy.indexOf("Owner who has not switched"));
    // "Session creation failed" is its own docs bullet: only then is the subscription the suspect.
    expect(sectionCopy).toContain("If `Session creation failed` also appears, the subscription may be inactive.");
    expect(sectionCopy).not.toContain("or the subscription is inactive");
  });

  it("answers the 'not available' search with the three eligibility messages and the API key rule", () => {
    const faq = article.faqs.find(({ q }) => q === "Why is Claude Code Remote Control not available?")!;
    expect(faq).toBeDefined();
    for (const fragment of [
      "Remote Control isn't enabled for this account",
      "Remote Control is disabled by your organization's policy",
      "Remote Control is only available when using Claude via api.anthropic.com",
      "claude doctor",
      "API keys are not supported either",
    ]) {
      expect(faq.a).toContain(fragment);
    }
  });

  it("states the documented numbers with their source", () => {
    expect(sectionCopy).toContain("Claude Code gives up after roughly 10 minutes and the `claude remote-control` process exits.");
    expect(sectionCopy).toContain("about four hours");
    expect(sectionCopy).toContain("32 at once by default");
    expect(sectionCopy).toContain("about 30 minutes");
    expect(sectionCopy).toContain("Claude Code 2.1.267 (9 September 2026)");
    expect(sectionCopy).toContain("Claude Code 2.1.284 (28 September 2026)");
    expect(sectionCopy).toContain("as read on 30 September 2026");
    expect(sectionCopy).toContain("(2.1.232, 13 August 2026)");
    // Where the docs and the changelog disagree, both are stated and neither is reconciled.
    expect(sectionCopy).toMatch(/The docs say it retries for as long as the outage lasts\. The changelog \(2\.1\.232, 13 August 2026\) says it keeps reconnecting for about 30 minutes/);
  });

  it("labels what is our own suggestion and does not claim the whole page is Anthropic's documentation", () => {
    expect(sectionCopy).toContain("The facts below come from Anthropic's Claude Code documentation and changelog as read on 30 September 2026.");
    expect(sectionCopy).toContain("the user-filed reports about them, and anything that is our own suggestion are labelled where they appear");
    expect(sectionCopy).toContain("Server mode is our pick for a machine you leave running, because one process serves several sessions");
    expect(sectionCopy).toContain("That is our reading of one report, not documented advice:");
    expect(sectionCopy).toContain("That is our suggestion, not Anthropic's: its docs name only tmux and screen.");
    expect(sectionCopy).toContain("Anthropic's mobile docs say the same about a computer that will be off");
    expect(sectionCopy).toContain("Its own table lists Remote Control for steering in-progress work from another device.");
    expect(sectionCopy).toContain("no overall limit on how long a Remote Control session can run or sit idle beyond the figures above");
    // Blanket or own-voice statements the docs do not make.
    for (const banned of [
      "Everything below comes from",
      "People search for",
      "No Anthropic service is involved",
      "It is also Anthropic's own advice",
      "It does not react to events or run on a schedule",
      "maximum session length or idle timeout",
    ]) {
      expect(fullCopy).not.toContain(banned);
    }
  });

  it("sources the sleep statement to Anthropic's Projects docs instead of asserting it", () => {
    // The Remote Control docs say only that Claude Code reconnects. "A sleeping laptop runs nothing" was our own claim.
    expect(fullCopy).not.toContain("a sleeping laptop runs nothing");
    expect(sectionCopy).toContain("Anthropic's [Projects docs](https://code.claude.com/docs/en/claude-projects#run-a-thread-on-your-own-computer) say a thread running on your computer pauses while that computer is asleep");
    const sleepFaq = article.faqs.find(({ q }) => q === "Does Remote Control keep working if my computer goes to sleep?")!;
    expect(sleepFaq.a).toContain("Anthropic's Projects docs say a thread running on your computer pauses while that computer is asleep");
  });

  it("keeps the options table to short answers that stay true, with no Hivra row", () => {
    // On a phone the table's second column is cut off by the site's 560px table minimum, so the answer must be short and
    // the qualifiers live in the bullets. The Hivra row was dropped because its untested qualifier was the cut-off part.
    const rows = sectionCopy.split("\n").filter((line) => line.startsWith("|") && !line.startsWith("|---"));
    expect(rows).toEqual([
      "| Where Claude Code runs | Keeps going, laptop shut? |",
      "| Your laptop, as it comes | No |",
      "| A desktop, home server or VPS | Yes, while it stays on and online |",
      "| Anthropic's cloud sessions | Yes, until idle |",
    ]);
    expect(rows.join("\n")).not.toMatch(/Hivra/);
    expect(sectionCopy).toContain("It keeps going only while the machine, its network and the `claude` process stay up.");
  });

  it("separates Dispatch from Remote Control, since \"Remote Control vs Dispatch\" is a related search", () => {
    const section = article.sections.find((candidate) => candidate.heading === "Remote Control, cloud sessions, Channels, Dispatch or SSH: which one do you mean?")!;
    expect(section).toBeDefined();
    const copy = section.paragraphs.join("\n");
    expect(copy).toContain("can mean five different things");
    expect(copy).toContain("- **Dispatch** lets you message a task from the Claude mobile app to the Claude Desktop app on your computer, and Dispatch decides how to run it.");
    expect(copy).toContain("It needs a Pro or Max plan");
    expect(copy).toContain("it drives your own machine, so that machine has to stay on ([Claude Code on mobile](https://code.claude.com/docs/en/mobile))");
    // One bullet per thing the heading names.
    expect(copy.split("\n").filter((line) => line.startsWith("- **"))).toHaveLength(5);
  });

  it("keeps the one rule and the requirements Anthropic documents", () => {
    expect(sectionCopy).toContain("your computer has to stay on and the `claude` process has to keep running");
    expect(sectionCopy).toContain("API keys are not supported");
    expect(sectionCopy).toContain("start it inside tmux or screen");
    expect(sectionCopy).toContain("turns Remote Control off even when a claude.ai login also exists");
    expect(sectionCopy).toContain("can only make model requests");
  });

  it("links to the guides and tools a reader needs next, and every link is a real route", () => {
    const links = internalLinks(sectionCopy);
    for (const href of [
      "/blog/keep-claude-code-running-24-7",
      "/blog/control-claude-code-from-telegram",
      "/blog/is-it-safe-to-leave-an-ai-agent-running-unattended",
      "/blog/byo-api-key-explained",
      "/blog/ai-agent-dies-terminal-closes-fixes",
      "/tools/keep-mac-awake",
      "/tools/tmux-cheat-sheet",
      "/agents/claude-code",
      "/pricing",
    ]) {
      expect(links).toContain(href);
    }
    for (const href of links.filter((link) => link.startsWith("/blog/"))) {
      expect(BLOG_ARTICLES[href.slice("/blog/".length)]).toBeDefined();
    }
    expect(article.relatedArticles.length).toBeGreaterThanOrEqual(3);
    expect(article.relatedArticles.length).toBeLessThanOrEqual(5);
    for (const { slug } of article.relatedArticles) expect(BLOG_ARTICLES[slug]).toBeDefined();
    expect(sectionCopy).toContain("https://code.claude.com/docs/en/remote-control");
  });

  it("is linked from the 24/7 and Telegram posts", () => {
    for (const slug of ["keep-claude-code-running-24-7", "control-claude-code-from-telegram"]) {
      const copy = BLOG_ARTICLES[slug].sections.flatMap((section) => section.paragraphs).join("\n");
      expect(copy).toContain("(/blog/claude-code-remote-control)");
    }
  });

  it("gives 8 to 11 real questions, including both offline messages", () => {
    expect(article.faqs.length).toBeGreaterThanOrEqual(8);
    expect(article.faqs.length).toBeLessThanOrEqual(11);
    const questions = article.faqs.map(({ q }) => q);
    expect(questions).toContain("What does \"Can\u2019t reach your computer\" mean in Claude Code?");
    expect(questions).toContain("What does \"Claude Code on the computer running this session is offline\" mean?");
    expect(new Set(questions).size).toBe(questions.length);
    // The FAQ quotes the first message's body exactly as the section does.
    expect(article.faqs.map(({ a }) => a).join("\n")).toContain("It may be asleep or offline. This session will reconnect when it\u2019s back.");
  });

  it("puts Hivra in as one honest option: the verified keep-running statement, plan facts, and no Remote Control promise", () => {
    expect(sectionCopy).toContain(CLI_RUN_LIFETIME);
    expect(sectionCopy).toContain("Remote Control has not been tested on a Hivra computer");
    expect(sectionCopy).toContain(`The ${LARGER_PLAN_PRICE} plan is ${LARGER_PLAN_SIZE}.`);
    expect(sectionCopy).toContain("Hivra is independent and is not affiliated with Anthropic or OpenAI.");
    expect(article.faqs.find(({ q }) => q === "Does Remote Control work on a Hivra computer?")?.a).toContain(CLI_RUN_LIFETIME);
    // Nothing may say Remote Control works, runs or survives a closed laptop on Hivra: it is untested.
    expect(fullCopy).not.toMatch(/Remote Control (?:works|runs|survives|keeps (?:going|running))[^.]*\bHivra\b/i);
    expect(fullCopy).not.toMatch(/\bHivra\b[^.]*(?:supports|certifies|certified|tested with) Remote Control/i);
    // The regexes above only catch a few verbs, and "You can run Remote Control on a Hivra computer and it stays up when
    // you close the laptop" passes every one of them. So the rule is per sentence: any sentence or table row that names
    // both Remote Control and Hivra must be a question or must say it is untested.
    const hivraSection = article.sections.find((section) => section.heading === "Hivra computers and Remote Control")!;
    expect(hivraSection).toBeDefined();
    const both = fullCopy
      .split(/\n+|(?<=[.!?:])\s+/)
      .filter((sentence) => sentence !== hivraSection.heading && /Remote Control/i.test(sentence) && /\bHivra\b/i.test(sentence));
    expect(both.length).toBeGreaterThan(0);
    for (const sentence of both) {
      expect(sentence).toMatch(/\?$|has not been tested|treat it as untested|not about Remote Control|untested/);
    }
    // The Hivra section must not reuse the Remote Control rule ("the machine that has to stay on") as a Hivra benefit.
    expect(hivraSection.paragraphs.join("\n").replace(CLI_RUN_LIFETIME, "")).not.toMatch(/(?:has|have|must) (?:to )?stay on|the machine that has to stay on/i);
    expect(fullCopy).not.toContain("the machine that has to stay on is not your laptop");
    // Hivra's Telegram tab is not Anthropic's Channels feature and not Remote Control.
    expect(sectionCopy).toContain("Hivra's Telegram tab is Hivra's own connection, separate from Anthropic's Channels feature");
    // Claude Code is pinned on Hivra computers, and that version is not a public claim.
    expect(fullCopy).not.toMatch(/2\.1\.246/);
  });

  it("keeps the operator voice guardrails", () => {
    expect(JSON.stringify(article)).not.toMatch(/[–—]/);
    expect(fullCopy).not.toMatch(/\b(?:seamless|robust|unlock|leverage|transform)\b/i);
    expect(fullCopy).not.toMatch(/it's not just .+ it's /i);
    expect(fullCopy).not.toMatch(/\b(?:box|boxes|runtimes?|instances?)\b/i);
  });
});

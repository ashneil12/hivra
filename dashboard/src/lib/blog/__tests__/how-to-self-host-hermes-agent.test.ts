import { BLOG_ARTICLES } from "@/lib/blog-data";
import { article } from "../articles/how-to-self-host-hermes-agent";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE } from "../plan-facts";

const copy = [
  article.intro,
  article.shortAnswer,
  ...article.sections.flatMap(({ heading, paragraphs }) => [heading, ...paragraphs]),
  ...article.faqs.flatMap(({ q, a }) => [q, a]),
].join("\n");

function section(heading: string): string {
  const found = article.sections.find((candidate) => candidate.heading === heading);
  expect(found).toBeDefined();
  return found!.paragraphs.join("\n");
}

describe("Hermes self-hosting operational guide", () => {
  it("keeps the canonical page and standalone search metadata", () => {
    expect(BLOG_ARTICLES[article.slug]).toBe(article);
    expect(article.slug).toBe("how-to-self-host-hermes-agent");
    expect(article.lastModified).toBe("2026-11-19");
    expect(article.metaTitle!.length).toBeLessThanOrEqual(55);
    expect(article.metaDescription.length).toBeGreaterThanOrEqual(70);
    expect(article.metaDescription.length).toBeLessThanOrEqual(155);
    const words = article.shortAnswer!.trim().split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(40);
    expect(words).toBeLessThanOrEqual(60);
    expect(article.shortAnswer).toContain("Hermes Agent");
    expect(JSON.stringify(article)).not.toMatch(/[\u2013\u2014]/);
    expect(copy).not.toMatch(/(?:checked|read|fetched) on \d/i);
  });

  it("separates optional host sandboxing from the persistent container route", () => {
    expect(copy).toContain("Docker is optional for host installs");
    const container = section("Container route: make the data mount explicit");
    expect(container).toContain("-v ~/.hermes:/opt/data");
    expect(container).toContain("source is the host directory or named volume");
    expect(container).toContain("An empty but valid mount");
    expect(container).toContain("does not inherently erase a named volume");
    expect(container).toContain("anonymous volumes are not automatically reattached");
    expect(container).toContain("--volumes");
    expect(container).not.toMatch(/\n\s*-p /);
    expect(container).not.toMatch(/\n\+/);
  });

  it("requires observable gateway and state checks after disconnect and restart", () => {
    const acceptance = section("Install the service, then prove it survives disconnects");
    for (const expected of [
      "hermes gateway install",
      "hermes gateway start",
      "sudo loginctl enable-linger SERVICE_USER",
      "Disconnect SSH completely",
      "planned server reboot",
      "without first logging into the service account",
      "expected conversation or memory",
      "Investigate repeated restarts",
    ]) expect(acceptance).toContain(expected);
  });

  it("provides private backup and destructive-restore guidance, not just image rollback", () => {
    const recovery = section("Back up before upgrading, and rehearse a restore");
    for (const expected of [
      "hermes backup -o my-agent.zip",
      "hermes import my-agent.zip",
      "--keep-host",
      "off the server",
      ".env",
      "auth.json",
      "credential-bearing secret",
      "Import replaces state",
      "private test destination",
      "hermes doctor",
      "verify the persistent mount again",
    ]) expect(recovery).toContain(expected);
    expect(section("Upgrade with a recovery point, not just an old image")).toContain(
      "Reverting an image alone does not undo changes already written"
    );
  });

  it("keeps authorization brief and removes unconditional resource and access claims", () => {
    const telegram = section("Connect Telegram without duplicating the whole setup");
    expect(telegram).toContain("DM pairing");
    expect(telegram).toContain("unauthorized account cannot start an agent conversation");
    expect(telegram).toContain("/blog/how-to-set-up-hermes-agent-telegram");
    expect(copy).not.toMatch(/anyone who finds the bot|4 GB is the hard floor|you will hit OOM|You need Docker either|under an hour most months/i);
    expect(copy).toContain("does not promise a fixed bill or completion time");
  });

  it("scopes Hivra's new setup to testing and retains billing facts and the self-host choice", () => {
    const hivra = section("The Hivra alternative and its current availability");
    for (const expected of [
      "Hivra Cloud only, not on My cloud or My server",
      "Existing Hermes agents keep their current setup",
      "in testing and is not on hivra.cloud yet",
    ]) {
      expect(hivra).toContain(expected);
    }
    expect(hivra).toContain("Hivra is not affiliated with Nous Research");
    expect(hivra).toContain(`${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}`);
    expect(hivra).toContain("Self-hosting fits better");
    const answer = article.faqs.find(({ q }) => q === "Can Hermes on Hivra run on my own server?")!.a;
    expect(answer).toContain("in testing and is not on hivra.cloud yet");
    expect(answer).not.toMatch(/canary/i);
  });
});

// What the /agents social cards say. The shared renderer (lib/og-card) is mocked so the test reads the
// words it is given; the image itself is covered by opengraph-image.test.tsx.

import HubOg from "../opengraph-image";
import AgentOg from "../[slug]/opengraph-image";
import { AGENT_SEO_ENTRIES } from "@/lib/hivra/agent-seo-catalog";
import { getAgent } from "@/lib/hivra/agent-catalog";
import { HUB_CONTENT } from "../content";
import { metadata as hubMetadata } from "../page";

const renderOgCard = jest.fn(async (input: { eyebrow?: string; title: string; subtitle: string }) => ({ input }));
jest.mock("@/lib/og-card", () => ({
  renderOgCard: (input: { eyebrow?: string; title: string; subtitle: string }) => renderOgCard(input),
}));

// The shared card sets its title at 76px in about 1040px, which is two lines of roughly 22 characters,
// with the subtitle under it. Longer titles push the card's footer off the bottom.
const TWO_LINES = 46;

describe("/agents social card copy", () => {
  it("titles the directory card with the page's own H1", async () => {
    await HubOg();
    const { title, subtitle, eyebrow } = renderOgCard.mock.calls[0][0];
    expect(title).toBe("Pick your agent. We'll give it a computer.");
    expect(title).toBe(HUB_CONTENT.h1);
    expect(title.length).toBeLessThanOrEqual(TWO_LINES);
    expect(eyebrow).toBe("Agents");
    // The card carries no sentence of its own: the subtitle is the first sentence of Ash's search description.
    expect(subtitle).toBe("Give Claude Code, Codex, Hermes, Aeon, OpenClaw or Agent Zero a cloud computer.");
    expect(String(hubMetadata.description).startsWith(`${subtitle} `)).toBe(true);
    expect(subtitle.length).toBeLessThanOrEqual(100);
  });

  it.each(AGENT_SEO_ENTRIES)("$slug: the card names the agent and carries its directory tagline", async (entry) => {
    renderOgCard.mockClear();
    await AgentOg({ params: Promise.resolve({ slug: entry.slug }) });
    const { title, subtitle } = renderOgCard.mock.calls[0][0];
    expect(title).toBe(`${getAgent(entry.slug)!.name}, in the cloud`);
    expect(title.length).toBeLessThanOrEqual(TWO_LINES);
    expect(subtitle).toBe(HUB_CONTENT.directory.cards.find((card) => card.slug === entry.slug)!.tagline);
    expect(subtitle.length).toBeLessThanOrEqual(100);
    expect(`${title} ${subtitle}`).not.toMatch(/[–—]/);
  });
});

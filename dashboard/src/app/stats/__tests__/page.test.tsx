/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";

import { findBannedClaims } from "@/lib/tools/copy-rules";

const mockAuth = jest.fn();
const mockStats = jest.fn();
const mockPublic = jest.fn();
const mockTokenView = jest.fn();
const mockContent = jest.fn();

jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));
jest.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => ({ get: () => null }),
}));
jest.mock("@/lib/agents-deployed-stats", () => ({ getAgentsDeployedStats: (...args: unknown[]) => mockStats(...args) }));
jest.mock("@/lib/public-stats", () => ({ getPublicStats: () => mockPublic() }));
jest.mock("@/lib/compliance/token-surface-view", () => ({ getTokenSurfaceView: (...args: unknown[]) => mockTokenView(...args) }));
jest.mock("@/components/public-site/PublicSite", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="public-site">{children}</div>,
}));
jest.mock("@/components/StructuredData", () => ({
  __esModule: true,
  default: ({ schema }: { schema: unknown }) => <script type="application/ld+json" data-testid="ld" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }} />,
}));
jest.mock("@/components/stats/StatsPageContent.client", () => ({
  __esModule: true,
  default: (props: unknown) => {
    mockContent(props);
    return <main data-testid="content" />;
  },
}));
jest.mock("@/lib/logger", () => ({ log: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));

import StatsPage, { metadata } from "../page";

const MD_TITLE = "Hivra Statistics | Platform Activity";

describe("/stats page", () => {
  beforeEach(() => {
    mockAuth.mockResolvedValue({ userId: null });
    mockTokenView.mockResolvedValue({ tokenSurfaces: false, geoBlocked: false });
    mockStats.mockResolvedValue({
      total: 10,
      last24h: 1,
      last7d: 2,
      series: [{ date: "2026-10-20", count: 10 }],
      firstDeployAt: "2026-03-02T09:00:00.000Z",
      generatedAt: "2026-10-20T14:05:00.000Z",
    });
    mockPublic.mockResolvedValue(null);
  });

  it("uses the md title exactly, once, without the template appending the brand again", () => {
    expect(metadata.title).toEqual({ absolute: MD_TITLE });
    const openGraph = metadata.openGraph as { title?: string; url?: string };
    const twitter = metadata.twitter as { title?: string };
    expect(openGraph.title).toBe(MD_TITLE);
    expect(twitter.title).toBe(MD_TITLE);
    expect(openGraph.url).toBe("https://hivra.cloud/stats");
    expect(metadata.alternates?.canonical).toBe("https://hivra.cloud/stats");
  });

  it("describes the live counter without dashes or banned claims", () => {
    const text = `${MD_TITLE} ${metadata.description}`;
    expect(metadata.description).toBe("Live count of every agent and computer launched on Hivra. Updated as people launch.");
    expect(text).not.toMatch(/[\u2013\u2014]/);
    expect(findBannedClaims(text)).toEqual([]);
  });

  it("hands the live lookups and the token view to the content", async () => {
    render(await StatsPage());
    expect(screen.getByTestId("content")).toBeInTheDocument();
    expect(mockTokenView).toHaveBeenCalledWith(null);
    expect(mockContent).toHaveBeenCalledWith(
      expect.objectContaining({
        initial: expect.objectContaining({ total: 10, generatedAt: "2026-10-20T14:05:00.000Z" }),
        firstDeployIso: "2026-03-02T09:00:00.000Z",
        platform: null,
        tokenView: { tokenSurfaces: false, geoBlocked: false },
      }),
    );
    const ld = JSON.parse(screen.getByTestId("ld").textContent ?? "{}");
    expect(ld["@graph"][0]["@type"]).toBe("BreadcrumbList");
  });

  it("still renders when a lookup throws, with nothing to show", async () => {
    mockStats.mockRejectedValue(new Error("rpc down"));
    render(await StatsPage());
    expect(mockContent).toHaveBeenLastCalledWith(expect.objectContaining({ initial: null, firstDeployIso: null, platform: null }));
  });
});

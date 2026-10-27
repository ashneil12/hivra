/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";

import { findBannedClaims } from "@/lib/tools/copy-rules";

jest.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => ({ get: () => null }),
}));
jest.mock("@/components/public-site/PublicSite", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="public-site">{children}</div>,
}));
jest.mock("@/components/StructuredData", () => ({
  __esModule: true,
  default: ({ schema }: { schema: unknown }) => <script type="application/ld+json" data-testid="ld" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }} />,
}));
jest.mock("@/components/status/StatusPageContent.client", () => ({
  __esModule: true,
  default: () => <main data-testid="content" />,
}));

import StatusPage, { metadata } from "../page";

// Ash's pack title ended "| Current Incidents and Updates". No incident source exists behind the page, so the
// title promises the status only.
const TITLE = "Hivra Service Status";

describe("/status page", () => {
  it("uses the retitled name exactly, once, in the tab and on the social cards", () => {
    expect(metadata.title).toEqual({ absolute: TITLE });
    const openGraph = metadata.openGraph as { title?: string; url?: string };
    const twitter = metadata.twitter as { title?: string };
    expect(openGraph.title).toBe(TITLE);
    expect(twitter.title).toBe(TITLE);
    expect(openGraph.url).toBe("https://hivra.cloud/status");
  });

  it("keeps a description that says what the page really checks", () => {
    const description = String(metadata.description);
    expect(description).toContain("Live status of Hivra's public pages");
    expect(`${TITLE} ${description}`).not.toMatch(/[\u2013\u2014]/);
    // No incident list, feed or history exists, so neither the title nor the description promises one.
    expect(`${TITLE} ${description}`).not.toMatch(/incident|updates/i);
    expect(findBannedClaims(`${TITLE} ${description}`)).toEqual([]);
  });

  it("renders the live checks inside the public frame with a breadcrumb", async () => {
    render(await StatusPage());
    expect(screen.getByTestId("content")).toBeInTheDocument();
    const ld = JSON.parse(screen.getByTestId("ld").textContent ?? "{}");
    expect(ld["@graph"][0].itemListElement.map((item: { name: string }) => item.name)).toEqual(["Home", "Status"]);
  });
});

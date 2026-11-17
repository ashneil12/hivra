/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import MakerPageRoute from "../page";

jest.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));
jest.mock("@/components/launch/MakerPage", () => ({
  MakerPage: ({ profileId }: { profileId: string }) => <p>Maker page for {profileId}</p>,
}));

const open = (profile: string) => MakerPageRoute({ params: Promise.resolve({ profile }) });

describe("the maker page route", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_HIVRA_LAUNCH_CATALOG = "1";
    process.env.NEXT_PUBLIC_HIVRA_MAKER_CLAIMS = "1";
  });
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_HIVRA_LAUNCH_CATALOG;
    delete process.env.NEXT_PUBLIC_HIVRA_MAKER_CLAIMS;
  });

  it("shows the page for an agent whose maker publishes a repository", async () => {
    render(await open("openclaw"));
    expect(screen.getByText("Maker page for openclaw")).toBeInTheDocument();
  });

  it("is not there for an unknown page, or one with no repository to read a proof from", async () => {
    await expect(open("not-a-page")).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(open("ubuntu-desktop")).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(open("openbot")).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(open("omarchy")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it.each([
    ["the maker claims switch", "NEXT_PUBLIC_HIVRA_MAKER_CLAIMS"],
    ["the catalog switch", "NEXT_PUBLIC_HIVRA_LAUNCH_CATALOG"],
  ])("is not there while %s is off", async (_words, name) => {
    delete process.env[name];
    await expect(open("openclaw")).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

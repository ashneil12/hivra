/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import ActivityPage from "../page";
import { auth } from "@clerk/nextjs/server";
let localAuthMode = false;
jest.mock("@clerk/nextjs/server", () => ({ auth: { protect: jest.fn() } }));
jest.mock("@/components/dashboard/activity/ActivityObservatory", () => ({
  ActivityObservatory: ({ showUsage }: { showUsage: boolean }) => (
    <div>Observatory · usage {String(showUsage)}</div>
  ),
}));
jest.mock("@/lib/self-host/config", () => ({
  isLocalAuthMode: () => localAuthMode,
}));
beforeEach(() => {
  localAuthMode = false;
});
it("protects account activity and preserves managed usage access", async () => {
  render(await ActivityPage());
  expect(auth.protect).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Observatory · usage true")).toBeVisible();
});
it("uses the same evidence surface in local mode without hosted billing", async () => {
  localAuthMode = true;
  render(await ActivityPage());
  expect(screen.getByText("Observatory · usage false")).toBeVisible();
});

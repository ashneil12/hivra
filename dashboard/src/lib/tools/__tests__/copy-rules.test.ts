import { findBannedClaims } from "../copy-rules";

// The shared rule list that every /tools page and the homepage are scanned
// against. These sentences are the invented setup-time claims the 2026-09-30
// copy audit (F-15) removed from the public pages. The rule must keep catching
// them, and must leave the honest wording alone.
describe("tools copy rules: setup time", () => {
  it.each([
    "Setting it up yourself takes 4-8 hours for someone who knows Linux.",
    "Plan on 6 to 8 hours of setup the first time.",
    "You would spend a weekend setting it up, then an hour a month keeping it alive.",
    "It can easily take a full weekend.",
    "None of this is hard, but it is a full afternoon of work.",
    "Budget 2 hours a month for updates.",
  ])("flags an invented length of time: %s", (sentence) => {
    const why = findBannedClaims(sentence).map((hit) => hit.why);
    expect(why.join("\n")).toMatch(/No invented hours for setting up or running a server/);
  });

  it.each([
    "The calculator takes your own hours and hourly rate.",
    "A small server can cost less each month, but you set it up and keep it running yourself.",
    "Setup and upkeep are your own time.",
    "Run it for 8 hours with caffeinate -t.",
  ])("leaves honest wording alone: %s", (sentence) => {
    const why = findBannedClaims(sentence).map((hit) => hit.why);
    expect(why.join("\n")).not.toMatch(/No invented hours/);
  });

  it("flags em and en dashes", () => {
    expect(findBannedClaims("Set it once — forget it").map((hit) => hit.why)).toContain("No em or en dashes in copy.");
    expect(findBannedClaims("2–3 minutes").map((hit) => hit.why)).toContain("No em or en dashes in copy.");
  });
});

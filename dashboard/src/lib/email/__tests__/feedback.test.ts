import { buildFeedbackEmail } from "@/lib/email/feedback";

describe("buildFeedbackEmail", () => {
  it("asks the three check-in questions and asks for a reply", () => {
    const email = buildFeedbackEmail("feedback_checkin", { firstName: "Sam" });
    expect(email.subject).toBe("a quick question about Hivra");
    expect(email.text.startsWith("Hey Sam,")).toBe(true);
    expect(email.text).toContain("1. What do you mostly use your agent for?");
    expect(email.text).toContain("3. Who else do you think should be using it?");
    expect(email.text).toContain("Just hit reply.");
  });

  it("asks a cancelled customer what made them stop", () => {
    const email = buildFeedbackEmail("cancel_feedback", { firstName: null });
    expect(email.text.startsWith("Hey,")).toBe(true);
    expect(email.text).toContain("what made you stop?");
  });

  it("escapes the first name in the HTML part", () => {
    const email = buildFeedbackEmail("feedback_checkin", { firstName: "<b>Sam</b>" });
    expect(email.html).not.toContain("<b>Sam</b>");
    expect(email.html).toContain("&lt;b&gt;Sam&lt;/b&gt;");
  });
});

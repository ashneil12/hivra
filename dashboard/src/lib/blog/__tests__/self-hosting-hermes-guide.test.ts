import { article } from "../articles/self-hosting-hermes-guide";

describe("self-hosting Hermes guide backup FAQ", () => {
  it("keeps the backup FAQ plain text and links to restore guidance in the article body", () => {
    const faq = article.faqs.find(({ q }) => q === "How do I back up my agent's memory?");

    expect(faq).toBeDefined();
    for (const expected of [
      "Hermes provides a built-in full-home backup command",
      "hermes backup -o my-agent.zip",
      ".env",
      "auth.json",
      "treat it as private",
      "keep a copy off the server",
    ]) {
      expect(faq!.a).toContain(expected);
    }
    expect(faq!.a).not.toContain("`");
    expect(faq!.a).not.toContain("[");
    expect(faq!.a).not.toContain("There is no built-in backup tooling");

    const updateSection = article.sections.find(({ heading }) => heading === "What usually breaks?");
    expect(updateSection).toBeDefined();
    expect(updateSection!.paragraphs.join("\n")).toContain(
      "[Hermes Agent self-hosting guide](/blog/how-to-self-host-hermes-agent)"
    );
  });
});

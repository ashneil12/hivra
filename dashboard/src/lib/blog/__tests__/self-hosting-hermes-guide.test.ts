import { article } from "../articles/self-hosting-hermes-guide";

describe("self-hosting Hermes guide backup FAQ", () => {
  it("documents the built-in private backup and links to restore guidance", () => {
    const faq = article.faqs.find(({ q }) => q === "How do I back up my agent's memory?");

    expect(faq).toBeDefined();
    for (const expected of [
      "Hermes provides a built-in full-home backup command",
      "`hermes backup -o my-agent.zip`",
      "`.env`",
      "`auth.json`",
      "treat it as private",
      "keep a copy off the server",
      "/blog/how-to-self-host-hermes-agent",
    ]) {
      expect(faq!.a).toContain(expected);
    }
    expect(faq!.a).not.toContain("There is no built-in backup tooling");
  });
});

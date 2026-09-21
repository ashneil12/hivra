import { escapeHtml } from "@/lib/email/escape-html";

describe("escapeHtml", () => {
  it("escapes &, <, > and double-quote", () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;"
    );
  });

  it("escapes & first so other entities are not double-escaped", () => {
    expect(escapeHtml("a & <b>")).toBe("a &amp; &lt;b&gt;");
  });

  it("does NOT escape single quotes — that is lifecycle.ts's separate, stricter variant", () => {
    expect(escapeHtml("it's fine")).toBe("it's fine");
  });

  it("returns plain text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});

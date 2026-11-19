import {
  renderBroadcastHtml,
  renderBroadcastHtmlBlocks,
  renderBroadcastText,
} from "../broadcast-body";

describe("broadcast body", () => {
  const body = [
    "# Hivra, issue 1",
    "Hi there,\nshort intro.",
    "## What shipped",
    "- **Hermes** the official way\n- See [the guide](https://hivra.cloud/docs)",
  ].join("\n\n");

  it("renders headings, lists, links and bold", () => {
    const html = renderBroadcastHtmlBlocks(body);
    expect(html).toContain("<h2");
    expect(html).toContain("Hivra, issue 1</h2>");
    expect(html).toContain("<h3");
    expect(html).toContain("Hi there,<br>short intro.");
    expect(html).toContain("<ul");
    expect(html).toContain("<strong>Hermes</strong>");
    expect(html).toContain('<a href="https://hivra.cloud/docs"');
  });

  it("escapes HTML and refuses non-http links", () => {
    const html = renderBroadcastHtmlBlocks(
      '<script>x</script> [bad](javascript:alert(1)) [q](https://a.b/"onx=1)',
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('href="javascript');
    expect(html).not.toContain('"onx');
  });

  it("keeps the unsubscribe link and the Hivra name in the footer", () => {
    const html = renderBroadcastHtml(body);
    expect(html).toContain("{{{RESEND_UNSUBSCRIBE_URL}}}");
    expect(html).toContain("signed up for Hivra");
    expect(html).not.toContain("Hermes OS");
  });

  it("writes plain text with links spelled out", () => {
    const text = renderBroadcastText(body);
    expect(text).toContain("See the guide (https://hivra.cloud/docs)");
    expect(text).toContain("Hivra, issue 1");
    expect(text).not.toContain("#");
    expect(text).not.toContain("**");
    expect(text).toContain("{{{RESEND_UNSUBSCRIBE_URL}}}");
  });
});

import { renderToStaticMarkup } from "react-dom/server";

import StructuredData from "../StructuredData";

describe("StructuredData", () => {
  it("renders JSON-LD in the server HTML so crawlers that do not run JavaScript see it", () => {
    const html = renderToStaticMarkup(
      <StructuredData schema={{ "@context": "https://schema.org", "@type": "Organization", name: "Hivra" }} />,
    );

    expect(html).toMatch(/^<script type="application\/ld\+json">/);
    expect(html).toContain('"@type":"Organization"');
  });

  it("escapes '<' so schema text cannot close the script tag", () => {
    const html = renderToStaticMarkup(
      <StructuredData schema={{ name: "</script><script>alert(1)</script>" }} />,
    );

    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).toContain("\\u003c/script>");
  });

  it("keeps several schemas on one page as separate tags", () => {
    const html = renderToStaticMarkup(
      <>
        <StructuredData schema={{ "@type": "BlogPosting" }} />
        <StructuredData schema={{ "@type": "BreadcrumbList" }} />
      </>,
    );

    expect(html.match(/<script type="application\/ld\+json">/g)).toHaveLength(2);
  });
});

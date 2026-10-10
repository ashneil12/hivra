// Reusable component to inject JSON-LD structured data into the page.
// Usage: <StructuredData schema={mySchemaObject} />
// Accepts any valid schema.org JSON-LD object or @graph array.
//
// Deliberately a plain inline <script>, NOT next/script: next/script with
// strategy="afterInteractive" injects the tag client-side after hydration, so
// crawlers fetching raw HTML never see the structured data (and its fixed id
// deduped multiple schemas on one page down to a single tag). A plain script
// renders in the server HTML, which is the canonical Next.js JSON-LD pattern.

interface StructuredDataProps {
  schema: Record<string, unknown>;
}

export default function StructuredData({ schema }: StructuredDataProps) {
  return (
    <script
      type="application/ld+json"
      // '<' is escaped so schema text can never close the tag early (XSS guard).
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(schema).replace(/</g, "\\u003c"),
      }}
    />
  );
}

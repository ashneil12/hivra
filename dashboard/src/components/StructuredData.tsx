// Reusable component to inject JSON-LD structured data into the page <head>.
// Usage: <StructuredData schema={mySchemaObject} />
// Accepts any valid schema.org JSON-LD object or @graph array.

import Script from 'next/script';

interface StructuredDataProps {
  schema: Record<string, unknown>;
}

export default function StructuredData({ schema }: StructuredDataProps) {
  return (
    <Script
      id="structured-data"
      type="application/ld+json"
      strategy="afterInteractive"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}

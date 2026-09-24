import type { Metadata } from "next";

import TokenPageClient from "@/components/token/TokenPageClient";
import { buildWebsiteMetadata } from "@/lib/metadata";
import { getTokenPageEntries, tokenVerificationContent } from "@/lib/token-verification-content";

// The $HIVRA entry changes at its activation instant: re-render at least every
// minute rather than freezing the build-time phase into static HTML.
export const revalidate = 60;

export const metadata: Metadata = {
  title: tokenVerificationContent.metadata.title,
  description: tokenVerificationContent.metadata.description,
  ...buildWebsiteMetadata({
    path: "/token",
    title: tokenVerificationContent.metadata.title,
    description: tokenVerificationContent.metadata.description,
  }),
};

export default function TokenVerificationPage() {
  return <TokenPageClient entries={getTokenPageEntries()} />;
}

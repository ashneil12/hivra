import type { Metadata } from "next";

import TokenPageClient from "@/components/token/TokenPageClient";
import { buildWebsiteMetadata } from "@/lib/metadata";
import { tokenVerificationContent } from "@/lib/token-verification-content";

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
  return <TokenPageClient />;
}

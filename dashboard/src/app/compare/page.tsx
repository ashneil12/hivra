import type { Metadata } from "next";
import { absoluteTitle, buildWebsiteMetadata } from "@/lib/metadata";
import { COMPARE_DIRECTORY } from "@/lib/compare/directory";
import CompareArticle from "./CompareArticle";

// The finished browser title is written out here so the title scanners can read it
// (app/__tests__/absolute-title-metadata.test.ts); a test keeps it equal to the copy in lib/compare/directory.ts.
// The description carries the month the prices were checked, so it is read from the same copy and cannot drift from it.
const TITLE = "Hivra compared with the alternatives | Hivra";
const DESCRIPTION = COMPARE_DIRECTORY.metaDescription;

export const metadata: Metadata = {
  title: absoluteTitle(TITLE),
  description: DESCRIPTION,
  ...buildWebsiteMetadata({ path: "/compare", title: TITLE, description: DESCRIPTION }),
};

export default function ComparePage() {
  return <CompareArticle page={COMPARE_DIRECTORY} variant="directory" />;
}

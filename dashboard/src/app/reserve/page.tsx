import { HOSTED_COMPUTE_NEEDS_PLAN_SHORT, FREE_ACCOUNT_SENTENCE } from "@/lib/blog/plan-facts";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PUBLIC_START_HREF } from "@/lib/public-start";

export const metadata: Metadata = {
  title: "Get Started",
  description: `Create your Hivra account. ${FREE_ACCOUNT_SENTENCE} ${HOSTED_COMPUTE_NEEDS_PLAN_SHORT}`,
  robots: { index: false, follow: true },
};

export default function ReservePage() {
  redirect(PUBLIC_START_HREF);
}

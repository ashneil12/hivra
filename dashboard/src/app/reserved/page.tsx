import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PUBLIC_START_HREF } from "@/lib/public-start";

export const metadata: Metadata = {
  title: "Start Free | Hivra",
  description: "The Hivra free tier is live. Start your first persistent Hermes agent for free.",
  robots: { index: false, follow: true },
};

export default function ReservedPage() {
  redirect(PUBLIC_START_HREF);
}

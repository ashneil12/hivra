import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "Start Free | Hivra",
  description: "The Hivra free tier is live. Start your first persistent Hermes agent for free.",
  robots: { index: false, follow: true },
};

export default function ReservedPage() {
  redirect("/get-started?plan=free");
}
